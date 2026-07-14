import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { SessionHistoryTurn } from '../../core/backend.js';
import { EXIT_CODES, OpenPError } from '../../core/errors.js';
import { appendJsonlLines } from '../../core/jsonl-append.js';
import { findCodexSessionLogPath } from './session-log.js';
import { uuidv7 } from './uuidv7.js';

interface JsonObject {
  [key: string]: unknown;
}

// Resolves the Codex rollout log (honoring instance homeDir), then appends the caller's turns as
// native `response_item` messages cloned from the log's own last user/assistant message items
// (runtime golden). session_meta, instructions, world_state, and event_msg records are neither
// touched nor synthesized — Codex re-injects any missing instruction head on the next resume.
export async function appendCodexSessionHistory(input: {
  readonly sessionId: string;
  readonly cwd: string;
  readonly turns: readonly SessionHistoryTurn[];
  readonly homeDir?: string | null;
  readonly signal?: AbortSignal;
}): Promise<void> {
  const logPath = await findCodexSessionLogPath(input.sessionId, input.homeDir ?? null);
  if (!logPath) {
    throw new OpenPError(`codex session log not found for ${input.sessionId}`, EXIT_CODES.sessionLogNotFound);
  }
  let logText: string;
  try {
    logText = await readFile(logPath, 'utf8');
  } catch (error) {
    if (isNotFoundError(error)) {
      throw new OpenPError(`codex session log not found for ${input.sessionId}`, EXIT_CODES.sessionLogNotFound);
    }
    throw error;
  }
  const lines = buildCodexHistoryEntries(logText, input.turns);
  await appendJsonlLines(logPath, lines, input.signal);
}

// Pure transform (unit-test surface): existing log text -> JSON lines to append. The last single
// `input_text` user message and the last single `output_text` assistant message are the clone
// templates; a missing template is a protocol violation. Unparseable lines are skipped, never
// rewritten. turn_id pairing mirrors a real rollout: a user turn opens a fresh UUIDv7 turn id and a
// following assistant turn inherits it; a batch that leads with an assistant gets its own fresh id.
export function buildCodexHistoryEntries(
  logText: string,
  turns: readonly SessionHistoryTurn[],
  nowMs: number = Date.now(),
): string[] {
  let userTemplate: string | null = null;
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
    if (isCodexUserTemplate(entry)) {
      userTemplate = line;
    }
    if (isCodexAssistantTemplate(entry)) {
      assistantTemplate = line;
    }
  }

  if (!userTemplate || !assistantTemplate) {
    throw new OpenPError(
      'codex session log has no user/assistant message item to clone',
      EXIT_CODES.protocolViolation,
    );
  }

  const lines: string[] = [];
  let currentTurnId: string | null = null;
  turns.forEach((turn, index) => {
    const timestamp = new Date(nowMs + index).toISOString();
    if (turn.role === 'user') {
      currentTurnId = uuidv7(nowMs + index);
      lines.push(JSON.stringify(buildCodexUserEntry(userTemplate!, turn.text, timestamp, currentTurnId)));
    } else {
      if (currentTurnId === null) {
        currentTurnId = uuidv7(nowMs + index);
      }
      lines.push(JSON.stringify(buildCodexAssistantEntry(assistantTemplate!, turn.text, timestamp, currentTurnId)));
    }
  });
  return lines;
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
