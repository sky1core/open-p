import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { AppendSessionHistoryResult, NativeWrittenTurn, SeedWriteTurn } from '../../core/backend.js';
import { EXIT_CODES, OpenPError } from '../../core/errors.js';
import { appendJsonlLines } from '../../core/jsonl-append.js';
import { findClaudeCodeSessionLog } from './session-log.js';
import {
  isCallerUserTurn,
  rememberLocalCommandTranscriptPromptId,
} from './turn-boundary-predicates.js';

interface JsonObject {
  [key: string]: unknown;
}

// Resolves the Claude Code session log (honoring instance configDir), then appends the caller's
// turns as native entries cloned from the log's own last user/assistant entries (runtime golden).
export async function appendClaudeCodeSessionHistory(input: {
  readonly sessionId: string;
  readonly cwd: string;
  readonly turns: readonly SeedWriteTurn[];
  readonly configDir?: string | null;
  readonly signal?: AbortSignal;
}): Promise<AppendSessionHistoryResult> {
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
  const built = buildClaudeCodeHistoryEntries(logText, input.turns);
  await appendJsonlLines(logPath, built.lines, input.signal);
  return { turns: built.written };
}

// Pure transform (unit-test surface): existing log text -> JSON lines to append.
// The last user entry (string content) and last assistant entry (with a text block) are the clone
// templates; the last turn_duration entry is the completion template. The parent chain starts from
// the last uuid-bearing entry. Missing templates or chain start is a protocol violation.
// Unparseable lines are skipped, never rewritten.
export function buildClaudeCodeHistoryEntries(
  logText: string,
  turns: readonly SeedWriteTurn[],
  nowMs: number = Date.now(),
): { readonly lines: readonly string[]; readonly written: readonly NativeWrittenTurn[] } {
  let userTemplate: string | null = null;
  let assistantTemplate: string | null = null;
  let completionTemplate: string | null = null;
  let chainStartUuid: string | null = null;
  const localCommandTranscriptPromptIds = new Set<string>();

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
    rememberLocalCommandTranscriptPromptId(localCommandTranscriptPromptIds, entry);
    if (isUserTemplateEntry(entry, localCommandTranscriptPromptIds)) {
      userTemplate = line;
    }
    if (isAssistantTemplateEntry(entry)) {
      assistantTemplate = line;
    }
    if (isCompletionTemplateEntry(entry)) {
      completionTemplate = line;
    }
    if (typeof entry.uuid === 'string' && entry.uuid.length > 0) {
      chainStartUuid = entry.uuid;
    }
  }

  if (!userTemplate || !assistantTemplate || !completionTemplate) {
    throw new OpenPError(
      'claude session log has no user/assistant/completion template entry to clone',
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
  const written: NativeWrittenTurn[] = [];
  let parentUuid = chainStartUuid;
  let entryIndex = 0;
  turns.forEach((turn) => {
    const userUuid = randomUUID();
    const userTimestamp = new Date(nowMs + entryIndex).toISOString();
    entryIndex += 1;
    const userEntry = buildUserEntry(userTemplate!, turn.userText, userUuid, parentUuid, userTimestamp);
    lines.push(JSON.stringify(userEntry));
    parentUuid = userUuid;

    const assistantUuid = randomUUID();
    const assistantTimestamp = new Date(nowMs + entryIndex).toISOString();
    entryIndex += 1;
    const assistantEntry = buildAssistantEntry(assistantTemplate!, turn.assistantText, assistantUuid, parentUuid, assistantTimestamp);
    const assistantMessageId = ((assistantEntry.message as JsonObject).id as string);
    lines.push(JSON.stringify(assistantEntry));
    parentUuid = assistantUuid;

    const completionUuid = randomUUID();
    const completionTimestamp = new Date(nowMs + entryIndex).toISOString();
    entryIndex += 1;
    const completionEntry = buildCompletionEntry(completionTemplate!, completionUuid, parentUuid, completionTimestamp);
    lines.push(JSON.stringify(completionEntry));
    parentUuid = completionUuid;

    written.push({
      logicalId: turn.logicalId,
      contentDigest: turn.contentDigest,
      nativeIds: {
        userId: userUuid,
        assistantIds: [assistantMessageId],
        completionId: completionUuid,
      },
    });
  });
  return { lines, written };
}

function isUserTemplateEntry(entry: JsonObject, localCommandTranscriptPromptIds: ReadonlySet<string>): boolean {
  if (entry.type !== 'user' || entry.isSidechain === true || entry.isMeta === true || entry.isCompactSummary === true) {
    return false;
  }
  const message = entry.message;
  return isJsonObject(message) && typeof message.content === 'string' &&
    isCallerUserTurn(entry, localCommandTranscriptPromptIds);
}

function isCompletionTemplateEntry(entry: JsonObject): boolean {
  return entry.type === 'system' && entry.subtype === 'turn_duration' &&
    entry.isSidechain !== true && entry.isMeta !== true && entry.isCompactSummary !== true;
}

function isAssistantTemplateEntry(entry: JsonObject): boolean {
  if (entry.type !== 'assistant' || entry.isSidechain === true || entry.isMeta === true || entry.isCompactSummary === true) {
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

function buildCompletionEntry(
  templateLine: string,
  uuid: string,
  parentUuid: string,
  timestamp: string,
): JsonObject {
  const entry = JSON.parse(templateLine) as JsonObject;
  entry.uuid = uuid;
  entry.parentUuid = parentUuid;
  entry.timestamp = timestamp;
  entry.durationMs = 0;
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
