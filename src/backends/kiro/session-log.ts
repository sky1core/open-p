import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { ARTIFACT_REJECTION_REASONS, EXIT_CODES, OpenPError } from '../../core/errors.js';
import { isSafeSessionId } from '../../core/session-id.js';
import type { AssistantEventSnapshot } from '../../core/types.js';

type JsonObject = Record<string, unknown>;
type KiroPromptEventClassification = 'caller' | 'continuation' | 'unsupported' | 'not_prompt';
type KiroTurnResultRead = {
  readonly logFound: boolean;
  readonly size: number | null;
  readonly sawScopedRecords: boolean;
  readonly text: string | null;
  readonly assistantEvents: readonly AssistantEventSnapshot[];
  readonly toolsUsed: readonly string[];
};

export function resolveKiroSessionLogPath(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!isSafeSessionId(sessionId)) {
    return null;
  }
  const home = typeof env.HOME === 'string' && env.HOME.trim() ? env.HOME.trim() : homedir();
  return join(home, '.kiro', 'sessions', 'cli', `${sessionId}.jsonl`);
}

export async function readKiroSessionLogOffset(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const logPath = resolveKiroSessionLogPath(sessionId, env);
  if (!logPath) {
    return 0;
  }
  try {
    return (await stat(logPath)).size;
  } catch {
    return 0;
  }
}

export async function waitForKiroTurnResultText(options: {
  readonly sessionId: string;
  readonly fromOffset: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly deadlineMs: number;
  readonly intervalMs?: number;
  readonly throwIfStopped?: () => void;
}): Promise<string | null> {
  const result = await waitForKiroTurnResult(options);
  return result.text;
}

export async function waitForKiroTurnResult(options: {
  readonly sessionId: string;
  readonly fromOffset: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly deadlineMs: number;
  readonly intervalMs?: number;
  readonly throwIfStopped?: () => void;
}): Promise<{
  readonly sawScopedRecords: boolean;
  readonly text: string | null;
  readonly assistantEvents: readonly AssistantEventSnapshot[];
  readonly toolsUsed: readonly string[];
}> {
  const intervalMs = options.intervalMs ?? 50;
  let lastResult: {
    sawScopedRecords: boolean;
    text: string | null;
    assistantEvents: readonly AssistantEventSnapshot[];
    toolsUsed: readonly string[];
  } = {
    sawScopedRecords: false,
    text: null,
    assistantEvents: [],
    toolsUsed: [],
  };
  let sawLog = false;
  let sawScopedRecords = false;

  for (;;) {
    options.throwIfStopped?.();
    const snapshot = await readKiroTurnResultText(options.sessionId, options.fromOffset, options.env);
    sawLog ||= snapshot.logFound;
    sawScopedRecords ||= snapshot.sawScopedRecords;
    if (snapshot.text !== null || snapshot.assistantEvents.length > 0) {
      lastResult = {
        sawScopedRecords,
        text: snapshot.text,
        assistantEvents: snapshot.assistantEvents,
        toolsUsed: snapshot.toolsUsed,
      };
    }
    options.throwIfStopped?.();
    const now = Date.now();
    if (now >= options.deadlineMs) {
      if (lastResult.text !== null || lastResult.assistantEvents.length > 0) {
        return lastResult;
      }
      if (!sawLog) {
        throw new OpenPError(
          `Kiro session log not found for session ${options.sessionId}`,
          EXIT_CODES.sessionLogNotFound,
          ARTIFACT_REJECTION_REASONS.noCandidate,
        );
      }
      return {
        ...lastResult,
        sawScopedRecords,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, options.deadlineMs - now)));
  }
}

async function readKiroTurnResultText(
  sessionId: string,
  fromOffset: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<KiroTurnResultRead> {
  const logPath = resolveKiroSessionLogPath(sessionId, env);
  if (!logPath) {
    return {
      logFound: false,
      size: null,
      sawScopedRecords: false,
      text: null,
      assistantEvents: [],
      toolsUsed: [],
    };
  }

  let size: number;
  try {
    size = (await stat(logPath)).size;
  } catch {
    return {
      logFound: false,
      size: null,
      sawScopedRecords: false,
      text: null,
      assistantEvents: [],
      toolsUsed: [],
    };
  }
  if (size <= fromOffset) {
    return {
      logFound: true,
      size,
      sawScopedRecords: false,
      text: null,
      assistantEvents: [],
      toolsUsed: [],
    };
  }
  const rawLogSegment = await readTextFromOffset(logPath, fromOffset, size);
  const result = extractKiroTurnResult(rawLogSegment);
  return {
    logFound: true,
    sawScopedRecords: containsParsedKiroRecord(rawLogSegment),
    text: result.text,
    assistantEvents: result.assistantEvents,
    toolsUsed: result.toolsUsed,
    size,
  };
}

export function extractKiroTurnResultText(rawLogSegment: string): string | null {
  return extractKiroTurnResult(rawLogSegment).text;
}

export function extractKiroTurnResult(rawLogSegment: string): {
  readonly text: string | null;
  readonly assistantEvents: readonly AssistantEventSnapshot[];
  readonly toolsUsed: readonly string[];
} {
  const assistantMessages: string[] = [];
  const assistantEvents: AssistantEventSnapshot[] = [];
  const toolsUsed = new Set<string>();
  let sawCallerPrompt = false;

  for (const rawLine of rawLogSegment.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    let event: JsonObject;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        continue;
      }
      event = parsed as JsonObject;
    } catch {
      continue;
    }

    const promptClassification = classifyKiroPromptEvent(event);
    if (promptClassification === 'unsupported') {
      throwUnsupportedKiroPromptShape();
    }
    if (promptClassification === 'caller') {
      if (sawCallerPrompt) {
        throw new OpenPError(
          'Kiro session log contains multiple caller prompt boundaries in one active turn segment',
          EXIT_CODES.protocolViolation,
          ARTIFACT_REJECTION_REASONS.multipleTurnBoundaries,
        );
      }
      sawCallerPrompt = true;
      continue;
    }
    if (!sawCallerPrompt) {
      continue;
    }
    if (event.kind === 'ToolResults') {
      const snapshot = buildKiroToolResultSnapshot(event);
      if (snapshot) {
        assistantEvents.push(snapshot);
      }
      continue;
    }
    if (event.kind !== 'AssistantMessage') {
      continue;
    }

    const data = asObject(event.data);
    const toolSnapshot = buildKiroAssistantToolSnapshot(data);
    if (toolSnapshot) {
      assistantEvents.push(toolSnapshot);
      for (const toolName of extractToolUseNames(data)) {
        toolsUsed.add(toolName);
      }
    }
    const text = extractAssistantMessageText(data);
    if (text) {
      assistantMessages.push(text);
    }
  }

  return {
    text: assistantMessages.length > 0 ? assistantMessages.join('\n\n') : null,
    assistantEvents,
    toolsUsed: [...toolsUsed],
  };
}

function containsParsedKiroRecord(rawLogSegment: string): boolean {
  for (const rawLine of rawLogSegment.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}

function classifyKiroPromptEvent(event: JsonObject): KiroPromptEventClassification {
  if (event.kind !== 'Prompt') {
    return 'not_prompt';
  }
  const data = asObject(event.data);
  if (!data || !Array.isArray(data.content) || data.content.length === 0) {
    return 'unsupported';
  }
  const content = data.content;
  const hasMeta = Object.prototype.hasOwnProperty.call(data, 'meta');
  const textBlockCount = content.filter(isKiroTextContentBlock).length;
  if (textBlockCount === content.length) {
    return hasMeta ? 'caller' : 'unsupported';
  }
  if (textBlockCount === 0) {
    return 'continuation';
  }
  return 'unsupported';
}

function throwUnsupportedKiroPromptShape(): never {
  throw new OpenPError(
    'Kiro session log contains unsupported prompt shape in active turn segment',
    EXIT_CODES.protocolViolation,
    ARTIFACT_REJECTION_REASONS.unsupportedArtifactShape,
  );
}

function isKiroTextContentBlock(block: unknown): boolean {
  return asObject(block)?.kind === 'text';
}

function extractAssistantMessageText(data: JsonObject | null): string {
  const content = Array.isArray(data?.content) ? data.content : [];
  return content.map(extractContentText).join('');
}

function extractContentText(content: unknown): string {
  const item = asObject(content);
  if (!item || item.kind !== 'text' || typeof item.data !== 'string') {
    return '';
  }
  return item.data;
}

function buildKiroAssistantToolSnapshot(data: JsonObject | null): AssistantEventSnapshot | null {
  const content = Array.isArray(data?.content) ? data.content : [];
  const toolBlocks = content
    .map((block) => asObject(block))
    .filter((block): block is JsonObject => block?.kind === 'toolUse');
  if (toolBlocks.length === 0) {
    return null;
  }
  const messageId = typeof data?.message_id === 'string' ? data.message_id : buildKiroMessageId('tool-use', toolBlocks);
  return {
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      content: toolBlocks.map((block, index) => normalizeKiroToolUseBlock(block, index)),
      stop_reason: null,
      stop_sequence: null,
      stop_details: null,
      diagnostics: null,
      context_management: null,
    },
  };
}

function buildKiroToolResultSnapshot(event: JsonObject): AssistantEventSnapshot | null {
  const data = asObject(event.data);
  const content = Array.isArray(data?.content) ? data.content : [];
  const resultBlocks = content
    .map((block) => asObject(block))
    .filter((block): block is JsonObject => block !== null);
  if (resultBlocks.length === 0) {
    return null;
  }
  return {
    message: {
      id: buildKiroMessageId('tool-result', resultBlocks),
      type: 'message',
      role: 'assistant',
      content: resultBlocks.map((block, index) => normalizeKiroToolResultBlock(block, index)),
      stop_reason: null,
      stop_sequence: null,
      stop_details: null,
      diagnostics: null,
      context_management: null,
    },
  };
}

function normalizeKiroToolUseBlock(block: JsonObject, index: number): Record<string, unknown> {
  const data = asObject(block.data);
  const id = typeof data?.toolUseId === 'string'
    ? data.toolUseId
    : typeof data?.id === 'string'
      ? data.id
      : typeof data?.toolCallId === 'string'
        ? data.toolCallId
        : buildKiroMessageId(`tool-use-${index}`, block);
  return {
    type: 'tool_use',
    id,
    name: typeof data?.name === 'string' ? data.name : 'kiro_tool',
    input: Object.prototype.hasOwnProperty.call(data ?? {}, 'input') ? data?.input : data ?? block.data ?? {},
    caller: { type: 'kiro' },
  };
}

function normalizeKiroToolResultBlock(block: JsonObject, index: number): Record<string, unknown> {
  const data = asObject(block.data);
  const toolUseId = typeof data?.toolUseId === 'string'
    ? data.toolUseId
    : typeof data?.tool_use_id === 'string'
      ? data.tool_use_id
      : typeof data?.toolCallId === 'string'
        ? data.toolCallId
        : buildKiroMessageId(`tool-result-${index}`, block);
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: extractToolResultContent(block),
  };
}

function extractToolUseNames(data: JsonObject | null): string[] {
  const content = Array.isArray(data?.content) ? data.content : [];
  return content
    .map((block) => asObject(block))
    .filter((block): block is JsonObject => block?.kind === 'toolUse')
    .map((block) => asObject(block.data))
    .map((blockData) => typeof blockData?.name === 'string' && blockData.name.trim() ? blockData.name.trim() : null)
    .filter((name): name is string => name !== null);
}

function extractToolResultContent(block: JsonObject): string {
  const data = asObject(block.data);
  if (typeof data?.content === 'string') {
    return data.content;
  }
  if (Array.isArray(data?.content)) {
    return data.content.map(extractToolResultContentPart).join('');
  }
  if (Object.prototype.hasOwnProperty.call(block, 'data')) {
    return JSON.stringify(block.data);
  }
  return JSON.stringify(block);
}

function extractToolResultContentPart(content: unknown): string {
  const item = asObject(content);
  if (!item) {
    return JSON.stringify(content);
  }
  if (item.kind === 'text' && typeof item.data === 'string') {
    return item.data;
  }
  if (item.kind === 'json' && Object.prototype.hasOwnProperty.call(item, 'data')) {
    return JSON.stringify(item.data);
  }
  return JSON.stringify(content);
}

function buildKiroMessageId(prefix: string, value: unknown): string {
  return `kiro_${prefix}_${Buffer.from(JSON.stringify(value)).toString('base64url')}`;
}

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function readTextFromOffset(path: string, offset: number, size: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stream = createReadStream(path, { start: offset, end: size - 1 });
    stream.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    stream.on('error', reject);
    stream.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
}
