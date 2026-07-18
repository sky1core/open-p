import type {
  AssistantContentBlock,
  AssistantEventSnapshot,
  AssistantSnapshotMessage,
  BackendUsage,
  TurnDiagnostics,
  TurnResult,
  TurnResultWarning,
} from '../../core/types.js';
import { ARTIFACT_REJECTION_REASONS, EXIT_CODES, OpenPError } from '../../core/errors.js';
import { validateStructuredOutput } from '../../core/json-schema.js';
import { isSafeSessionId } from '../../core/session-id.js';
import {
  isCallerUserTurn,
  isStablePrefixOfLongerText,
  isSystemLocalCommandEvent,
  rememberLocalCommandTranscriptPromptId,
  userEventHasToolResult,
} from './turn-boundary-predicates.js';
import { isClaudeCodeApiErrorAssistant } from './provider-error.js';

interface JsonObject {
  readonly [key: string]: unknown;
}

interface ActiveAssistantTextState {
  activeAssistantTexts: string[];
  lastActiveAssistantMessageId: string | null;
  lastActiveAssistantTextBlockCount: number;
  lastActiveAssistantHadTerminalStop: boolean;
}

interface ReasoningContentState {
  reasoningTexts: string[];
  reasoningContentBlocks: AssistantContentBlock[];
  lastReasoningMessageId: string | null;
  lastReasoningContentBlockCount: number;
}

interface ProviderErrorInterruption {
  readonly apiErrorStatus: number | null;
  readonly errorText: string | null;
  readonly summary: string;
}

interface ModelFallbackSignal {
  readonly fromModel: string | null;
  readonly toModel: string | null;
  readonly apiRefusalCategory: string | null;
  readonly trigger: string | null;
}

interface ParserState {
  inScope: boolean;
  resultText: string | null;
  completed: boolean;
  interruption: ProviderErrorInterruption | null;
  sawToolResult: boolean;
  toolsUsed: string[];
  usage: BackendUsage;
  rawUsage: Record<string, unknown> | null;
  lastSubturnUsage: BackendUsage | null;
  structuredOutput: unknown;
  durationMs: number | null;
  rawEventCount: number;
  stopReason: string | null;
  reasoningTexts: string[];
  reasoningContentBlocks: AssistantContentBlock[];
  lastReasoningMessageId: string | null;
  lastReasoningContentBlockCount: number;
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
  model: string | null;
  modelFallback: ModelFallbackSignal | null;
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
  return usage.inputTokens !== null ||
    usage.cacheReadInputTokens !== null ||
    typeof usage.cacheCreationInputTokens === 'number' ||
    usage.outputTokens !== null;
}

function backendUsageFromRawUsage(usage: JsonObject): BackendUsage {
  return {
    inputTokens: numberOrNull(usage.input_tokens),
    cacheReadInputTokens: numberOrNull(usage.cache_read_input_tokens),
    cacheCreationInputTokens: numberOrNull(usage.cache_creation_input_tokens),
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
  options: {
    readonly structuredOutputRequested?: boolean;
    readonly jsonSchema?: unknown;
    readonly initialLocalCommandTranscriptPromptIds?: ReadonlySet<string>;
  } = {},
): TurnResult | null {
  const state: ParserState = {
    inScope: true,
    resultText: null,
    completed: false,
    interruption: null,
    sawToolResult: false,
    toolsUsed: [],
    usage: EMPTY_USAGE,
    rawUsage: null,
    lastSubturnUsage: null,
    structuredOutput: undefined,
    durationMs: null,
    rawEventCount: 0,
    stopReason: null,
    reasoningTexts: [],
    reasoningContentBlocks: [],
    lastReasoningMessageId: null,
    lastReasoningContentBlockCount: 0,
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
    model: null,
    modelFallback: null,
    assistantEvents: [],
    callerUserTurnCount: 0,
    localCommandTranscriptPromptIds: new Set(options.initialLocalCommandTranscriptPromptIds ?? []),
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
    throw new OpenPError(
      `missing caller user-turn boundary for turn ${turnId}`,
      EXIT_CODES.protocolViolation,
      ARTIFACT_REJECTION_REASONS.missingTurnBoundary,
    );
  }
  // Only the completion marker (turn_duration) makes a turn eligible for a result. A provider error
  // without a completion marker leaves `completed` false, so the wait loop keeps its fail-closed
  // behavior (backend-exit / timeout fast-fail); partial preservation happens only when the backend
  // itself marked the turn complete.
  if (!state.completed) {
    return null;
  }

  // A provider error (rate limit etc.) can interrupt a turn AFTER the backend closed some sub-turns
  // (assistant text, tool_use/tool_result with real side effects) and still emitted turn_duration. When
  // that happens the already-completed content is preserved and returned with an interruption signal
  // instead of being discarded.
  const providerError = state.interruption;
  const hasPreservableToolArtifacts = state.toolsUsed.length > 0 || state.sawToolResult;

  if (state.resultText === null || state.resultText.trim().length === 0) {
    if (providerError && hasPreservableToolArtifacts) {
      // Empty answer text but real tool side effects: emit an empty-answer result so the tool_use /
      // tool_result records (already in assistantEvents) survive the interruption.
      state.resultText = state.resultText ?? '';
    } else if (providerError) {
      // Interrupted with nothing to preserve (no answer, no tool artifacts): keep the pre-existing
      // fail-closed behavior and message shape.
      throw new OpenPError(
        `Claude Code API error for turn ${turnId}: ${providerError.summary}`,
        EXIT_CODES.backendExited,
      );
    } else if (state.resultText === null) {
      return null;
    } else {
      throw new OpenPError(
        `empty result content for turn ${turnId}`,
        EXIT_CODES.protocolViolation,
        ARTIFACT_REJECTION_REASONS.unsupportedArtifactShape,
      );
    }
  }

  const resultText = state.resultText;
  // A provider-error interruption leaves the answer text partial, so it is not valid structured output.
  // Running the JSON fallback on it would throw (exit 40) and discard the very content the interruption
  // path is preserving, replacing the real cause (the provider error) with a bogus parse failure. Skip
  // the fallback on interruption: structuredOutput stays undefined, which is correct for an incomplete
  // turn. A fully captured StructuredOutput tool block (state.structuredOutput defined) is still kept.
  const structuredOutput = state.structuredOutput !== undefined
    ? state.structuredOutput
    : (options.structuredOutputRequested && !providerError && resultText.trim().length > 0
        ? parseStructuredOutputFallback(resultText, turnId)
        : undefined);
  if (structuredOutput !== undefined && options.jsonSchema) {
    validateStructuredOutput(structuredOutput, options.jsonSchema, turnId);
  }

  const diagnostics: TurnDiagnostics = {
    durationMs: state.durationMs,
    stopReason: providerError ? 'provider_error' : state.stopReason,
    toolsUsed: state.toolsUsed,
    usage: state.usage,
    ...(state.lastSubturnUsage && hasUsageSnapshot(state.lastSubturnUsage) ? { lastSubturnUsage: state.lastSubturnUsage } : {}),
    rawUsage: state.rawUsage,
    ...(state.model ? { model: state.model } : {}),
    rawEventCount: state.rawEventCount,
  };

  const warnings = [
    ...(providerError ? [buildProviderErrorInterruptedWarning(providerError)] : []),
    ...(state.modelFallback ? [buildModelFallbackWarning(state.modelFallback)] : []),
  ];

  return {
    turnId,
    text: resultText,
    reasoningContent: buildReasoningContent(state),
    ...(structuredOutput !== undefined ? { structuredOutput } : {}),
    ...(state.requestId ? { requestId: state.requestId } : {}),
    ...(state.sessionId ? { sessionId: state.sessionId } : {}),
    ...(state.assistantEvents.length > 0 ? { assistantEvents: state.assistantEvents } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(providerError ? { interruptedExitCode: EXIT_CODES.backendExited } : {}),
    diagnostics,
  };
}

function recordProviderErrorInterruption(state: ParserState, event: JsonObject): void {
  const apiErrorStatus = typeof event.apiErrorStatus === 'number' ? event.apiErrorStatus : null;
  const textBlocks = assistantTextBlocks(event);
  const errorText = textBlocks.length > 0 ? textBlocks.join('\n\n') : null;
  state.interruption = {
    apiErrorStatus,
    errorText,
    summary: claudeCodeApiErrorMessage(event),
  };
}

// The reset time in a rate-limit notice ("resets 8am (Asia/Seoul)") exists only inside the human-readable
// notice text, so it is passed through verbatim in `message` and never fabricated into a structured field.
function buildProviderErrorInterruptedWarning(interruption: ProviderErrorInterruption): TurnResultWarning {
  const statusPart = interruption.apiErrorStatus !== null ? ` (status ${interruption.apiErrorStatus})` : '';
  const noticePart = interruption.errorText ? `: ${interruption.errorText}` : '';
  return {
    severity: 'warning',
    code: 'provider_error_interrupted',
    message:
      `The backend reported a provider error${statusPart} before the turn finished${noticePart}. ` +
      'The turn did not complete; only the already-completed answer and tool activity were preserved. ' +
      'Continuing means resuming the existing backend session, not resubmitting the same prompt — ' +
      're-sending the same prompt risks duplicating side effects that already ran.',
  };
}

function buildModelFallbackWarning(fallback: ModelFallbackSignal): TurnResultWarning {
  const fromModel = fallback.fromModel ?? 'the requested model';
  const toModel = fallback.toModel ?? 'a fallback model';
  const details = [
    fallback.apiRefusalCategory ? `category ${fallback.apiRefusalCategory}` : null,
    fallback.trigger ? `trigger ${fallback.trigger}` : null,
  ].filter((part): part is string => part !== null).join(', ');
  return {
    severity: 'warning',
    code: 'model_refusal_fallback',
    message:
      `Claude Code switched models from ${fromModel} to ${toModel} after the requested model triggered a fallback` +
      `${details ? ` (${details})` : ''}. ` +
      'The turn continued on the fallback model; cost and behavior may differ from the requested model.',
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
  options: {
    readonly includeTerminalAssistant?: boolean;
    readonly initialLocalCommandTranscriptPromptIds?: ReadonlySet<string>;
  } = {},
): IntermediateContent {
  let inBackgroundTask = false;
  const backgroundParentUuids = new Set<string>();
  const localCommandTranscriptPromptIds = new Set(options.initialLocalCommandTranscriptPromptIds ?? []);
  const textState: ActiveAssistantTextState = {
    activeAssistantTexts: [],
    lastActiveAssistantMessageId: null,
    lastActiveAssistantTextBlockCount: 0,
    lastActiveAssistantHadTerminalStop: false,
  };
  const reasoningState: ReasoningContentState = {
    reasoningTexts: [],
    reasoningContentBlocks: [],
    lastReasoningMessageId: null,
    lastReasoningContentBlockCount: 0,
  };
  let pendingAssistantSnapshot: AssistantEventSnapshot | null = null;
  let parsedEventSequence = 0;
  const clearTextState = (): void => {
    textState.activeAssistantTexts = [];
    textState.lastActiveAssistantMessageId = null;
    textState.lastActiveAssistantTextBlockCount = 0;
    textState.lastActiveAssistantHadTerminalStop = false;
  };
  const clearReasoningState = (): void => {
    reasoningState.reasoningTexts = [];
    reasoningState.reasoningContentBlocks = [];
    reasoningState.lastReasoningMessageId = null;
    reasoningState.lastReasoningContentBlockCount = 0;
  };

  for (const line of lines) {
    const event = parseJsonObject(line);
    if (!event) continue;
    parsedEventSequence += 1;
    rememberLocalCommandTranscriptPromptId(localCommandTranscriptPromptIds, event);
    if (event.type === 'user' && isTaskNotification(event)) {
      clearTextState();
      clearReasoningState();
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
        clearReasoningState();
        pendingAssistantSnapshot = null;
        continue;
      }
      if (isBackgroundTaskEnd(event)) {
        inBackgroundTask = false;
      }
      continue;
    }
    if (isCallerUserTurn(event, localCommandTranscriptPromptIds, {
      isTaskNotification: isTaskNotification(event),
    })) {
      inBackgroundTask = false;
      clearTextState();
      clearReasoningState();
      pendingAssistantSnapshot = null;
      continue;
    }
    if (inBackgroundTask) {
      if (!hasNonBackgroundParent(backgroundParentUuids, event) && isBackgroundTaskEnd(event)) {
        inBackgroundTask = false;
        clearTextState();
        clearReasoningState();
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
      clearReasoningState();
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
          eventReasoningBlocks.push(reasoningText);
          eventReasoningContentBlocks.push({ ...item, type: item.type });
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
        reasoningState,
        joinTextBlocks(eventReasoningBlocks),
        eventReasoningContentBlocks,
        messageId,
      );
    }
    if (eventTextBlocks.length > 0 || eventReasoningBlocks.length > 0) {
      pendingAssistantSnapshot = buildAssistantSnapshot(event, parsedEventSequence);
    }
  }

  return {
    text: buildFallbackResultText(textState),
    reasoningText: reasoningState.reasoningTexts.length > 0 ? reasoningState.reasoningTexts.join('\n\n') : null,
    reasoningContentBlocks: reasoningState.reasoningContentBlocks.length > 0
      ? [...reasoningState.reasoningContentBlocks]
      : null,
    assistantSnapshot: pendingAssistantSnapshot,
  };
}

function consumeEvent(state: ParserState, event: JsonObject, turnId: string): void {
  rememberSessionId(state, event, turnId);

  if (state.completed && state.callerUserTurnCount > 0 && (event.type === 'user' || isSystemLocalCommandEvent(event))) {
    state.inScope = false;
    return;
  }

  rememberLocalCommandTranscriptPromptId(state.localCommandTranscriptPromptIds, event);

  if (isCallerUserTurn(event, state.localCommandTranscriptPromptIds, {
    isTaskNotification: isTaskNotification(event),
  })) {
    state.callerUserTurnCount += 1;
    if (state.callerUserTurnCount > 1) {
      throw new OpenPError(
        `multiple caller user-turn boundaries for turn ${turnId}`,
        EXIT_CODES.protocolViolation,
        ARTIFACT_REJECTION_REASONS.multipleTurnBoundaries,
      );
    }
    state.resultText = null;
    state.completed = false;
    state.interruption = null;
    state.sawToolResult = false;
    state.toolsUsed = [];
    state.usage = EMPTY_USAGE;
    state.rawUsage = null;
    state.lastSubturnUsage = null;
    state.structuredOutput = undefined;
    state.durationMs = null;
    state.stopReason = null;
    state.reasoningTexts = [];
    state.reasoningContentBlocks = [];
    state.lastReasoningMessageId = null;
    state.lastReasoningContentBlockCount = 0;
    state.activeAssistantTexts = [];
    state.lastActiveAssistantMessageId = null;
    state.lastActiveAssistantTextBlockCount = 0;
    state.lastActiveAssistantHadTerminalStop = false;
    state.inBackgroundTask = false;
    state.backgroundParentUuids.clear();
    state.ambiguousTaskNotificationText = false;
    state.activeTextSinceBackgroundStart = false;
    state.requestId = null;
    state.model = null;
    state.modelFallback = null;
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

  if (isClaudeCodeApiErrorAssistant(event)) {
    // A provider error (e.g. rate limit) surfaces as a synthetic assistant event. Do not throw here and
    // do not promote its notice text into the answer: record the interruption reason and skip the event
    // (the streaming path in extractClaudeCodeIntermediateContent skips it the same way). Whether any
    // already-completed content is preserved is decided at completion time in parseClaudeCodeJsonlTurn.
    recordProviderErrorInterruption(state, event);
    return;
  }

  if (isSyntheticNoResponseAssistant(event)) {
    return;
  }

  if (event.type === 'system' && event.subtype === 'model_refusal_fallback') {
    rememberModelFallback(state, modelFallbackFromSystemEvent(event));
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
    if (state.callerUserTurnCount === 0 && !hasPreCallerCompletionEvidence(state)) {
      return;
    }
    consumeTurnDuration(state, event, turnId);
  }
}

function hasPreCallerCompletionEvidence(state: ParserState): boolean {
  return state.resultText !== null ||
    state.interruption !== null ||
    state.sawToolResult ||
    state.toolsUsed.length > 0 ||
    state.structuredOutput !== undefined ||
    state.reasoningTexts.length > 0 ||
    state.activeAssistantTexts.length > 0 ||
    state.assistantEvents.length > 0;
}

function consumeUserToolResultEvent(state: ParserState, event: JsonObject): void {
  const snapshot = buildUserToolResultSnapshot(event, state.rawEventCount);
  if (snapshot) {
    state.sawToolResult = true;
    state.assistantEvents.push(snapshot);
  }
}

function modelFallbackFromSystemEvent(event: JsonObject): ModelFallbackSignal {
  return {
    fromModel: stringOrNull(event.originalModel),
    toModel: stringOrNull(event.fallbackModel),
    apiRefusalCategory: stringOrNull(event.apiRefusalCategory),
    trigger: stringOrNull(event.trigger),
  };
}

function modelFallbackFromAssistantContent(
  content: readonly unknown[],
  observedModel: string | null,
): ModelFallbackSignal | null {
  for (const block of content) {
    const item = asObject(block);
    if (item?.type !== 'fallback') {
      continue;
    }
    const from = asObject(item.from);
    const to = asObject(item.to);
    return {
      fromModel: stringOrNull(from?.model) ?? stringOrNull(item.originalModel),
      toModel: stringOrNull(to?.model) ?? stringOrNull(item.fallbackModel) ?? observedModel,
      apiRefusalCategory: stringOrNull(item.apiRefusalCategory),
      trigger: stringOrNull(item.trigger),
    };
  }
  return null;
}

function rememberModelFallback(state: ParserState, fallback: ModelFallbackSignal | null): void {
  if (!fallback) {
    return;
  }
  const existing = state.modelFallback;
  state.modelFallback = {
    fromModel: existing?.fromModel ?? fallback.fromModel,
    toModel: fallback.toModel ?? existing?.toModel ?? null,
    apiRefusalCategory: existing?.apiRefusalCategory ?? fallback.apiRefusalCategory,
    trigger: existing?.trigger ?? fallback.trigger,
  };
  if (state.modelFallback.toModel) {
    state.model = state.modelFallback.toModel;
  }
}

function rememberSessionId(state: ParserState, event: JsonObject, turnId: string): void {
  const sessionId = stringOrNull(event.sessionId) ?? stringOrNull(event.session_id);
  if (!sessionId) {
    return;
  }
  if (!isSafeSessionId(sessionId)) {
    throw new OpenPError(`invalid Claude Code session id for turn ${turnId}`, EXIT_CODES.protocolViolation);
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
  const model = stringOrNull(message?.model);
  if (model && model !== '<synthetic>') {
    state.model = model;
  }
  const stopReason = typeof message?.stop_reason === 'string' ? message.stop_reason : null;
  state.stopReason = stopReason;
  const snapshot = buildAssistantSnapshot(event, state.rawEventCount);
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
  rememberModelFallback(state, modelFallbackFromAssistantContent(content, model));
  const eventTextBlocks: string[] = [];
  const eventReasoningBlocks: string[] = [];
  const eventReasoningContentBlocks: AssistantContentBlock[] = [];
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
        eventReasoningBlocks.push(reasoningText);
        eventReasoningContentBlocks.push({ ...item, type: item.type });
      }
    }
    if (item.type === 'text' && typeof item.text === 'string') {
      if (item.text.trim()) {
        eventTextBlocks.push(item.text);
      }
    }
  }
  if (eventReasoningBlocks.length > 0) {
    appendReasoningContent(
      state,
      joinTextBlocks(eventReasoningBlocks),
      eventReasoningContentBlocks,
      messageId,
    );
  }
  if (eventTextBlocks.length > 0) {
    appendActiveAssistantTextBlocks(state, eventTextBlocks, messageId, stopReason !== null);
  } else if (stopReason !== null) {
    state.lastActiveAssistantHadTerminalStop = true;
    state.lastActiveAssistantMessageId = messageId;
  }
}

function buildAssistantSnapshot(event: JsonObject, eventSequence: number): AssistantEventSnapshot | null {
  const message = asObject(event.message);
  if (!message) {
    return null;
  }
  const messageId = stringOrNull(message.id)
    ?? stringOrNull(event.uuid)
    ?? `claude_event_${eventSequence}`;
  const requestId = stringOrNull(event.requestId) ?? stringOrNull(event.request_id);
  return {
    message: normalizeAssistantMessage(message, messageId),
    ...(requestId ? { requestId } : {}),
  };
}

function buildUserToolResultSnapshot(event: JsonObject, eventSequence: number): AssistantEventSnapshot | null {
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
  const eventId = stringOrNull(event.uuid) ?? `claude_event_${eventSequence}`;
  const requestId = stringOrNull(event.requestId) ?? stringOrNull(event.request_id);
  return {
    message: normalizeAssistantMessage({
      ...message,
      role: 'assistant',
      content,
      stop_reason: null,
    }, eventId),
    ...(requestId ? { requestId } : {}),
  };
}

function normalizeAssistantMessage(message: JsonObject, messageId: string): AssistantSnapshotMessage {
  const content = Array.isArray(message.content)
    ? message.content
        .map(asObject)
        .filter((block): block is JsonObject => typeof block?.type === 'string')
        .map((block) => ({ ...block, type: block.type as string }))
    : [];
  return {
    ...(typeof message.model === 'string' ? { model: message.model } : {}),
    id: messageId,
    type: 'message',
    role: 'assistant',
    content,
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
    throw new OpenPError(
      `ambiguous task-notification interleave for turn ${turnId}`,
      EXIT_CODES.protocolViolation,
      ARTIFACT_REJECTION_REASONS.unsupportedArtifactShape,
    );
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

// Reasoning accumulation follows the same contract rule as answer accumulation: an assistant update
// with the same native `message.id` is a same-message snapshot of the latest reasoning segment,
// and a different `message.id` always starts a new segment (never merged by text comparison).
// Raw references show every Claude assistant event carries `message.id`; events without it are
// unverified and keep the pre-message-id whole-text cumulative-snapshot behavior unchanged.
function appendReasoningContent(
  state: ReasoningContentState,
  reasoningText: string,
  nextContentBlocks: readonly AssistantContentBlock[],
  messageId: string | null,
): void {
  if (state.reasoningTexts.length === 0) {
    pushReasoningSegment(state, reasoningText, nextContentBlocks, messageId);
    return;
  }
  if (messageId !== null && state.lastReasoningMessageId !== null) {
    if (messageId !== state.lastReasoningMessageId) {
      pushReasoningSegment(state, reasoningText, nextContentBlocks, messageId);
      return;
    }
    const lastSegmentText = state.reasoningTexts[state.reasoningTexts.length - 1]!;
    if (reasoningText === lastSegmentText || isStablePrefixOfLongerText(reasoningText, lastSegmentText)) {
      return;
    }
    if (isStablePrefixOfLongerText(lastSegmentText, reasoningText)) {
      replaceLastReasoningSegment(state, reasoningText, nextContentBlocks, messageId);
      return;
    }
    pushReasoningSegment(state, reasoningText, nextContentBlocks, messageId);
    return;
  }
  const currentText = joinTextBlocks(state.reasoningTexts);
  if (reasoningText === currentText || isStablePrefixOfLongerText(reasoningText, currentText)) {
    return;
  }
  if (isStablePrefixOfLongerText(currentText, reasoningText)) {
    state.reasoningTexts.splice(0, state.reasoningTexts.length, reasoningText);
    state.reasoningContentBlocks.splice(0, state.reasoningContentBlocks.length, ...nextContentBlocks);
    state.lastReasoningMessageId = messageId;
    state.lastReasoningContentBlockCount = nextContentBlocks.length;
    return;
  }
  pushReasoningSegment(state, reasoningText, nextContentBlocks, messageId);
}

function pushReasoningSegment(
  state: ReasoningContentState,
  reasoningText: string,
  nextContentBlocks: readonly AssistantContentBlock[],
  messageId: string | null,
): void {
  state.reasoningTexts.push(reasoningText);
  state.reasoningContentBlocks.push(...nextContentBlocks);
  state.lastReasoningMessageId = messageId;
  state.lastReasoningContentBlockCount = nextContentBlocks.length;
}

function replaceLastReasoningSegment(
  state: ReasoningContentState,
  reasoningText: string,
  nextContentBlocks: readonly AssistantContentBlock[],
  messageId: string | null,
): void {
  state.reasoningTexts.splice(state.reasoningTexts.length - 1, 1, reasoningText);
  state.reasoningContentBlocks.splice(
    state.reasoningContentBlocks.length - state.lastReasoningContentBlockCount,
    state.lastReasoningContentBlockCount,
    ...nextContentBlocks,
  );
  state.lastReasoningMessageId = messageId;
  state.lastReasoningContentBlockCount = nextContentBlocks.length;
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
