import { EXIT_CODES, OpenPError } from '../../core/errors.js';
import type { AssistantEventSnapshot, BackendUsage } from '../../core/types.js';

export interface OpenCodeParsedOutput {
  readonly content: string;
  readonly sessionId: string | null;
  readonly assistantEvents: readonly AssistantEventSnapshot[];
  readonly usage: BackendUsage;
  readonly rawUsage: Record<string, unknown> | null;
  readonly rawEventCount: number;
  readonly model: string | null;
  readonly toolsUsed: readonly string[];
  readonly errorMessage: string | null;
}

export function parseOpenCodeJsonOutput(stdout: string): OpenCodeParsedOutput {
  const events = parseJsonEvents(stdout);
  let sessionId: string | null = null;
  let resultText: string | null = null;
  const assistantTexts: string[] = [];
  const assistantEvents: AssistantEventSnapshot[] = [];
  const toolsUsed = new Set<string>();
  let errorMessage: string | null = null;
  let rawUsage: Record<string, unknown> | null = null;
  let model: string | null = null;

  for (const event of events) {
    const object = asRecord(event);
    if (!object) continue;
    sessionId ??= readSessionId(object);
    model ??= readString(object.model);
    if (isExplicitErrorEvent(object)) {
      errorMessage = readOpenCodeError(object) ?? 'OpenCode returned an error event';
      continue;
    }
    const text = readResultText(object);
    if (text !== null) {
      resultText = text;
    }
    const textPart = readTextPart(object);
    if (textPart) {
      assistantTexts.push(textPart);
      assistantEvents.push({
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: textPart }],
        },
      });
    }
    const assistantMessage = readAssistantMessage(object);
    const assistantText = assistantMessage ? readAssistantText(assistantMessage) : null;
    if (assistantMessage && assistantText) {
      assistantTexts.push(assistantText);
      assistantEvents.push({
        message: assistantMessage,
      });
    }
    const usage = asRecord(object.usage) ?? asRecord(asRecord(object.part)?.tokens);
    if (usage) {
      rawUsage = usage;
    }
    const toolName = readToolName(object);
    if (toolName) {
      toolsUsed.add(toolName);
    }
    const toolBlock = buildToolContentBlock(object);
    if (toolBlock) {
      assistantEvents.push({
        message: {
          role: 'assistant',
          content: [toolBlock],
        },
      });
    }
  }

  const content = resultText ?? assistantTexts.join('\n\n');
  return {
    content,
    sessionId,
    assistantEvents,
    usage: normalizeUsage(rawUsage),
    rawUsage,
    rawEventCount: events.length,
    model,
    toolsUsed: [...toolsUsed],
    errorMessage,
  };
}

function parseJsonEvents(stdout: string): readonly unknown[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    // fall through to JSONL parse
  }
  const events: unknown[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const value = line.trim();
    if (!value) continue;
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) events.push(...parsed);
      else events.push(parsed);
    } catch {
      throw new OpenPError('OpenCode returned non-JSON output', EXIT_CODES.protocolViolation);
    }
  }
  return events;
}

function readSessionId(object: Record<string, unknown>): string | null {
  return readString(object.sessionID) ??
    readString(object.sessionId) ??
    readString(object.session_id) ??
    readString(asRecord(object.message)?.sessionID) ??
    readString(asRecord(object.message)?.sessionId) ??
    null;
}

function readResultText(object: Record<string, unknown>): string | null {
  const type = readString(object.type);
  if (type !== 'result') return null;
  if (typeof object.result === 'string') return object.result;
  if (typeof object.text === 'string') return object.text;
  if (typeof object.content === 'string') return object.content;
  return null;
}

function readTextPart(object: Record<string, unknown>): string | null {
  if (object.type !== 'text') return null;
  const part = asRecord(object.part);
  return readString(part?.text) ?? readString(object.text);
}

function readAssistantMessage(object: Record<string, unknown>): Record<string, unknown> | null {
  const message = asRecord(object.message);
  if (message?.role === 'assistant') {
    return message;
  }
  if (object.role === 'assistant') {
    return object;
  }
  if (object.type === 'assistant') {
    return message ? { ...message, role: 'assistant' } : { ...object, role: 'assistant' };
  }
  return null;
}

function readAssistantText(message: Record<string, unknown>): string | null {
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    const item = asRecord(block);
    if (!item) continue;
    if (item.type === 'text' && typeof item.text === 'string') {
      parts.push(item.text);
    }
  }
  return parts.length > 0 ? parts.join('') : null;
}

function readOpenCodeError(object: Record<string, unknown>): string | null {
  const error = asRecord(object.error);
  if (!error) return readString(object.message) ?? readString(object.result) ?? readString(object.text);
  const data = asRecord(error.data);
  return readString(data?.message) ?? readString(error.message) ?? readString(error.name);
}

function readToolName(object: Record<string, unknown>): string | null {
  if (typeof object.tool === 'string') return object.tool;
  if (typeof object.name === 'string' && (object.type === 'tool' || object.type === 'tool_call')) return object.name;
  const tool = asRecord(object.tool);
  return readString(tool?.name);
}

function isExplicitErrorEvent(object: Record<string, unknown>): boolean {
  if (isToolResultEvent(object)) return false;
  if (object.type === 'error') return true;
  if (Object.prototype.hasOwnProperty.call(object, 'error')) return true;
  if (object.is_error === true) return true;
  if (Object.prototype.hasOwnProperty.call(object, 'api_error_status') && object.api_error_status !== null) return true;
  if (typeof object.subtype === 'string' && object.subtype !== 'success') return true;
  return false;
}

function buildToolContentBlock(object: Record<string, unknown>): Record<string, unknown> | null {
  const type = readString(object.type);
  if (isToolResultEvent(object)) {
    return {
      type: 'tool_result',
      tool_use_id: readString(object.toolUseId) ?? readString(object.tool_use_id) ?? readString(object.callID) ?? readString(object.call_id),
      content: Object.prototype.hasOwnProperty.call(object, 'content') ? object.content : object.result,
      ...(typeof object.is_error === 'boolean' ? { is_error: object.is_error } : {}),
    };
  }
  if (type === 'tool' || type === 'tool_call' || type === 'tool_use') {
    const tool = asRecord(object.tool);
    return {
      type: 'tool_use',
      id: readString(object.id) ?? readString(object.toolUseId) ?? readString(object.tool_use_id) ?? readString(object.callID) ?? readString(object.call_id),
      name: readString(object.name) ?? readString(tool?.name) ?? 'opencode_tool',
      input: Object.prototype.hasOwnProperty.call(object, 'input')
        ? object.input
        : Object.prototype.hasOwnProperty.call(object, 'args')
          ? object.args
          : Object.prototype.hasOwnProperty.call(object, 'arguments')
            ? object.arguments
            : undefined,
      caller: { type: 'opencode' },
    };
  }
  return null;
}

function isToolResultEvent(object: Record<string, unknown>): boolean {
  const type = readString(object.type);
  return type === 'tool_result' || type === 'tool_result_delta';
}

function normalizeUsage(rawUsage: Record<string, unknown> | null): BackendUsage {
  const cache = asRecord(rawUsage?.cache);
  return {
    inputTokens: readNumber(rawUsage?.input_tokens) ?? readNumber(rawUsage?.inputTokens) ?? readNumber(rawUsage?.input) ?? null,
    outputTokens: readNumber(rawUsage?.output_tokens) ?? readNumber(rawUsage?.outputTokens) ?? readNumber(rawUsage?.output) ?? null,
    cacheReadInputTokens: readNumber(rawUsage?.cache_read_input_tokens) ??
      readNumber(rawUsage?.cacheReadInputTokens) ??
      readNumber(cache?.read) ??
      null,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
