import type { AssistantEventSnapshot } from './types.js';
import type { WorkerTurnDiagnostics } from './worker-types.js';

interface JsonObject {
  readonly [key: string]: unknown;
}

export interface StreamJsonParserOptions {
  readonly contextWindowsByModel?: Readonly<Record<string, number>>;
  readonly contextWindow?: number | null;
  readonly onIntermediateText?: (text: string) => void;
  readonly onBackgroundAssistantText?: (text: string) => void;
}

export interface StreamJsonTurnResult {
  readonly content: string;
  readonly reasoningContent: string | null;
  readonly structuredOutput?: unknown;
  readonly assistantEvents?: readonly AssistantEventSnapshot[];
  readonly sessionId: string | null;
  readonly diagnostics: WorkerTurnDiagnostics;
  readonly backgroundTexts: readonly string[];
}

interface ParserState {
  resultContent: string | null;
  sessionId: string | null;
  numTurns: number | null;
  durationMs: number | null;
  totalCostUsd: number | null;
  stopReason: string | null;
  toolsUsed: Set<string>;
  lastUsage: UsageSnapshot;
  rawUsage: Record<string, unknown> | null;
  lastModel: string | null;
  resultContextWindow: number | null;
  autoCompacted: boolean | null;
  activeAssistantTexts: string[];
  lastActiveAssistantMessageId: string | null;
  lastActiveAssistantTextBlockCount: number;
  lastActiveAssistantHadTerminalStop: boolean;
  lastPublishedIntermediate: string | null;
  intermediateTextCount: number;
  reasoningTexts: string[];
  assistantEvents: AssistantEventSnapshot[];
  inBackgroundTask: boolean;
  skipNextResultForBackground: boolean;
  backgroundTexts: string[];
  pendingBackgroundTexts: string[];
  lastFlushedBackgroundText: string | null;
  deferredResultAfterBackground: JsonObject | null;
  tentativeResultBeforeBackgroundText: JsonObject | null;
  structuredOutput: unknown;
}

interface UsageSnapshot {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadInputTokens: number | null;
}

const EMPTY_USAGE: UsageSnapshot = {
  inputTokens: null,
  outputTokens: null,
  cacheReadInputTokens: null,
};

export function parseStreamJsonLines(
  lines: readonly string[],
  options: StreamJsonParserOptions = {},
): StreamJsonTurnResult | null {
  const state: ParserState = {
    resultContent: null,
    sessionId: null,
    numTurns: null,
    durationMs: null,
    totalCostUsd: null,
    stopReason: null,
    toolsUsed: new Set(),
    lastUsage: EMPTY_USAGE,
    rawUsage: null,
    lastModel: null,
    resultContextWindow: null,
    autoCompacted: null,
    activeAssistantTexts: [],
    lastActiveAssistantMessageId: null,
    lastActiveAssistantTextBlockCount: 0,
    lastActiveAssistantHadTerminalStop: false,
    lastPublishedIntermediate: null,
    intermediateTextCount: 0,
    reasoningTexts: [],
    assistantEvents: [],
    inBackgroundTask: false,
    skipNextResultForBackground: false,
    backgroundTexts: [],
    pendingBackgroundTexts: [],
    lastFlushedBackgroundText: null,
    deferredResultAfterBackground: null,
    tentativeResultBeforeBackgroundText: null,
    structuredOutput: undefined,
  };

  for (const line of lines) {
    const event = normalizeOpenPEvent(parseJsonObject(line));
    if (!event) continue;
    consumeStreamJsonEvent(state, event, options);
  }

  flushBackgroundText(state, options);

  if (state.resultContent === null) {
    return null;
  }
  const hasStructuredOutput = state.structuredOutput !== undefined;
  const resultContent = state.resultContent.trim().length === 0 && hasStructuredOutput
    ? JSON.stringify(state.structuredOutput)
    : state.resultContent;

  const contextWindow = state.resultContextWindow ?? resolveContextWindow(state.lastModel, options);
  const lastSubturnContextTokens =
    state.lastUsage.inputTokens === null || state.lastUsage.cacheReadInputTokens === null
      ? null
      : state.lastUsage.inputTokens + state.lastUsage.cacheReadInputTokens;

  const result: StreamJsonTurnResult = {
    content: resultContent,
    reasoningContent: buildReasoningContent(state),
    ...(state.assistantEvents.length > 0 ? { assistantEvents: [...state.assistantEvents] } : {}),
    sessionId: state.sessionId,
    diagnostics: {
      numTurns: state.numTurns,
      inputTokens: state.lastUsage.inputTokens,
      outputTokens: state.lastUsage.outputTokens,
      cacheReadInputTokens: state.lastUsage.cacheReadInputTokens,
      contextWindow,
      lastSubturnContextTokens,
      durationMs: state.durationMs,
      totalCostUsd: state.totalCostUsd,
      stopReason: state.stopReason,
      toolsUsed: [...state.toolsUsed],
      autoCompacted: state.autoCompacted,
      intermediateTextCount: state.intermediateTextCount,
      ...(state.rawUsage ? { rawUsage: state.rawUsage } : {}),
    },
    backgroundTexts: state.backgroundTexts,
  };
  return state.structuredOutput === undefined
    ? result
    : { ...result, structuredOutput: state.structuredOutput };
}

function normalizeOpenPEvent(event: JsonObject | null): JsonObject | null {
  if (!event) {
    return null;
  }
  const openp = asObject(event.openp);
  if (!openp || Object.keys(event).length !== 1) {
    return event;
  }
  return openPToParserEvent(openp);
}

function openPToParserEvent(openp: JsonObject): JsonObject {
  const metadata = asObject(openp.metadata) ?? {};
  const sessionId = typeof openp.sessionId === 'string' ? openp.sessionId : null;
  const output = asObject(openp.output);
  if (openp.form === 'result' && output) {
    return compactObject({
      type: 'result',
      subtype: 'success',
      session_id: sessionId ?? undefined,
      is_error: false,
      api_error_status: null,
      result: resultAnswerFromOutput(output),
      num_turns: metadata.numTurns,
      duration_ms: metadata.durationMs,
      total_cost_usd: metadata.totalCostUsd,
      stop_reason: metadata.stopReason,
      usage: snakeUsage(metadata.rawUsage ?? metadata.usage),
      structured_output: Object.prototype.hasOwnProperty.call(openp, 'structuredOutput') &&
        openp.structuredOutput !== null
        ? openp.structuredOutput
        : undefined,
      openp,
    });
  }

  if (openp.form === 'streaming' && output) {
    if (openp.scope === 'background') {
      return compactObject({
        type: 'assistant',
        session_id: sessionId ?? undefined,
        parent_tool_use_id: null,
        openp_scope: 'background',
        message: {
          type: 'message',
          role: 'assistant',
          content: openPStreamingMessageContent(output),
          stop_reason: metadata.stopReason ?? 'end_turn',
          stop_sequence: null,
          stop_details: null,
          usage: snakeUsage(metadata.usage),
        },
        openp,
      });
    }
    const toolResult = asObject(output.toolResult);
    if (toolResult) {
      return compactObject({
        type: 'user',
        session_id: sessionId ?? undefined,
        parent_tool_use_id: typeof toolResult.toolUseId === 'string' ? toolResult.toolUseId : null,
        tool_use_result: toolResult.content,
        message: {
          role: 'user',
          content: [toolResult],
        },
        openp,
      });
    }
    return compactObject({
      type: 'assistant',
      session_id: sessionId ?? undefined,
      parent_tool_use_id: null,
      request_id: typeof metadata.requestId === 'string' ? metadata.requestId : undefined,
      message: {
        type: 'message',
        role: 'assistant',
        id: typeof metadata.messageId === 'string' ? metadata.messageId : undefined,
        model: metadata.model,
        content: openPStreamingMessageContent(output),
        stop_reason: metadata.stopReason ?? null,
        stop_sequence: null,
        stop_details: null,
        usage: snakeUsage(metadata.usage),
      },
      openp,
    });
  }

  return { type: 'openp.unsupported', openp };
}

function resultAnswerFromOutput(output: JsonObject): string {
  return Array.isArray(output.answer)
    ? output.answer.filter((item): item is string => typeof item === 'string' && item.length > 0).join('\n\n')
    : '';
}

function openPStreamingMessageContent(output: JsonObject): readonly unknown[] {
  if (typeof output.answer === 'string') {
    return [{ type: 'text', text: output.answer }];
  }
  if (typeof output.reasoning === 'string') {
    return [{ type: 'thinking', thinking: output.reasoning }];
  }
  const toolCall = asObject(output.toolCall);
  if (toolCall) {
    return [toolCall];
  }
  const toolResult = asObject(output.toolResult);
  if (toolResult) {
    return [toolResult];
  }
  return [];
}

function snakeUsage(value: unknown): JsonObject | undefined {
  const usage = asObject(value);
  if (!usage) {
    return undefined;
  }
  if (
    Object.prototype.hasOwnProperty.call(usage, 'input_tokens') ||
    Object.prototype.hasOwnProperty.call(usage, 'output_tokens') ||
    Object.prototype.hasOwnProperty.call(usage, 'cache_read_input_tokens')
  ) {
    return usage;
  }
  return compactObject({
    input_tokens: usage.inputTokens ?? null,
    output_tokens: usage.outputTokens ?? null,
    cache_read_input_tokens: usage.cacheReadInputTokens ?? null,
  });
}

function compactObject<T extends Record<string, unknown>>(input: T): JsonObject {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

function consumeStreamJsonEvent(
  state: ParserState,
  event: JsonObject,
  options: StreamJsonParserOptions,
): void {
  if (event.type === 'stream_event') {
    consumeStreamEvent(state, event);
    return;
  }

  if (event.type === 'system') {
    consumeSystemEvent(state, event);
    return;
  }

  if (event.type === 'user') {
    if (isTaskNotification(event)) {
      flushBackgroundText(state, options);
      state.inBackgroundTask = true;
      return;
    }
    const snapshot = buildUserToolResultSnapshot(event);
    if (snapshot) {
      state.assistantEvents.push(snapshot);
    }
    return;
  }

  if (event.type === 'assistant') {
    if (event.openp_scope === 'background') {
      consumeBackgroundAssistantEvent(state, event, options);
      return;
    }
    const openp = asObject(event.openp);
    if (openp?.form === 'result') {
      consumeResultAssistantEvent(state, event);
      return;
    }
    consumeAssistantEvent(state, event, options);
    return;
  }

  if (event.type === 'result') {
    consumeResultEvent(state, event, options);
  }
}

function consumeBackgroundAssistantEvent(
  state: ParserState,
  event: JsonObject,
  options: StreamJsonParserOptions,
): void {
  const message = asObject(event.message);
  if (!message) return;
  const textBlocks = collectAssistantTextContent(message);
  if (textBlocks.length === 0) return;
  state.pendingBackgroundTexts.push(...textBlocks);
  flushBackgroundText(state, options);
}

function consumeStreamEvent(state: ParserState, event: JsonObject): void {
  const streamEvent = asObject(event.event);
  if (streamEvent?.type === 'message_stop') {
    state.lastActiveAssistantHadTerminalStop = true;
    state.lastActiveAssistantMessageId = null;
    state.lastActiveAssistantTextBlockCount = 0;
  }
}

function consumeSystemEvent(state: ParserState, event: JsonObject): void {
  if (typeof event.session_id === 'string') {
    state.sessionId = event.session_id;
  }
  if (typeof event.sessionId === 'string') {
    state.sessionId = event.sessionId;
  }
  if (event.subtype === 'auto_compaction' || event.subtype === 'auto_compacted') {
    state.autoCompacted = true;
  }
}

function consumeAssistantEvent(
  state: ParserState,
  event: JsonObject,
  options: StreamJsonParserOptions,
): void {
  const message = asObject(event.message);
  if (!message) return;

  if (state.inBackgroundTask) {
    const textBlocks = collectAssistantTextContent(message);
    if (textBlocks.length > 0) {
      if (state.tentativeResultBeforeBackgroundText !== null && state.resultContent === null) {
        setActiveResultFromEvent(state, state.tentativeResultBeforeBackgroundText);
        state.tentativeResultBeforeBackgroundText = null;
      }
      state.pendingBackgroundTexts.push(...textBlocks);
    }
    if (message.stop_reason === 'end_turn') {
      const backgroundText = flushBackgroundText(state, options);
      if (backgroundText !== null) {
        state.inBackgroundTask = false;
        state.skipNextResultForBackground = true;
      } else if (state.tentativeResultBeforeBackgroundText !== null && state.resultContent === null) {
        setActiveResultFromEvent(state, state.tentativeResultBeforeBackgroundText);
        state.tentativeResultBeforeBackgroundText = null;
        state.inBackgroundTask = false;
        state.skipNextResultForBackground = true;
      }
    }
    return;
  }

  if (typeof message.model === 'string') {
    state.lastModel = message.model;
  }
  if (typeof message.stop_reason === 'string') {
    state.stopReason = message.stop_reason;
  }

  const usage = asObject(message.usage);
  if (usage) {
    state.rawUsage = usage;
    state.lastUsage = {
      inputTokens: numberOrNull(usage.input_tokens),
      outputTokens: numberOrNull(usage.output_tokens),
      cacheReadInputTokens: numberOrNull(usage.cache_read_input_tokens),
    };
  }

  const isOpenPStreamingEvent = asObject(event.openp)?.form === 'streaming';
  const snapshot = !isOpenPStreamingEvent ? buildAssistantSnapshot(event) : null;
  if (snapshot) {
    state.assistantEvents.push(snapshot);
  }

  const textBlocks = collectAssistantContent(state, message);
  const messageId = typeof message.id === 'string' ? message.id : null;
  if (textBlocks.length > 0) {
    appendActiveAssistantTextBlocks(state, textBlocks, messageId);
    publishIntermediateText(state, options);
    state.lastActiveAssistantMessageId = messageId;
    state.lastActiveAssistantHadTerminalStop = typeof message.stop_reason === 'string';
  } else if (typeof message.stop_reason === 'string') {
    state.lastActiveAssistantHadTerminalStop = true;
    state.lastActiveAssistantMessageId = messageId;
  }
}

function consumeResultAssistantEvent(state: ParserState, event: JsonObject): void {
  const message = asObject(event.message);
  if (!message) return;

  if (typeof message.model === 'string') {
    state.lastModel = message.model;
  }
  if (typeof message.stop_reason === 'string') {
    state.stopReason = message.stop_reason;
  }

  const usage = asObject(message.usage);
  if (usage) {
    state.rawUsage = usage;
    state.lastUsage = {
      inputTokens: numberOrNull(usage.input_tokens),
      outputTokens: numberOrNull(usage.output_tokens),
      cacheReadInputTokens: numberOrNull(usage.cache_read_input_tokens),
    };
  }

  collectAssistantContent(state, message);
  if (typeof message.stop_reason === 'string') {
    state.lastActiveAssistantHadTerminalStop = true;
  }
}

function appendActiveAssistantTextBlocks(
  state: ParserState,
  textBlocks: readonly string[],
  messageId: string | null,
): void {
  if (shouldSkipDuplicateActiveAssistantText(state, textBlocks, messageId)) {
    return;
  }
  if (shouldReplaceActiveAssistantText(state, textBlocks, messageId)) {
    state.activeAssistantTexts.splice(
      state.activeAssistantTexts.length - state.lastActiveAssistantTextBlockCount,
      state.lastActiveAssistantTextBlockCount,
      ...textBlocks,
    );
    state.lastActiveAssistantTextBlockCount = textBlocks.length;
    return;
  }
  for (const text of textBlocks) {
    state.activeAssistantTexts.push(text);
  }
  state.lastActiveAssistantTextBlockCount = textBlocks.length;
}

function shouldSkipDuplicateActiveAssistantText(
  state: ParserState,
  textBlocks: readonly string[],
  messageId: string | null,
): boolean {
  if (isNewAssistantMessageBoundary(state, messageId)) {
    return false;
  }
  return textBlockGroupsEqual(lastActiveAssistantTextBlocks(state), textBlocks);
}

function shouldReplaceActiveAssistantText(
  state: ParserState,
  textBlocks: readonly string[],
  messageId: string | null,
): boolean {
  if (isNewAssistantMessageBoundary(state, messageId)) {
    return false;
  }
  const previousBlocks = lastActiveAssistantTextBlocks(state);
  return previousBlocks.length > 0 &&
    !textBlockGroupsEqual(previousBlocks, textBlocks) &&
    joinTextBlocks(textBlocks).startsWith(joinTextBlocks(previousBlocks));
}

function isNewAssistantMessageBoundary(state: ParserState, messageId: string | null): boolean {
  if (state.lastActiveAssistantHadTerminalStop || state.activeAssistantTexts.length === 0) {
    return true;
  }
  return messageId !== null &&
    state.lastActiveAssistantMessageId !== null &&
    messageId !== state.lastActiveAssistantMessageId;
}

function lastActiveAssistantTextBlocks(state: ParserState): readonly string[] {
  if (state.lastActiveAssistantTextBlockCount <= 0) {
    return [];
  }
  return state.activeAssistantTexts.slice(-state.lastActiveAssistantTextBlockCount);
}

function textBlockGroupsEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((text, index) => text === right[index]);
}

function collectAssistantContent(state: ParserState, message: JsonObject): string[] {
  const content = Array.isArray(message.content) ? message.content : [];
  const textBlocks: string[] = [];
  for (const rawBlock of content) {
    const block = asObject(rawBlock);
    if (!block) continue;

    if (block.type === 'tool_use' && typeof block.name === 'string') {
      state.toolsUsed.add(block.name);
      if (block.name === 'StructuredOutput' && Object.prototype.hasOwnProperty.call(block, 'input')) {
        state.structuredOutput = block.input;
      }
      continue;
    }

    if (block.type === 'text' && typeof block.text === 'string') {
      textBlocks.push(block.text);
      continue;
    }

    if (block.type === 'thinking' || block.type === 'reasoning') {
      const reasoningText = extractReasoningBlockText(block);
      if (reasoningText) {
        appendReasoningText(state, reasoningText);
      }
    }
  }
  return textBlocks;
}

function buildAssistantSnapshot(event: JsonObject): AssistantEventSnapshot | null {
  const message = asObject(event.message);
  if (!message) {
    return null;
  }
  const requestId =
    typeof event.requestId === 'string' ? event.requestId :
    typeof event.request_id === 'string' ? event.request_id :
    null;
  return {
    message: { ...message },
    ...(requestId ? { requestId } : {}),
  };
}

function buildUserToolResultSnapshot(event: JsonObject): AssistantEventSnapshot | null {
  const message = asObject(event.message);
  if (!message) {
    return null;
  }
  const content = Array.isArray(message.content)
    ? message.content.filter((block) => asObject(block)?.type === 'tool_result')
    : [];
  if (content.length === 0) {
    return null;
  }
  const requestId =
    typeof event.requestId === 'string' ? event.requestId :
    typeof event.request_id === 'string' ? event.request_id :
    null;
  return {
    message: {
      ...message,
      role: 'assistant',
      content,
      stop_reason: null,
    },
    ...(requestId ? { requestId } : {}),
  };
}

function appendReasoningText(state: ParserState, reasoningText: string): void {
  const currentText = joinTextBlocks(state.reasoningTexts);
  if (!currentText) {
    state.reasoningTexts.push(reasoningText);
    return;
  }
  if (reasoningText === currentText || isStablePrefixOfLongerText(reasoningText, currentText)) {
    return;
  }
  if (isStablePrefixOfLongerText(currentText, reasoningText)) {
    state.reasoningTexts = [reasoningText];
    return;
  }
  state.reasoningTexts.push(reasoningText);
}

function collectAssistantTextContent(message: JsonObject): string[] {
  const content = Array.isArray(message.content) ? message.content : [];
  const textBlocks: string[] = [];
  for (const rawBlock of content) {
    const block = asObject(rawBlock);
    if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
      textBlocks.push(block.text);
    }
  }
  return textBlocks;
}

function consumeResultEvent(
  state: ParserState,
  event: JsonObject,
  options: StreamJsonParserOptions,
): void {
  if (state.skipNextResultForBackground) {
    state.skipNextResultForBackground = false;
    if (state.resultContent !== null || resultMatchesBackgroundText(event, state.lastFlushedBackgroundText)) {
      return;
    }
    state.deferredResultAfterBackground = event;
    return;
  }

  if (state.inBackgroundTask) {
    if (state.pendingBackgroundTexts.length === 0 && state.resultContent === null) {
      if (state.tentativeResultBeforeBackgroundText !== null) {
        setActiveResultFromEvent(state, event);
        state.tentativeResultBeforeBackgroundText = null;
        state.inBackgroundTask = false;
        return;
      }
      state.tentativeResultBeforeBackgroundText = event;
      return;
    }
    const backgroundText = flushBackgroundText(state, options);
    state.inBackgroundTask = false;
    if (state.resultContent === null && !resultMatchesBackgroundText(event, backgroundText)) {
      state.deferredResultAfterBackground = event;
    }
    return;
  }

  if (state.resultContent !== null) {
    return;
  }

  setActiveResultFromEvent(state, event);
  state.deferredResultAfterBackground = null;
}

function publishIntermediateText(state: ParserState, options: StreamJsonParserOptions): void {
  const text = joinTextBlocks(state.activeAssistantTexts);
  if (!text || text === state.lastPublishedIntermediate) {
    return;
  }
  state.lastPublishedIntermediate = text;
  state.intermediateTextCount += 1;
  options.onIntermediateText?.(text);
}

function flushBackgroundText(state: ParserState, options: StreamJsonParserOptions): string | null {
  const text = joinTextBlocks(state.pendingBackgroundTexts);
  state.pendingBackgroundTexts = [];
  if (!text) {
    return null;
  }
  state.backgroundTexts.push(text);
  state.lastFlushedBackgroundText = text;
  options.onBackgroundAssistantText?.(text);
  return text;
}

function resultMatchesBackgroundText(event: JsonObject, backgroundText: string | null): boolean {
  return typeof event.result === 'string' &&
    backgroundText !== null &&
    normalizeText(event.result) === normalizeText(backgroundText);
}

function setActiveResultFromEvent(state: ParserState, event: JsonObject): void {
  const hasStructuredOutput = hasStructuredOutputPayload(event);
  if (!isResultSourceEvent(event, hasStructuredOutput)) {
    return;
  }
  state.resultContent = typeof event.result === 'string' ? event.result : '';
  if (Object.prototype.hasOwnProperty.call(event, 'structured_output')) {
    state.structuredOutput = event.structured_output;
  } else if (Object.prototype.hasOwnProperty.call(event, 'structuredOutput')) {
    state.structuredOutput = event.structuredOutput;
  }
  if (typeof event.session_id === 'string') {
    state.sessionId = event.session_id;
  }
  if (typeof event.sessionId === 'string') {
    state.sessionId = event.sessionId;
  }
  const openp = asObject(event.openp);
  const output = asObject(openp?.output);
  if (output) {
    for (const text of Array.isArray(output.reasoning) ? output.reasoning : []) {
      if (typeof text === 'string' && text.length > 0) {
        appendReasoningText(state, text);
      }
    }
    for (const toolCall of Array.isArray(output.toolCall) ? output.toolCall : []) {
      const item = asObject(toolCall);
      if (typeof item?.name === 'string') {
        state.toolsUsed.add(item.name);
      }
    }
  }
  state.numTurns = numberOrNull(event.num_turns ?? event.numTurns);
  state.durationMs = numberOrNull(event.duration_ms ?? event.durationMs);
  state.totalCostUsd = numberOrNull(event.total_cost_usd ?? event.totalCostUsd);
  if (state.stopReason === null && typeof event.stop_reason === 'string') {
    state.stopReason = event.stop_reason;
  }
  const usage = asObject(event.usage);
  if (usage) {
    state.rawUsage = usage;
  }
  if (!hasUsageSnapshot(state.lastUsage) && usage) {
    state.lastUsage = {
      inputTokens: numberOrNull(usage.input_tokens),
      outputTokens: numberOrNull(usage.output_tokens),
      cacheReadInputTokens: numberOrNull(usage.cache_read_input_tokens),
    };
  }
  const resultContextWindow = extractModelUsageContextWindow(event, state.lastModel);
  if (resultContextWindow !== null) {
    state.resultContextWindow = resultContextWindow;
  }
}

function hasStructuredOutputPayload(event: JsonObject): boolean {
  return Object.prototype.hasOwnProperty.call(event, 'structured_output') ||
    Object.prototype.hasOwnProperty.call(event, 'structuredOutput');
}

function isResultSourceEvent(event: JsonObject, hasStructuredOutput = hasStructuredOutputPayload(event)): boolean {
  if (isExplicitErrorResult(event)) {
    return false;
  }
  if (hasStructuredOutput) {
    return true;
  }
  return typeof event.result === 'string' && event.result.trim().length > 0;
}

function isExplicitErrorResult(event: JsonObject): boolean {
  if (event.is_error === true) {
    return true;
  }
  if (typeof event.subtype === 'string' && event.subtype !== 'success') {
    return true;
  }
  if (event.api_error_status !== null && event.api_error_status !== undefined) {
    return true;
  }
  return Object.prototype.hasOwnProperty.call(event, 'error');
}

function hasUsageSnapshot(usage: UsageSnapshot): boolean {
  return usage.inputTokens !== null || usage.outputTokens !== null || usage.cacheReadInputTokens !== null;
}

function buildReasoningContent(state: ParserState): string | null {
  const explicitReasoning = joinTextBlocks(state.reasoningTexts);
  return explicitReasoning || null;
}

function resolveContextWindow(model: string | null, options: StreamJsonParserOptions): number | null {
  if (model && options.contextWindowsByModel && Number.isFinite(options.contextWindowsByModel[model])) {
    return options.contextWindowsByModel[model];
  }
  return typeof options.contextWindow === 'number' && Number.isFinite(options.contextWindow) ? options.contextWindow : null;
}

function extractModelUsageContextWindow(event: JsonObject, model: string | null): number | null {
  const modelUsage = asObject(event.modelUsage);
  if (!modelUsage) return null;
  for (const key of Object.keys(modelUsage)) {
    const entry = asObject(modelUsage[key]);
    if (!entry) continue;
    if (typeof entry.contextWindow === 'number' && Number.isFinite(entry.contextWindow)) {
      if (model && (key === model || key.startsWith(model + '-') || key.startsWith(model + '['))) return entry.contextWindow;
      if (!model) return entry.contextWindow;
    }
  }
  if (model) {
    for (const key of Object.keys(modelUsage)) {
      const entry = asObject(modelUsage[key]);
      if (entry && typeof entry.contextWindow === 'number' && Number.isFinite(entry.contextWindow)) {
        return entry.contextWindow;
      }
    }
  }
  return null;
}

function isTaskNotification(event: JsonObject): boolean {
  const origin = asObject(event.origin);
  return origin?.kind === 'task-notification';
}

function extractReasoningBlockText(block: JsonObject): string | null {
  const candidates = [
    extractTextLike(block.text),
    extractTextLike(block.content),
    extractTextLike(block.summary),
    extractTextLike(block.thinking),
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
  return joinTextBlocks(candidates) || null;
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
  if (!trimmed || !trimmed.startsWith('{')) {
    return null;
  }
  try {
    return asObject(JSON.parse(trimmed));
  } catch {
    return null;
  }
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
