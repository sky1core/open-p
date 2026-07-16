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
  userId: string | null;
  userText: string | null;
  assistantIds: string[];
  assistantText: string[];
  completionId: string | null;
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

export function assertCodexNativeSessionIdentity(logText: string, expectedSessionId: string): void {
  let sessionMetaCount = 0;
  for (const line of logText.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const entry = parseLine(line);
    if (entry.type !== 'session_meta') continue;
    sessionMetaCount += 1;
    const payload = isObject(entry.payload) ? entry.payload : null;
    if (!payload) {
      throw new OpenPError('Codex session metadata has no native session identity', EXIT_CODES.protocolViolation);
    }
    const identities: string[] = [];
    for (const key of ['id', 'session_id'] as const) {
      if (!Object.prototype.hasOwnProperty.call(payload, key)) continue;
      const value = payload[key];
      if (typeof value !== 'string' || value.length === 0) {
        throw new OpenPError('Codex session metadata has an invalid native session identity', EXIT_CODES.protocolViolation);
      }
      identities.push(value);
    }
    if (identities.length === 0 || identities.some((identity) => identity !== expectedSessionId)) {
      throw new OpenPError('Codex session log belongs to a different native session', EXIT_CODES.protocolViolation);
    }
  }
  if (sessionMetaCount !== 1) {
    throw new OpenPError('Codex session log must contain exactly one session metadata record', EXIT_CODES.protocolViolation);
  }
}

export function extractCodexNativeTurns(logText: string): readonly NativeSessionTurn[] {
  const byTurnId = new Map<string, PendingCodexTurn>();
  const startedTurnIds = new Set<string>();
  const completedTurnIds = new Set<string>();
  const order: string[] = [];
  const orderedTurnIds = new Set<string>();
  let activeTurnId: string | null = null;
  const rememberTurnId = (turnId: string): void => {
    if (!orderedTurnIds.has(turnId)) {
      orderedTurnIds.add(turnId);
      order.push(turnId);
    }
  };

  const entries: JsonObject[] = [];
  for (const line of logText.split(/\r?\n/)) {
    if (!line.trim()) continue;
    entries.push(parseLine(line));
  }

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    rejectUnsupportedCodexSource(entry);
    const payload = isObject(entry.payload) ? entry.payload : null;
    if (!payload) continue;
    if (entry.type === 'event_msg' && payload.type === 'task_started') {
      const turnId = requireLifecycleTurnId(payload, 'task_started');
      const pending = ensureTurn(byTurnId, turnId);
      if (pending.completed) {
        throw new OpenPError(`Codex source has events after task_complete for ${turnId}`, EXIT_CODES.protocolViolation);
      }
      if (pending.started) {
        throw new OpenPError(`Codex source has duplicate task_started for ${turnId}`, EXIT_CODES.protocolViolation);
      }
      if (activeTurnId !== null) {
        throw new OpenPError(
          `Codex source overlaps task lifecycle ${activeTurnId} with ${turnId}`,
          EXIT_CODES.protocolViolation,
        );
      }
      if (pending.userText !== null || pending.assistantText.length > 0) {
        throw new OpenPError(`Codex source turn ${turnId} has portable messages before task_started`, EXIT_CODES.protocolViolation);
      }
      rememberTurnId(turnId);
      startedTurnIds.add(turnId);
      pending.started = true;
      activeTurnId = turnId;
      continue;
    }
    if (entry.type === 'event_msg' && payload.type === 'task_complete') {
      const turnId = requireLifecycleTurnId(payload, 'task_complete');
      const pending = ensureTurn(byTurnId, turnId);
      if (pending.completed) {
        throw new OpenPError(`Codex source has duplicate task_complete for ${turnId}`, EXIT_CODES.protocolViolation);
      }
      if (!pending.started) {
        throw new OpenPError(`Codex source turn ${turnId} completed before task_started`, EXIT_CODES.protocolViolation);
      }
      if (activeTurnId !== turnId) {
        throw new OpenPError(`Codex source task_complete does not own the active lifecycle`, EXIT_CODES.protocolViolation);
      }
      if (pending.userText === null || pending.assistantText.length === 0) {
        throw new OpenPError(`Codex source turn ${turnId} completed before portable user/assistant messages`, EXIT_CODES.protocolViolation);
      }
      rememberTurnId(turnId);
      completedTurnIds.add(turnId);
      pending.completed = true;
      pending.completionId = turnId;
      activeTurnId = null;
      continue;
    }
    if (entry.type !== 'response_item' || payload.type !== 'message') {
      continue;
    }
    if (payload.role === 'user') {
      const text = readSingleText(payload.content, 'input_text');
      if (text === null) continue;
      let turnId = readTurnId(payload);
      if (!turnId) {
        if (!isCallerMirrorRecord(entries[index + 1])) continue;
        if (activeTurnId === null) {
          throw new OpenPError(
            'Codex source has a window-bound caller message outside a task lifecycle window',
            EXIT_CODES.protocolViolation,
          );
        }
        turnId = activeTurnId;
      }
      rejectOverlappingPortableMessage(activeTurnId, turnId);
      rememberTurnId(turnId);
      const pending = ensureTurn(byTurnId, turnId);
      if (pending.completed) {
        throw new OpenPError(`Codex source has events after task_complete for ${turnId}`, EXIT_CODES.protocolViolation);
      }
      if (pending.userText !== null) {
        throw new OpenPError('Codex source has multiple user messages for one turn id', EXIT_CODES.protocolViolation);
      }
      pending.userId = nativePayloadId(payload, `user:${turnId}`);
      pending.userText = text;
      continue;
    }
    if (payload.role === 'assistant') {
      const text = readSingleText(payload.content, 'output_text');
      if (text === null || text.length === 0) continue;
      const passthroughTurnId = readTurnId(payload);
      const turnId = passthroughTurnId ?? activeTurnId;
      if (turnId === null) {
        throw new OpenPError(
          'Codex source has a window-bound assistant message outside a task lifecycle window',
          EXIT_CODES.protocolViolation,
        );
      }
      rejectOverlappingPortableMessage(activeTurnId, turnId);
      const pending = ensureTurn(byTurnId, turnId);
      if (pending.completed) {
        throw new OpenPError(`Codex source has events after task_complete for ${turnId}`, EXIT_CODES.protocolViolation);
      }
      if (pending.userText === null) {
        throw new OpenPError(`Codex source turn ${turnId} has assistant before portable user message`, EXIT_CODES.protocolViolation);
      }
      rememberTurnId(turnId);
      pending.assistantIds.push(passthroughTurnId !== null
        ? requireAssistantPayloadId(payload)
        : nativePayloadId(payload, `assistant:${turnId}:${pending.assistantIds.length + 1}`));
      pending.assistantText.push(text);
    }
  }

  const turns: NativeSessionTurn[] = [];
  for (const [index, turnId] of order.entries()) {
    const pending = byTurnId.get(turnId);
    if (!pending) {
      const trailingWithoutCompletion = index === order.length - 1 && !completedTurnIds.has(turnId);
      if (trailingWithoutCompletion) {
        continue;
      }
      throw new OpenPError(
        `Codex source turn ${turnId} has lifecycle evidence without portable message structure`,
        EXIT_CODES.protocolViolation,
      );
    }
    const complete = startedTurnIds.has(turnId) && completedTurnIds.has(turnId) &&
      pending.userText !== null && pending.userText.length > 0 &&
      pending.userId !== null && pending.assistantText.length > 0 && pending.completionId !== null;
    if (!complete) {
      const trailingWithoutCompletion = index === order.length - 1 && !completedTurnIds.has(turnId);
      if (!trailingWithoutCompletion) {
        throw new OpenPError(
          `Codex source turn ${turnId} has malformed or non-trailing incomplete lifecycle state`,
          EXIT_CODES.protocolViolation,
        );
      }
      continue;
    }
    const userText = pending.userText;
    const userId = pending.userId;
    const completionId = pending.completionId;
    if (userText === null || userId === null || completionId === null) {
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

function rejectOverlappingPortableMessage(activeTurnId: string | null, turnId: string): void {
  if (activeTurnId !== null && activeTurnId !== turnId) {
    throw new OpenPError(
      `Codex source message for ${turnId} overlaps active lifecycle ${activeTurnId}`,
      EXIT_CODES.protocolViolation,
    );
  }
}

function ensureTurn(map: Map<string, PendingCodexTurn>, turnId: string): PendingCodexTurn {
  const existing = map.get(turnId);
  if (existing) {
    return existing;
  }
  const created: PendingCodexTurn = {
    started: false,
    completed: false,
    userId: null,
    userText: null,
    assistantIds: [],
    assistantText: [],
    completionId: null,
  };
  map.set(turnId, created);
  return created;
}

function requireLifecycleTurnId(payload: JsonObject, type: 'task_started' | 'task_complete'): string {
  if (typeof payload.turn_id === 'string' && payload.turn_id.length > 0) {
    return payload.turn_id;
  }
  throw new OpenPError(`Codex ${type} event is missing turn_id`, EXIT_CODES.protocolViolation);
}

function rejectUnsupportedCodexSource(entry: JsonObject): void {
  if (entry.type === 'compacted') {
    throw new OpenPError('Codex compacted rollouts are not supported for seed source conversion', EXIT_CODES.protocolViolation);
  }
  const payload = isObject(entry.payload) ? entry.payload : null;
  if (!payload) return;
  if (payload.type === 'context_compacted' || payload.type === 'turn_aborted' || payload.type === 'thread_rolled_back') {
    throw new OpenPError(`Codex ${String(payload.type)} rollouts are not supported for seed source conversion`, EXIT_CODES.protocolViolation);
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
