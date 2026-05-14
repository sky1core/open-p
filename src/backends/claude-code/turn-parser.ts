import type {
  AssistantContentBlock,
  AssistantEventSnapshot,
  BackendUsage,
  TurnDiagnostics,
  TurnResult,
} from '../../core/types.js';
import { EXIT_CODES, OpenPError } from '../../core/errors.js';
import { validateStructuredOutput } from '../../core/json-schema.js';

interface JsonObject {
  readonly [key: string]: unknown;
}

interface ParserState {
  inScope: boolean;
  finalText: string | null;
  completed: boolean;
  toolsUsed: string[];
  usage: BackendUsage;
  rawUsage: Record<string, unknown> | null;
  structuredOutput: unknown;
  durationMs: number | null;
  rawEventCount: number;
  stopReason: string | null;
  reasoningTexts: string[];
  fallbackFinalText: string | null;
  inBackgroundTask: boolean;
  backgroundParentUuids: Set<string>;
  ambiguousTaskNotificationText: boolean;
  activeTextSinceBackgroundStart: boolean;
  requestId: string | null;
  assistantEvents: AssistantEventSnapshot[];
}

const EMPTY_USAGE: BackendUsage = {
  inputTokens: null,
  cacheReadInputTokens: null,
  outputTokens: null,
};

export function parseClaudeCodeJsonlTurn(
  lines: readonly string[],
  turnId: string,
  options: { readonly structuredOutputRequested?: boolean; readonly jsonSchema?: unknown } = {},
): TurnResult | null {
  const state: ParserState = {
    inScope: true,
    finalText: null,
    completed: false,
    toolsUsed: [],
    usage: EMPTY_USAGE,
    rawUsage: null,
    structuredOutput: undefined,
    durationMs: null,
    rawEventCount: 0,
    stopReason: null,
    reasoningTexts: [],
    fallbackFinalText: null,
    inBackgroundTask: false,
    backgroundParentUuids: new Set(),
    ambiguousTaskNotificationText: false,
    activeTextSinceBackgroundStart: false,
    requestId: null,
    assistantEvents: [],
  };

  for (const line of lines) {
    const event = parseJsonObject(line);
    if (!event) continue;
    state.rawEventCount += 1;
    consumeEvent(state, event, turnId);
  }

  if (state.completed && state.finalText === null) {
    const fallbackText = state.fallbackFinalText;
    if (fallbackText) {
      state.finalText = fallbackText;
    } else if (state.structuredOutput !== undefined) {
      state.finalText = serializeStructuredOutput(state.structuredOutput, turnId);
    }
  }
  if (!state.completed || state.finalText === null) {
    return null;
  }
  if (state.finalText.trim().length === 0) {
    throw new OpenPError(`empty final content for turn ${turnId}`, EXIT_CODES.protocolViolation);
  }
  const structuredOutput = state.structuredOutput !== undefined
    ? state.structuredOutput
    : (options.structuredOutputRequested ? parseStructuredOutputFallback(state.finalText, turnId) : undefined);
  if (structuredOutput !== undefined && options.jsonSchema) {
    validateStructuredOutput(structuredOutput, options.jsonSchema, turnId);
  }

  const diagnostics: TurnDiagnostics = {
    durationMs: state.durationMs,
    stopReason: state.stopReason,
    toolsUsed: state.toolsUsed,
    usage: state.usage,
    rawUsage: state.rawUsage,
    rawEventCount: state.rawEventCount,
  };

  return {
    turnId,
    text: state.finalText,
    reasoningContent: buildReasoningContent(state),
    ...(structuredOutput !== undefined ? { structuredOutput } : {}),
    ...(state.requestId ? { requestId: state.requestId } : {}),
    ...(state.assistantEvents.length > 0 ? { assistantEvents: state.assistantEvents } : {}),
    diagnostics,
  };
}

export interface IntermediateContent {
  readonly text: string | null;
  readonly reasoningText: string | null;
  readonly reasoningContentBlocks: readonly AssistantContentBlock[] | null;
  readonly assistantSnapshot: AssistantEventSnapshot | null;
}

export function extractClaudeCodeIntermediateText(
  lines: readonly string[],
): string | null {
  return extractClaudeCodeIntermediateContent(lines).text;
}

export function extractClaudeCodeIntermediateContent(
  lines: readonly string[],
  options: { readonly includeTerminalAssistant?: boolean } = {},
): IntermediateContent {
  let inBackgroundTask = false;
  const backgroundParentUuids = new Set<string>();
  let pendingTextBlocks: string[] = [];
  let pendingReasoningBlocks: string[] = [];
  const pendingReasoningContentBlocks: AssistantContentBlock[] = [];
  let pendingAssistantSnapshot: AssistantEventSnapshot | null = null;

  for (const line of lines) {
    const event = parseJsonObject(line);
    if (!event) continue;
    if (event.type === 'user' && isTaskNotification(event)) {
      pendingTextBlocks = [];
      pendingReasoningBlocks = [];
      pendingReasoningContentBlocks.splice(0, pendingReasoningContentBlocks.length);
      pendingAssistantSnapshot = null;
      const uuid = stringOrNull(event.uuid);
      if (uuid) {
        backgroundParentUuids.add(uuid);
      }
      inBackgroundTask = true;
      continue;
    }
    if (isKnownBackgroundEvent(backgroundParentUuids, event)) {
      rememberBackgroundDescendant(backgroundParentUuids, event);
      if (isSyntheticNoResponseAssistant(event)) {
        inBackgroundTask = false;
        pendingTextBlocks = [];
        pendingReasoningBlocks = [];
        pendingReasoningContentBlocks.splice(0, pendingReasoningContentBlocks.length);
        pendingAssistantSnapshot = null;
        continue;
      }
      if (isBackgroundTaskEnd(event)) {
        inBackgroundTask = false;
      }
      continue;
    }
    if (event.type === 'user') {
      inBackgroundTask = false;
      pendingTextBlocks = [];
      pendingReasoningBlocks = [];
      pendingReasoningContentBlocks.splice(0, pendingReasoningContentBlocks.length);
      pendingAssistantSnapshot = null;
      continue;
    }
    if (inBackgroundTask) {
      if (!hasNonBackgroundParent(backgroundParentUuids, event) && isBackgroundTaskEnd(event)) {
        inBackgroundTask = false;
        pendingTextBlocks = [];
        pendingReasoningBlocks = [];
        pendingReasoningContentBlocks.splice(0, pendingReasoningContentBlocks.length);
        pendingAssistantSnapshot = null;
        continue;
      }
      if (!hasNonBackgroundParent(backgroundParentUuids, event)) {
        continue;
      }
    }
    if (event.type !== 'assistant') {
      continue;
    }
    if (isSyntheticNoResponseAssistant(event)) {
      continue;
    }
    if (messageStopReason(event) === 'end_turn' && !options.includeTerminalAssistant) {
      pendingTextBlocks = [];
      pendingReasoningBlocks = [];
      pendingReasoningContentBlocks.splice(0, pendingReasoningContentBlocks.length);
      pendingAssistantSnapshot = null;
      continue;
    }

    const message = asObject(event.message);
    const content = Array.isArray(message?.content) ? message.content : [];
    const eventTextBlocks: string[] = [];
    const eventReasoningBlocks: string[] = [];
    const eventReasoningContentBlocks: AssistantContentBlock[] = [];
    for (const block of content) {
      const item = asObject(block);
      if (!item) continue;
      if (item.type === 'text' && typeof item.text === 'string' && item.text.trim()) {
        eventTextBlocks.push(item.text);
      } else if (item.type === 'thinking' || item.type === 'reasoning') {
        const reasoningText = extractReasoningBlockText(item);
        if (reasoningText) {
          appendReasoningContent(
            eventReasoningBlocks,
            eventReasoningContentBlocks,
            reasoningText,
            [item],
          );
        }
      }
    }
    if (eventTextBlocks.length > 0) {
      pendingTextBlocks = eventTextBlocks;
    }
    if (eventReasoningBlocks.length > 0) {
      appendReasoningContent(
        pendingReasoningBlocks,
        pendingReasoningContentBlocks,
        joinTextBlocks(eventReasoningBlocks),
        eventReasoningContentBlocks,
      );
    }
    if (eventTextBlocks.length > 0 || eventReasoningBlocks.length > 0) {
      pendingAssistantSnapshot = buildAssistantSnapshot(event);
    }
  }

  return {
    text: pendingTextBlocks.length > 0 ? pendingTextBlocks.join('\n\n') : null,
    reasoningText: pendingReasoningBlocks.length > 0 ? pendingReasoningBlocks.join('\n\n') : null,
    reasoningContentBlocks: pendingReasoningContentBlocks.length > 0
      ? [...pendingReasoningContentBlocks]
      : null,
    assistantSnapshot: pendingAssistantSnapshot,
  };
}

function consumeEvent(state: ParserState, event: JsonObject, turnId: string): void {
  if (event.type === 'user' && !isTaskNotification(event)) {
    state.finalText = null;
    state.completed = false;
    state.toolsUsed = [];
    state.usage = EMPTY_USAGE;
    state.rawUsage = null;
    state.structuredOutput = undefined;
    state.durationMs = null;
    state.stopReason = null;
    state.reasoningTexts = [];
    state.fallbackFinalText = null;
    state.inBackgroundTask = false;
    state.backgroundParentUuids.clear();
    state.ambiguousTaskNotificationText = false;
    state.activeTextSinceBackgroundStart = false;
    state.requestId = null;
    state.assistantEvents = [];
    return;
  }

  if (!state.inScope) {
    return;
  }

  if (event.type === 'user' && isTaskNotification(event)) {
    const uuid = stringOrNull(event.uuid);
    if (uuid) {
      state.backgroundParentUuids.add(uuid);
    }
    state.inBackgroundTask = true;
    state.activeTextSinceBackgroundStart = false;
    return;
  }

  if (isKnownBackgroundEvent(state.backgroundParentUuids, event)) {
    rememberBackgroundDescendant(state.backgroundParentUuids, event);
    if (isSyntheticNoResponseAssistant(event)) {
      state.inBackgroundTask = false;
      return;
    }
    if (isBackgroundTaskEnd(event)) {
      state.inBackgroundTask = false;
    }
    return;
  }

  if (state.inBackgroundTask) {
    if (!hasNonBackgroundParent(state.backgroundParentUuids, event)) {
      if (event.type === 'system' && event.subtype === 'turn_duration') {
        if (!state.activeTextSinceBackgroundStart) {
          state.ambiguousTaskNotificationText = true;
        }
        consumeTurnDuration(state, event, turnId);
        return;
      }
      if (event.type === 'assistant' && assistantHasCompletionCandidate(event) && !state.activeTextSinceBackgroundStart) {
        state.ambiguousTaskNotificationText = true;
      }
      if (isBackgroundTaskEnd(event)) {
        state.inBackgroundTask = false;
      }
      return;
    }
  }

  if (isSyntheticNoResponseAssistant(event)) {
    return;
  }

  if (event.type === 'assistant') {
    const activeDuringBackground = state.inBackgroundTask;
    consumeAssistantEvent(state, event);
    if (activeDuringBackground && assistantHasCompletionCandidate(event)) {
      state.activeTextSinceBackgroundStart = true;
    }
    return;
  }

  if (event.type === 'system' && event.subtype === 'turn_duration') {
    consumeTurnDuration(state, event, turnId);
  }
}

function consumeAssistantEvent(state: ParserState, event: JsonObject): void {
  const requestId = stringOrNull(event.requestId) ?? stringOrNull(event.request_id);
  if (requestId) {
    state.requestId = requestId;
  }

  const message = asObject(event.message);
  state.stopReason = typeof message?.stop_reason === 'string' ? message.stop_reason : null;
  const snapshot = buildAssistantSnapshot(event);
  if (snapshot) {
    state.assistantEvents.push(snapshot);
  }
  const usage = asObject(message?.usage);
  if (usage) {
    state.rawUsage = usage;
    state.usage = {
      inputTokens: numberOrNull(usage.input_tokens),
      cacheReadInputTokens: numberOrNull(usage.cache_read_input_tokens),
      outputTokens: numberOrNull(usage.output_tokens),
    };
  }

  const content = Array.isArray(message?.content) ? message.content : [];
  const eventTextBlocks: string[] = [];
  for (const block of content) {
    const item = asObject(block);
    if (!item) continue;
    if (item.type === 'tool_use' && typeof item.name === 'string' && !state.toolsUsed.includes(item.name)) {
      state.toolsUsed.push(item.name);
    }
    if (item.type === 'tool_use' && item.name === 'StructuredOutput' && Object.prototype.hasOwnProperty.call(item, 'input')) {
      state.structuredOutput = item.input;
    }
    if ((item.type === 'thinking' || item.type === 'reasoning')) {
      const reasoningText = extractReasoningBlockText(item);
      if (reasoningText) {
        appendReasoningText(state.reasoningTexts, reasoningText);
      }
    }
    if (item.type === 'text' && typeof item.text === 'string') {
      if (item.text.trim()) {
        eventTextBlocks.push(item.text);
      }
    }
  }
  if (eventTextBlocks.length > 0) {
    state.fallbackFinalText = joinTextBlocks(eventTextBlocks);
  }
}

function buildAssistantSnapshot(event: JsonObject): AssistantEventSnapshot | null {
  const message = asObject(event.message);
  if (!message) {
    return null;
  }
  const requestId = stringOrNull(event.requestId) ?? stringOrNull(event.request_id);
  return {
    message: normalizeAssistantMessage(message),
    ...(requestId ? { requestId } : {}),
  };
}

function normalizeAssistantMessage(message: JsonObject): Record<string, unknown> {
  return {
    ...(typeof message.model === 'string' ? { model: message.model } : {}),
    ...(typeof message.id === 'string' ? { id: message.id } : {}),
    type: typeof message.type === 'string' ? message.type : 'message',
    role: typeof message.role === 'string' ? message.role : 'assistant',
    content: Array.isArray(message.content) ? message.content : [],
    stop_reason: Object.prototype.hasOwnProperty.call(message, 'stop_reason') ? message.stop_reason : null,
    stop_sequence: Object.prototype.hasOwnProperty.call(message, 'stop_sequence') ? message.stop_sequence : null,
    stop_details: Object.prototype.hasOwnProperty.call(message, 'stop_details') ? message.stop_details : null,
    ...(asObject(message.usage) ? { usage: message.usage } : {}),
    diagnostics: Object.prototype.hasOwnProperty.call(message, 'diagnostics') ? message.diagnostics : null,
    context_management: Object.prototype.hasOwnProperty.call(message, 'context_management') ? message.context_management : null,
  };
}

function consumeTurnDuration(state: ParserState, event: JsonObject, turnId: string): void {
  if (state.ambiguousTaskNotificationText) {
    throw new OpenPError(`ambiguous task-notification interleave for turn ${turnId}`, EXIT_CODES.protocolViolation);
  }
  state.completed = true;
  state.durationMs = typeof event.durationMs === 'number' ? event.durationMs : null;
  if (state.finalText === null) {
    const fallbackText = state.fallbackFinalText;
    if (!fallbackText) {
      if (state.structuredOutput !== undefined) {
        state.finalText = serializeStructuredOutput(state.structuredOutput, turnId);
      } else {
        return;
      }
    } else {
      state.finalText = fallbackText;
    }
  }
}

function buildReasoningContent(state: ParserState): string | null {
  const explicitReasoning = joinTextBlocks(state.reasoningTexts);
  return explicitReasoning || null;
}

function appendReasoningText(texts: string[], reasoningText: string): void {
  appendReasoningContent(texts, [], reasoningText, []);
}

function appendReasoningContent(
  texts: string[],
  contentBlocks: AssistantContentBlock[],
  reasoningText: string,
  nextContentBlocks: readonly AssistantContentBlock[],
): void {
  const currentText = joinTextBlocks(texts);
  if (!currentText) {
    texts.push(reasoningText);
    contentBlocks.push(...nextContentBlocks);
    return;
  }
  if (reasoningText === currentText || isStablePrefixOfLongerText(reasoningText, currentText)) {
    return;
  }
  if (isStablePrefixOfLongerText(currentText, reasoningText)) {
    texts.splice(0, texts.length, reasoningText);
    contentBlocks.splice(0, contentBlocks.length, ...nextContentBlocks);
    return;
  }
  texts.push(reasoningText);
  contentBlocks.push(...nextContentBlocks);
}

function isTaskNotification(event: JsonObject): boolean {
  const origin = asObject(event.origin);
  return origin?.kind === 'task-notification';
}

function isBackgroundTaskEnd(event: JsonObject): boolean {
  if (event.type === 'result') {
    return true;
  }
  if (event.type !== 'assistant') {
    return false;
  }
  const message = asObject(event.message);
  return message?.stop_reason === 'end_turn';
}

function isKnownBackgroundEvent(backgroundParentUuids: Set<string>, event: JsonObject): boolean {
  const parentUuid = stringOrNull(event.parentUuid);
  return parentUuid !== null && backgroundParentUuids.has(parentUuid);
}

function hasNonBackgroundParent(backgroundParentUuids: Set<string>, event: JsonObject): boolean {
  const parentUuid = stringOrNull(event.parentUuid);
  return parentUuid !== null && !backgroundParentUuids.has(parentUuid);
}

function rememberBackgroundDescendant(backgroundParentUuids: Set<string>, event: JsonObject): void {
  const uuid = stringOrNull(event.uuid);
  if (uuid) {
    backgroundParentUuids.add(uuid);
  }
}

function assistantHasText(event: JsonObject): boolean {
  const message = asObject(event.message);
  const content = Array.isArray(message?.content) ? message.content : [];
  return content.some((block) => {
    const item = asObject(block);
    return item?.type === 'text' && typeof item.text === 'string' && item.text.trim().length > 0;
  });
}

function assistantHasCompletionCandidate(event: JsonObject): boolean {
  if (assistantHasText(event)) {
    return true;
  }
  const message = asObject(event.message);
  const content = Array.isArray(message?.content) ? message.content : [];
  return content.some((block) => {
    const item = asObject(block);
    return item?.type === 'tool_use' &&
      item.name === 'StructuredOutput' &&
      Object.prototype.hasOwnProperty.call(item, 'input');
  });
}

function messageStopReason(event: JsonObject): string | null {
  const message = asObject(event.message);
  return typeof message?.stop_reason === 'string' ? message.stop_reason : null;
}

function isSyntheticNoResponseAssistant(event: JsonObject): boolean {
  if (event.type !== 'assistant') {
    return false;
  }
  const message = asObject(event.message);
  if (message?.model !== '<synthetic>') {
    return false;
  }
  const content = Array.isArray(message.content) ? message.content : [];
  const textBlocks = content
    .map((block) => asObject(block))
    .filter((block): block is JsonObject => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => (block.text as string).trim())
    .filter((text) => text.length > 0);
  return textBlocks.length === 1 && textBlocks[0] === 'No response requested.';
}

function serializeStructuredOutput(value: unknown, turnId: string): string {
  const text = JSON.stringify(value);
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new OpenPError(`structured output for turn ${turnId} could not be serialized`, EXIT_CODES.protocolViolation);
  }
  return text;
}

function extractReasoningBlockText(block: JsonObject): string | null {
  const parts = [
    extractTextLike(block.text),
    extractTextLike(block.content),
    extractTextLike(block.summary),
    extractTextLike(block.thinking),
  ].filter((text): text is string => typeof text === 'string' && text.length > 0);
  return joinTextBlocks(parts) || null;
}

function extractTextLike(value: unknown): string | null {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return joinTextBlocks(value.map(extractTextLike).filter((text): text is string => text !== null)) || null;
  }
  const object = asObject(value);
  if (!object) {
    return null;
  }
  return extractTextLike(object.text) ?? extractTextLike(object.content) ?? extractTextLike(object.summary);
}

function joinTextBlocks(blocks: readonly string[]): string {
  return blocks.filter((block) => block.trim()).join('\n\n');
}

function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

function isStablePrefixOfLongerText(candidate: string, previous: string): boolean {
  const normalizedCandidate = normalizeText(candidate);
  const normalizedPrevious = normalizeText(previous);
  return normalizedCandidate.length > 0 &&
    normalizedPrevious.length > normalizedCandidate.length &&
    normalizedPrevious.startsWith(normalizedCandidate);
}

function parseJsonObject(line: string): JsonObject | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return asObject(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

function parseStructuredOutputFallback(text: string, turnId: string): unknown {
  const candidate = extractStructuredOutputCandidate(text);
  try {
    return JSON.parse(candidate);
  } catch {
    throw new OpenPError(`structured output for turn ${turnId} was not valid JSON`, EXIT_CODES.protocolViolation);
  }
}

function extractStructuredOutputCandidate(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```json[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(trimmed);
  return fenced?.[1]?.trim() ?? trimmed;
}

function asObject(value: unknown): JsonObject | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as JsonObject;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
