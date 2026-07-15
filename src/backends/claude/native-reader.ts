import { readFile, realpath } from 'node:fs/promises';
import type { NativeSessionReadResult, NativeSessionTurn } from '../../core/backend.js';
import { EXIT_CODES, OpenPError } from '../../core/errors.js';
import {
  confirmStableNativeFileSnapshots,
  NativeFileSnapshotChangedError,
} from '../../core/fs-durability.js';
import { decodeNativeStateUtf8, digestNativeState } from '../../core/native-state-digest.js';
import { findClaudeCodeSessionLog } from './session-log.js';
import {
  isCallerUserTurn,
  rememberLocalCommandTranscriptPromptId,
} from './turn-boundary-predicates.js';
import { isClaudeCodeApiErrorAssistant } from './provider-error.js';

interface JsonObject {
  readonly [key: string]: unknown;
}

export async function readClaudeCodeNativeSession(input: {
  readonly backend: string;
  readonly sessionId: string;
  readonly cwd: string;
  readonly configDir?: string | null;
  readonly mode?: 'logical' | 'settlement';
}): Promise<NativeSessionReadResult> {
  const logPath = await findClaudeCodeSessionLog(input.sessionId, input.cwd, input.configDir ?? null);
  if (!logPath) {
    throw new OpenPError(`claude session log not found for ${input.sessionId}`, EXIT_CODES.sessionLogNotFound);
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(logPath);
  } catch (error) {
    if (isNotFoundError(error)) {
      throw new OpenPError(`claude session log not found for ${input.sessionId}`, EXIT_CODES.sessionLogNotFound);
    }
    throw new OpenPError('Claude native session log could not be read after discovery', EXIT_CODES.protocolViolation);
  }
  if (input.mode === 'settlement') {
    bytes = await confirmStableClaudeNativeFile(logPath, bytes);
  }
  const text = decodeNativeStateUtf8(bytes, 'Claude native session log');
  await assertClaudeNativeSessionIdentity(text, input.sessionId, input.cwd);
  return {
    backend: input.backend,
    sessionId: input.sessionId,
    turns: extractClaudeNativeTurns(text),
    nativeStateDigest: claudeNativeStateDigest(bytes),
  };
}

export function claudeNativeStateDigest(logBytes: Uint8Array): string {
  return digestNativeState('claude-code-jsonl-v1', [logBytes]);
}

async function confirmStableClaudeNativeFile(path: string, before: Buffer): Promise<Buffer> {
  try {
    const [after] = await confirmStableNativeFileSnapshots([{ path, bytes: before }]);
    return after!;
  } catch (error) {
    if (error instanceof NativeFileSnapshotChangedError) {
      throw new OpenPError('Claude native session changed during durability confirmation', EXIT_CODES.protocolViolation);
    }
    throw new OpenPError('Claude native session durability could not be confirmed', EXIT_CODES.protocolViolation);
  }
}

export async function assertClaudeNativeSessionIdentity(
  logText: string,
  expectedSessionId: string,
  expectedCwd: string,
): Promise<void> {
  const entries = parseEntries(logText);
  const validCwds = new Set<string>([expectedCwd]);
  try {
    validCwds.add(await realpath(expectedCwd));
  } catch {
    // A removed workspace can still be identified by the caller-provided path stored in the log.
  }
  let sawSessionIdentity = false;
  let sawCallerCwd = false;
  for (const entry of entries) {
    for (const key of ['sessionId', 'session_id'] as const) {
      if (!Object.prototype.hasOwnProperty.call(entry, key)) continue;
      const value = entry[key];
      if (typeof value !== 'string' || value.length === 0 || value !== expectedSessionId) {
        throw new OpenPError('Claude session log belongs to a different native session', EXIT_CODES.protocolViolation);
      }
      sawSessionIdentity = true;
    }
    if (Object.prototype.hasOwnProperty.call(entry, 'cwd')) {
      if (typeof entry.cwd !== 'string' || entry.cwd.length === 0 || !validCwds.has(entry.cwd)) {
        throw new OpenPError('Claude session log belongs to a different workspace', EXIT_CODES.protocolViolation);
      }
      sawCallerCwd = true;
    }
  }
  if (!sawSessionIdentity || !sawCallerCwd) {
    throw new OpenPError('Claude session log is missing its native session identity', EXIT_CODES.protocolViolation);
  }
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
    if (assistantIds.includes(completionId)) {
      throw new OpenPError(
        'Claude completion uuid overlaps an assistant message id',
        EXIT_CODES.protocolViolation,
      );
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
    if (entry.type === 'assistant' && isPortableTurnScope(entry) && pendingUser) {
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
    if (entry.type === 'system' && entry.subtype === 'turn_duration' && isPortableTurnScope(entry)) {
      flush(nativeEntryId(entry));
    }
  }
  return turns;
}

function parseEntries(logText: string): readonly JsonObject[] {
  const entries: JsonObject[] = [];
  for (const line of logText.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const entry = parseLine(line);
    if (!entry) continue;
    rejectUnsupportedClaudeSource(entry);
    rejectMissingClaudeStructuralId(entry);
    entries.push(entry);
  }
  return entries;
}

function rejectMissingClaudeStructuralId(entry: JsonObject): void {
  const portableBoundaryShape = isPortableTurnScope(entry) &&
    (entry.type === 'user' || entry.type === 'assistant' ||
      (entry.type === 'system' && entry.subtype === 'turn_duration'));
  if (portableBoundaryShape && (typeof entry.uuid !== 'string' || entry.uuid.length === 0)) {
    throw new OpenPError('Claude native turn record is missing uuid', EXIT_CODES.protocolViolation);
  }
}

function isPortableTurnScope(entry: JsonObject): boolean {
  return entry.isSidechain !== true && entry.isMeta !== true && entry.isCompactSummary !== true;
}

function activeParentLineage(entries: readonly JsonObject[]): readonly JsonObject[] {
  const byUuid = new Map<string, JsonObject>();
  const indexByUuid = new Map<string, number>();
  let firstUuid: string | null = null;
  let lastUuid: string | null = null;
  for (const [index, entry] of entries.entries()) {
    if (typeof entry.uuid === 'string' && entry.uuid.length > 0) {
      if (byUuid.has(entry.uuid)) {
        throw new OpenPError('Claude session log contains duplicate uuid entries', EXIT_CODES.protocolViolation);
      }
      byUuid.set(entry.uuid, entry);
      indexByUuid.set(entry.uuid, index);
      firstUuid ??= entry.uuid;
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
    if (active.has(cursor)) {
      throw new OpenPError('Claude session log parentUuid chain contains a cycle', EXIT_CODES.protocolViolation);
    }
    const entry = byUuid.get(cursor);
    if (!entry) {
      throw new OpenPError('Claude active session lineage references missing parentUuid', EXIT_CODES.protocolViolation);
    }
    active.add(cursor);
    const parentUuid = parentUuidOf(entry);
    if (parentUuid === null && cursor !== firstUuid) {
      throw new OpenPError('Claude active session lineage terminates at an unexpected root', EXIT_CODES.protocolViolation);
    }
    if (parentUuid) {
      const parentIndex = indexByUuid.get(parentUuid);
      const childIndex = indexByUuid.get(cursor)!;
      if (parentIndex !== undefined && parentIndex >= childIndex) {
        throw new OpenPError('Claude active session lineage is not in append order', EXIT_CODES.protocolViolation);
      }
    }
    cursor = parentUuid;
  }
  return entries.filter((entry) => typeof entry.uuid === 'string' && active.has(entry.uuid));
}

function parentUuidOf(entry: JsonObject): string | null {
  if (!Object.prototype.hasOwnProperty.call(entry, 'parentUuid') || entry.parentUuid === null) {
    return null;
  }
  if (typeof entry.parentUuid === 'string' && entry.parentUuid.length > 0) {
    return entry.parentUuid;
  }
  throw new OpenPError('Claude active session lineage has an invalid parentUuid', EXIT_CODES.protocolViolation);
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

function isNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { readonly code?: unknown }).code === 'ENOENT';
}
