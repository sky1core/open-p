import { readFile } from 'node:fs/promises';
import type { NativeSessionReadResult, NativeSessionTurn } from '../../core/backend.js';
import { EXIT_CODES, OpenPError } from '../../core/errors.js';
import { findCodexSessionLogPath } from './session-log.js';

interface JsonObject {
  readonly [key: string]: unknown;
}

interface PendingCodexTurn {
  userId: string;
  userText: string;
  assistantIds: string[];
  assistantText: string[];
  completionId: string | null;
}

export async function readCodexNativeSession(input: {
  readonly backend: string;
  readonly sessionId: string;
  readonly homeDir?: string | null;
}): Promise<NativeSessionReadResult> {
  const logPath = await findCodexSessionLogPath(input.sessionId, input.homeDir ?? null);
  if (!logPath) {
    throw new OpenPError(`codex session log not found for ${input.sessionId}`, EXIT_CODES.sessionLogNotFound);
  }
  let text: string;
  try {
    text = await readFile(logPath, 'utf8');
  } catch {
    throw new OpenPError(`codex session log not found for ${input.sessionId}`, EXIT_CODES.sessionLogNotFound);
  }
  return {
    backend: input.backend,
    sessionId: input.sessionId,
    turns: extractCodexNativeTurns(text),
  };
}

export function extractCodexNativeTurns(logText: string): readonly NativeSessionTurn[] {
  const byTurnId = new Map<string, PendingCodexTurn>();
  const startedTurnIds = new Set<string>();
  const completedTurnIds = new Set<string>();
  const order: string[] = [];
  const orderedTurnIds = new Set<string>();
  const rememberTurnId = (turnId: string): void => {
    if (!orderedTurnIds.has(turnId)) {
      orderedTurnIds.add(turnId);
      order.push(turnId);
    }
  };

  for (const line of logText.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const entry = parseLine(line);
    if (!entry) continue;
    rejectUnsupportedCodexSource(entry);
    const payload = isObject(entry.payload) ? entry.payload : null;
    if (!payload) continue;
    if (entry.type === 'event_msg' && payload.type === 'task_started') {
      const turnId = requireLifecycleTurnId(payload, 'task_started');
      if (startedTurnIds.has(turnId)) {
        throw new OpenPError(`Codex source has duplicate task_started for ${turnId}`, EXIT_CODES.protocolViolation);
      }
      rememberTurnId(turnId);
      startedTurnIds.add(turnId);
      continue;
    }
    if (entry.type === 'event_msg' && payload.type === 'task_complete') {
      const turnId = requireLifecycleTurnId(payload, 'task_complete');
      if (completedTurnIds.has(turnId)) {
        throw new OpenPError(`Codex source has duplicate task_complete for ${turnId}`, EXIT_CODES.protocolViolation);
      }
      rememberTurnId(turnId);
      completedTurnIds.add(turnId);
      const pending = byTurnId.get(turnId);
      if (pending) pending.completionId = turnId;
      continue;
    }
    if (entry.type !== 'response_item' || payload.type !== 'message') {
      continue;
    }
    const turnId = readTurnId(payload);
    if (!turnId) continue;
    if (payload.role === 'user') {
      const text = readSingleText(payload.content, 'input_text');
      if (text === null) continue;
      rememberTurnId(turnId);
      const pending = byTurnId.get(turnId);
      if (pending) {
        throw new OpenPError('Codex source has multiple user messages for one turn id', EXIT_CODES.protocolViolation);
      }
      byTurnId.set(turnId, {
        userId: nativePayloadId(payload, `user:${turnId}`),
        userText: text,
        assistantIds: [],
        assistantText: [],
        completionId: null,
      });
      continue;
    }
    if (payload.role === 'assistant') {
      const text = readSingleText(payload.content, 'output_text');
      if (text === null || text.length === 0) continue;
      let pending = byTurnId.get(turnId);
      if (!pending) {
        rememberTurnId(turnId);
        pending = {
          userId: `missing-user:${turnId}`,
          userText: '',
          assistantIds: [],
          assistantText: [],
          completionId: null,
        };
        byTurnId.set(turnId, pending);
      }
      pending.assistantIds.push(nativePayloadId(payload, `assistant:${turnId}:${pending.assistantIds.length}`));
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
      pending.userText.length > 0 && pending.assistantText.length > 0 && pending.completionId !== null;
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
    if (pending.completionId === null) {
      throw new OpenPError(`Codex source turn ${turnId} has no completion id`, EXIT_CODES.protocolViolation);
    }
    turns.push({
      userText: pending.userText,
      assistantText: pending.assistantText.join('\n\n'),
      nativeIds: {
        userId: pending.userId,
        assistantIds: pending.assistantIds,
        completionId: pending.completionId,
      },
    });
  }
  return turns;
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
