import { readFile } from 'node:fs/promises';
import type { NativeSessionReadResult, NativeSessionTurn } from '../../core/backend.js';
import { EXIT_CODES, OpenPError } from '../../core/errors.js';
import {
  confirmStableNativeFileSnapshots,
  NativeFileSnapshotChangedError,
} from '../../core/fs-durability.js';
import { decodeNativeStateUtf8, digestNativeState } from '../../core/native-state-digest.js';
import { findCodexSessionLogPath } from './session-log.js';

interface JsonObject {
  readonly [key: string]: unknown;
}

interface PendingCodexTurn {
  started: boolean;
  completed: boolean;
  aborted: boolean;
  userId: string | null;
  userText: string | null;
  assistantIds: string[];
  assistantText: string[];
  completionId: string | null;
  // Index of the turn's own task_started record; null for implicit windows without one.
  taskStartedIndex: number | null;
  // Index of the last record attributed to this turn (lifecycle start, portable messages, and
  // non-message response_items).
  lastRecordIndex: number | null;
  // Whether the last attributed substantive record is an assistant message (trailing-completion
  // evidence for an open window at end of file).
  tailIsAssistantMessage: boolean;
}

export async function readCodexNativeSession(input: {
  readonly backend: string;
  readonly sessionId: string;
  readonly homeDir?: string | null;
  readonly mode?: 'logical' | 'settlement';
}): Promise<NativeSessionReadResult> {
  const logPath = await findCodexSessionLogPath(input.sessionId, input.homeDir ?? null);
  if (!logPath) {
    throw new OpenPError(`codex session log not found for ${input.sessionId}`, EXIT_CODES.sessionLogNotFound);
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(logPath);
  } catch (error) {
    if (isNotFoundError(error)) {
      throw new OpenPError(`codex session log not found for ${input.sessionId}`, EXIT_CODES.sessionLogNotFound);
    }
    throw new OpenPError('Codex native session log could not be read after discovery', EXIT_CODES.protocolViolation);
  }
  if (input.mode === 'settlement') {
    bytes = await confirmStableCodexNativeFile(logPath, bytes);
  }
  const text = decodeNativeStateUtf8(bytes, 'Codex native session log');
  assertCodexNativeSessionIdentity(text, input.sessionId);
  return {
    backend: input.backend,
    sessionId: input.sessionId,
    turns: extractCodexNativeTurns(text),
    nativeStateDigest: codexNativeStateDigest(bytes),
  };
}

export function codexNativeStateDigest(logBytes: Uint8Array): string {
  return digestNativeState('codex-rollout-jsonl-v1', [logBytes]);
}

async function confirmStableCodexNativeFile(path: string, before: Buffer): Promise<Buffer> {
  try {
    const [after] = await confirmStableNativeFileSnapshots([{ path, bytes: before }]);
    return after!;
  } catch (error) {
    if (error instanceof NativeFileSnapshotChangedError) {
      throw new OpenPError('Codex native session changed during durability confirmation', EXIT_CODES.protocolViolation);
    }
    throw new OpenPError('Codex native session durability could not be confirmed', EXIT_CODES.protocolViolation);
  }
}

// The first session_meta record carries the file's own identity and must match the requested
// session. `payload.id` is the authoritative identity: every observed first meta carries it,
// always equal to the filename session id. `payload.session_id` is thread-lineage metadata, not
// this rollout's identity — observed absent, equal to `id`, and different from `id` (CLI 0.142.0+
// resume/fork lineage) — so it is never
// identity-compared (nor type-checked) while `payload.id` is present, and serves as the identity
// only when `payload.id` is absent (legacy shape). `codex exec resume`/fork rewrites replay the
// parent thread's history into the new rollout, including the parent's session_meta records, so
// second and later session_meta records carry parent ids and are not identity-checked.
export function assertCodexNativeSessionIdentity(logText: string, expectedSessionId: string): void {
  for (const line of logText.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const entry = parseLine(line);
    if (entry.type !== 'session_meta') continue;
    const payload = isObject(entry.payload) ? entry.payload : null;
    const identityKey = payload === null
      ? null
      : Object.prototype.hasOwnProperty.call(payload, 'id')
        ? 'id'
        : Object.prototype.hasOwnProperty.call(payload, 'session_id')
          ? 'session_id'
          : null;
    if (payload === null || identityKey === null) {
      throw new OpenPError('Codex session metadata has no native session identity', EXIT_CODES.protocolViolation);
    }
    const identity = payload[identityKey];
    if (typeof identity !== 'string' || identity.length === 0) {
      throw new OpenPError('Codex session metadata has an invalid native session identity', EXIT_CODES.protocolViolation);
    }
    if (identity !== expectedSessionId) {
      throw new OpenPError('Codex session log belongs to a different native session', EXIT_CODES.protocolViolation);
    }
    return;
  }
  throw new OpenPError('Codex session log has no session metadata record', EXIT_CODES.protocolViolation);
}

// Turn windows open at task_started(T) and leave the open-window stack at explicit
// task_complete(T) or turn_aborted(T). Records without a passthrough turn_id attribute to the top
// of the open-window stack; `codex exec resume`/fork rewrites replay parallel and nested windows,
// so a new task_started never closes another window. Codex also omits task_complete for some
// otherwise-completed turns (and omits task_started for the implicit first `codex exec` window),
// so completion is settled in a post-pass: explicit task_complete wins; otherwise a turn whose
// last attributed record precedes another turn's task_started is completed-by-successor;
// otherwise a trailing window whose last attributed record is an assistant message is a completed
// turn, and anything else is dropped as interrupted mid-work. The completion boundary id is
// always T.
export function extractCodexNativeTurns(logText: string): readonly NativeSessionTurn[] {
  const byTurnId = new Map<string, PendingCodexTurn>();
  const order: string[] = [];
  const orderedTurnIds = new Set<string>();
  const openWindowStack: string[] = [];
  const rememberTurnId = (turnId: string): void => {
    if (!orderedTurnIds.has(turnId)) {
      orderedTurnIds.add(turnId);
      order.push(turnId);
    }
  };
  const openWindowTop = (): string | null =>
    openWindowStack.length > 0 ? openWindowStack[openWindowStack.length - 1]! : null;
  const removeOpenWindow = (turnId: string): void => {
    const at = openWindowStack.lastIndexOf(turnId);
    if (at !== -1) openWindowStack.splice(at, 1);
  };

  const entries: JsonObject[] = [];
  for (const line of logText.split(/\r?\n/)) {
    if (!line.trim()) continue;
    entries.push(parseLine(line));
  }

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    // Compaction summaries (`replacement_history`) are never read as source turns; the completed
    // original turns around the marker stay portable.
    if (entry.type === 'compacted') continue;
    rejectUnsupportedCodexSource(entry);
    const payload = isObject(entry.payload) ? entry.payload : null;
    if (!payload) continue;
    if (payload.type === 'context_compacted') continue;
    if (entry.type === 'event_msg' && payload.type === 'task_started') {
      const turnId = requireLifecycleTurnId(payload, 'task_started');
      const pending = ensureTurn(byTurnId, turnId);
      if (pending.aborted) {
        throw new OpenPError(`Codex source has events after turn_aborted for ${turnId}`, EXIT_CODES.protocolViolation);
      }
      if (pending.completed) {
        throw new OpenPError(`Codex source has events after task_complete for ${turnId}`, EXIT_CODES.protocolViolation);
      }
      if (pending.started) {
        throw new OpenPError(`Codex source has duplicate task_started for ${turnId}`, EXIT_CODES.protocolViolation);
      }
      rememberTurnId(turnId);
      pending.started = true;
      pending.taskStartedIndex = index;
      pending.lastRecordIndex = index;
      openWindowStack.push(turnId);
      continue;
    }
    if (entry.type === 'event_msg' && payload.type === 'task_complete') {
      const turnId = requireLifecycleTurnId(payload, 'task_complete');
      const pending = ensureTurn(byTurnId, turnId);
      if (pending.aborted) {
        throw new OpenPError(`Codex source has events after turn_aborted for ${turnId}`, EXIT_CODES.protocolViolation);
      }
      if (pending.completed) {
        throw new OpenPError(`Codex source has duplicate task_complete for ${turnId}`, EXIT_CODES.protocolViolation);
      }
      // A task_complete without task_started is the implicit first `codex exec` window: the CLI
      // omits the first turn's task_started but still emits its completion.
      rememberTurnId(turnId);
      pending.completed = true;
      pending.completionId = turnId;
      removeOpenWindow(turnId);
      continue;
    }
    if (entry.type === 'event_msg' && payload.type === 'turn_aborted') {
      const turnId = requireLifecycleTurnId(payload, 'turn_aborted');
      const pending = ensureTurn(byTurnId, turnId);
      if (pending.completed) {
        throw new OpenPError(`Codex source has events after task_complete for ${turnId}`, EXIT_CODES.protocolViolation);
      }
      pending.aborted = true;
      removeOpenWindow(turnId);
      continue;
    }
    if (entry.type !== 'response_item') {
      // Other event_msg records (user_message, agent_message, token_count,
      // thread_settings_applied, ...) are bookkeeping and never attribute to a window.
      continue;
    }
    if (payload.type !== 'message') {
      // Non-message response_items (reasoning, function_call, function_call_output,
      // custom_tool_call, ...) attribute for window-tail tracking only. Attribution to an
      // already-settled window has not been observed in real session logs, so the record is discarded without
      // failing the file; its content is never read.
      const turnId = readTurnId(payload) ?? openWindowTop();
      if (turnId === null) continue;
      const pending = ensureTurn(byTurnId, turnId);
      if (pending.completed || pending.aborted) continue;
      pending.lastRecordIndex = index;
      pending.tailIsAssistantMessage = false;
      continue;
    }
    if (payload.role === 'user') {
      const text = readSingleText(payload.content, 'input_text');
      if (text === null) continue;
      // A caller user carries a user_message mirror in both record generations. Injected records
      // (environment_context, AGENTS.md instructions, codex_internal_context, subagent notices)
      // also carry a passthrough turn_id but have no mirror, so passthrough alone must not qualify
      // a caller.
      if (!isCallerMirrorRecord(entries[index + 1])) continue;
      const turnId = readTurnId(payload) ?? openWindowTop();
      if (turnId === null) {
        throw new OpenPError(
          'Codex source has a caller message outside a task lifecycle window',
          EXIT_CODES.protocolViolation,
        );
      }
      rememberTurnId(turnId);
      const pending = ensureTurn(byTurnId, turnId);
      if (pending.aborted) {
        throw new OpenPError(`Codex source has events after turn_aborted for ${turnId}`, EXIT_CODES.protocolViolation);
      }
      if (pending.completed) {
        throw new OpenPError(`Codex source has events after task_complete for ${turnId}`, EXIT_CODES.protocolViolation);
      }
      if (pending.userText === null) {
        if (pending.assistantText.length > 0) {
          throw new OpenPError(`Codex source turn ${turnId} has assistant before portable user message`, EXIT_CODES.protocolViolation);
        }
        pending.userId = nativePayloadId(payload, `user:${turnId}`);
        pending.userText = text;
      } else {
        // Mid-turn steering: the TUI appends further caller messages into a still-open window.
        // They merge in record order; the first caller keeps the user id.
        pending.userText = `${pending.userText}\n\n${text}`;
      }
      pending.lastRecordIndex = index;
      pending.tailIsAssistantMessage = false;
      continue;
    }
    if (payload.role === 'assistant') {
      const text = readSingleText(payload.content, 'output_text');
      if (text === null || text.length === 0) continue;
      const passthroughTurnId = readTurnId(payload);
      const turnId = passthroughTurnId ?? openWindowTop();
      if (turnId === null) {
        throw new OpenPError(
          'Codex source has a window-bound assistant message outside a task lifecycle window',
          EXIT_CODES.protocolViolation,
        );
      }
      const pending = ensureTurn(byTurnId, turnId);
      if (pending.aborted) {
        throw new OpenPError(`Codex source has events after turn_aborted for ${turnId}`, EXIT_CODES.protocolViolation);
      }
      if (pending.completed) {
        throw new OpenPError(`Codex source has events after task_complete for ${turnId}`, EXIT_CODES.protocolViolation);
      }
      rememberTurnId(turnId);
      pending.assistantIds.push(passthroughTurnId !== null
        ? requireAssistantPayloadId(payload)
        : nativePayloadId(payload, `assistant:${turnId}:${pending.assistantIds.length + 1}`));
      pending.assistantText.push(text);
      pending.lastRecordIndex = index;
      pending.tailIsAssistantMessage = true;
    }
  }

  let maxTaskStartedIndex = -1;
  for (const pending of byTurnId.values()) {
    if (pending.taskStartedIndex !== null && pending.taskStartedIndex > maxTaskStartedIndex) {
      maxTaskStartedIndex = pending.taskStartedIndex;
    }
  }

  const turns: NativeSessionTurn[] = [];
  for (const turnId of order) {
    const pending = byTurnId.get(turnId)!;
    // turn_aborted-closed windows are dropped: their content is an interrupted turn.
    if (pending.aborted) continue;
    let completionId = pending.completionId;
    if (!pending.completed) {
      const lastRecordIndex = pending.lastRecordIndex ?? -1;
      if (maxTaskStartedIndex > lastRecordIndex) {
        // completed-by-successor: another turn's task_started after this window's last attributed
        // record proves this window's work ended even though its task_complete was omitted. A
        // turn's own task_started index never exceeds its lastRecordIndex, so a strictly greater
        // maximum always belongs to a different turn.
        completionId = turnId;
      } else if (pending.tailIsAssistantMessage && pending.userText !== null && pending.userText.length > 0
        && pending.assistantText.length > 0) {
        // A trailing open window that ends on an assistant message is a turn that ran to
        // completion before the process exited without writing task_complete.
        completionId = turnId;
      } else {
        // Trailing window cut off mid-work (tool-call tail or no answer yet): interrupted, dropped.
        continue;
      }
    }
    const userText = pending.userText;
    const userId = pending.userId;
    // A completed window without both a caller user message and assistant output (for example a
    // developer-only or tool-only turn) is not a portable turn and is skipped; the file continues.
    if (userText === null || userText.length === 0 || userId === null || pending.assistantText.length === 0) {
      continue;
    }
    if (completionId === null) {
      throw new OpenPError(`Codex source turn ${turnId} has no completion id`, EXIT_CODES.protocolViolation);
    }
    if (pending.assistantIds.includes(completionId)) {
      throw new OpenPError(
        `Codex source turn ${turnId} reuses its completion id as an assistant message id`,
        EXIT_CODES.protocolViolation,
      );
    }
    turns.push({
      userText,
      assistantText: pending.assistantText.join('\n\n'),
      nativeIds: {
        userId,
        assistantIds: pending.assistantIds,
        completionId,
      },
    });
  }
  return turns;
}

function isCallerMirrorRecord(entry: JsonObject | undefined): boolean {
  if (!entry || entry.type !== 'event_msg') return false;
  const payload = isObject(entry.payload) ? entry.payload : null;
  return payload !== null && payload.type === 'user_message';
}

function ensureTurn(map: Map<string, PendingCodexTurn>, turnId: string): PendingCodexTurn {
  const existing = map.get(turnId);
  if (existing) {
    return existing;
  }
  const created: PendingCodexTurn = {
    started: false,
    completed: false,
    aborted: false,
    userId: null,
    userText: null,
    assistantIds: [],
    assistantText: [],
    completionId: null,
    taskStartedIndex: null,
    lastRecordIndex: null,
    tailIsAssistantMessage: false,
  };
  map.set(turnId, created);
  return created;
}

function requireLifecycleTurnId(payload: JsonObject, type: 'task_started' | 'task_complete' | 'turn_aborted'): string {
  if (typeof payload.turn_id === 'string' && payload.turn_id.length > 0) {
    return payload.turn_id;
  }
  throw new OpenPError(`Codex ${type} event is missing turn_id`, EXIT_CODES.protocolViolation);
}

// thread_rolled_back invalidates prior turns, so the file is not safely recoverable and the
// conversion fails closed. Compaction markers are handled (skipped) by the extraction loop.
function rejectUnsupportedCodexSource(entry: JsonObject): void {
  const payload = isObject(entry.payload) ? entry.payload : null;
  if (!payload) return;
  if (payload.type === 'thread_rolled_back') {
    throw new OpenPError('Codex thread_rolled_back rollouts are not supported for seed source conversion', EXIT_CODES.protocolViolation);
  }
}

function readTurnId(payload: JsonObject): string | null {
  const passthrough = payload.internal_chat_message_metadata_passthrough;
  if (isObject(passthrough) && typeof passthrough.turn_id === 'string' && passthrough.turn_id.length > 0) {
    return passthrough.turn_id;
  }
  return null;
}

function readSingleText(content: unknown, type: 'input_text' | 'output_text'): string | null {
  if (!Array.isArray(content) || content.length !== 1) return null;
  const block = content[0];
  if (!isObject(block) || block.type !== type || typeof block.text !== 'string') return null;
  return block.text;
}

function nativePayloadId(payload: JsonObject, fallback: string): string {
  return typeof payload.id === 'string' && payload.id.length > 0 ? payload.id : fallback;
}

function requireAssistantPayloadId(payload: JsonObject): string {
  if (typeof payload.id === 'string' && payload.id.length > 0) {
    return payload.id;
  }
  throw new OpenPError('Codex assistant message is missing payload.id', EXIT_CODES.protocolViolation);
}

function parseLine(line: string): JsonObject {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new OpenPError('Codex session log contains malformed JSONL', EXIT_CODES.sessionLogParse);
  }
  if (!isObject(value)) {
    throw new OpenPError('Codex session log contains a non-object JSONL record', EXIT_CODES.protocolViolation);
  }
  return value;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { readonly code?: unknown }).code === 'ENOENT';
}
