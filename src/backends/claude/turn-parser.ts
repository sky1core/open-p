import type {
  AssistantContentBlock,
  AssistantEventSnapshot,
  BackendUsage,
  TurnDiagnostics,
  TurnResult,
} from '../../core/types.js';
import { EXIT_CODES, OpenPError } from '../../core/errors.js';
import { validateStructuredOutput } from '../../core/json-schema.js';
import { isSafeSessionId } from '../../core/session-id.js';

interface JsonObject {
  readonly [key: string]: unknown;
}

interface ActiveAssistantTextState {
  activeAssistantTexts: string[];
  lastActiveAssistantMessageId: string | null;
  lastActiveAssistantTextBlockCount: number;
  lastActiveAssistantHadTerminalStop: boolean;
}

interface ParserState {
  inScope: boolean;
  resultText: string | null;
  completed: boolean;
  toolsUsed: string[];
  usage: BackendUsage;
  rawUsage: Record<string, unknown> | null;
  lastSubturnUsage: BackendUsage | null;
  structuredOutput: unknown;
  durationMs: number | null;
  rawEventCount: number;
  stopReason: string | null;
  reasoningTexts: string[];
  activeAssistantTexts: string[];
  lastActiveAssistantMessageId: string | null;
  lastActiveAssistantTextBlockCount: number;
  lastActiveAssistantHadTerminalStop: boolean;
  inBackgroundTask: boolean;
  backgroundParentUuids: Set<string>;
  ambiguousTaskNotificationText: boolean;
  activeTextSinceBackgroundStart: boolean;
  requestId: string | null;
  sessionId: string | null;
  assistantEvents: AssistantEventSnapshot[];
  callerUserTurnCount: number;
  localCommandTranscriptPromptIds: Set<string>;
}

const EMPTY_USAGE: BackendUsage = {
  inputTokens: null,
  cacheReadInputTokens: null,
  outputTokens: null,
};

function hasUsageSnapshot(usage: BackendUsage): boolean {
  return usage.inputTokens !== null || usage.cacheReadInputTokens !== null || usage.outputTokens !== null;
}

function backendUsageFromRawUsage(usage: JsonObject): BackendUsage {
  return {
    inputTokens: numberOrNull(usage.input_tokens),
    cacheReadInputTokens: numberOrNull(usage.cache_read_input_tokens),
    outputTokens: numberOrNull(usage.output_tokens),
  };
}

function lastSubturnUsageFromClaudeUsage(usage: JsonObject): BackendUsage | null {
  const iteration = finalMessageIteration(usage);
  return iteration ? backendUsageFromRawUsage(iteration) : null;
}

function finalMessageIteration(usage: JsonObject): JsonObject | null {
  const iterations = Array.isArray(usage.iterations) ? usage.iterations : [];
  for (let index = iterations.length - 1; index >= 0; index -= 1) {
    const iteration = asObject(iterations[index]);
    if (!iteration) continue;
    if (iteration.type !== undefined && iteration.type !== 'message') continue;
    return iteration;
  }
  return null;
}

export function parseClaudeCodeJsonlTurn(
  lines: readonly string[],
  turnId: string,
  options: { readonly structuredOutputRequested?: boolean; readonly jsonSchema?: unknown } = {},
): TurnResult | null {
  const state: ParserState = {
    inScope: true,
    resultText: null,
    completed: false,
    toolsUsed: [],
    usage: EMPTY_USAGE,
    rawUsage: null,
    lastSubturnUsage: null,
    structuredOutput: undefined,
    durationMs: null,
    rawEventCount: 0,
    stopReason: null,
    reasoningTexts: [],
    activeAssistantTexts: [],
    lastActiveAssistantMessageId: null,
    lastActiveAssistantTextBlockCount: 0,
    lastActiveAssistantHadTerminalStop: false,
    inBackgroundTask: false,
    backgroundParentUuids: new Set(),
    ambiguousTaskNotificationText: false,
    activeTextSinceBackgroundStart: false,
    requestId: null,
    sessionId: null,
    assistantEvents: [],
    callerUserTurnCount: 0,
    localCommandTranscriptPromptIds: new Set(),
  };

  for (const line of lines) {
    const event = parseJsonObject(line);
    if (!event) continue;
    state.rawEventCount += 1;
    consumeEvent(state, event, turnId);
  }

  if (state.completed && state.resultText === null) {
    const fallbackText = buildFallbackResultText(state);
    if (fallbackText) {
      state.resultText = fallbackText;
    } else if (state.structuredOutput !== undefined) {
      state.resultText = serializeStructuredOutput(state.structuredOutput, turnId);
    }
  }
  if (state.completed && state.callerUserTurnCount === 0) {
    throw new OpenPError(`missing caller user-turn boundary for turn ${turnId}`, EXIT_CODES.protocolViolation);
  }
  if (!state.completed || state.resultText === null) {
    return null;
  }
  if (state.resultText.trim().length === 0) {
    throw new OpenPError(`empty result content for turn ${turnId}`, EXIT_CODES.protocolViolation);
  }
  const structuredOutput = state.structuredOutput !== undefined
    ? state.structuredOutput
    : (options.structuredOutputRequested ? parseStructuredOutputFallback(state.resultText, turnId) : undefined);
  if (structuredOutput !== undefined && options.jsonSchema) {
    validateStructuredOutput(structuredOutput, options.jsonSchema, turnId);
  }

  const diagnostics: TurnDiagnostics = {
    durationMs: state.durationMs,
    stopReason: state.stopReason,
    toolsUsed: state.toolsUsed,
    usage: state.usage,
    ...(state.lastSubturnUsage && hasUsageSnapshot(state.lastSubturnUsage) ? { lastSubturnUsage: state.lastSubturnUsage } : {}),
    rawUsage: state.rawUsage,
    rawEventCount: state.rawEventCount,
  };

  return {
    turnId,
    text: state.resultText,
    reasoningContent: buildReasoningContent(state),
    ...(structuredOutput !== undefined ? { structuredOutput } : {}),
    ...(state.requestId ? { requestId: state.requestId } : {}),
    ...(state.sessionId ? { sessionId: state.sessionId } : {}),
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
  const localCommandTranscriptPromptIds = new Set<string>();
  const textState: ActiveAssistantTextState = {
    activeAssistantTexts: [],
    lastActiveAssistantMessageId: null,
    lastActiveAssistantTextBlockCount: 0,
    lastActiveAssistantHadTerminalStop: false,
  };
  let pendingReasoningBlocks: string[] = [];
  const pendingReasoningContentBlocks: AssistantContentBlock[] = [];
  let pendingAssistantSnapshot: AssistantEventSnapshot | null = null;
  const clearTextState = (): void => {
    textState.activeAssistantTexts = [];
    textState.lastActiveAssistantMessageId = null;
    textState.lastActiveAssistantTextBlockCount = 0;
    textState.lastActiveAssistantHadTerminalStop = false;
  };

  for (const line of lines) {
    const event = parseJsonObject(line);
    if (!event) continue;
    rememberLocalCommandTranscriptPromptId(localCommandTranscriptPromptIds, event);
    if (event.type === 'user' && isTaskNotification(event)) {
      clearTextState();
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
        clearTextState();
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
    if (isCallerUserTurn(event, localCommandTranscriptPromptIds)) {
      inBackgroundTask = false;
      clearTextState();
      pendingReasoningBlocks = [];
      pendingReasoningContentBlocks.splice(0, pendingReasoningContentBlocks.length);
      pendingAssistantSnapshot = null;
      localCommandTranscriptPromptIds.clear();
      continue;
    }
    if (inBackgroundTask) {
      if (!hasNonBackgroundParent(backgroundParentUuids, event) && isBackgroundTaskEnd(event)) {
        inBackgroundTask = false;
        clearTextState();
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
    if (isClaudeCodeApiErrorAssistant(event)) {
      continue;
    }
    if (isSyntheticNoResponseAssistant(event)) {
      continue;
    }
    if (messageStopReason(event) === 'end_turn' && !options.includeTerminalAssistant) {
      clearTextState();
      pendingReasoningBlocks = [];
      pendingReasoningContentBlocks.splice(0, pendingReasoningContentBlocks.length);
      pendingAssistantSnapshot = null;
      continue;
    }

    const message = asObject(event.message);
    const messageId = typeof message?.id === 'string' ? message.id : null;
    const stopReason = typeof message?.stop_reason === 'string' ? message.stop_reason : null;
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
      appendActiveAssistantTextBlocks(textState, eventTextBlocks, messageId, stopReason !== null);
    } else if (stopReason !== null) {
      textState.lastActiveAssistantHadTerminalStop = true;
      textState.lastActiveAssistantMessageId = messageId;
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
    text: buildFallbackResultText(textState),
    reasoningText: pendingReasoningBlocks.length > 0 ? pendingReasoningBlocks.join('\n\n') : null,
    reasoningContentBlocks: pendingReasoningContentBlocks.length > 0
      ? [...pendingReasoningContentBlocks]
      : null,
    assistantSnapshot: pendingAssistantSnapshot,
  };
}

function consumeEvent(state: ParserState, event: JsonObject, turnId: string): void {
  rememberSessionId(state, event, turnId);
  rememberLocalCommandTranscriptPromptId(state.localCommandTranscriptPromptIds, event);

  if (isCallerUserTurn(event, state.localCommandTranscriptPromptIds)) {
    state.callerUserTurnCount += 1;
    if (state.callerUserTurnCount > 1) {
      throw new OpenPError(`multiple caller user-turn boundaries for turn ${turnId}`, EXIT_CODES.protocolViolation);
    }
    state.resultText = null;
    state.completed = false;
    state.toolsUsed = [];
    state.usage = EMPTY_USAGE;
    state.rawUsage = null;
    state.lastSubturnUsage = null;
    state.structuredOutput = undefined;
    state.durationMs = null;
    state.stopReason = null;
    state.reasoningTexts = [];
    state.activeAssistantTexts = [];
    state.lastActiveAssistantMessageId = null;
    state.lastActiveAssistantTextBlockCount = 0;
    state.lastActiveAssistantHadTerminalStop = false;
    state.inBackgroundTask = false;
    state.backgroundParentUuids.clear();
    state.ambiguousTaskNotificationText = false;
    state.activeTextSinceBackgroundStart = false;
    state.requestId = null;
    state.assistantEvents = [];
    state.localCommandTranscriptPromptIds.clear();
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

  if (isClaudeCodeApiErrorAssistant(event)) {
    throw new OpenPError(
      `Claude Code API error for turn ${turnId}: ${claudeCodeApiErrorMessage(event)}`,
      EXIT_CODES.backendExited,
    );
  }

  if (isSyntheticNoResponseAssistant(event)) {
    return;
  }

  if (event.type === 'user' && userEventHasToolResult(event)) {
    consumeUserToolResultEvent(state, event);
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

function consumeUserToolResultEvent(state: ParserState, event: JsonObject): void {
  const snapshot = buildUserToolResultSnapshot(event);
  if (snapshot) {
    state.assistantEvents.push(snapshot);
  }
}

function rememberSessionId(state: ParserState, event: JsonObject, turnId: string): void {
  const sessionId = stringOrNull(event.sessionId) ?? stringOrNull(event.session_id);
  if (!sessionId) {
    return;
  }
  if (!isSafeSessionId(sessionId)) {
    throw new OpenPError(`unsafe Claude Code session id for turn ${turnId}`, EXIT_CODES.protocolViolation);
  }
  if (state.sessionId && state.sessionId !== sessionId) {
    throw new OpenPError(`Claude Code session id changed during turn ${turnId}`, EXIT_CODES.protocolViolation);
  }
  state.sessionId = sessionId;
}

function consumeAssistantEvent(state: ParserState, event: JsonObject): void {
  const requestId = stringOrNull(event.requestId) ?? stringOrNull(event.request_id);
  if (requestId) {
    state.requestId = requestId;
  }

  const message = asObject(event.message);
  const messageId = typeof message?.id === 'string' ? message.id : null;
  const stopReason = typeof message?.stop_reason === 'string' ? message.stop_reason : null;
  state.stopReason = stopReason;
  const snapshot = buildAssistantSnapshot(event);
  if (snapshot) {
    state.assistantEvents.push(snapshot);
  }
  const usage = asObject(message?.usage);
  if (usage) {
    state.rawUsage = usage;
    state.usage = backendUsageFromRawUsage(usage);
    state.lastSubturnUsage = lastSubturnUsageFromClaudeUsage(usage);
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
    appendActiveAssistantTextBlocks(state, eventTextBlocks, messageId, stopReason !== null);
  } else if (stopReason !== null) {
    state.lastActiveAssistantHadTerminalStop = true;
    state.lastActiveAssistantMessageId = messageId;
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
  const requestId = stringOrNull(event.requestId) ?? stringOrNull(event.request_id);
  return {
    message: normalizeAssistantMessage({
      ...message,
      role: 'assistant',
      content,
      stop_reason: null,
    }),
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
  if (state.resultText === null) {
    const fallbackText = buildFallbackResultText(state);
    if (!fallbackText) {
      if (state.structuredOutput !== undefined) {
        state.resultText = serializeStructuredOutput(state.structuredOutput, turnId);
      } else {
        return;
      }
    } else {
      state.resultText = fallbackText;
    }
  }
}

function appendActiveAssistantTextBlocks(
  state: ActiveAssistantTextState,
  textBlocks: readonly string[],
  messageId: string | null,
  hasTerminalStop: boolean,
): void {
  if (shouldSkipDuplicateActiveAssistantText(state, textBlocks, messageId)) {
    if (hasTerminalStop) {
      state.lastActiveAssistantHadTerminalStop = true;
      state.lastActiveAssistantMessageId = messageId;
    }
    return;
  }
  if (shouldReplaceActiveAssistantText(state, textBlocks, messageId)) {
    state.activeAssistantTexts.splice(
      state.activeAssistantTexts.length - state.lastActiveAssistantTextBlockCount,
      state.lastActiveAssistantTextBlockCount,
      ...textBlocks,
    );
    state.lastActiveAssistantTextBlockCount = textBlocks.length;
    state.lastActiveAssistantMessageId = messageId;
    state.lastActiveAssistantHadTerminalStop = hasTerminalStop;
    return;
  }
  state.activeAssistantTexts.push(...textBlocks);
  state.lastActiveAssistantTextBlockCount = textBlocks.length;
  state.lastActiveAssistantMessageId = messageId;
  state.lastActiveAssistantHadTerminalStop = hasTerminalStop;
}

function shouldSkipDuplicateActiveAssistantText(
  state: ActiveAssistantTextState,
  textBlocks: readonly string[],
  messageId: string | null,
): boolean {
  if (!textBlockGroupsEqual(lastActiveAssistantTextBlocks(state), textBlocks)) {
    return false;
  }
  if (
    messageId !== null &&
    state.lastActiveAssistantMessageId !== null &&
    messageId !== state.lastActiveAssistantMessageId
  ) {
    return false;
  }
  return true;
}

function shouldReplaceActiveAssistantText(
  state: ActiveAssistantTextState,
  textBlocks: readonly string[],
  messageId: string | null,
): boolean {
  if (isNewAssistantMessageBoundary(state, messageId)) {
    return false;
  }
  const previousBlocks = lastActiveAssistantTextBlocks(state);
  const previousText = joinTextBlocks(previousBlocks);
  const nextText = joinTextBlocks(textBlocks);
  const sameMessageId = messageId !== null &&
    state.lastActiveAssistantMessageId !== null &&
    messageId === state.lastActiveAssistantMessageId;
  return previousBlocks.length > 0 &&
    !textBlockGroupsEqual(previousBlocks, textBlocks) &&
    sameMessageId &&
    nextText.startsWith(previousText);
}

function isNewAssistantMessageBoundary(state: ActiveAssistantTextState, messageId: string | null): boolean {
  if (state.activeAssistantTexts.length === 0) {
    return true;
  }
  if (messageId !== null && state.lastActiveAssistantMessageId !== null) {
    return messageId !== state.lastActiveAssistantMessageId;
  }
  return state.lastActiveAssistantHadTerminalStop;
}

function lastActiveAssistantTextBlocks(state: ActiveAssistantTextState): readonly string[] {
  if (state.lastActiveAssistantTextBlockCount <= 0) {
    return [];
  }
  return state.activeAssistantTexts.slice(-state.lastActiveAssistantTextBlockCount);
}

function textBlockGroupsEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((text, index) => text === right[index]);
}

function buildFallbackResultText(state: ActiveAssistantTextState): string | null {
  const text = joinTextBlocks(state.activeAssistantTexts);
  return text.length > 0 ? text : null;
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

function isCallerUserTurn(event: JsonObject, localCommandTranscriptPromptIds: ReadonlySet<string>): boolean {
  if (event.type !== 'user') {
    return false;
  }
  if (isTaskNotification(event)) {
    return false;
  }
  if (event.isMeta === true) {
    return false;
  }
  // The context-compaction continuation message (`isCompactSummary: true`) is a `type:user` event Claude
  // injects after a `/compact`; it is not a caller prompt. Without this, a compaction inside a turn's scoped
  // segment is miscounted as an extra caller user turn (exit 40 "multiple caller user-turn boundaries").
  if (event.isCompactSummary === true) {
    return false;
  }
  if (userEventHasToolResult(event)) {
    return false;
  }
  if (isLocalCommandTranscriptEvent(event, localCommandTranscriptPromptIds)) {
    return false;
  }
  return true;
}

function userEventHasToolResult(event: JsonObject): boolean {
  const message = asObject(event.message);
  const content = Array.isArray(message?.content) ? message.content : [];
  return content.some((block) => asObject(block)?.type === 'tool_result');
}

function isLocalCommandTranscriptEvent(
  event: JsonObject,
  localCommandTranscriptPromptIds: ReadonlySet<string>,
): boolean {
  const texts = collectUserText(event);
  if (texts.length !== 1) {
    return false;
  }
  if (texts[0] === '/exit') {
    return true;
  }
  const promptId = stringOrNull(event.promptId);
  return promptId !== null &&
    localCommandTranscriptPromptIds.has(promptId) &&
    isLocalCommandTranscriptText(texts[0]!);
}

function rememberLocalCommandTranscriptPromptId(promptIds: Set<string>, event: JsonObject): void {
  if (event.type !== 'user' || event.isMeta !== true) {
    return;
  }
  const promptId = stringOrNull(event.promptId);
  if (promptId === null || !isLocalCommandCaveatEvent(event)) {
    return;
  }
  promptIds.add(promptId);
}

function isLocalCommandCaveatEvent(event: JsonObject): boolean {
  const texts = collectUserText(event);
  return texts.length === 1 && texts[0]!.startsWith('<local-command-caveat>');
}

function collectUserText(event: JsonObject): string[] {
  const message = asObject(event.message);
  const content = Array.isArray(message?.content) ? message.content : [];
  const textBlocks = content
    .map((block) => asObject(block))
    .filter((block): block is JsonObject => Boolean(block))
    .map((block) => {
      if (block.type === 'text' && typeof block.text === 'string') {
        return block.text.trim();
      }
      if (block.kind === 'text' && typeof block.data === 'string') {
        return block.data.trim();
      }
      return '';
    })
    .filter(Boolean);
  if (textBlocks.length === 0 && typeof message?.content === 'string') {
    textBlocks.push(message.content.trim());
  }
  return textBlocks;
}

// A Claude Code local-command transcript (e.g. `/exit`, `/compact`) is a `type:user` event written when a
// local slash command runs; it is not a caller prompt. Bare `/exit` plus the tagged transcript forms
// (`<command-name>…`, `<local-command-stdout>…`, `<local-command-stderr>…`) all count.
const LOCAL_COMMAND_TRANSCRIPT_PREFIXES = ['<command-name>', '<local-command-stdout>', '<local-command-stderr>'];

export function isLocalCommandTranscriptText(text: string): boolean {
  return text === '/exit' || LOCAL_COMMAND_TRANSCRIPT_PREFIXES.some((prefix) => text.startsWith(prefix));
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

function isClaudeCodeApiErrorAssistant(event: JsonObject): boolean {
  if (event.type !== 'assistant') {
    return false;
  }
  if (event.isApiErrorMessage === true) {
    return true;
  }
  if (typeof event.apiErrorStatus === 'number') {
    return true;
  }
  return typeof event.error === 'string' && event.error.trim().length > 0;
}

function claudeCodeApiErrorMessage(event: JsonObject): string {
  const parts: string[] = [];
  if (typeof event.apiErrorStatus === 'number') {
    parts.push(`status ${event.apiErrorStatus}`);
  }
  if (typeof event.error === 'string' && event.error.trim()) {
    parts.push(event.error.trim());
  }
  const text = assistantTextBlocks(event).join('\n\n');
  if (text) {
    parts.push(text);
  }
  return parts.length > 0 ? parts.join(': ') : 'unknown API error';
}

function assistantTextBlocks(event: JsonObject): string[] {
  const message = asObject(event.message);
  const content = Array.isArray(message?.content) ? message.content : [];
  return content
    .map((block) => asObject(block))
    .filter((block): block is JsonObject => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => (block.text as string).trim())
    .filter((text) => text.length > 0);
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
  if (trimmed.length === 0) return '';

  const fenceRegex = /```json[ \t]*\r?\n([\s\S]*?)\r?\n```/gi;
  let lastFence: RegExpExecArray | null = null;
  let m;
  while ((m = fenceRegex.exec(trimmed)) !== null) lastFence = m;
  if (lastFence?.[1]?.trim()) return lastFence[1].trim();

  if (trimmed[0] === '{' || trimmed[0] === '[') return trimmed;

  const lines = trimmed.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const ch = lines[i][0];
    if (ch === '{' || ch === '[') {
      const candidate = lines.slice(i).join('\n').trim();
      try { JSON.parse(candidate); return candidate; } catch { /* try earlier line */ }
    }
  }

  return trimmed;
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
