import { randomUUID } from 'node:crypto';
import { readFile, rename, stat, truncate, unlink, writeFile } from 'node:fs/promises';
import { throwIfAborted } from '../../core/abort.js';
import type { AppendSessionHistoryResult, NativeWrittenTurn, SeedWriteTurn } from '../../core/backend.js';
import { EXIT_CODES, OpenPError } from '../../core/errors.js';
import { appendJsonlLines } from '../../core/jsonl-append.js';
import { resolveKiroSessionLogPath } from './session-log.js';

interface JsonObject {
  [key: string]: unknown;
}

// Resolves the canonical Kiro CLI session log, then appends the caller's paired turns as native
// `Prompt` and `AssistantMessage` records cloned from the log's own last such records (runtime
// golden). The `.json` companion is updated with completion metadata for each appended pair so the
// seeded pairs can later be read as completed native turns.
export async function appendKiroSessionHistory(input: {
  readonly sessionId: string;
  readonly cwd: string; // signature parity only; Kiro resolves its log by session id, not cwd
  readonly turns: readonly SeedWriteTurn[];
  readonly signal?: AbortSignal;
}): Promise<AppendSessionHistoryResult> {
  throwIfAborted(input.signal);
  const logPath = resolveKiroSessionLogPath(input.sessionId);
  if (!logPath) {
    throw new OpenPError(`kiro session log not found for ${input.sessionId}`, EXIT_CODES.sessionLogNotFound);
  }
  let logText: string;
  try {
    logText = await readFile(logPath, 'utf8');
  } catch (error) {
    if (isNotFoundError(error)) {
      throw new OpenPError(`kiro session log not found for ${input.sessionId}`, EXIT_CODES.sessionLogNotFound);
    }
    throw error;
  }
  let companionText: string;
  const companionPath = logPath.replace(/\.jsonl$/, '.json');
  try {
    companionText = await readFile(companionPath, 'utf8');
  } catch {
    throw new OpenPError(`kiro companion metadata not found for ${input.sessionId}`, EXIT_CODES.protocolViolation);
  }
  const built = buildKiroHistoryEntries(logText, input.turns);
  const companion = buildKiroCompanionWithAppendedTurns(companionText, input.turns, built.written);
  await commitKiroHistoryAppend({
    logPath,
    companionPath,
    lines: built.lines,
    companion,
    signal: input.signal,
  });
  return { turns: built.written };
}

// Kiro stores one logical history in two files. If publishing the prepared companion fails after
// JSONL append, restore the JSONL to its exact prior byte length so readers and native resume never
// observe an unproven suffix.
export async function commitKiroHistoryAppend(input: {
  readonly logPath: string;
  readonly companionPath: string;
  readonly lines: readonly string[];
  readonly companion: string;
  readonly signal?: AbortSignal;
}): Promise<void> {
  throwIfAborted(input.signal);
  const originalSize = (await stat(input.logPath)).size;
  const tmpPath = `${input.companionPath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmpPath, input.companion, { mode: 0o600 });
  try {
    await appendJsonlLines(input.logPath, input.lines, input.signal);
    await rename(tmpPath, input.companionPath);
  } catch (error) {
    let rollbackFailed = false;
    try {
      await truncate(input.logPath, originalSize);
    } catch {
      rollbackFailed = true;
    }
    await unlink(tmpPath).catch(() => undefined);
    if (rollbackFailed) {
      throw new OpenPError(
        'kiro companion publish failed and the JSONL append could not be rolled back',
        EXIT_CODES.protocolViolation,
      );
    }
    throw error;
  }
}

// Pure transform (unit-test surface): existing log text -> JSON lines to append. The last single
// `text` Prompt and the last single `text` AssistantMessage are the clone templates; a missing
// template is a protocol violation. Unparseable lines are skipped, never rewritten. Only Prompt
// records carry `data.meta.timestamp`; AssistantMessage records have no meta and none is created.
export function buildKiroHistoryEntries(
  logText: string,
  turns: readonly SeedWriteTurn[],
  nowSec: number = Math.floor(Date.now() / 1000),
): { readonly lines: readonly string[]; readonly written: readonly NativeWrittenTurn[] } {
  let promptTemplate: string | null = null;
  let assistantTemplate: string | null = null;

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
    if (isKiroPromptTemplate(entry)) {
      promptTemplate = line;
    }
    if (isKiroAssistantTemplate(entry)) {
      assistantTemplate = line;
    }
  }

  if (!promptTemplate || !assistantTemplate) {
    throw new OpenPError(
      'kiro session log has no Prompt/AssistantMessage record to clone',
      EXIT_CODES.protocolViolation,
    );
  }

  const lines: string[] = [];
  const written: NativeWrittenTurn[] = [];
  turns.forEach((turn, index) => {
    const prompt = buildKiroPromptEntry(promptTemplate!, turn.userText, nowSec + index);
    const assistant = buildKiroAssistantEntry(assistantTemplate!, turn.assistantText);
    lines.push(JSON.stringify(prompt));
    lines.push(JSON.stringify(assistant));
    const userId = (prompt.data as JsonObject).message_id as string;
    const assistantId = (assistant.data as JsonObject).message_id as string;
    written.push({
      logicalId: turn.logicalId,
      contentDigest: turn.contentDigest,
      nativeIds: {
        userId,
        assistantIds: [assistantId],
        completionId: assistantId,
      },
    });
  });
  return { lines, written };
}

export function buildKiroCompanionWithAppendedTurns(
  companionText: string,
  turns: readonly SeedWriteTurn[],
  written: readonly NativeWrittenTurn[],
): string {
  let companion: unknown;
  try {
    companion = JSON.parse(companionText);
  } catch {
    throw new OpenPError('kiro companion metadata is not valid JSON', EXIT_CODES.protocolViolation);
  }
  if (!isJsonObject(companion) || !isJsonObject(companion.session_state) ||
    companion.session_state.version !== 'v1' ||
    !isJsonObject(companion.session_state.conversation_metadata) ||
    !Array.isArray(companion.session_state.conversation_metadata.user_turn_metadatas)) {
    throw new OpenPError('kiro companion metadata has no user_turn_metadatas', EXIT_CODES.protocolViolation);
  }
  if (turns.length !== written.length) {
    throw new OpenPError('kiro companion metadata turn count mismatch', EXIT_CODES.protocolViolation);
  }
  const metadatas = companion.session_state.conversation_metadata.user_turn_metadatas;
  const template = metadatas.length > 0 && isJsonObject(metadatas[metadatas.length - 1])
    ? metadatas[metadatas.length - 1] as JsonObject
    : null;
  if (!template) {
    throw new OpenPError('kiro companion metadata has no template turn', EXIT_CODES.protocolViolation);
  }
  const now = new Date();
  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index]!;
    const native = written[index]!.nativeIds;
    const metadata = structuredClone(template) as JsonObject;
    metadata.message_ids = [native.userId, ...native.assistantIds];
    metadata.end_reason = 'UserTurnEnd';
    metadata.end_timestamp = new Date(now.getTime() + index * 1000).toISOString();
    metadata.user_prompt_length = turn.userText.length;
    metadata.result = {
      Ok: {
        id: native.completionId,
        role: 'assistant',
        content: [{ kind: 'text', data: turn.assistantText }],
        meta: { timestamp: Math.floor((now.getTime() + index * 1000) / 1000) },
      },
    };
    if (isJsonObject(metadata.loop_id)) {
      metadata.loop_id = { ...metadata.loop_id, rand: randomUint32() };
    }
    metadatas.push(metadata);
  }
  return `${JSON.stringify(companion, null, 2)}\n`;
}

function isKiroPromptTemplate(entry: JsonObject): boolean {
  if (entry.version !== 'v1' || entry.kind !== 'Prompt') {
    return false;
  }
  const data = entry.data;
  return isJsonObject(data) && isSingleTextContent(data.content);
}

function isKiroAssistantTemplate(entry: JsonObject): boolean {
  if (entry.version !== 'v1' || entry.kind !== 'AssistantMessage') {
    return false;
  }
  const data = entry.data;
  return isJsonObject(data) && isSingleTextContent(data.content);
}

function isSingleTextContent(content: unknown): boolean {
  if (!Array.isArray(content) || content.length !== 1) {
    return false;
  }
  const block = content[0];
  return isJsonObject(block) && block.kind === 'text' && typeof block.data === 'string';
}

// Cloning re-parses the stored template line each turn so entries never share references. Only the
// fields below are replaced; every other field keeps its template value.
function buildKiroPromptEntry(templateLine: string, text: string, timestampSec: number): JsonObject {
  const entry = JSON.parse(templateLine) as JsonObject;
  const data = entry.data as JsonObject;
  data.message_id = randomUUID();
  (data.content as JsonObject[])[0]!.data = text;
  const meta = isJsonObject(data.meta) ? data.meta : {};
  meta.timestamp = timestampSec;
  data.meta = meta;
  return entry;
}

function buildKiroAssistantEntry(templateLine: string, text: string): JsonObject {
  const entry = JSON.parse(templateLine) as JsonObject;
  const data = entry.data as JsonObject;
  data.message_id = randomUUID();
  (data.content as JsonObject[])[0]!.data = text;
  return entry;
}

function randomUint32(): number {
  return Math.floor(Math.random() * 0x100000000);
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { readonly code?: unknown }).code === 'ENOENT';
}
