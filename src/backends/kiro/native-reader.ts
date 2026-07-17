import { readFile } from 'node:fs/promises';
import type { NativeSessionReadResult, NativeSessionTurn } from '../../core/backend.js';
import { EXIT_CODES, OpenPError } from '../../core/errors.js';
import {
  confirmStableNativeFileSnapshots,
  NativeFileSnapshotChangedError,
} from '../../core/fs-durability.js';
import { decodeNativeStateUtf8, digestNativeState } from '../../core/native-state-digest.js';
import { resolveKiroSessionLogPath } from './session-log.js';

interface JsonObject {
  readonly [key: string]: unknown;
}

interface IndexedKiroRecord {
  readonly record: JsonObject;
  readonly index: number;
}

export async function readKiroNativeSession(input: {
  readonly backend: string;
  readonly sessionId: string;
  readonly mode?: 'logical' | 'settlement';
}): Promise<NativeSessionReadResult> {
  const logPath = resolveKiroSessionLogPath(input.sessionId);
  if (!logPath) {
    throw new OpenPError(`kiro session log not found for ${input.sessionId}`, EXIT_CODES.sessionLogNotFound);
  }
  let logBytes: Buffer;
  let companionBytes: Buffer;
  try {
    logBytes = await readFile(logPath);
  } catch (error) {
    if (isNotFoundError(error)) {
      throw new OpenPError(`kiro session log not found for ${input.sessionId}`, EXIT_CODES.sessionLogNotFound);
    }
    throw new OpenPError('Kiro native session log could not be read after discovery', EXIT_CODES.protocolViolation);
  }
  const companionPath = logPath.replace(/\.jsonl$/, '.json');
  try {
    companionBytes = await readFile(companionPath);
  } catch {
    throw new OpenPError(`kiro companion metadata not found for ${input.sessionId}`, EXIT_CODES.protocolViolation);
  }
  if (input.mode === 'settlement') {
    ({ logBytes, companionBytes } = await confirmStableKiroNativeFiles({
      logPath,
      companionPath,
      logBytes,
      companionBytes,
    }));
  }
  const logText = decodeNativeStateUtf8(logBytes, 'Kiro native session log');
  const companionText = decodeNativeStateUtf8(companionBytes, 'Kiro companion metadata');
  return {
    backend: input.backend,
    sessionId: input.sessionId,
    turns: extractKiroNativeTurns(logText, companionText, input.sessionId),
    nativeStateDigest: kiroNativeStateDigest(logBytes, companionBytes),
  };
}

export function kiroNativeStateDigest(logBytes: Uint8Array, companionBytes: Uint8Array): string {
  return digestNativeState('kiro-jsonl-companion-v1', [logBytes, companionBytes]);
}

async function confirmStableKiroNativeFiles(input: {
  readonly logPath: string;
  readonly companionPath: string;
  readonly logBytes: Buffer;
  readonly companionBytes: Buffer;
}): Promise<{ readonly logBytes: Buffer; readonly companionBytes: Buffer }> {
  try {
    const [logBytes, companionBytes] = await confirmStableNativeFileSnapshots([
      { path: input.logPath, bytes: input.logBytes },
      { path: input.companionPath, bytes: input.companionBytes },
    ]);
    return { logBytes: logBytes!, companionBytes: companionBytes! };
  } catch (error) {
    if (error instanceof NativeFileSnapshotChangedError) {
      throw new OpenPError('Kiro native session changed during durability confirmation', EXIT_CODES.protocolViolation);
    }
    throw new OpenPError('Kiro native session durability could not be confirmed', EXIT_CODES.protocolViolation);
  }
}

export function extractKiroNativeTurns(
  logText: string,
  companionText: string,
  expectedSessionId?: string,
): readonly NativeSessionTurn[] {
  const records = readKiroRecordMap(logText);

  let companion: unknown;
  try {
    companion = JSON.parse(companionText);
  } catch {
    throw new OpenPError('Kiro companion metadata is not valid JSON', EXIT_CODES.protocolViolation);
  }
  if (expectedSessionId !== undefined) {
    assertKiroCompanionSessionIdentityValue(companion, expectedSessionId);
  }
  const turnMetadatas = readTurnMetadatas(companion);
  const turns: NativeSessionTurn[] = [];
  const referencedIds = new Set<string>();
  const completedMessageIds = new Set<string>();
  const completedBoundaryIds = new Set<string>();
  let previousCompletedRecordIndex = -1;
  for (const metadata of turnMetadatas) {
    if (!isObject(metadata)) {
      throw new OpenPError('Kiro companion contains non-object turn metadata', EXIT_CODES.protocolViolation);
    }
    const completed = isCompletedMetadata(metadata);
    const messageIds = readMessageIds(metadata, completed);
    const indexedRecords = messageIds.map((id) => {
      const indexed = records.get(id);
      if (!indexed) {
        throw new OpenPError('Kiro companion metadata references a missing message id', EXIT_CODES.protocolViolation);
      }
      return indexed;
    });
    for (const id of messageIds) {
      referencedIds.add(id);
    }
    if (completed && messageIds.length === 0) {
      throw new OpenPError('Kiro completed turn has an empty message_ids array', EXIT_CODES.protocolViolation);
    }
    if (!completed) {
      continue;
    }
    const completedId = completionId(metadata);
    if (new Set(messageIds).size !== messageIds.length) {
      throw new OpenPError('Kiro completed turn contains duplicate message ids', EXIT_CODES.protocolViolation);
    }
    rejectCompletedMetadataIdReuse(messageIds, completedId, completedMessageIds, completedBoundaryIds);
    for (const id of messageIds) {
      completedMessageIds.add(id);
    }
    completedBoundaryIds.add(completedId);
    for (let index = 1; index < indexedRecords.length; index += 1) {
      if (indexedRecords[index]!.index <= indexedRecords[index - 1]!.index) {
        throw new OpenPError('Kiro completed turn message ids are out of native record order', EXIT_CODES.protocolViolation);
      }
    }
    if (indexedRecords[0]!.index <= previousCompletedRecordIndex) {
      throw new OpenPError('Kiro completed turns are out of native record order', EXIT_CODES.protocolViolation);
    }
    previousCompletedRecordIndex = indexedRecords.at(-1)!.index;
    let prompt: JsonObject | null = null;
    const assistantMessages: JsonObject[] = [];
    for (const { record } of indexedRecords) {
      const promptClassification = classifyPrompt(record);
      if (promptClassification === 'caller') {
        if (prompt) {
          throw new OpenPError('Kiro source turn has multiple caller prompts', EXIT_CODES.protocolViolation);
        }
        prompt = record;
      } else if (promptClassification === 'unsupported') {
        throw new OpenPError('Kiro completed turn contains an unsupported prompt shape', EXIT_CODES.protocolViolation);
      } else if (record.kind === 'AssistantMessage') {
        assistantMessages.push(record);
      }
    }
    const textAssistantMessages = assistantMessages.filter((record) => textFromKiroRecord(record).length > 0);
    if (!prompt && textAssistantMessages.length === 0) {
      // Permission/tool-only completed metadata has no portable caller/final-answer evidence.
      continue;
    }
    if (!prompt || textAssistantMessages.length === 0) {
      throw new OpenPError('Kiro completed turn has incomplete portable prompt/assistant structure', EXIT_CODES.protocolViolation);
    }
    const userText = textFromKiroRecord(prompt);
    const assistantText = textAssistantMessages.map(textFromKiroRecord).join('\n\n');
    if (!userText || !assistantText) {
      throw new OpenPError('Kiro completed turn has empty portable text', EXIT_CODES.protocolViolation);
    }
    const assistantIds = textAssistantMessages.map((record) => messageId(record));
    turns.push({
      userText,
      assistantText,
      nativeIds: {
        userId: messageId(prompt),
        assistantIds,
        completionId: completedId,
      },
    });
  }
  // Trailing boundary: the highest native record index proven by companion metadata. Records after
  // it belong to an in-progress/unproven trailing turn and are allowed; unproven text records at or
  // before it are mid-history holes and stay fail-closed. With zero proven records the boundary is
  // -1, so the whole log is trailing and the reader returns an empty turn list.
  let provenBoundaryIndex = -1;
  for (const id of referencedIds) {
    const index = records.get(id)!.index;
    if (index > provenBoundaryIndex) {
      provenBoundaryIndex = index;
    }
  }
  for (const [id, { record, index }] of records) {
    if (referencedIds.has(id) || index > provenBoundaryIndex) {
      continue;
    }
    const promptClassification = classifyPrompt(record);
    if (promptClassification === 'caller' || promptClassification === 'unsupported' ||
      (record.kind === 'AssistantMessage' && textFromKiroRecord(record).length > 0)) {
      throw new OpenPError('Kiro JSONL contains text messages not proven by companion metadata', EXIT_CODES.protocolViolation);
    }
  }
  return turns;
}

function readKiroRecordMap(logText: string): Map<string, IndexedKiroRecord> {
  const records = new Map<string, IndexedKiroRecord>();
  let recordIndex = 0;
  for (const line of logText.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const entry = parseLine(line);
    if (entry.version !== 'v1') {
      throw new OpenPError('Kiro session log version is not supported for seed conversion', EXIT_CODES.protocolViolation);
    }
    if (entry.kind === 'Compaction') {
      // Compaction is session-history metadata carrying no message_id. It is skipped before any
      // data inspection so its payload (messages_snapshot/strategy/summary) is never read or
      // indexed — compaction summaries cannot leak into extracted turn text.
      recordIndex += 1;
      continue;
    }
    const data = isObject(entry.data) ? entry.data : null;
    if ((entry.kind === 'Prompt' || entry.kind === 'AssistantMessage') &&
      (typeof data?.message_id !== 'string' || data.message_id.length === 0)) {
      throw new OpenPError('Kiro native message record is missing message_id', EXIT_CODES.protocolViolation);
    }
    if (data && typeof data.message_id === 'string') {
      if (records.has(data.message_id)) {
        throw new OpenPError('Kiro session log contains a duplicate message id', EXIT_CODES.protocolViolation);
      }
      records.set(data.message_id, { record: entry, index: recordIndex });
    }
    recordIndex += 1;
  }
  return records;
}

export function assertKiroNativeSessionAppendable(
  logText: string,
  companionText: string,
  expectedSessionId: string,
): void {
  // Validate the complete paired artifact before applying the stricter target-terminal predicate.
  extractKiroNativeTurns(logText, companionText, expectedSessionId);
  let companion: unknown;
  try {
    companion = JSON.parse(companionText);
  } catch {
    throw new OpenPError('Kiro companion metadata is not valid JSON', EXIT_CODES.protocolViolation);
  }
  assertKiroCompanionSessionIdentityValue(companion, expectedSessionId);
  const metadatas = readTurnMetadatas(companion);
  let lastCompletedIndex = -1;
  for (let index = 0; index < metadatas.length; index += 1) {
    if (isCompletedMetadata(metadatas[index])) lastCompletedIndex = index;
  }
  if (lastCompletedIndex !== metadatas.length - 1) {
    throw new OpenPError('Kiro target has trailing incomplete metadata', EXIT_CODES.protocolViolation);
  }
}

function assertKiroCompanionSessionIdentityValue(companion: unknown, expectedSessionId: string): void {
  const object = isObject(companion) ? companion : null;
  if (!object) {
    throw new OpenPError('Kiro companion metadata has no native session identity', EXIT_CODES.protocolViolation);
  }
  const identities: string[] = [];
  collectKiroSessionIdentity(object, 'session_id', identities);
  const state = isObject(object.session_state) ? object.session_state : null;
  if (state && Object.prototype.hasOwnProperty.call(state, 'rts_model_state')) {
    if (!isObject(state.rts_model_state)) {
      throw new OpenPError('Kiro companion metadata has an invalid native session identity', EXIT_CODES.protocolViolation);
    }
    collectKiroSessionIdentity(state.rts_model_state, 'conversation_id', identities);
  }
  if (identities.length === 0 || identities.some((identity) => identity !== expectedSessionId)) {
    throw new OpenPError('Kiro companion metadata belongs to a different native session', EXIT_CODES.protocolViolation);
  }
}

function collectKiroSessionIdentity(object: JsonObject, key: string, identities: string[]): void {
  if (!Object.prototype.hasOwnProperty.call(object, key)) {
    return;
  }
  const value = object[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new OpenPError('Kiro companion metadata has an invalid native session identity', EXIT_CODES.protocolViolation);
  }
  identities.push(value);
}

function rejectCompletedMetadataIdReuse(
  messageIds: readonly string[],
  completionId: string,
  completedMessageIds: ReadonlySet<string>,
  completedBoundaryIds: ReadonlySet<string>,
): void {
  if (completedBoundaryIds.has(completionId) || completedMessageIds.has(completionId)) {
    throw new OpenPError('Kiro completed turn reuses a completion boundary id', EXIT_CODES.protocolViolation);
  }
  if (messageIds.some((id) => completedMessageIds.has(id) || completedBoundaryIds.has(id))) {
    throw new OpenPError('Kiro completed turn reuses a native id from another completed turn', EXIT_CODES.protocolViolation);
  }
}

function readTurnMetadatas(companion: unknown): readonly unknown[] {
  const object = isObject(companion) ? companion : null;
  const state = isObject(object?.session_state) ? object.session_state : null;
  if (state?.version !== 'v1') {
    throw new OpenPError('Kiro companion metadata version is not supported for seed conversion', EXIT_CODES.protocolViolation);
  }
  const metadata = isObject(state?.conversation_metadata) ? state.conversation_metadata : null;
  const turns = metadata?.user_turn_metadatas;
  if (!Array.isArray(turns)) {
    throw new OpenPError('Kiro companion metadata has no user_turn_metadatas', EXIT_CODES.protocolViolation);
  }
  return turns;
}

function readMessageIds(metadata: unknown, required: boolean): readonly string[] {
  const object = isObject(metadata) ? metadata : null;
  const ids = object?.message_ids;
  if (!Array.isArray(ids)) {
    if (required) {
      throw new OpenPError('Kiro completed turn has no message_ids array', EXIT_CODES.protocolViolation);
    }
    return [];
  }
  if (!ids.every((id): id is string => typeof id === 'string' && id.length > 0)) {
    throw new OpenPError('Kiro turn metadata contains an invalid message id', EXIT_CODES.protocolViolation);
  }
  return ids;
}

function isCompletedMetadata(metadata: unknown): boolean {
  const object = isObject(metadata) ? metadata : null;
  return object?.end_reason === 'UserTurnEnd';
}

function completionId(metadata: unknown): string {
  const ok = completionOk(metadata);
  if (typeof ok?.id === 'string' && ok.id.length > 0) {
    return ok.id;
  }
  throw new OpenPError('Kiro completed turn is missing its completion boundary id', EXIT_CODES.protocolViolation);
}

function completionOk(metadata: unknown): JsonObject {
  const object = isObject(metadata) ? metadata : null;
  const ok = isObject(object?.result) && isObject(object.result.Ok) ? object.result.Ok : null;
  if (!ok) {
    throw new OpenPError('Kiro completed turn is missing its completion boundary id', EXIT_CODES.protocolViolation);
  }
  return ok;
}

function classifyPrompt(record: JsonObject): 'not-prompt' | 'caller' | 'tool-only' | 'unsupported' {
  if (record.kind !== 'Prompt') return 'not-prompt';
  const data = isObject(record.data) ? record.data : null;
  if (!data || !Array.isArray(data.content) || data.content.length === 0) return 'unsupported';
  if (isSingleTextContent(data.content)) {
    return Object.prototype.hasOwnProperty.call(data, 'meta') ? 'caller' : 'unsupported';
  }
  const toolOnly = !Object.prototype.hasOwnProperty.call(data, 'meta') &&
    data.content.every((block) => isObject(block) && block.kind === 'toolResult');
  return toolOnly ? 'tool-only' : 'unsupported';
}

// Mirrors the live turn path (session-log.ts extractAssistantMessageText): every `text` block's
// data is concatenated in content order; non-text blocks (toolUse etc.) carry no portable text.
// Tool-use records typically carry an empty `text` block, so text evidence is the extracted
// text being non-empty — matching the live path's `if (text)` — not text-block presence.
function textFromKiroRecord(record: JsonObject): string {
  const data = isObject(record.data) ? record.data : null;
  const content = Array.isArray(data?.content) ? data.content : [];
  let text = '';
  for (const block of content) {
    if (!isObject(block) || block.kind !== 'text') continue;
    if (typeof block.data !== 'string') {
      throw new OpenPError('Kiro native record has a text content block without string data', EXIT_CODES.protocolViolation);
    }
    text += block.data;
  }
  return text;
}

function isSingleTextContent(content: unknown): boolean {
  return Array.isArray(content) &&
    content.length === 1 &&
    isObject(content[0]) &&
    content[0].kind === 'text' &&
    typeof content[0].data === 'string';
}

function messageId(record: JsonObject): string {
  const data = isObject(record.data) ? record.data : null;
  if (typeof data?.message_id === 'string' && data.message_id.length > 0) return data.message_id;
  throw new OpenPError('Kiro native record is missing message_id', EXIT_CODES.protocolViolation);
}

function parseLine(line: string): JsonObject {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new OpenPError('Kiro session log contains malformed JSONL', EXIT_CODES.sessionLogParse);
  }
  if (!isObject(value)) {
    throw new OpenPError('Kiro session log contains a non-object JSONL record', EXIT_CODES.protocolViolation);
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
