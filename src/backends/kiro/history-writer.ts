import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { SessionHistoryTurn } from '../../core/backend.js';
import { EXIT_CODES, OpenPError } from '../../core/errors.js';
import { appendJsonlLines } from '../../core/jsonl-append.js';
import { resolveKiroSessionLogPath } from './session-log.js';

interface JsonObject {
  [key: string]: unknown;
}

// Resolves the canonical Kiro CLI session log, then appends the caller's turns as native `Prompt`
// and `AssistantMessage` records cloned from the log's own last such records (runtime golden). The
// `.json` companion is neither read nor written: an existing session accepts `.jsonl`-only appends
// (research-confirmed live), so the companion's turn metadata is intentionally left untouched.
export async function appendKiroSessionHistory(input: {
  readonly sessionId: string;
  readonly cwd: string; // signature parity only; Kiro resolves its log by session id, not cwd
  readonly turns: readonly SessionHistoryTurn[];
  readonly signal?: AbortSignal;
}): Promise<void> {
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
  const lines = buildKiroHistoryEntries(logText, input.turns);
  await appendJsonlLines(logPath, lines, input.signal);
}

// Pure transform (unit-test surface): existing log text -> JSON lines to append. The last single
// `text` Prompt and the last single `text` AssistantMessage are the clone templates; a missing
// template is a protocol violation. Unparseable lines are skipped, never rewritten. Only Prompt
// records carry `data.meta.timestamp`; AssistantMessage records have no meta and none is created.
export function buildKiroHistoryEntries(
  logText: string,
  turns: readonly SessionHistoryTurn[],
  nowSec: number = Math.floor(Date.now() / 1000),
): string[] {
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
  turns.forEach((turn, index) => {
    const entry = turn.role === 'user'
      ? buildKiroPromptEntry(promptTemplate!, turn.text, nowSec + index)
      : buildKiroAssistantEntry(assistantTemplate!, turn.text);
    lines.push(JSON.stringify(entry));
  });
  return lines;
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

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { readonly code?: unknown }).code === 'ENOENT';
}
