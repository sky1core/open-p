import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { SessionHistoryTurn } from '../../core/backend.js';
import { EXIT_CODES, OpenPError } from '../../core/errors.js';
import { appendJsonlLines } from '../../core/jsonl-append.js';
import { findClaudeCodeSessionLog } from './session-log.js';

interface JsonObject {
  [key: string]: unknown;
}

// Resolves the Claude Code session log (honoring instance configDir), then appends the caller's
// turns as native entries cloned from the log's own last user/assistant entries (runtime golden).
export async function appendClaudeCodeSessionHistory(input: {
  readonly sessionId: string;
  readonly cwd: string;
  readonly turns: readonly SessionHistoryTurn[];
  readonly configDir?: string | null;
  readonly signal?: AbortSignal;
}): Promise<void> {
  const logPath = await findClaudeCodeSessionLog(input.sessionId, input.cwd, input.configDir ?? null);
  if (!logPath) {
    throw new OpenPError(`claude session log not found for ${input.sessionId}`, EXIT_CODES.sessionLogNotFound);
  }
  let logText: string;
  try {
    logText = await readFile(logPath, 'utf8');
  } catch (error) {
    if (isNotFoundError(error)) {
      throw new OpenPError(`claude session log not found for ${input.sessionId}`, EXIT_CODES.sessionLogNotFound);
    }
    throw error;
  }
  const lines = buildClaudeCodeHistoryEntries(logText, input.turns);
  await appendJsonlLines(logPath, lines, input.signal);
}

// Pure transform (unit-test surface): existing log text -> JSON lines to append.
// The last user entry (string content) and last assistant entry (with a text block) are the clone
// templates; the parent chain starts from the last uuid-bearing entry. Missing templates or chain
// start is a protocol violation. Unparseable lines are skipped, never rewritten.
export function buildClaudeCodeHistoryEntries(
  logText: string,
  turns: readonly SessionHistoryTurn[],
  nowMs: number = Date.now(),
): string[] {
  let userTemplate: string | null = null;
  let assistantTemplate: string | null = null;
  let chainStartUuid: string | null = null;

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
    if (isUserTemplateEntry(entry)) {
      userTemplate = line;
    }
    if (isAssistantTemplateEntry(entry)) {
      assistantTemplate = line;
    }
    if (typeof entry.uuid === 'string' && entry.uuid.length > 0) {
      chainStartUuid = entry.uuid;
    }
  }

  if (!userTemplate || !assistantTemplate) {
    throw new OpenPError(
      'claude session log has no user/assistant template entry to clone',
      EXIT_CODES.protocolViolation,
    );
  }
  if (!chainStartUuid) {
    throw new OpenPError(
      'claude session log has no uuid-bearing entry to start the parent chain',
      EXIT_CODES.protocolViolation,
    );
  }

  const lines: string[] = [];
  let parentUuid = chainStartUuid;
  turns.forEach((turn, index) => {
    const uuid = randomUUID();
    const timestamp = new Date(nowMs + index).toISOString();
    const entry = turn.role === 'user'
      ? buildUserEntry(userTemplate!, turn.text, uuid, parentUuid, timestamp)
      : buildAssistantEntry(assistantTemplate!, turn.text, uuid, parentUuid, timestamp);
    lines.push(JSON.stringify(entry));
    parentUuid = uuid;
  });
  return lines;
}

function isUserTemplateEntry(entry: JsonObject): boolean {
  if (entry.type !== 'user' || entry.isSidechain === true) {
    return false;
  }
  const message = entry.message;
  return isJsonObject(message) && typeof message.content === 'string';
}

function isAssistantTemplateEntry(entry: JsonObject): boolean {
  if (entry.type !== 'assistant') {
    return false;
  }
  const message = entry.message;
  if (!isJsonObject(message) || !Array.isArray(message.content)) {
    return false;
  }
  return message.content.some((block) => isJsonObject(block) && block.type === 'text');
}

// Cloning re-parses the stored template line each turn so entries never share references. Only the
// fields below are replaced; every other bookkeeping field (sessionId/cwd/version/model/usage/...)
// keeps its template value, and reassigning existing keys preserves the template's key ordering.
function buildUserEntry(
  templateLine: string,
  text: string,
  uuid: string,
  parentUuid: string,
  timestamp: string,
): JsonObject {
  const entry = JSON.parse(templateLine) as JsonObject;
  entry.uuid = uuid;
  entry.parentUuid = parentUuid;
  entry.timestamp = timestamp;
  entry.promptId = randomUUID();
  (entry.message as JsonObject).content = text;
  return entry;
}

function buildAssistantEntry(
  templateLine: string,
  text: string,
  uuid: string,
  parentUuid: string,
  timestamp: string,
): JsonObject {
  const entry = JSON.parse(templateLine) as JsonObject;
  entry.uuid = uuid;
  entry.parentUuid = parentUuid;
  entry.timestamp = timestamp;
  entry.requestId = `req_${randomHex(24)}`;
  const message = entry.message as JsonObject;
  message.content = [{ type: 'text', text }];
  message.id = `msg_${randomHex(32)}`;
  return entry;
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
