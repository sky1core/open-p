import { readFile } from 'node:fs/promises';
import type { NativeSessionReadResult, NativeSessionTurn } from '../../core/backend.js';
import { EXIT_CODES, OpenPError } from '../../core/errors.js';
import { resolveKiroSessionLogPath } from './session-log.js';

interface JsonObject {
  readonly [key: string]: unknown;
}

export async function readKiroNativeSession(input: {
  readonly backend: string;
  readonly sessionId: string;
}): Promise<NativeSessionReadResult> {
  const logPath = resolveKiroSessionLogPath(input.sessionId);
  if (!logPath) {
    throw new OpenPError(`kiro session log not found for ${input.sessionId}`, EXIT_CODES.sessionLogNotFound);
  }
  let logText: string;
  let companionText: string;
  try {
    logText = await readFile(logPath, 'utf8');
  } catch {
    throw new OpenPError(`kiro session log not found for ${input.sessionId}`, EXIT_CODES.sessionLogNotFound);
  }
  try {
    companionText = await readFile(logPath.replace(/\.jsonl$/, '.json'), 'utf8');
  } catch {
    throw new OpenPError(`kiro companion metadata not found for ${input.sessionId}`, EXIT_CODES.protocolViolation);
  }
  return {
    backend: input.backend,
    sessionId: input.sessionId,
    turns: extractKiroNativeTurns(logText, companionText),
  };
}

export function extractKiroNativeTurns(logText: string, companionText: string): readonly NativeSessionTurn[] {
  const records = new Map<string, JsonObject>();
  for (const line of logText.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const entry = parseLine(line);
    if (!entry) continue;
    if (entry.version !== 'v1') {
      throw new OpenPError('Kiro session log version is not supported for seed conversion', EXIT_CODES.protocolViolation);
    }
    if (entry.kind === 'Compaction') {
      throw new OpenPError('Kiro compacted sessions are not supported for seed source conversion', EXIT_CODES.protocolViolation);
    }
    const data = isObject(entry.data) ? entry.data : null;
    if (data && typeof data.message_id === 'string') {
      if (records.has(data.message_id)) {
        throw new OpenPError('Kiro session log contains a duplicate message id', EXIT_CODES.protocolViolation);
      }
      records.set(data.message_id, entry);
    }
  }

  let companion: unknown;
  try {
    companion = JSON.parse(companionText);
  } catch {
    throw new OpenPError('Kiro companion metadata is not valid JSON', EXIT_CODES.protocolViolation);
  }
  const turnMetadatas = readTurnMetadatas(companion);
  const turns: NativeSessionTurn[] = [];
  const referencedIds = new Set<string>();
  for (const metadata of turnMetadatas) {
    const completed = isCompletedMetadata(metadata);
    const messageIds = readMessageIds(metadata, completed);
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
    let prompt: JsonObject | null = null;
    const assistantMessages: JsonObject[] = [];
    for (const id of messageIds) {
      const record = records.get(id);
      if (!record) {
        throw new OpenPError('Kiro companion metadata references a missing message id', EXIT_CODES.protocolViolation);
      }
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
  for (const [id, record] of records) {
    if (referencedIds.has(id)) {
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
  const object = isObject(metadata) ? metadata : null;
  const ok = isObject(object?.result) && isObject(object.result.Ok) ? object.result.Ok : null;
  if (typeof ok?.id === 'string' && ok.id.length > 0) {
    return ok.id;
  }
  throw new OpenPError('Kiro completed turn is missing its completion boundary id', EXIT_CODES.protocolViolation);
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

function textFromKiroRecord(record: JsonObject): string {
  const data = isObject(record.data) ? record.data : null;
  if (!data || !isSingleTextContent(data.content)) return '';
  const block = (data.content as JsonObject[])[0]!;
  return block.data as string;
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
