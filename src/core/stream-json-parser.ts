import type { WorkerTurnDiagnostics } from './worker-types.js';
import { EXIT_CODES, OpenPError } from './errors.js';

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
  readonly sessionId: string | null;
  readonly diagnostics: WorkerTurnDiagnostics;
  readonly backgroundTexts: readonly string[];
}

interface ParserState {
  finalContent: string | null;
  sessionId: string | null;
  numTurns: number | null;
  durationMs: number | null;
  totalCostUsd: number | null;
  stopReason: string | null;
  toolsUsed: Set<string>;
  lastUsage: UsageSnapshot;
  rawUsage: Record<string, unknown> | null;
  lastModel: string | null;
  autoCompacted: boolean | null;
  activeAssistantTexts: string[];
  lastActiveAssistantMessageId: string | null;
  lastActiveAssistantTextBlockCount: number;
  lastActiveAssistantHadTerminalStop: boolean;
  lastPublishedIntermediate: string | null;
  intermediateTextCount: number;
  reasoningTexts: string[];
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
    finalContent: null,
    sessionId: null,
    numTurns: null,
    durationMs: null,
    totalCostUsd: null,
    stopReason: null,
    toolsUsed: new Set(),
    lastUsage: EMPTY_USAGE,
    rawUsage: null,
    lastModel: null,
    autoCompacted: null,
    activeAssistantTexts: [],
    lastActiveAssistantMessageId: null,
    lastActiveAssistantTextBlockCount: 0,
    lastActiveAssistantHadTerminalStop: false,
    lastPublishedIntermediate: null,
    intermediateTextCount: 0,
    reasoningTexts: [],
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
    const event = parseJsonObject(line);
    if (!event) continue;
    consumeStreamJsonEvent(state, event, options);
  }

  flushBackgroundText(state, options);

  if (state.finalContent === null) {
    return null;
  }
  const hasStructuredOutput = state.structuredOutput !== undefined;
  if (state.finalContent.trim().length === 0 && !hasStructuredOutput) {
    throw new OpenPError('empty final content in stream-json result', EXIT_CODES.protocolViolation);
  }
  const finalContent = state.finalContent.trim().length === 0 && hasStructuredOutput
    ? JSON.stringify(state.structuredOutput)
    : state.finalContent;

  const contextWindow = resolveContextWindow(state.lastModel, options);
  const lastSubturnContextTokens =
    state.lastUsage.inputTokens === null || state.lastUsage.cacheReadInputTokens === null
      ? null
      : state.lastUsage.inputTokens + state.lastUsage.cacheReadInputTokens;

  const result: StreamJsonTurnResult = {
    content: finalContent,
    reasoningContent: buildReasoningContent(state),
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

function consumeStreamJsonEvent(
  state: ParserState,
  event: JsonObject,
  options: StreamJsonParserOptions,
): void {
  if (event.type === 'system') {
    consumeSystemEvent(state, event);
    return;
  }

  if (event.type === 'user') {
    if (isTaskNotification(event)) {
      flushBackgroundText(state, options);
      state.inBackgroundTask = true;
    }
    return;
  }

  if (event.type === 'assistant') {
    consumeAssistantEvent(state, event, options);
    return;
  }

  if (event.type === 'result') {
    consumeResultEvent(state, event, options);
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
      if (state.tentativeResultBeforeBackgroundText !== null && state.finalContent === null) {
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
      } else if (state.tentativeResultBeforeBackgroundText !== null && state.finalContent === null) {
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

  const textBlocks = collectAssistantContent(state, message);
  const messageId = typeof message.id === 'string' ? message.id : null;
  if (textBlocks.length > 0) {
    appendActiveAssistantTextBlocks(state, textBlocks, messageId);
    publishIntermediateText(state, options);
    state.lastActiveAssistantMessageId = messageId;
    state.lastActiveAssistantHadTerminalStop = typeof message.stop_reason === 'string';
  } else if (typeof message.stop_reason === 'string') {
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
    if (state.finalContent !== null || resultMatchesBackgroundText(event, state.lastFlushedBackgroundText)) {
      return;
    }
    state.deferredResultAfterBackground = event;
    return;
  }

  if (state.inBackgroundTask) {
    if (state.pendingBackgroundTexts.length === 0 && state.finalContent === null) {
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
    if (state.finalContent === null && !resultMatchesBackgroundText(event, backgroundText)) {
      state.deferredResultAfterBackground = event;
    }
    return;
  }

  if (state.finalContent !== null) {
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
  if (typeof event.result === 'string') {
    state.finalContent = event.result;
  }
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
