import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { EXIT_CODES, OpenPError } from '../../core/errors.js';
import { isSafeSessionId } from '../../core/session-id.js';
import type { AssistantEventSnapshot } from '../../core/types.js';

type JsonObject = Record<string, unknown>;
type KiroTurnResultRead = {
  readonly logFound: boolean;
  readonly size: number | null;
  readonly text: string | null;
  readonly assistantEvents: readonly AssistantEventSnapshot[];
  readonly toolsUsed: readonly string[];
};

type KiroPromptAssistantRead = {
  readonly logFound: boolean;
  readonly size: number | null;
  readonly promptFound: boolean;
  readonly texts: readonly string[];
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
  readonly text: string | null;
  readonly assistantEvents: readonly AssistantEventSnapshot[];
  readonly toolsUsed: readonly string[];
}> {
  const intervalMs = options.intervalMs ?? 50;
  let lastResult: { text: string | null; assistantEvents: readonly AssistantEventSnapshot[]; toolsUsed: readonly string[] } = {
    text: null,
    assistantEvents: [],
    toolsUsed: [],
  };
  let sawLog = false;

  for (;;) {
    options.throwIfStopped?.();
    const snapshot = await readKiroTurnResultText(options.sessionId, options.fromOffset, options.env);
    sawLog ||= snapshot.logFound;
    if (snapshot.text !== null || snapshot.assistantEvents.length > 0) {
      lastResult = {
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
        );
      }
      return lastResult;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, options.deadlineMs - now)));
  }
}

export async function waitForKiroPromptScopedAssistantTexts(options: {
  readonly sessionId: string;
  readonly fromOffset: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly deadlineMs: number;
  readonly intervalMs?: number;
  readonly throwIfStopped?: () => void;
}): Promise<readonly string[]> {
  const intervalMs = options.intervalMs ?? 50;
  let sawLog = false;
  let sawPrompt = false;
  let lastTexts: readonly string[] = [];

  for (;;) {
    options.throwIfStopped?.();
    const snapshot = await readKiroPromptScopedAssistantText(
      options.sessionId,
      options.fromOffset,
      options.env,
    );
    sawLog ||= snapshot.logFound;
    sawPrompt ||= snapshot.promptFound;
    if (snapshot.texts.length > 0) {
      lastTexts = snapshot.texts;
    }
    options.throwIfStopped?.();
    const now = Date.now();
    if (now >= options.deadlineMs) {
      if (lastTexts.length > 0) {
        return lastTexts;
      }
      if (!sawLog) {
        throw new OpenPError(
          `Kiro session log not found for session ${options.sessionId}`,
          EXIT_CODES.sessionLogNotFound,
        );
      }
      throw new OpenPError(
        sawPrompt
          ? 'Kiro session log did not flush assistant text for setup prompt'
          : 'Kiro session log did not contain setup prompt',
        EXIT_CODES.protocolViolation,
      );
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
    return { logFound: false, size: null, text: null, assistantEvents: [], toolsUsed: [] };
  }

  let size: number;
  try {
    size = (await stat(logPath)).size;
  } catch {
    return { logFound: false, size: null, text: null, assistantEvents: [], toolsUsed: [] };
  }
  if (size <= fromOffset) {
    return { logFound: true, size, text: null, assistantEvents: [], toolsUsed: [] };
  }
  const result = extractKiroTurnResult(await readTextFromOffset(logPath, fromOffset, size));
  return {
    logFound: true,
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
  let sawPrompt = false;

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

    if (event.kind === 'Prompt') {
      sawPrompt = true;
      assistantMessages.length = 0;
      assistantEvents.length = 0;
      toolsUsed.clear();
      continue;
    }
    if (!sawPrompt) {
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

export function extractKiroPromptScopedAssistantText(rawLogSegment: string): {
  readonly promptFound: boolean;
  readonly text: string | null;
  readonly texts: readonly string[];
} {
  const assistantMessages: string[] = [];
  let collecting = false;
  let promptFound = false;

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

    if (event.kind === 'Prompt') {
      collecting = !promptFound;
      promptFound = true;
      assistantMessages.length = 0;
      continue;
    }
    if (!collecting || event.kind !== 'AssistantMessage') {
      continue;
    }

    const text = extractAssistantMessageText(asObject(event.data));
    if (text) {
      assistantMessages.push(text);
    }
  }

  return {
    promptFound,
    text: assistantMessages.length > 0 ? assistantMessages.join('\n\n') : null,
    texts: assistantMessages,
  };
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

async function readKiroPromptScopedAssistantText(
  sessionId: string,
  fromOffset: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<KiroPromptAssistantRead> {
  const logPath = resolveKiroSessionLogPath(sessionId, env);
  if (!logPath) {
    return { logFound: false, size: null, promptFound: false, texts: [] };
  }

  let size: number;
  try {
    size = (await stat(logPath)).size;
  } catch {
    return { logFound: false, size: null, promptFound: false, texts: [] };
  }
  if (size <= fromOffset) {
    return { logFound: true, size, promptFound: false, texts: [] };
  }

  const extracted = extractKiroPromptScopedAssistantText(
    await readTextFromOffset(logPath, fromOffset, size),
  );
  return {
    logFound: true,
    size,
    promptFound: extracted.promptFound,
    texts: extracted.texts,
  };
}
