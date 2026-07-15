import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { AppendSessionHistoryInput, AppendSessionHistoryResult, NativeWrittenTurn, SeedWriteTurn } from '../../core/backend.js';
import { EXIT_CODES, OpenPError } from '../../core/errors.js';
import { appendJsonlLines, encodeJsonlAppendPayload } from '../../core/jsonl-append.js';
import { decodeNativeStateUtf8 } from '../../core/native-state-digest.js';
import { assertNativeAppendCandidate } from '../../core/native-append-preflight.js';
import {
  assertCodexNativeSessionIdentity,
  codexNativeStateDigest,
  extractCodexNativeTurns,
} from './native-reader.js';
import { findCodexSessionLogPath } from './session-log.js';
import { uuidv7 } from './uuidv7.js';

interface JsonObject {
  [key: string]: unknown;
}

// Resolves the Codex rollout log (honoring instance homeDir), then appends the caller's turns as
// native task lifecycle events and `response_item` messages cloned from the log's own last
// task/user/assistant/completion entries (runtime golden). Existing session_meta, instructions,
// world_state, and event_msg records are never rewritten.
export async function appendCodexSessionHistory(input: {
  readonly sessionId: string;
  readonly cwd: string;
  readonly turns: readonly SeedWriteTurn[];
  readonly persistPreparedAppend: AppendSessionHistoryInput['persistPreparedAppend'];
  readonly homeDir?: string | null;
  readonly signal?: AbortSignal;
}): Promise<AppendSessionHistoryResult> {
  const logPath = await findCodexSessionLogPath(input.sessionId, input.homeDir ?? null);
  if (!logPath) {
    throw new OpenPError(`codex session log not found for ${input.sessionId}`, EXIT_CODES.sessionLogNotFound);
  }
  let logBytes: Buffer;
  try {
    logBytes = await readFile(logPath);
  } catch (error) {
    if (isNotFoundError(error)) {
      throw new OpenPError(`codex session log not found for ${input.sessionId}`, EXIT_CODES.sessionLogNotFound);
    }
    throw error;
  }
  const logText = decodeNativeStateUtf8(logBytes, 'Codex native session log');
  assertCodexNativeSessionIdentity(logText, input.sessionId);
  const before = extractCodexNativeTurns(logText);
  const built = buildCodexHistoryEntries(logText, input.turns);
  const payload = encodeJsonlAppendPayload(
    logBytes.length === 0 || logBytes[logBytes.length - 1] === 0x0a,
    built.lines,
  );
  const candidateText = `${logText}${payload.toString('utf8')}`;
  const candidateBytes = Buffer.concat([logBytes, payload]);
  const candidate = extractCodexNativeTurns(candidateText);
  assertNativeAppendCandidate({
    backend: 'Codex',
    before,
    candidate,
    requested: input.turns,
    written: built.written,
  });
  await input.persistPreparedAppend({
    before,
    beforeNativeStateDigest: codexNativeStateDigest(logBytes),
    candidateNativeStateDigest: codexNativeStateDigest(candidateBytes),
    turns: built.written,
  });
  await appendJsonlLines(logPath, built.lines, input.signal);
  return { sessionId: input.sessionId, turns: built.written };
}

// Pure transform (unit-test surface): existing log text -> JSON lines to append. The last
// task_started/task_complete events and single `input_text` user / `output_text` assistant messages
// are clone templates; missing templates are a protocol violation. Unparseable lines are skipped,
// never rewritten.
export function buildCodexHistoryEntries(
  logText: string,
  turns: readonly SeedWriteTurn[],
  nowMs: number = Date.now(),
): { readonly lines: readonly string[]; readonly written: readonly NativeWrittenTurn[] } {
  let userTemplate: string | null = null;
  let assistantTemplate: string | null = null;
  let taskStartedTemplate: string | null = null;
  let taskCompleteTemplate: string | null = null;

  for (const rawLine of logText.split('\n')) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isJsonObject(entry)) {
      continue;
    }
    if (isCodexUserTemplate(entry)) {
      userTemplate = line;
    }
    if (isCodexAssistantTemplate(entry)) {
      assistantTemplate = line;
    }
    if (isCodexTaskEventTemplate(entry, 'task_started')) {
      taskStartedTemplate = line;
    }
    if (isCodexTaskEventTemplate(entry, 'task_complete')) {
      taskCompleteTemplate = line;
    }
  }

  if (!userTemplate || !assistantTemplate || !taskStartedTemplate || !taskCompleteTemplate) {
    throw new OpenPError(
      'codex session log has no task/user/assistant template item to clone',
      EXIT_CODES.protocolViolation,
    );
  }

  const lines: string[] = [];
  const written: NativeWrittenTurn[] = [];
  turns.forEach((turn, index) => {
    const turnId = uuidv7(nowMs + index * 2);
    const userTimestamp = new Date(nowMs + index * 2).toISOString();
    const assistantTimestamp = new Date(nowMs + index * 2 + 1).toISOString();
    const userEntry = buildCodexUserEntry(userTemplate!, turn.userText, userTimestamp, turnId);
    const assistantEntry = buildCodexAssistantEntry(assistantTemplate!, turn.assistantText, assistantTimestamp, turnId);
    const startedEntry = buildCodexTaskStartedEntry(taskStartedTemplate!, userTimestamp, turnId);
    const completedEntry = buildCodexTaskCompleteEntry(taskCompleteTemplate!, assistantTimestamp, turnId, turn.assistantText);
    const assistantId = ((assistantEntry.payload as JsonObject).id as string);
    lines.push(JSON.stringify(startedEntry));
    lines.push(JSON.stringify(userEntry));
    lines.push(JSON.stringify(assistantEntry));
    lines.push(JSON.stringify(completedEntry));
    written.push({
      logicalId: turn.logicalId,
      contentDigest: turn.contentDigest,
      nativeIds: {
        userId: `user:${turnId}`,
        assistantIds: [assistantId],
        completionId: turnId,
      },
    });
  });
  return { lines, written };
}

function isCodexTaskEventTemplate(entry: JsonObject, type: 'task_started' | 'task_complete'): boolean {
  if (entry.type !== 'event_msg') {
    return false;
  }
  const payload = entry.payload;
  return isJsonObject(payload) && payload.type === type && typeof payload.turn_id === 'string';
}

function isCodexUserTemplate(entry: JsonObject): boolean {
  if (entry.type !== 'response_item') {
    return false;
  }
  const payload = entry.payload;
  if (!isJsonObject(payload) || payload.type !== 'message' || payload.role !== 'user') {
    return false;
  }
  return isSingleTextContent(payload.content, 'input_text');
}

function isCodexAssistantTemplate(entry: JsonObject): boolean {
  if (entry.type !== 'response_item') {
    return false;
  }
  const payload = entry.payload;
  if (!isJsonObject(payload) || payload.type !== 'message' || payload.role !== 'assistant') {
    return false;
  }
  return isSingleTextContent(payload.content, 'output_text');
}

function isSingleTextContent(content: unknown, textType: 'input_text' | 'output_text'): boolean {
  if (!Array.isArray(content) || content.length !== 1) {
    return false;
  }
  const block = content[0];
  return isJsonObject(block) && block.type === textType && typeof block.text === 'string';
}

// Cloning re-parses the stored template line each turn so entries never share references. Only the
// fields below are replaced; every other field (role/phase/type/bookkeeping) keeps its template
// value, and reassigning existing keys preserves the template's key ordering.
function buildCodexUserEntry(
  templateLine: string,
  text: string,
  timestamp: string,
  turnId: string,
): JsonObject {
  const entry = JSON.parse(templateLine) as JsonObject;
  entry.timestamp = timestamp;
  const payload = entry.payload as JsonObject;
  delete payload.id;
  (payload.content as JsonObject[])[0]!.text = text;
  setTurnId(payload, turnId);
  return entry;
}

function buildCodexAssistantEntry(
  templateLine: string,
  text: string,
  timestamp: string,
  turnId: string,
): JsonObject {
  const entry = JSON.parse(templateLine) as JsonObject;
  entry.timestamp = timestamp;
  const payload = entry.payload as JsonObject;
  (payload.content as JsonObject[])[0]!.text = text;
  payload.id = `msg_${randomHex(32)}`;
  setTurnId(payload, turnId);
  return entry;
}

function buildCodexTaskStartedEntry(templateLine: string, timestamp: string, turnId: string): JsonObject {
  const entry = JSON.parse(templateLine) as JsonObject;
  entry.timestamp = timestamp;
  const payload = entry.payload as JsonObject;
  payload.turn_id = turnId;
  payload.started_at = Math.floor(Date.parse(timestamp) / 1000);
  return entry;
}

function buildCodexTaskCompleteEntry(templateLine: string, timestamp: string, turnId: string, assistantText: string): JsonObject {
  const entry = JSON.parse(templateLine) as JsonObject;
  entry.timestamp = timestamp;
  const payload = entry.payload as JsonObject;
  payload.turn_id = turnId;
  payload.last_agent_message = assistantText;
  payload.completed_at = Math.floor(Date.parse(timestamp) / 1000);
  payload.duration_ms = 0;
  payload.time_to_first_token_ms = 0;
  return entry;
}

// Replaces only turn_id inside the passthrough object, keeping any other passthrough keys.
function setTurnId(payload: JsonObject, turnId: string): void {
  const existing = payload.internal_chat_message_metadata_passthrough;
  const passthrough = isJsonObject(existing) ? existing : {};
  passthrough.turn_id = turnId;
  payload.internal_chat_message_metadata_passthrough = passthrough;
}

function randomHex(chars: number): string {
  return randomBytes(Math.ceil(chars / 2)).toString('hex').slice(0, chars);
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { readonly code?: unknown }).code === 'ENOENT';
}
