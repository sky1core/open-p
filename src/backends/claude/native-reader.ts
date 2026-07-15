import { readFile } from 'node:fs/promises';
import type { NativeSessionReadResult, NativeSessionTurn } from '../../core/backend.js';
import { EXIT_CODES, OpenPError } from '../../core/errors.js';
import { findClaudeCodeSessionLog } from './session-log.js';
import {
  isCallerUserTurn,
  rememberLocalCommandTranscriptPromptId,
} from './turn-boundary-predicates.js';

interface JsonObject {
  readonly [key: string]: unknown;
}

export async function readClaudeCodeNativeSession(input: {
  readonly backend: string;
  readonly sessionId: string;
  readonly cwd: string;
  readonly configDir?: string | null;
}): Promise<NativeSessionReadResult> {
  const logPath = await findClaudeCodeSessionLog(input.sessionId, input.cwd, input.configDir ?? null);
  if (!logPath) {
    throw new OpenPError(`claude session log not found for ${input.sessionId}`, EXIT_CODES.sessionLogNotFound);
  }
  let text: string;
  try {
    text = await readFile(logPath, 'utf8');
  } catch {
    throw new OpenPError(`claude session log not found for ${input.sessionId}`, EXIT_CODES.sessionLogNotFound);
  }
  return {
    backend: input.backend,
    sessionId: input.sessionId,
    turns: extractClaudeNativeTurns(text),
  };
}

export function extractClaudeNativeTurns(logText: string): readonly NativeSessionTurn[] {
  const entries = parseEntries(logText);
  const activeEntries = activeParentLineage(entries);
  const turns: NativeSessionTurn[] = [];
  let pendingUser: { id: string; text: string } | null = null;
  let assistantIds: string[] = [];
  let assistantText: string[] = [];
  let pendingInterrupted = false;
  const localCommandTranscriptPromptIds = new Set<string>();

  const discard = (): void => {
    pendingUser = null;
    assistantIds = [];
    assistantText = [];
    pendingInterrupted = false;
  };

  const flush = (completionId: string): void => {
    if (pendingInterrupted || !pendingUser || assistantIds.length === 0 || assistantText.length === 0) {
      discard();
      return;
    }
    turns.push({
      userText: pendingUser.text,
      assistantText: assistantText.join('\n\n'),
      nativeIds: {
        userId: pendingUser.id,
        assistantIds,
        completionId,
      },
    });
    discard();
  };

  for (const entry of activeEntries) {
    rememberLocalCommandTranscriptPromptId(localCommandTranscriptPromptIds, entry);
    if (isCallerUser(entry, localCommandTranscriptPromptIds)) {
      if (pendingUser && !pendingInterrupted) {
        throw new OpenPError(
          'Claude source contains a non-trailing turn without a completion boundary',
          EXIT_CODES.protocolViolation,
        );
      }
      discard();
      pendingUser = { id: nativeEntryId(entry), text: (entry.message as JsonObject).content as string };
      continue;
    }
    if (entry.type === 'assistant' && entry.isSidechain !== true && pendingUser) {
      if (isClaudeCodeApiErrorAssistant(entry)) {
        pendingInterrupted = true;
        continue;
      }
      const text = assistantTextFromEntry(entry);
      if (text.length > 0) {
        assistantIds.push(nativeAssistantId(entry));
        assistantText.push(text);
      }
      continue;
    }
    if (entry.type === 'system' && entry.subtype === 'turn_duration') {
      flush(nativeEntryId(entry));
    }
  }
  return turns;
}

function isClaudeCodeApiErrorAssistant(entry: JsonObject): boolean {
  return entry.type === 'assistant' && (
    entry.isApiErrorMessage === true ||
    typeof entry.apiErrorStatus === 'number' ||
    typeof entry.error === 'string' && entry.error.trim().length > 0
  );
}

function parseEntries(logText: string): readonly JsonObject[] {
  const entries: JsonObject[] = [];
  for (const line of logText.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const entry = parseLine(line);
    if (!entry) continue;
    rejectUnsupportedClaudeSource(entry);
    entries.push(entry);
  }
  return entries;
}

function activeParentLineage(entries: readonly JsonObject[]): readonly JsonObject[] {
  const byUuid = new Map<string, JsonObject>();
  let lastUuid: string | null = null;
  for (const entry of entries) {
    if (typeof entry.uuid === 'string' && entry.uuid.length > 0) {
      byUuid.set(entry.uuid, entry);
      if (entry.isSidechain !== true) {
        lastUuid = entry.uuid;
      }
    }
  }
  if (!lastUuid) {
    return [];
  }
  const active = new Set<string>();
  let cursor: string | null = lastUuid;
  while (cursor) {
    const entry = byUuid.get(cursor);
    if (!entry) {
      break;
    }
    active.add(cursor);
    cursor = typeof entry.parentUuid === 'string' && entry.parentUuid.length > 0 ? entry.parentUuid : null;
  }
  return entries.filter((entry) => typeof entry.uuid === 'string' && active.has(entry.uuid));
}

function rejectUnsupportedClaudeSource(entry: JsonObject): void {
  if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
    throw new OpenPError('Claude compacted sessions are not supported for seed source conversion', EXIT_CODES.protocolViolation);
  }
  if (entry.isCompactSummary === true) {
    throw new OpenPError('Claude compaction summaries are not portable seed turns', EXIT_CODES.protocolViolation);
  }
}

function isCallerUser(entry: JsonObject, localCommandTranscriptPromptIds: ReadonlySet<string>): boolean {
  if (entry.type !== 'user' || entry.isSidechain === true || entry.isMeta === true || entry.isCompactSummary === true) {
    return false;
  }
  const message = entry.message;
  return isObject(message) && typeof message.content === 'string' &&
    isCallerUserTurn(entry, localCommandTranscriptPromptIds);
}

function assistantTextFromEntry(entry: JsonObject): string {
  const message = entry.message;
  if (!isObject(message) || !Array.isArray(message.content)) {
    return '';
  }
  return message.content
    .filter((block): block is JsonObject => isObject(block) && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .filter((text) => text.length > 0)
    .join('');
}

function nativeAssistantId(entry: JsonObject): string {
  const message = entry.message;
  if (isObject(message) && typeof message.id === 'string' && message.id.length > 0) {
    return message.id;
  }
  return nativeEntryId(entry);
}

function nativeEntryId(entry: JsonObject): string {
  if (typeof entry.uuid === 'string' && entry.uuid.length > 0) return entry.uuid;
  if (typeof entry.requestId === 'string' && entry.requestId.length > 0) return entry.requestId;
  throw new OpenPError('Claude native turn is missing structural id', EXIT_CODES.protocolViolation);
}

function parseLine(line: string): JsonObject {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new OpenPError('Claude session log contains malformed JSONL', EXIT_CODES.sessionLogParse);
  }
  if (!isObject(value)) {
    throw new OpenPError('Claude session log contains a non-object JSONL record', EXIT_CODES.protocolViolation);
  }
  return value;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
