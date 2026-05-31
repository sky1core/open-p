import { createHash, randomUUID } from 'node:crypto';
import type { AssistantContentBlock, AssistantEventSnapshot, BackendUsage, TurnResult } from './types.js';
import type { WorkerTurnResult } from './worker-types.js';

export type OutputFormat = 'text' | 'json' | 'stream-json';

export interface OutputOptions {
  readonly outputFormat: OutputFormat;
  readonly backendSessionId: string;
  readonly backend?: string | null;
  readonly includeSystemInit?: boolean;
  readonly model?: string | null;
  readonly cwd?: string | null;
  readonly permissionMode?: string | null;
  readonly mcpServers?: readonly unknown[];
  readonly contextWindow?: number | null;
  readonly structuredOutputToolUseId?: string | null;
  readonly suppressAssistantTexts?: readonly string[];
  readonly suppressAssistantReasoningTexts?: readonly string[];
  readonly suppressAssistantSnapshots?: readonly AssistantEventSnapshot[];
  readonly previouslyEmittedAssistantEvents?: readonly Record<string, unknown>[];
  readonly suppressFallbackAssistantText?: boolean;
  readonly warnings?: readonly OutputWarning[];
  readonly verbose?: boolean;
}

export interface OutputWarning {
  readonly severity: 'warning' | 'error';
  readonly code: string;
  readonly message: string;
}

export interface StreamingMessageState {
  started: boolean;
  blockOpen: boolean;
  previousText: string;
  messageId: string | null;
  hasReasoning: boolean;
  reasoningBlockOpen: boolean;
  previousReasoningText: string;
}

const OPENP_NATIVE_VERSION = 1;

export function formatTurnResult(result: TurnResult, options: OutputOptions): string {
  if (options.outputFormat === 'text') {
    const textOutput = resultAnswerTextForTextOutput(result, options);
    const text = textOutput.endsWith('\n') ? textOutput : `${textOutput}\n`;
    return `${text}${formatVerboseTextMarker(options.verbose)}${formatTextWarnings(options.warnings)}`;
  }
  const stopReason = result.diagnostics.stopReason ?? 'end_turn';
  const effectiveModel = result.diagnostics.model ?? options.model ?? null;
  const resultUsage = result.diagnostics.usage;
  const lastSubturnUsage = result.diagnostics.lastSubturnUsage ?? null;
  const assistantEventUsage = resultUsage;
  const lastSubturnContextTokens =
    result.diagnostics.lastSubturnContextTokens ??
    (lastSubturnUsage ? contextTokensFromUsage(lastSubturnUsage) : null);
  const effectiveContextWindow =
    result.diagnostics.contextWindow ?? options.contextWindow ?? null;
  const structuredOutputToolUseId = resolveStructuredOutputToolUseId({
    structuredOutput: result.structuredOutput,
    assistantEvents: result.assistantEvents,
    preferredToolUseId: options.structuredOutputToolUseId,
  });
  const normalizedSnapshots = normalizeStructuredOutputFallbackSnapshots(
    result.assistantEvents,
    result.structuredOutput,
    structuredOutputToolUseId,
  );
  const normalizedSuppressedSnapshots = normalizeStructuredOutputFallbackSnapshots(
    options.suppressAssistantSnapshots,
    result.structuredOutput,
    structuredOutputToolUseId,
  );
  const suppressedResultSnapshots = intersectSuppressedResultSnapshots(
    normalizedSnapshots,
    normalizedSuppressedSnapshots,
  );
  const snapshotStructuredOutputToolUseId = findStructuredOutputToolUseId(normalizedSnapshots);
  const suppressedAssistantTexts = (options.suppressAssistantTexts ?? [])
    .filter((text) => text.length > 0);
  const suppressedAssistantReasoningTexts = (options.suppressAssistantReasoningTexts ?? [])
    .filter((text) => text.length > 0);
  const latestSuppressedAssistantText = suppressedAssistantTexts
    .at(-1) ?? null;
  const fallbackReasoningContent = isReasoningContentAlreadySuppressed(
    result.reasoningContent,
    suppressedAssistantReasoningTexts,
  )
    ? null
    : result.reasoningContent;
  const fallbackStructuredOutput = snapshotStructuredOutputToolUseId === null
    ? result.structuredOutput
    : undefined;
  const assistantSnapshots = filterAssistantSnapshots(normalizedSnapshots, {
    text: suppressedAssistantTexts,
    reasoning: suppressedAssistantReasoningTexts,
    snapshots: normalizedSuppressedSnapshots ?? [],
  });
  const semanticSnapshotsContainResultText = snapshotsContainSemanticAssistantText(normalizedSnapshots, result.text);
  const suppressedSnapshotsContainResultText = nonSemanticSnapshotsContainAssistantText(
    normalizedSuppressedSnapshots,
    result.text,
  );
  const blankResultTextFallback = shouldBlankResultTextFallback(
    result.text,
    latestSuppressedAssistantText,
    options.suppressFallbackAssistantText,
    semanticSnapshotsContainResultText,
  );
  const assistantEvents = buildAssistantEventsFromSnapshots(
    assistantSnapshots,
    options.backendSessionId,
    assistantEventUsage,
    {
      turnId: result.turnId,
      resultAnswerText: result.text,
      resultReasoningText: fallbackReasoningContent ?? null,
      structuredOutput: result.structuredOutput,
      structuredOutputToolUseId,
      requestId: result.requestId ?? null,
      model: effectiveModel,
      stopReason,
      usage: assistantEventUsage,
      form: 'result',
    },
  );
  const suppressedResultSnapshotOpenPEvents = buildPreviouslyEmittedAssistantOpenPEvents(
    suppressedResultSnapshots,
    options.backendSessionId,
    result.turnId,
    result.text,
    fallbackReasoningContent ?? null,
    result.structuredOutput,
    structuredOutputToolUseId,
    result.requestId ?? null,
    effectiveModel,
    stopReason,
    assistantEventUsage,
    'result',
  );
  const effectiveFallbackReasoningContent = openPEventsContainReasoningText(
    [...assistantEvents, ...suppressedResultSnapshotOpenPEvents],
    fallbackReasoningContent,
  )
    ? null
    : fallbackReasoningContent;
  const assistantSnapshotsContainResultText =
    snapshotsContainAssistantText(assistantSnapshots, result.text) ||
    openPAnswerEventsContainResultText(assistantEvents, result.text) ||
    openPAnswerEventsContainResultText(suppressedResultSnapshotOpenPEvents, result.text) ||
    openPAnswerEventsAggregateResultText(assistantEvents, result.text) ||
    openPAnswerEventsAggregateResultText(suppressedResultSnapshotOpenPEvents, result.text) ||
    suppressedSnapshotsContainResultText;
  const shouldEmitTextFallback = shouldEmitResultTextFallback(
    result.text,
    latestSuppressedAssistantText,
    options.suppressFallbackAssistantText,
    semanticSnapshotsContainResultText,
  ) && !suppressedSnapshotsContainResultText;
  const terminalAssistantEvents = buildTerminalAssistantEventRecords({
    existingAssistantEvents: assistantEvents,
    assistantSnapshotsContainResultText,
    text: result.text,
    fallbackReasoningContent: effectiveFallbackReasoningContent,
    structuredOutput: result.structuredOutput,
    fallbackStructuredOutput,
    snapshotStructuredOutputToolUseId,
    structuredOutputToolUseId,
    shouldEmitTextFallback,
    blankResultTextFallback,
    turnId: result.turnId,
    sessionId: options.backendSessionId,
    requestId: result.requestId,
    model: effectiveModel,
    stopReason,
    usage: {
      inputTokens: assistantEventUsage.inputTokens,
      outputTokens: assistantEventUsage.outputTokens,
      cacheReadInputTokens: assistantEventUsage.cacheReadInputTokens,
    },
  });
  const nestedAssistantOpenPEvents = buildNestedAssistantOpenPEvents({
    previouslyEmittedSnapshots: suppressedResultSnapshots,
    previouslyEmittedAssistantEvents: options.previouslyEmittedAssistantEvents,
    emittedAssistantEvents: terminalAssistantEvents,
    sessionId: options.backendSessionId,
    turnId: result.turnId,
    resultAnswerText: result.text,
    resultReasoningText: result.reasoningContent ?? null,
    structuredOutput: result.structuredOutput,
    structuredOutputToolUseId,
    requestId: result.requestId ?? null,
    model: effectiveModel,
    stopReason,
    usage: assistantEventUsage,
  });

  if (options.outputFormat === 'json') {
    return `${JSON.stringify(buildResultEvent({
      turnId: result.turnId,
      sessionId: options.backendSessionId,
      backend: options.backend ?? null,
      text: result.text,
      reasoningText: result.reasoningContent ?? null,
      requestId: result.requestId ?? null,
      structuredOutput: result.structuredOutput,
      structuredOutputToolUseId,
      assistantEvents: assistantSnapshots ?? [],
      assistantOpenPEvents: nestedAssistantOpenPEvents,
      assistantEventUsage,
      lastSubturnUsage,
      durationMs: result.diagnostics.durationMs,
      numTurns: 1,
      totalCostUsd: null,
      stopReason,
      usage: {
        inputTokens: resultUsage.inputTokens,
        outputTokens: resultUsage.outputTokens,
        cacheReadInputTokens: resultUsage.cacheReadInputTokens,
      },
      rawUsage: result.diagnostics.rawUsage ?? null,
      contextWindow: effectiveContextWindow,
      lastSubturnContextTokens,
      model: effectiveModel,
      warnings: options.warnings ?? [],
    }))}\n`;
  }

  void options.includeSystemInit;
  const events: Record<string, unknown>[] = [];
  events.push(
    buildResultEvent({
      turnId: result.turnId,
      sessionId: options.backendSessionId,
      backend: options.backend ?? null,
      text: result.text,
      reasoningText: result.reasoningContent ?? null,
      requestId: result.requestId ?? null,
      structuredOutput: result.structuredOutput,
      structuredOutputToolUseId,
      assistantEvents: assistantSnapshots ?? [],
      assistantOpenPEvents: nestedAssistantOpenPEvents,
      assistantEventUsage,
      lastSubturnUsage,
      durationMs: result.diagnostics.durationMs,
      numTurns: 1,
      totalCostUsd: null,
      stopReason,
      usage: {
        inputTokens: resultUsage.inputTokens,
        outputTokens: resultUsage.outputTokens,
        cacheReadInputTokens: resultUsage.cacheReadInputTokens,
      },
      rawUsage: result.diagnostics.rawUsage ?? null,
      contextWindow: effectiveContextWindow,
      lastSubturnContextTokens,
      model: effectiveModel,
      warnings: options.warnings ?? [],
    }),
  );
  return events.map((event) => `${JSON.stringify(event)}\n`).join('');
}

export function formatIntermediateTextEvent(event: {
  readonly turnId: string;
  readonly text: string;
  readonly sessionId?: string | null;
  readonly model?: string | null;
}): string {
  return `${JSON.stringify(buildAssistantTextEvent({
    turnId: event.turnId,
    sessionId: event.sessionId,
    text: event.text,
    messageId: buildStableMessageId(`intermediate:${event.turnId}`),
    stopReason: null,
    model: event.model,
    openp: buildOpenPAssistantMessage({
      kind: 'answer',
      form: 'streaming',
      turnId: event.turnId,
      sessionId: event.sessionId,
      messageId: buildStableMessageId(`intermediate:${event.turnId}`),
      text: event.text,
    }),
  }))}\n`;
}

export function formatIntermediateReasoningEvent(event: {
  readonly turnId: string;
  readonly text: string;
  readonly contentBlocks?: readonly AssistantContentBlock[] | null;
  readonly sessionId?: string | null;
  readonly model?: string | null;
}): string {
  return `${JSON.stringify(buildAssistantTextEvent({
    turnId: event.turnId,
    sessionId: event.sessionId,
    text: '',
    reasoningContent: event.text,
    reasoningContentBlocks: event.contentBlocks,
    messageId: buildStableMessageId(`intermediate-reasoning:${event.turnId}`),
    stopReason: null,
    model: event.model,
    openp: buildOpenPAssistantMessage({
      kind: 'reasoning',
      form: 'streaming',
      turnId: event.turnId,
      sessionId: event.sessionId,
      messageId: buildStableMessageId(`intermediate-reasoning:${event.turnId}`),
      text: event.text,
    }),
  }))}\n`;
}

export function buildIntermediateAssistantSnapshotEvents(event: {
  readonly snapshot: AssistantEventSnapshot;
  readonly sessionId?: string | null;
  readonly turnId?: string | null;
}): Record<string, unknown>[] {
  return buildAssistantEventsFromSnapshots([event.snapshot], event.sessionId, undefined, {
    turnId: event.turnId ?? null,
    form: 'streaming',
  });
}

export function formatIntermediateAssistantSnapshotEvent(event: {
  readonly snapshot: AssistantEventSnapshot;
  readonly sessionId?: string | null;
  readonly turnId?: string | null;
}): string {
  return buildIntermediateAssistantSnapshotEvents(event)
    .map((snapshotEvent) => `${JSON.stringify(snapshotEvent)}\n`)
    .join('');
}

export function extractAssistantSnapshotText(snapshot: AssistantEventSnapshot): string | null {
  return snapshotAssistantText(snapshot);
}

export function extractAssistantSnapshotReasoningText(snapshot: AssistantEventSnapshot): string | null {
  const content = snapshot.message.content;
  if (!Array.isArray(content) || content.length === 0) {
    return null;
  }
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) {
      return null;
    }
    const item = block as Record<string, unknown>;
    if (item.type === 'thinking' || item.type === 'reasoning') {
      const reasoning = reasoningBlockText(item);
      if (reasoning !== null && reasoning.length > 0) {
        parts.push(reasoning);
      }
    }
  }
  const text = parts.join('\n\n');
  return text.length > 0 ? text : null;
}

export function formatBackgroundAssistantTextEvent(event: {
  readonly turnId: string;
  readonly text: string;
  readonly sessionId?: string | null;
}): string {
  return [
    buildAssistantTextEvent({
      turnId: event.turnId,
      sessionId: event.sessionId,
      text: event.text,
      stopReason: 'end_turn',
      openp: buildOpenPAssistantMessage({
        kind: 'answer',
        form: 'streaming',
        scope: 'background',
        turnId: event.turnId,
        sessionId: event.sessionId,
        text: event.text,
      }),
    }),
  ].map((line) => `${JSON.stringify(line)}\n`).join('');
}

export function formatWorkerTurnResult(result: WorkerTurnResult, event: {
  readonly turnId: string;
  readonly backend?: string | null;
  readonly model?: string | null;
  readonly structuredOutputToolUseId?: string | null;
  readonly suppressAssistantTexts?: readonly string[];
  readonly suppressAssistantReasoningTexts?: readonly string[];
  readonly suppressAssistantSnapshots?: readonly AssistantEventSnapshot[];
  readonly previouslyEmittedAssistantEvents?: readonly Record<string, unknown>[];
  readonly suppressFallbackAssistantText?: boolean;
  readonly warnings?: readonly OutputWarning[];
}): string {
  const usage = {
    inputTokens: result.diagnostics.inputTokens,
    outputTokens: result.diagnostics.outputTokens,
    cacheReadInputTokens: result.diagnostics.cacheReadInputTokens,
  };
  const effectiveModel = result.diagnostics.model ?? event.model ?? null;
  const lastSubturnUsage = result.diagnostics.lastSubturnUsage ?? null;
  const assistantEventUsage = usage;
  const lastSubturnContextTokens =
    result.diagnostics.lastSubturnContextTokens ??
    (lastSubturnUsage ? contextTokensFromUsage(lastSubturnUsage) : null);
  const structuredOutputToolUseId = resolveStructuredOutputToolUseId({
    structuredOutput: result.structuredOutput,
    assistantEvents: result.assistantEvents,
    preferredToolUseId: event.structuredOutputToolUseId,
  });
  const normalizedSnapshots = normalizeStructuredOutputFallbackSnapshots(
    result.assistantEvents,
    result.structuredOutput,
    structuredOutputToolUseId,
  );
  const normalizedSuppressedSnapshots = normalizeStructuredOutputFallbackSnapshots(
    event.suppressAssistantSnapshots,
    result.structuredOutput,
    structuredOutputToolUseId,
  );
  const suppressedResultSnapshots = intersectSuppressedResultSnapshots(
    normalizedSnapshots,
    normalizedSuppressedSnapshots,
  );
  const snapshotStructuredOutputToolUseId = findStructuredOutputToolUseId(normalizedSnapshots);
  const suppressedAssistantTexts = (event.suppressAssistantTexts ?? [])
    .filter((text) => text.length > 0);
  const suppressedAssistantReasoningTexts = (event.suppressAssistantReasoningTexts ?? [])
    .filter((text) => text.length > 0);
  const latestSuppressedAssistantText = suppressedAssistantTexts
    .at(-1) ?? null;
  const fallbackReasoningContent = isReasoningContentAlreadySuppressed(
    result.reasoningContent,
    suppressedAssistantReasoningTexts,
  )
    ? null
    : result.reasoningContent;
  const fallbackStructuredOutput = snapshotStructuredOutputToolUseId === null
    ? result.structuredOutput
    : undefined;
  const assistantSnapshots = filterAssistantSnapshots(normalizedSnapshots, {
    text: suppressedAssistantTexts,
    reasoning: suppressedAssistantReasoningTexts,
    snapshots: normalizedSuppressedSnapshots ?? [],
  });
  const semanticSnapshotsContainResultText = snapshotsContainSemanticAssistantText(normalizedSnapshots, result.content);
  const suppressedSnapshotsContainResultText = nonSemanticSnapshotsContainAssistantText(
    normalizedSuppressedSnapshots,
    result.content,
  );
  const blankResultTextFallback = shouldBlankResultTextFallback(
    result.content,
    latestSuppressedAssistantText,
    event.suppressFallbackAssistantText,
    semanticSnapshotsContainResultText,
  );
  const assistantEvents = buildAssistantEventsFromSnapshots(
    assistantSnapshots,
    result.sessionId,
    assistantEventUsage,
      {
        turnId: event.turnId,
        resultAnswerText: result.content,
        resultReasoningText: fallbackReasoningContent ?? null,
        structuredOutput: result.structuredOutput,
        structuredOutputToolUseId,
        requestId: result.requestId ?? null,
        model: effectiveModel,
        stopReason: result.diagnostics.stopReason,
        usage: assistantEventUsage,
        form: 'result',
      },
    );
  const suppressedResultSnapshotOpenPEvents = buildPreviouslyEmittedAssistantOpenPEvents(
    suppressedResultSnapshots,
    result.sessionId,
    event.turnId,
    result.content,
    fallbackReasoningContent ?? null,
    result.structuredOutput,
    structuredOutputToolUseId,
    result.requestId ?? null,
    effectiveModel,
    result.diagnostics.stopReason,
    assistantEventUsage,
    'result',
  );
  const effectiveFallbackReasoningContent = openPEventsContainReasoningText(
    [...assistantEvents, ...suppressedResultSnapshotOpenPEvents],
    fallbackReasoningContent,
  )
    ? null
    : fallbackReasoningContent;
  const assistantSnapshotsContainResultText =
    snapshotsContainAssistantText(assistantSnapshots, result.content) ||
    openPAnswerEventsContainResultText(assistantEvents, result.content) ||
    openPAnswerEventsContainResultText(suppressedResultSnapshotOpenPEvents, result.content) ||
    openPAnswerEventsAggregateResultText(assistantEvents, result.content) ||
    openPAnswerEventsAggregateResultText(suppressedResultSnapshotOpenPEvents, result.content) ||
    suppressedSnapshotsContainResultText;
  const missingFallbackReasoningContent = openPEventsContainReasoningText(assistantEvents, effectiveFallbackReasoningContent)
    ? null
    : effectiveFallbackReasoningContent;
  const shouldEmitFallbackAssistant = result.structuredOutput !== undefined && fallbackStructuredOutput === undefined
    ? false
    : Boolean(effectiveFallbackReasoningContent)
      || fallbackStructuredOutput !== undefined
      || shouldEmitResultTextFallback(
        result.content,
        latestSuppressedAssistantText,
        event.suppressFallbackAssistantText,
        semanticSnapshotsContainResultText,
      ) && !suppressedSnapshotsContainResultText;
  const textFallbackAfterSnapshots = result.structuredOutput === undefined &&
    assistantEvents.length > 0 &&
    !assistantSnapshotsContainResultText &&
    shouldEmitResultTextFallback(
      result.content,
      latestSuppressedAssistantText,
      event.suppressFallbackAssistantText,
      semanticSnapshotsContainResultText,
    ) && !suppressedSnapshotsContainResultText
    ? buildResultTextAssistantEventRecords({
        turnId: event.turnId,
        sessionId: result.sessionId,
        answerText: result.content,
        reasoningText: missingFallbackReasoningContent,
        emitAnswer: true,
        requestId: result.requestId,
        stopReason: result.diagnostics.stopReason,
        model: effectiveModel,
        usage: assistantEventUsage,
      })
    : [];
  const fallbackAssistantEvents = assistantEvents.length > 0
    ? [
        ...assistantEvents,
        ...textFallbackAfterSnapshots,
        ...(result.structuredOutput !== undefined && !snapshotStructuredOutputToolUseId
          ? [
              ...buildResultTextAssistantEventRecords({
                turnId: event.turnId,
                sessionId: result.sessionId,
                answerText: '',
                reasoningText: missingFallbackReasoningContent,
                emitAnswer: false,
                requestId: result.requestId,
                stopReason: result.diagnostics.stopReason,
                model: effectiveModel,
                usage: assistantEventUsage,
              }),
              buildStructuredOutputAssistantEventRecord({
                turnId: event.turnId,
                sessionId: result.sessionId,
                structuredOutput: result.structuredOutput,
                structuredOutputToolUseId,
                requestId: result.requestId,
                stopReason: result.diagnostics.stopReason,
                model: effectiveModel,
                usage: assistantEventUsage,
              }),
            ]
          : []),
      ]
    : (shouldEmitFallbackAssistant
        ? [
            ...buildResultTextAssistantEventRecords({
              turnId: event.turnId,
              sessionId: result.sessionId,
              answerText: result.content,
              reasoningText: effectiveFallbackReasoningContent,
              emitAnswer: shouldEmitResultTextFallback(
                result.content,
                latestSuppressedAssistantText,
                event.suppressFallbackAssistantText,
                semanticSnapshotsContainResultText,
              ) && !suppressedSnapshotsContainResultText &&
                fallbackStructuredOutput === undefined &&
                !blankResultTextFallback,
              requestId: result.requestId,
              stopReason: result.diagnostics.stopReason,
              model: effectiveModel,
              usage: assistantEventUsage,
            }),
            ...(fallbackStructuredOutput !== undefined
              ? [buildStructuredOutputAssistantEventRecord({
                  turnId: event.turnId,
                  sessionId: result.sessionId,
                  structuredOutput: fallbackStructuredOutput,
                  structuredOutputToolUseId,
                  requestId: result.requestId,
                  stopReason: result.diagnostics.stopReason,
                  model: effectiveModel,
                  usage: assistantEventUsage,
                })]
              : []),
          ]
        : []);

  const emittedAssistantOpenPEvents = buildNestedAssistantOpenPEvents({
    previouslyEmittedSnapshots: suppressedResultSnapshots,
    previouslyEmittedAssistantEvents: event.previouslyEmittedAssistantEvents,
    emittedAssistantEvents: fallbackAssistantEvents,
    sessionId: result.sessionId,
    turnId: event.turnId,
    resultAnswerText: result.content,
    resultReasoningText: result.reasoningContent,
    structuredOutput: result.structuredOutput,
    structuredOutputToolUseId,
    requestId: result.requestId ?? null,
    model: effectiveModel,
    stopReason: result.diagnostics.stopReason,
    usage: assistantEventUsage,
  });
  const events = [
    buildResultEvent({
      turnId: event.turnId,
      sessionId: result.sessionId,
      backend: event.backend ?? null,
      text: result.content,
      reasoningText: result.reasoningContent,
      requestId: result.requestId ?? null,
      structuredOutput: result.structuredOutput,
      structuredOutputToolUseId,
      assistantEvents: assistantSnapshots ?? [],
      assistantOpenPEvents: emittedAssistantOpenPEvents,
      assistantEventUsage,
      lastSubturnUsage,
      durationMs: result.diagnostics.durationMs,
      numTurns: result.diagnostics.numTurns,
      totalCostUsd: result.diagnostics.totalCostUsd,
      stopReason: result.diagnostics.stopReason,
      usage,
      rawUsage: result.diagnostics.rawUsage ?? null,
      contextWindow: result.diagnostics.contextWindow,
      lastSubturnContextTokens,
      model: effectiveModel,
      warnings: event.warnings ?? [],
    }),
  ];
  return events.map((line) => `${JSON.stringify(line)}\n`).join('');
}

function formatTextWarnings(warnings: readonly OutputWarning[] | undefined): string {
  if (!warnings || warnings.length === 0) {
    return '';
  }
  return warnings
    .map((warning) => `[openp ${warning.severity}] ${warning.code}: ${warning.message}\n`)
    .join('');
}

function formatVerboseTextMarker(verbose: boolean | undefined): string {
  return verbose ? '[openp verbose] enabled\n' : '';
}

function resultAnswerTextForTextOutput(result: TurnResult, options: OutputOptions): string {
  const structuredOutputToolUseId = resolveStructuredOutputToolUseId({
    structuredOutput: result.structuredOutput,
    assistantEvents: result.assistantEvents,
    preferredToolUseId: options.structuredOutputToolUseId,
  });
  const normalizedSnapshots = normalizeStructuredOutputFallbackSnapshots(
    result.assistantEvents,
    result.structuredOutput,
    structuredOutputToolUseId,
  );
  const normalizedSuppressedSnapshots = normalizeStructuredOutputFallbackSnapshots(
    options.suppressAssistantSnapshots,
    result.structuredOutput,
    structuredOutputToolUseId,
  );
  const suppressedAssistantTexts = options.suppressAssistantTexts ?? [];
  const suppressedAssistantReasoningTexts = options.suppressAssistantReasoningTexts ?? [];
  const assistantSnapshots = filterAssistantSnapshots(normalizedSnapshots, {
    text: suppressedAssistantTexts,
    reasoning: suppressedAssistantReasoningTexts,
    snapshots: normalizedSuppressedSnapshots ?? [],
  });
  const resultUsage = result.diagnostics.usage;
  const assistantEventUsage = resultUsage;
  const assistantEvents = buildAssistantEventsFromSnapshots(
    assistantSnapshots,
    options.backendSessionId,
    assistantEventUsage,
    {
      turnId: result.turnId,
      resultAnswerText: result.text,
      resultReasoningText: result.reasoningContent ?? null,
      structuredOutput: result.structuredOutput,
      structuredOutputToolUseId,
      requestId: result.requestId ?? null,
      model: result.diagnostics.model ?? options.model ?? null,
      stopReason: result.diagnostics.stopReason ?? 'end_turn',
      usage: assistantEventUsage,
      form: 'result',
    },
  );
  const answers = collectOpenPAnswersFromAssistantEvents(extractEmittedAssistantOpenPEvents(assistantEvents));
  return answers.length > 0 ? answers.join('\n\n') : result.text;
}

function shouldEmitResultTextFallback(
  text: string,
  latestSuppressedText: string | null,
  suppressFallback: boolean | undefined,
  semanticSnapshotMatchesResult = false,
): boolean {
  if (text.length === 0) {
    return false;
  }
  if (semanticSnapshotMatchesResult) {
    return true;
  }
  if (!suppressFallback) {
    return true;
  }
  return latestSuppressedText !== text;
}

function shouldBlankResultTextFallback(
  text: string,
  latestSuppressedText: string | null,
  suppressFallback: boolean | undefined,
  semanticSnapshotMatchesResult: boolean,
): boolean {
  return Boolean(suppressFallback) &&
    !semanticSnapshotMatchesResult &&
    text.length > 0 &&
    latestSuppressedText === text;
}

type OpenPEventKind = 'answer' | 'reasoning' | 'tool_call' | 'tool_result' | 'structured_output' | 'metadata';
type OpenPAssistantEventKind = Exclude<OpenPEventKind, 'answer' | 'reasoning'>;
type OpenPForm = 'streaming' | 'result';
type OpenPScope = 'active' | 'background';
type OpenPOutputKey = 'answer' | 'reasoning' | 'toolCall' | 'toolResult';
type OpenPResultOutput = {
  answer: string[];
  reasoning: string[];
  toolCall: Record<string, unknown>[];
  toolResult: Record<string, unknown>[];
};

function openPScopeFromSemanticKind(semanticKind: AssistantEventSnapshot['semanticKind']): OpenPScope {
  return semanticKind === 'background' ? 'background' : 'active';
}

function nativePhaseMetadataFromSemanticKind(
  semanticKind: AssistantEventSnapshot['semanticKind'],
): Record<string, unknown> | null {
  if (semanticKind === 'commentary' || semanticKind === 'progress') {
    return { nativePhase: semanticKind };
  }
  return null;
}

function buildOpenPOutputRecord(event: {
  readonly form: OpenPForm;
  readonly scope: OpenPScope;
  readonly turnId?: string | null;
  readonly sessionId?: string | null;
  readonly output: Record<string, unknown>;
  readonly structuredOutput?: unknown;
  readonly metadata?: Record<string, unknown> | null;
}): Record<string, unknown> {
  const metadata = compactRecord(event.metadata ?? {});
  const record = compactRecord({
    version: OPENP_NATIVE_VERSION,
    form: event.form,
    scope: event.scope,
    turnId: event.turnId ?? null,
    sessionId: event.sessionId ?? null,
    output: event.output,
    structuredOutput: event.structuredOutput ?? null,
    metadata: Object.keys(metadata).length > 0 ? metadata : {},
  });
  return assertOpenPOutputRecord(record);
}

function buildOpenPResultOutput(input: Partial<Record<OpenPOutputKey, unknown>> = {}): OpenPResultOutput {
  return {
    answer: stringArray(input.answer),
    reasoning: stringArray(input.reasoning),
    toolCall: recordArray(input.toolCall),
    toolResult: recordArray(input.toolResult),
  };
}

function openPOutputFromAssistantEvent(event: {
  readonly form: OpenPForm;
  readonly kind: OpenPAssistantEventKind;
  readonly structuredOutput?: unknown;
  readonly toolCalls: readonly Record<string, unknown>[];
  readonly toolResults: readonly Record<string, unknown>[];
}): Record<string, unknown> {
  const toolCall = event.toolCalls[0] ??
    (event.kind === 'structured_output' && event.structuredOutput !== undefined
      ? buildOpenPStructuredOutputToolCall(buildToolUseId(), event.structuredOutput)
      : undefined);
  const toolResult = event.toolResults[0];
  if (event.form === 'streaming') {
    if (toolCall) return { toolCall };
    if (toolResult) return { toolResult };
    throw new Error('streaming tool output must carry toolCall or toolResult payload');
  }
  return buildOpenPResultOutput({
    toolCall: toolCall ? [toolCall] : [],
    toolResult: toolResult ? [toolResult] : [],
  });
}

function assertOpenPOutputRecord(openp: Record<string, unknown>): Record<string, unknown> {
  if (openp.form !== 'streaming' && openp.form !== 'result') {
    throw new Error('openp record must declare form as streaming or result');
  }
  if (openp.scope !== 'active' && openp.scope !== 'background') {
    throw new Error('openp record must declare scope as active or background');
  }
  const output = openp.output;
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error('openp record must carry output object');
  }
  const keys = Object.keys(output as Record<string, unknown>);
  if (openp.form === 'streaming') {
    if (openp.structuredOutput !== null && openp.structuredOutput !== undefined) {
      throw new Error('streaming openp record must not carry structuredOutput');
    }
    const present = keys.filter((key) => ['answer', 'reasoning', 'toolCall', 'toolResult'].includes(key));
    if (present.length !== 1 || present.length !== keys.length) {
      throw new Error('streaming openp.output must contain exactly one payload key');
    }
    return openp;
  }
  const expected = ['answer', 'reasoning', 'toolCall', 'toolResult'];
  if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) {
    throw new Error('result openp.output must contain exactly answer/reasoning/toolCall/toolResult arrays');
  }
  if (expected.some((key) => !Array.isArray((output as Record<string, unknown>)[key]))) {
    throw new Error('result openp.output must aggregate answer/reasoning/toolCall/toolResult arrays');
  }
  return openp;
}

function stringArray(value: unknown): string[] {
  if (typeof value === 'string') {
    return value.length > 0 ? [value] : [];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function recordArray(value: unknown): Record<string, unknown>[] {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return [value as Record<string, unknown>];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is Record<string, unknown> =>
    Boolean(item) && typeof item === 'object' && !Array.isArray(item)
  );
}

function buildOpenPAssistantMessage(event: {
  readonly kind: 'answer' | 'reasoning';
  readonly form: OpenPForm;
  readonly scope?: OpenPScope;
  readonly turnId?: string | null;
  readonly sessionId?: string | null;
  readonly messageId?: string | null;
  readonly requestId?: string | null;
  readonly text: string;
  readonly metadata?: Record<string, unknown> | null;
}): Record<string, unknown> {
  return buildOpenPOutputRecord({
    form: event.form,
    scope: event.scope ?? 'active',
    turnId: event.turnId ?? null,
    sessionId: event.sessionId ?? null,
    output: event.form === 'streaming'
      ? { [event.kind]: event.text }
      : buildOpenPResultOutput({
          [event.kind]: event.text.length > 0 ? [event.text] : [],
        }),
    structuredOutput: null,
    metadata: compactRecord({
      ...(event.metadata ?? {}),
      messageId: event.messageId ?? event.metadata?.messageId ?? undefined,
      requestId: event.requestId ?? event.metadata?.requestId ?? undefined,
    }),
  });
}

function buildOpenPResultMessage(event: {
  readonly turnId?: string | null;
  readonly sessionId?: string | null;
  readonly answerText: string;
  readonly metadata?: Record<string, unknown> | null;
}): Record<string, unknown> {
  return buildOpenPAssistantMessage({
    kind: 'answer',
    form: 'result',
    scope: 'active',
    turnId: event.turnId ?? null,
    sessionId: event.sessionId ?? null,
    text: event.answerText,
    metadata: event.metadata ?? null,
  });
}

function buildOpenPAssistantEvent(event: {
  readonly kind: OpenPAssistantEventKind;
  readonly form?: OpenPForm;
  readonly scope?: OpenPScope;
  readonly turnId?: string | null;
  readonly sessionId?: string | null;
  readonly requestId?: string | null;
  readonly structuredOutput?: unknown;
  readonly toolCalls?: readonly Record<string, unknown>[];
  readonly toolResults?: readonly Record<string, unknown>[];
  readonly messageBlocks?: readonly unknown[];
  readonly metadata?: Record<string, unknown> | null;
}): Record<string, unknown> {
  const form = event.form ?? 'streaming';
  const output = openPOutputFromAssistantEvent({
    form,
    kind: event.kind,
    ...(event.structuredOutput !== undefined ? { structuredOutput: event.structuredOutput } : {}),
    toolCalls: event.toolCalls ?? [],
    toolResults: event.toolResults ?? [],
  });
  return buildOpenPOutputRecord({
    form,
    scope: event.scope ?? 'active',
    turnId: event.turnId ?? null,
    sessionId: event.sessionId ?? null,
    output,
    structuredOutput: event.structuredOutput ?? null,
    metadata: compactRecord({
      ...(event.metadata ?? {}),
      requestId: event.requestId ?? undefined,
      ...(event.messageBlocks && metadataMessageBlocks(event.messageBlocks).length > 0
        ? { messageBlocks: metadataMessageBlocks(event.messageBlocks) }
        : {}),
    }),
  });
}

function buildOpenPStructuredOutputAssistantEvent(event: {
  readonly turnId?: string | null;
  readonly sessionId?: string | null;
  readonly metadata?: Record<string, unknown> | null;
}): Record<string, unknown> {
  return buildOpenPAssistantEvent({
    kind: 'structured_output',
    form: 'result',
    scope: 'active',
    turnId: event.turnId ?? null,
    sessionId: event.sessionId ?? null,
    metadata: event.metadata ?? null,
  });
}

function buildOpenPAssistantEventsFromSnapshot(
  snapshot: AssistantEventSnapshot,
  context: {
    readonly turnId?: string | null;
    readonly sessionId?: string | null;
    readonly resultAnswerText?: string | null;
    readonly resultReasoningText?: string | null;
    readonly structuredOutput?: unknown;
    readonly structuredOutputToolUseId?: string | null;
    readonly requestId?: string | null;
    readonly model?: string | null;
    readonly stopReason?: string | null;
    readonly usage?: BackendUsage | null;
    readonly form?: OpenPForm;
  },
): Record<string, unknown>[] {
  const text = snapshotAssistantText(snapshot);
  const reasoningText = extractAssistantSnapshotReasoningText(snapshot);
  const toolCalls = extractOpenPToolCalls(snapshot.message);
  const toolResults = extractOpenPToolResults(snapshot.message);
  const messageBlocks = extractOpenPMessageBlocks(snapshot.message);
  const metadata = buildOpenPMessageMetadata(snapshot.message, snapshot.requestId ?? null);
  const nativePhaseMetadata = nativePhaseMetadataFromSemanticKind(snapshot.semanticKind);
  const contextMetadata = mergeOpenPContextMetadata(metadata, {
    requestId: context.requestId ?? null,
    model: context.model ?? null,
    stopReason: context.stopReason ?? null,
    usage: context.usage ?? null,
  });
  const eventMetadata = nativePhaseMetadata
    ? {
        ...(contextMetadata ?? {}),
        ...nativePhaseMetadata,
      }
    : contextMetadata;
  const scope = openPScopeFromSemanticKind(snapshot.semanticKind);
  if (scope === 'background') {
    return text && text.length > 0
      ? [buildOpenPAssistantMessage({
          kind: 'answer',
          form: context.form ?? 'streaming',
          scope,
          turnId: context.turnId ?? null,
          sessionId: context.sessionId ?? null,
          requestId: snapshot.requestId ?? null,
          text,
          metadata: eventMetadata,
        })]
      : [];
  }
  const resultReasoningText = reasoningText ??
    (context.structuredOutput !== undefined
      ? context.resultReasoningText ?? null
      : null);
  const hasStructuredToolCall = hasStructuredOutputToolCall(toolCalls);
  const isStructuredOutputFallbackSnapshot = context.structuredOutput !== undefined &&
    snapshotTextEqualsStructuredOutput(snapshot, context.structuredOutput);
  const structuredOutputToolUseId = context.structuredOutputToolUseId ?? null;
  const structuredToolCalls = !hasStructuredToolCall &&
    isStructuredOutputFallbackSnapshot &&
    structuredOutputToolUseId
    ? [buildOpenPStructuredOutputToolCall(structuredOutputToolUseId, context.structuredOutput)]
    : toolCalls;
  const structuredMessageBlocks = !hasStructuredToolCall &&
    isStructuredOutputFallbackSnapshot &&
    structuredOutputToolUseId
    ? [buildStructuredOutputToolUseMessageBlock(structuredOutputToolUseId, context.structuredOutput)]
    : messageBlocks;
  if (
    !snapshot.semanticKind &&
    context.structuredOutput !== undefined &&
    (hasStructuredToolCall || isStructuredOutputFallbackSnapshot)
  ) {
    const structuredEvents: Record<string, unknown>[] = [
      ...buildOpenPTextAssistantMessages({
        text: null,
        reasoningText: resultReasoningText,
        form: context.form ?? 'streaming',
        scope: 'active',
        turnId: context.turnId ?? null,
        sessionId: context.sessionId ?? null,
        requestId: snapshot.requestId ?? null,
        metadata: contextMetadata,
      }),
	      ...structuredToolCalls.map((toolCall) => buildOpenPAssistantEvent({
	        kind: 'structured_output',
	        form: context.form ?? 'streaming',
	        scope: 'active',
	        turnId: context.turnId ?? null,
	        sessionId: context.sessionId ?? null,
	        requestId: snapshot.requestId ?? null,
	        structuredOutput: context.structuredOutput,
	        toolCalls: [toolCall],
	        messageBlocks: filterOpenPMessageBlocksForKind(structuredMessageBlocks, 'structured_output'),
	        metadata: contextMetadata,
	      })),
	      ...toolResults.map((toolResult) => buildOpenPAssistantEvent({
	        kind: 'tool_result',
	        form: context.form ?? 'streaming',
	        scope: 'active',
	        turnId: context.turnId ?? null,
	        sessionId: context.sessionId ?? null,
	        requestId: snapshot.requestId ?? null,
	        toolResults: [toolResult],
	        messageBlocks: filterOpenPMessageBlocksForKind(messageBlocks, 'tool_result'),
	        metadata: contextMetadata,
	      })),
	    ];
	    const metadataBlocks = filterOpenPMessageBlocksForKind(messageBlocks, 'metadata');
	    if (metadataBlocks.length > 0 && (context.form ?? 'streaming') === 'result') {
      structuredEvents.push(buildOpenPAssistantEvent({
        kind: 'metadata',
        form: context.form ?? 'streaming',
        scope: 'active',
        turnId: context.turnId ?? null,
        sessionId: context.sessionId ?? null,
        requestId: snapshot.requestId ?? null,
        messageBlocks: metadataBlocks,
        metadata: contextMetadata,
      }));
    }
    return structuredEvents;
  }
  const hasToolPayload = toolCalls.length > 0 || toolResults.length > 0;
  if (!hasToolPayload && !snapshot.semanticKind && isResultAssistantSnapshot({
    text,
    reasoningText,
    hasTerminalStop: snapshotHasTerminalStop(snapshot),
    resultAnswerText: context.resultAnswerText ?? null,
    resultReasoningText: context.resultReasoningText ?? null,
  })) {
    const resultEvents = buildOpenPTextAssistantMessages({
      text,
      reasoningText: resultReasoningText,
      form: 'result',
      scope: 'active',
      turnId: context.turnId ?? null,
      sessionId: context.sessionId ?? null,
      requestId: snapshot.requestId ?? null,
      metadata: contextMetadata,
    });
    const metadataBlocks = filterOpenPMessageBlocksForKind(messageBlocks, 'metadata');
	    if (metadataBlocks.length > 0 && (context.form ?? 'streaming') === 'result') {
      resultEvents.push(buildOpenPAssistantEvent({
        kind: 'metadata',
        form: 'result',
        scope: 'active',
        turnId: context.turnId ?? null,
        sessionId: context.sessionId ?? null,
        requestId: snapshot.requestId ?? null,
        messageBlocks: metadataBlocks,
        metadata: contextMetadata,
      }));
    }
    return resultEvents;
  }
  const events = buildOpenPTextAssistantMessages({
    text,
    reasoningText,
    form: context.form ?? 'streaming',
    scope,
    turnId: context.turnId ?? null,
    sessionId: context.sessionId ?? null,
    requestId: snapshot.requestId ?? null,
    metadata: eventMetadata,
  });
	  if (toolCalls.length > 0) {
	    events.push(...toolCalls.map((toolCall) => buildOpenPAssistantEvent({
	      kind: 'tool_call',
	      form: context.form ?? 'streaming',
	      scope,
	      turnId: context.turnId ?? null,
	      sessionId: context.sessionId ?? null,
	      requestId: snapshot.requestId ?? null,
	      toolCalls: [toolCall],
	      messageBlocks: filterOpenPMessageBlocksForKind(messageBlocks, 'tool_call'),
	      metadata: eventMetadata,
	    })));
	  }
	  if (toolResults.length > 0) {
	    events.push(...toolResults.map((toolResult) => buildOpenPAssistantEvent({
	      kind: 'tool_result',
	      form: context.form ?? 'streaming',
	      scope,
	      turnId: context.turnId ?? null,
	      sessionId: context.sessionId ?? null,
	      requestId: snapshot.requestId ?? null,
	      toolResults: [toolResult],
	      messageBlocks: filterOpenPMessageBlocksForKind(messageBlocks, 'tool_result'),
	      metadata: eventMetadata,
	    })));
	  }
	  const metadataBlocks = filterOpenPMessageBlocksForKind(messageBlocks, 'metadata');
	  if (metadataBlocks.length > 0 && (context.form ?? 'streaming') === 'result') {
    events.push(buildOpenPAssistantEvent({
      kind: 'metadata',
      form: context.form ?? 'streaming',
      scope,
      turnId: context.turnId ?? null,
      sessionId: context.sessionId ?? null,
      requestId: snapshot.requestId ?? null,
      messageBlocks: metadataBlocks,
      metadata: eventMetadata,
    }));
  }
	  if (events.length === 0 && eventMetadata && (context.form ?? 'streaming') === 'result') {
    events.push(buildOpenPAssistantEvent({
      kind: 'metadata',
      form: context.form ?? 'streaming',
      scope,
      turnId: context.turnId ?? null,
      sessionId: context.sessionId ?? null,
      requestId: snapshot.requestId ?? null,
      metadata: eventMetadata,
    }));
  }
  return events;
}

function isResultAssistantSnapshot(event: {
  readonly text: string | null;
  readonly reasoningText: string | null;
  readonly hasTerminalStop: boolean;
  readonly resultAnswerText: string | null;
  readonly resultReasoningText: string | null;
}): boolean {
  if (!event.hasTerminalStop) {
    return false;
  }
  if (event.text !== null && event.text.length > 0 && event.text === event.resultAnswerText) {
    return event.reasoningText === null || event.reasoningText === event.resultReasoningText;
  }
  return (event.resultAnswerText === null || event.resultAnswerText.length === 0) &&
    event.text === null &&
    event.reasoningText !== null &&
    event.reasoningText.length > 0 &&
    event.reasoningText === event.resultReasoningText;
}

function buildOpenPTextAssistantMessages(event: {
  readonly text: string | null;
  readonly reasoningText: string | null;
  readonly form: OpenPForm;
  readonly scope: OpenPScope;
  readonly turnId?: string | null;
  readonly sessionId?: string | null;
  readonly requestId?: string | null;
  readonly metadata?: Record<string, unknown> | null;
}): Record<string, unknown>[] {
  const output: Record<string, unknown>[] = [];
  if (event.reasoningText && event.reasoningText.length > 0) {
    output.push(buildOpenPAssistantMessage({
      kind: 'reasoning',
      form: event.form,
      scope: event.scope,
      turnId: event.turnId ?? null,
      sessionId: event.sessionId ?? null,
      requestId: event.requestId ?? null,
      text: event.reasoningText,
      metadata: event.metadata ?? null,
    }));
  }
  if (event.text && event.text.length > 0) {
    output.push(buildOpenPAssistantMessage({
      kind: 'answer',
      form: event.form,
      scope: event.scope,
      turnId: event.turnId ?? null,
      sessionId: event.sessionId ?? null,
      requestId: event.requestId ?? null,
      text: event.text,
      metadata: event.metadata ?? null,
    }));
  }
  return output;
}

function filterOpenPMessageBlocksForKind(blocks: readonly unknown[], kind: Exclude<OpenPEventKind, 'answer' | 'reasoning'>): unknown[] {
  return blocks.filter((block) => {
    if (!block || typeof block !== 'object' || Array.isArray(block)) {
      return false;
    }
    const type = (block as Record<string, unknown>).type;
    if (kind === 'tool_call' || kind === 'structured_output') {
      return type === 'tool_use' || type === 'server_tool_use';
    }
    if (kind === 'tool_result') {
      return type === 'tool_result';
    }
    return isNeutralOpenPMetadataBlock(block as Record<string, unknown>);
  });
}

function isNeutralOpenPMetadataBlock(block: Record<string, unknown>): boolean {
  const type = block.type;
  if (typeof type !== 'string') {
    return false;
  }
  if (isForbiddenOpenPMetadataTypeValue(type)) {
    return false;
  }
  return !hasOpenPMetadataForbiddenField(block);
}

function isForbiddenOpenPMetadataTypeValue(value: string): boolean {
  return new Set([
    'answer',
    'toolCall',
    'toolResult',
    'output',
    'kind',
    'text',
    'textDelta',
    'answerText',
    'answers',
    'reasoningText',
    'thinking',
    'reasoning',
    'toolCalls',
    'toolResults',
    'assistantEvents',
    'assistant.message',
    'assistant.event',
    'tool_use',
    'server_tool_use',
    'tool_result',
    'output_text',
    'message.partial',
    'message.final',
  ]).has(value);
}

function hasOpenPMetadataForbiddenField(value: unknown): boolean {
  const forbiddenFields = new Set([
    'answer',
    'toolCall',
    'toolResult',
    'output',
    'kind',
    'text',
    'textDelta',
    'answerText',
    'answers',
    'reasoningText',
    'thinking',
    'reasoning',
    'toolCalls',
    'toolResults',
    'assistantEvents',
    'assistant.message',
    'assistant.event',
    'input',
    'content',
    'tool_use_id',
    'is_error',
  ]);
  const visit = (item: unknown, nestedDepth: number): boolean => {
    if (Array.isArray(item)) {
      return item.some((nested) => visit(nested, nestedDepth + 1));
    }
    if (!item || typeof item !== 'object') {
      return false;
    }
    for (const [key, nested] of Object.entries(item as Record<string, unknown>)) {
      if (forbiddenFields.has(key)) {
        return true;
      }
      if (
        key === 'type' &&
        typeof nested === 'string' &&
        isForbiddenOpenPMetadataTypeValue(nested)
      ) {
        return true;
      }
      if (visit(nested, nestedDepth + 1)) {
        return true;
      }
    }
    return false;
  };
  return visit(value, 0);
}

function extractOpenPMessageBlocks(message: Record<string, unknown>): unknown[] {
  const content = message.content;
  if (!Array.isArray(content)) {
    return [];
  }
  return content.map(normalizePublicContentBlock);
}

function extractOpenPToolCalls(message: Record<string, unknown>): Record<string, unknown>[] {
  const content = message.content;
  if (!Array.isArray(content)) {
    return [];
  }
  const toolCalls: Record<string, unknown>[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) {
      continue;
    }
    const item = block as Record<string, unknown>;
    if (item.type !== 'tool_use' && item.type !== 'server_tool_use') {
      continue;
    }
    toolCalls.push(compactRecord({
      type: item.type,
      id: typeof item.id === 'string' ? item.id : undefined,
      name: typeof item.name === 'string' ? item.name : undefined,
      input: Object.prototype.hasOwnProperty.call(item, 'input') ? item.input : undefined,
      caller: Object.prototype.hasOwnProperty.call(item, 'caller') ? item.caller : undefined,
    }));
  }
  return toolCalls;
}

function extractOpenPToolResults(message: Record<string, unknown>): Record<string, unknown>[] {
  const content = message.content;
  if (!Array.isArray(content)) {
    return [];
  }
  const toolResults: Record<string, unknown>[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) {
      continue;
    }
    const item = block as Record<string, unknown>;
    if (item.type !== 'tool_result') {
      continue;
    }
    toolResults.push(compactRecord({
      type: 'tool_result',
      toolUseId: typeof item.tool_use_id === 'string' ? item.tool_use_id : undefined,
      content: Object.prototype.hasOwnProperty.call(item, 'content') ? item.content : undefined,
      isError: typeof item.is_error === 'boolean' ? item.is_error : undefined,
    }));
  }
  return toolResults;
}

function hasStructuredOutputToolCall(toolCalls: readonly Record<string, unknown>[]): boolean {
  return toolCalls.some((toolCall) => toolCall.name === 'StructuredOutput');
}

function collectOpenPToolCallsFromAssistantEvents(events: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  return events.flatMap((event) => {
    if (event.scope === 'background' || event.form !== 'result') {
      return [];
    }
    const output = asOpenPOutput(event);
    return recordArray(output?.toolCall);
  });
}

function collectOpenPAnswersFromAssistantEvents(events: readonly Record<string, unknown>[]): string[] {
  return events.flatMap((event) => {
    if (event.scope === 'background' || event.form !== 'result') {
      return [];
    }
    const output = asOpenPOutput(event);
    return stringArray(output?.answer);
  });
}

function openPAnswerEventsAggregateResultText(events: readonly Record<string, unknown>[], text: string): boolean {
  if (text.length === 0) {
    return false;
  }
  const extracted = extractEmittedAssistantOpenPEvents(events);
  const answers = collectOpenPAnswersFromAssistantEvents(extracted.length > 0 ? extracted : events);
  return answers.length > 0 && answers.join('\n\n') === text;
}

function openPAnswerEventsContainResultText(events: readonly Record<string, unknown>[], text: string): boolean {
  if (text.length === 0) {
    return false;
  }
  const extracted = extractEmittedAssistantOpenPEvents(events);
  const answers = collectOpenPAnswersFromAssistantEvents(extracted.length > 0 ? extracted : events);
  return answers.includes(text);
}

function collectOpenPReasoningFromAssistantEvents(events: readonly Record<string, unknown>[]): string[] {
  return events.flatMap((event) => {
    if (event.scope === 'background' || event.form !== 'result') {
      return [];
    }
    const output = asOpenPOutput(event);
    return stringArray(output?.reasoning);
  });
}

function collectOpenPToolResultsFromAssistantEvents(events: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  return events.flatMap((event) => {
    if (event.scope === 'background' || event.form !== 'result') {
      return [];
    }
    const output = asOpenPOutput(event);
    return recordArray(output?.toolResult);
  });
}

function collectOpenPMessageBlocksFromAssistantEvents(events: readonly Record<string, unknown>[]): unknown[] {
  return events.flatMap((event) => {
    if (event.scope === 'background' || event.form !== 'result') return [];
    const metadata = event.metadata && typeof event.metadata === 'object' && !Array.isArray(event.metadata)
      ? event.metadata as Record<string, unknown>
      : {};
    return Array.isArray(metadata.messageBlocks) ? metadata.messageBlocks : [];
  });
}

function asOpenPOutput(event: Record<string, unknown>): Record<string, unknown> | null {
  return event.output && typeof event.output === 'object' && !Array.isArray(event.output)
    ? event.output as Record<string, unknown>
    : null;
}

function buildOpenPMessageMetadata(
  message: Record<string, unknown>,
  requestId: string | null,
): Record<string, unknown> | null {
  const metadata = compactRecord({
    requestId: requestId ?? undefined,
    messageId: typeof message.id === 'string' ? message.id : undefined,
    model: typeof message.model === 'string' ? message.model : undefined,
    stopReason: Object.prototype.hasOwnProperty.call(message, 'stop_reason') ? message.stop_reason : undefined,
    usage: normalizeOpenPUsage(message.usage),
  });
  return Object.keys(metadata).length > 0 ? metadata : null;
}

function mergeOpenPContextMetadata(
  metadata: Record<string, unknown> | null,
  event: {
    readonly requestId?: string | null;
    readonly model?: string | null;
    readonly stopReason?: string | null;
    readonly usage?: BackendUsage | null;
  },
): Record<string, unknown> | null {
  const existing = metadata ?? {};
  const stopReason = Object.prototype.hasOwnProperty.call(existing, 'stopReason')
    ? existing.stopReason
    : event.stopReason ?? undefined;
  const merged = compactRecord({
    ...existing,
    requestId: existing.requestId ?? event.requestId ?? undefined,
    model: existing.model ?? event.model ?? undefined,
    stopReason,
    usage: existing.usage ?? (event.usage ? buildOpenPUsage(event.usage) : undefined),
  });
  return Object.keys(merged).length > 0 ? merged : null;
}

function addOpenPMetadata(
  openp: Record<string, unknown>,
  event: {
    readonly requestId?: string | null;
    readonly messageId?: string | null;
    readonly model?: string | null;
    readonly stopReason?: string | null;
    readonly usage?: {
      readonly inputTokens: number | null;
      readonly outputTokens: number | null;
      readonly cacheReadInputTokens: number | null;
    };
  },
): Record<string, unknown> {
  const existing = openp.metadata && typeof openp.metadata === 'object' && !Array.isArray(openp.metadata)
    ? openp.metadata as Record<string, unknown>
    : {};
  const metadata = compactRecord({
    ...existing,
    requestId: event.requestId ?? existing.requestId,
    messageId: event.messageId ?? existing.messageId,
    model: event.model ?? existing.model,
    stopReason: Object.prototype.hasOwnProperty.call(event, 'stopReason') ? event.stopReason : existing.stopReason,
    usage: event.usage ? buildOpenPUsage(event.usage) : existing.usage,
  });
  return Object.keys(metadata).length > 0
    ? { ...openp, metadata }
    : openp;
}

function normalizeOpenPUsage(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const usage = value as Record<string, unknown>;
  const normalized = compactRecord({
    inputTokens: numberOrNull(usage.input_tokens),
    outputTokens: numberOrNull(usage.output_tokens),
    cacheReadInputTokens: numberOrNull(usage.cache_read_input_tokens),
  });
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function numberOrNull(value: unknown): number | null | undefined {
  return typeof value === 'number' || value === null ? value : undefined;
}

function addOpenPStructuredOutput(
  openp: Record<string, unknown>,
  event: {
    readonly id: string;
    readonly input: unknown;
  },
): Record<string, unknown> {
  const output = asOpenPOutput(openp) ?? {};
  const structuredToolCall = buildOpenPStructuredOutputToolCall(event.id, event.input);
  const nextOutput = openp.form === 'streaming'
    ? { toolCall: structuredToolCall }
    : buildOpenPResultOutput({
        ...output,
        toolCall: [...recordArray(output.toolCall), structuredToolCall],
      });
  return {
    ...openp,
    output: nextOutput,
    structuredOutput: event.input,
  };
}

function buildOpenPStructuredOutputToolCall(id: string, input: unknown): Record<string, unknown> {
  return {
    type: 'tool_use',
    id,
    name: 'StructuredOutput',
    input,
    caller: { type: 'direct' },
  };
}

function addOpenPMessageBlocks(
  openp: Record<string, unknown>,
  blocks: readonly Record<string, unknown>[],
): Record<string, unknown> {
  const messageBlocks = metadataMessageBlocks(blocks);
  if (messageBlocks.length === 0) {
    return openp;
  }
  const metadata = openp.metadata && typeof openp.metadata === 'object' && !Array.isArray(openp.metadata)
    ? openp.metadata as Record<string, unknown>
    : {};
  return {
    ...openp,
    metadata: {
      ...metadata,
      messageBlocks,
    },
  };
}

function metadataMessageBlocks(blocks: readonly unknown[]): Record<string, unknown>[] {
  return filterOpenPMessageBlocksForKind(blocks, 'metadata')
    .map(normalizePublicContentBlock)
    .filter((block): block is Record<string, unknown> =>
      Boolean(block) && typeof block === 'object' && !Array.isArray(block)
    );
}

function buildOpenPTurnResult(event: {
  readonly turnId: string;
  readonly sessionId: string;
  readonly backend?: string | null;
  readonly answerText: string;
  readonly reasoningText?: string | null;
  readonly assistantEvents: readonly AssistantEventSnapshot[];
  readonly assistantOpenPEvents?: readonly Record<string, unknown>[];
  readonly structuredOutput?: unknown;
  readonly structuredOutputToolUseId?: string | null;
  readonly requestId?: string | null;
  readonly model?: string | null;
  readonly stopReason?: string | null;
  readonly numTurns: number | null;
  readonly durationMs: number | null;
  readonly totalCostUsd: number | null;
  readonly contextWindow: number | null;
  readonly lastSubturnContextTokens: number | null;
  readonly modelUsage?: Record<string, Record<string, number>>;
  readonly rawUsage?: Record<string, unknown> | null;
  readonly warnings?: readonly OutputWarning[];
  readonly assistantEventUsage?: BackendUsage | null;
  readonly lastSubturnUsage?: BackendUsage | null;
  readonly usage: {
    readonly inputTokens: number | null;
    readonly outputTokens: number | null;
    readonly cacheReadInputTokens: number | null;
  };
  readonly status: 'success';
}): Record<string, unknown> {
  const assistantEvents = event.assistantOpenPEvents ?? buildOpenPAssistantEventsFromSnapshots(
    event.assistantEvents,
    event.sessionId,
    event.assistantEventUsage,
    {
      turnId: event.turnId,
      resultAnswerText: event.answerText,
      resultReasoningText: event.reasoningText ?? null,
      structuredOutput: event.structuredOutput,
      structuredOutputToolUseId: event.structuredOutputToolUseId ?? null,
      requestId: event.requestId ?? null,
      model: event.model ?? null,
      stopReason: event.stopReason ?? null,
      usage: event.assistantEventUsage ?? null,
      form: 'result',
    },
  );
  const collectedAnswers = collectOpenPAnswersFromAssistantEvents(assistantEvents);
  const collectedReasoning = collectOpenPReasoningFromAssistantEvents(assistantEvents);
  const collectedToolCalls = collectOpenPToolCallsFromAssistantEvents(assistantEvents);
  const collectedToolResults = collectOpenPToolResultsFromAssistantEvents(assistantEvents);
  const collectedMessageBlocks = collectOpenPMessageBlocksFromAssistantEvents(assistantEvents);
  const answers = collectedAnswers.length > 0
    ? collectedAnswers
    : event.answerText.length > 0 ? [event.answerText] : [];
  const reasoning = [
    ...collectedReasoning,
    ...(event.reasoningText && event.reasoningText.length > 0 && !collectedReasoning.includes(event.reasoningText)
      ? [event.reasoningText]
      : []),
  ];
  const structuredOutputToolUseId = event.structuredOutput !== undefined
    ? event.structuredOutputToolUseId ?? null
    : null;
  const hasStructuredOutputToolCall = structuredOutputToolUseId !== null &&
    collectedToolCalls.some((toolCall) => toolCall.id === structuredOutputToolUseId);
  const toolCalls = structuredOutputToolUseId !== null && !hasStructuredOutputToolCall
    ? [
        ...collectedToolCalls,
        buildOpenPStructuredOutputToolCall(structuredOutputToolUseId, event.structuredOutput),
      ]
    : collectedToolCalls;
  const structuredOutputToolResult = structuredOutputToolUseId !== null
    ? buildOpenPStructuredOutputToolResult(structuredOutputToolUseId)
    : null;
  const hasStructuredOutputToolResult = structuredOutputToolResult !== null &&
    collectedToolResults.some((toolResult) => sameOpenPToolResult(toolResult, structuredOutputToolResult));
  const toolResults = structuredOutputToolResult !== null && !hasStructuredOutputToolResult
    ? [...collectedToolResults, structuredOutputToolResult]
    : collectedToolResults;
  const messageBlocks = collectedMessageBlocks;
  const metadata = compactRecord({
    backend: event.backend ?? undefined,
    requestId: event.requestId ?? undefined,
    model: event.model ?? undefined,
    usage: buildOpenPUsage(event.usage),
    lastSubturnUsage: event.lastSubturnUsage ? buildOpenPUsage(event.lastSubturnUsage) : undefined,
    rawUsage: event.rawUsage ?? undefined,
    stopReason: event.stopReason ?? undefined,
    numTurns: event.numTurns,
    durationMs: event.durationMs,
    totalCostUsd: event.totalCostUsd,
    contextWindow: event.contextWindow,
    lastSubturnContextTokens: event.lastSubturnContextTokens,
    modelUsage: event.modelUsage ?? undefined,
    warnings: event.warnings && event.warnings.length > 0 ? event.warnings : undefined,
    messageBlocks: messageBlocks.length > 0 ? messageBlocks : undefined,
  });
  return buildOpenPOutputRecord({
    form: 'result',
    scope: 'active',
    turnId: event.turnId,
    sessionId: event.sessionId,
    output: buildOpenPResultOutput({
      answer: answers,
      reasoning,
      toolCall: toolCalls,
      toolResult: toolResults,
    }),
    structuredOutput: event.structuredOutput ?? null,
    metadata,
  });
}

function buildOpenPUsage(usage: {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadInputTokens: number | null;
}): Record<string, number | null> {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadInputTokens: usage.cacheReadInputTokens,
  };
}

function contextTokensFromUsage(usage: BackendUsage): number | null {
  if (usage.inputTokens === null || usage.cacheReadInputTokens === null) {
    return null;
  }
  return usage.inputTokens + usage.cacheReadInputTokens;
}

function compactRecord(record: Record<string, unknown>): Record<string, unknown> {
  const compacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) {
      compacted[key] = value;
    }
  }
  return compacted;
}

function buildAssistantEventsFromSnapshots(
  snapshots: readonly AssistantEventSnapshot[] | undefined,
  sessionId?: string | null,
  turnUsage?: BackendUsage,
  context: {
    readonly turnId?: string | null;
    readonly resultAnswerText?: string | null;
    readonly resultReasoningText?: string | null;
    readonly structuredOutput?: unknown;
    readonly structuredOutputToolUseId?: string | null;
    readonly requestId?: string | null;
    readonly model?: string | null;
    readonly stopReason?: string | null;
    readonly usage?: BackendUsage | null;
    readonly form?: OpenPForm;
  } = {},
): Record<string, unknown>[] {
  if (!snapshots || snapshots.length === 0) {
    return [];
  }
  return snapshots.flatMap((snapshot, index) => {
    const shouldInjectUsage = shouldInjectSnapshotUsage(snapshots, index, turnUsage);
    const openpSnapshot = shouldInjectUsage ? injectSnapshotUsage(snapshot, turnUsage) : snapshot;
    return buildOpenPAssistantEventsFromSnapshot(openpSnapshot, {
        sessionId,
        turnId: context.turnId ?? null,
        resultAnswerText: context.resultAnswerText ?? null,
        resultReasoningText: context.resultReasoningText ?? null,
        structuredOutput: context.structuredOutput,
        structuredOutputToolUseId: context.structuredOutputToolUseId ?? null,
        requestId: context.requestId ?? null,
        model: context.model ?? null,
        stopReason: context.stopReason ?? null,
        usage: context.usage ?? null,
        form: context.form ?? 'result',
      }).map((openp) => ({ openp }));
  });
}

function buildOpenPAssistantEventsFromSnapshots(
  snapshots: readonly AssistantEventSnapshot[] | undefined,
  sessionId: string | null,
  turnUsage: BackendUsage | null | undefined,
  context: {
    readonly turnId?: string | null;
    readonly resultAnswerText?: string | null;
    readonly resultReasoningText?: string | null;
    readonly structuredOutput?: unknown;
    readonly structuredOutputToolUseId?: string | null;
    readonly requestId?: string | null;
    readonly model?: string | null;
    readonly stopReason?: string | null;
    readonly usage?: BackendUsage | null;
    readonly form?: OpenPForm;
  },
): Record<string, unknown>[] {
  if (!snapshots || snapshots.length === 0) {
    return [];
  }
  return snapshots.flatMap((snapshot, index) => buildOpenPAssistantEventsFromSnapshot(
    shouldInjectSnapshotUsage(snapshots, index, turnUsage)
      ? injectSnapshotUsage(snapshot, turnUsage)
      : snapshot,
    {
      sessionId,
      turnId: context.turnId ?? null,
      resultAnswerText: context.resultAnswerText ?? null,
      resultReasoningText: context.resultReasoningText ?? null,
      structuredOutput: context.structuredOutput,
      structuredOutputToolUseId: context.structuredOutputToolUseId ?? null,
      requestId: context.requestId ?? null,
      model: context.model ?? null,
      stopReason: context.stopReason ?? null,
      usage: context.usage ?? null,
      form: context.form ?? 'result',
    },
  ));
}

function extractEmittedAssistantOpenPEvents(events: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  return events.flatMap((event) => {
    const openp = event.openp;
    if (!openp || typeof openp !== 'object' || Array.isArray(openp)) {
      return [];
    }
    return [openp as Record<string, unknown>];
  });
}

function extractEmittedResultAssistantOpenPEvents(events: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  return extractEmittedAssistantOpenPEvents(events).filter((event) => event.form === 'result');
}

function buildNestedAssistantOpenPEvents(event: {
  readonly previouslyEmittedSnapshots?: readonly AssistantEventSnapshot[];
  readonly previouslyEmittedAssistantEvents?: readonly Record<string, unknown>[];
  readonly emittedAssistantEvents: readonly Record<string, unknown>[];
  readonly sessionId?: string | null;
  readonly turnId?: string | null;
  readonly resultAnswerText?: string | null;
  readonly resultReasoningText?: string | null;
  readonly structuredOutput?: unknown;
  readonly structuredOutputToolUseId?: string | null;
  readonly requestId?: string | null;
  readonly model?: string | null;
  readonly stopReason?: string | null;
  readonly usage?: BackendUsage | null;
}): Record<string, unknown>[] {
  const previouslyEmittedSnapshotOpenPEvents = buildPreviouslyEmittedAssistantOpenPEvents(
    event.previouslyEmittedSnapshots,
    event.sessionId ?? null,
    event.turnId ?? null,
    event.resultAnswerText ?? null,
    event.resultReasoningText ?? null,
    event.structuredOutput,
    event.structuredOutputToolUseId ?? null,
    event.requestId ?? null,
    event.model ?? null,
    event.stopReason ?? null,
    event.usage ?? null,
    'result',
  );
  const previouslyEmittedResultOpenPEvents = event.previouslyEmittedAssistantEvents
    ? extractEmittedResultAssistantOpenPEvents(event.previouslyEmittedAssistantEvents)
    : [];
  return dedupeOpenPAssistantResultEvents([
    ...previouslyEmittedSnapshotOpenPEvents,
    ...previouslyEmittedResultOpenPEvents,
    ...extractEmittedAssistantOpenPEvents(event.emittedAssistantEvents),
  ]);
}

function dedupeOpenPAssistantResultEvents(events: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  const seen = new Map<string, number>();
  const output: Record<string, unknown>[] = [];
  for (const event of events) {
    const key = openPResultDeduplicationKey(event);
    if (!key) {
      output.push(event);
      continue;
    }
    const existingIndex = seen.get(key);
    if (existingIndex !== undefined) {
      output[existingIndex] = mergeOpenPAssistantResultEvents(output[existingIndex]!, event);
      continue;
    }
    seen.set(key, output.length);
    output.push(event);
  }
  return output;
}

function openPResultDeduplicationKey(event: Record<string, unknown>): string | null {
  if (event.form !== 'result') {
    return null;
  }
  const metadata = event.metadata && typeof event.metadata === 'object' && !Array.isArray(event.metadata)
    ? event.metadata as Record<string, unknown>
    : {};
  return JSON.stringify({
    form: event.form,
    output: event.output,
    structuredOutput: event.structuredOutput,
    messageId: metadata.messageId,
    requestId: metadata.requestId,
    nativePhase: metadata.nativePhase,
    stopReason: metadata.stopReason,
  });
}

function mergeOpenPAssistantResultEvents(
  first: Record<string, unknown>,
  second: Record<string, unknown>,
): Record<string, unknown> {
  return compactRecord({
    ...second,
    ...first,
    output: mergeOpenPResultOutput(first.output, second.output),
    metadata: mergeOpenPMetadataField(first.metadata, second.metadata),
  });
}

function mergeOpenPResultOutput(first: unknown, second: unknown): OpenPResultOutput {
  const firstOutput = first && typeof first === 'object' && !Array.isArray(first)
    ? first as Record<string, unknown>
    : {};
  const secondOutput = second && typeof second === 'object' && !Array.isArray(second)
    ? second as Record<string, unknown>
    : {};
  return buildOpenPResultOutput({
    answer: mergeOpenPStringField(firstOutput.answer, secondOutput.answer),
    reasoning: mergeOpenPStringField(firstOutput.reasoning, secondOutput.reasoning),
    toolCall: mergeOpenPArrayField(firstOutput.toolCall, secondOutput.toolCall),
    toolResult: mergeOpenPArrayField(firstOutput.toolResult, secondOutput.toolResult),
  });
}

function mergeOpenPStringField(first: unknown, second: unknown): string[] | undefined {
  const output: string[] = [];
  const seen = new Set<string>();
  for (const value of [
    ...stringArray(first),
    ...stringArray(second),
  ]) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    output.push(value);
  }
  return output.length > 0 ? output : undefined;
}

function mergeOpenPArrayField(first: unknown, second: unknown): unknown[] | undefined {
  const output: unknown[] = [];
  const seen = new Set<string>();
  for (const value of [
    ...(Array.isArray(first) ? first : []),
    ...(Array.isArray(second) ? second : []),
  ]) {
    const key = JSON.stringify(value);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(value);
  }
  return output.length > 0 ? output : undefined;
}

function sameOpenPToolResult(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  return left.type === right.type &&
    left.toolUseId === right.toolUseId &&
    JSON.stringify(left.content) === JSON.stringify(right.content) &&
    left.isError === right.isError;
}

function mergeOpenPMetadataField(first: unknown, second: unknown): Record<string, unknown> | undefined {
  const firstMetadata = first && typeof first === 'object' && !Array.isArray(first)
    ? first as Record<string, unknown>
    : {};
  const secondMetadata = second && typeof second === 'object' && !Array.isArray(second)
    ? second as Record<string, unknown>
    : {};
  const output: Record<string, unknown> = { ...secondMetadata };
  for (const [key, value] of Object.entries(firstMetadata)) {
    if (value !== undefined && value !== null) {
      output[key] = value;
    } else if (!Object.prototype.hasOwnProperty.call(output, key)) {
      output[key] = value;
    }
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

function buildPreviouslyEmittedAssistantOpenPEvents(
  snapshots: readonly AssistantEventSnapshot[] | undefined,
  sessionId: string | null,
  turnId: string | null,
  resultAnswerText: string | null,
  resultReasoningText: string | null,
  structuredOutput: unknown,
  structuredOutputToolUseId: string | null,
  requestId: string | null,
  model: string | null,
  stopReason: string | null,
  usage: BackendUsage | null,
  form: OpenPForm,
): Record<string, unknown>[] {
  if (!snapshots || snapshots.length === 0) {
    return [];
  }
  return snapshots.flatMap((snapshot) => buildOpenPAssistantEventsFromSnapshot(snapshot, {
    sessionId,
    turnId,
    resultAnswerText,
    resultReasoningText,
    structuredOutput,
    structuredOutputToolUseId,
    requestId,
    model,
    stopReason,
    usage,
    form,
  }));
}

function buildResultTextAssistantEventRecords(event: {
  readonly turnId: string;
  readonly sessionId: string;
  readonly answerText: string;
  readonly reasoningText?: string | null;
  readonly emitAnswer: boolean;
  readonly requestId?: string | null;
  readonly model?: string | null;
  readonly stopReason?: string | null;
  readonly usage: {
    readonly inputTokens: number | null;
    readonly outputTokens: number | null;
    readonly cacheReadInputTokens: number | null;
  };
}): Record<string, unknown>[] {
  const output: Record<string, unknown>[] = [];
  if (event.reasoningText && event.reasoningText.length > 0) {
    output.push(buildAssistantTextEvent({
      turnId: event.turnId,
      sessionId: event.sessionId,
      text: '',
      reasoningContent: event.reasoningText,
      openp: buildOpenPAssistantMessage({
        kind: 'reasoning',
        form: 'result',
        scope: 'active',
        turnId: event.turnId,
        sessionId: event.sessionId,
        text: event.reasoningText,
      }),
      requestId: event.requestId,
      stopReason: null,
      metadataStopReason: event.stopReason ?? null,
      model: event.model,
      usage: event.usage,
    }));
  }
  if (event.emitAnswer && event.answerText.length > 0) {
    output.push(buildAssistantTextEvent({
      turnId: event.turnId,
      sessionId: event.sessionId,
      text: event.answerText,
      openp: buildOpenPResultMessage({
        turnId: event.turnId,
        sessionId: event.sessionId,
        answerText: event.answerText,
      }),
      requestId: event.requestId,
      stopReason: null,
      metadataStopReason: event.stopReason ?? null,
      model: event.model,
      usage: event.usage,
    }));
  }
  return output;
}

function buildStructuredOutputAssistantEventRecord(event: {
  readonly turnId: string;
  readonly sessionId: string;
  readonly structuredOutput: unknown;
  readonly structuredOutputToolUseId: string | null;
  readonly requestId?: string | null;
  readonly model?: string | null;
  readonly stopReason?: string | null;
  readonly usage: {
    readonly inputTokens: number | null;
    readonly outputTokens: number | null;
    readonly cacheReadInputTokens: number | null;
  };
}): Record<string, unknown> {
  return buildAssistantTextEvent({
    turnId: event.turnId,
    sessionId: event.sessionId,
    text: '',
    structuredOutput: event.structuredOutput,
    structuredOutputToolUseId: event.structuredOutputToolUseId,
    openp: buildOpenPStructuredOutputAssistantEvent({
      turnId: event.turnId,
      sessionId: event.sessionId,
    }),
    requestId: event.requestId,
    stopReason: null,
    metadataStopReason: event.stopReason ?? null,
    model: event.model,
    usage: event.usage,
  });
}

function openPEventsContainReasoningText(events: readonly Record<string, unknown>[], text: string | null | undefined): boolean {
  if (!text) {
    return false;
  }
  return events.some((event) => event.openp && typeof event.openp === 'object' && !Array.isArray(event.openp)
    ? openPEventHasReasoningText(event.openp as Record<string, unknown>, text)
    : openPEventHasReasoningText(event, text));
}

function openPEventHasReasoningText(event: Record<string, unknown>, text: string): boolean {
  const output = asOpenPOutput(event);
  return stringArray(output?.reasoning).includes(text);
}

function buildTerminalAssistantEventRecords(event: {
  readonly existingAssistantEvents: readonly Record<string, unknown>[];
  readonly assistantSnapshotsContainResultText: boolean;
  readonly text: string;
  readonly fallbackReasoningContent?: string | null;
  readonly structuredOutput?: unknown;
  readonly fallbackStructuredOutput?: unknown;
  readonly snapshotStructuredOutputToolUseId: string | null;
  readonly structuredOutputToolUseId: string | null;
  readonly shouldEmitTextFallback: boolean;
  readonly blankResultTextFallback: boolean;
  readonly turnId: string;
  readonly sessionId: string;
  readonly requestId?: string | null;
  readonly model?: string | null;
  readonly stopReason?: string | null;
  readonly usage: {
    readonly inputTokens: number | null;
    readonly outputTokens: number | null;
    readonly cacheReadInputTokens: number | null;
  };
}): Record<string, unknown>[] {
  if (event.existingAssistantEvents.length > 0) {
    const output = [...event.existingAssistantEvents];
    const fallbackReasoningText = openPEventsContainReasoningText(output, event.fallbackReasoningContent)
      ? null
      : event.fallbackReasoningContent;
    if (
      event.structuredOutput === undefined &&
      !event.assistantSnapshotsContainResultText &&
      event.shouldEmitTextFallback
    ) {
      output.push(...buildResultTextAssistantEventRecords({
        turnId: event.turnId,
        sessionId: event.sessionId,
        answerText: event.text,
        reasoningText: fallbackReasoningText,
        emitAnswer: true,
        requestId: event.requestId,
        stopReason: event.stopReason ?? null,
        model: event.model,
        usage: event.usage,
      }));
    }
    if (event.structuredOutput !== undefined && !event.snapshotStructuredOutputToolUseId) {
      output.push(...buildResultTextAssistantEventRecords({
        turnId: event.turnId,
        sessionId: event.sessionId,
        answerText: '',
        reasoningText: fallbackReasoningText,
        emitAnswer: false,
        requestId: event.requestId,
        stopReason: event.stopReason ?? null,
        model: event.model,
        usage: event.usage,
      }));
      output.push(buildStructuredOutputAssistantEventRecord({
        turnId: event.turnId,
        sessionId: event.sessionId,
        structuredOutput: event.structuredOutput,
        structuredOutputToolUseId: event.structuredOutputToolUseId,
        requestId: event.requestId,
        stopReason: event.stopReason ?? null,
        model: event.model,
        usage: event.usage,
      }));
    }
    return output;
  }

  if (event.structuredOutput !== undefined && event.fallbackStructuredOutput === undefined) {
    return [];
  }

  if (
    !event.fallbackReasoningContent &&
    event.fallbackStructuredOutput === undefined &&
    !event.shouldEmitTextFallback
  ) {
    return [];
  }
  const output = buildResultTextAssistantEventRecords({
    turnId: event.turnId,
    sessionId: event.sessionId,
    answerText: event.text,
    reasoningText: event.fallbackReasoningContent,
    emitAnswer: event.shouldEmitTextFallback &&
      event.fallbackStructuredOutput === undefined &&
      !event.blankResultTextFallback,
    requestId: event.requestId,
    stopReason: event.stopReason ?? null,
    model: event.model,
    usage: event.usage,
  });
  if (event.fallbackStructuredOutput !== undefined) {
    output.push(buildStructuredOutputAssistantEventRecord({
      turnId: event.turnId,
      sessionId: event.sessionId,
      structuredOutput: event.fallbackStructuredOutput,
      structuredOutputToolUseId: event.structuredOutputToolUseId,
      requestId: event.requestId,
      stopReason: event.stopReason ?? null,
      model: event.model,
      usage: event.usage,
    }));
  }
  return output;
}

function shouldInjectSnapshotUsage(
  snapshots: readonly AssistantEventSnapshot[],
  index: number,
  turnUsage: BackendUsage | null | undefined,
): turnUsage is BackendUsage {
  return Boolean(turnUsage && index === snapshots.length - 1 && !hasUsage(snapshots[index]!.message));
}

function injectSnapshotUsage(snapshot: AssistantEventSnapshot, turnUsage: BackendUsage): AssistantEventSnapshot {
  return {
    ...snapshot,
    message: {
      ...snapshot.message,
      usage: buildSnakeUsage(turnUsage),
    },
  };
}

function hasUsage(message: Record<string, unknown>): boolean {
  return message.usage !== null && message.usage !== undefined && typeof message.usage === 'object';
}

function buildSnakeUsage(usage: BackendUsage): Record<string, unknown> {
  return {
    input_tokens: usage.inputTokens,
    cache_read_input_tokens: usage.cacheReadInputTokens,
    output_tokens: usage.outputTokens,
  };
}

function normalizePublicAssistantMessage(message: Record<string, unknown>): Record<string, unknown> {
  return {
    ...message,
    content: Array.isArray(message.content)
      ? message.content.map(normalizePublicContentBlock)
      : [],
    stop_reason: null,
    stop_sequence: Object.prototype.hasOwnProperty.call(message, 'stop_sequence') ? message.stop_sequence : null,
    stop_details: Object.prototype.hasOwnProperty.call(message, 'stop_details') ? message.stop_details : null,
  };
}

function normalizePublicContentBlock(block: unknown): unknown {
  if (!block || typeof block !== 'object' || Array.isArray(block)) {
    return block;
  }
  const item = block as Record<string, unknown>;
  if (item.type !== 'thinking') {
    return item;
  }
  const thinking = reasoningBlockText(item);
  if (!thinking) {
    return item;
  }
  const { text: _text, content: _content, summary: _summary, ...rest } = item;
  return {
    ...rest,
    type: 'thinking',
    thinking,
  };
}

function normalizeStructuredOutputFallbackSnapshots(
  snapshots: readonly AssistantEventSnapshot[] | undefined,
  structuredOutput: unknown,
  structuredOutputToolUseId: string | null,
): readonly AssistantEventSnapshot[] | undefined {
  if (!snapshots || structuredOutput === undefined || !structuredOutputToolUseId) {
    return snapshots;
  }
  let changed = false;
  const normalized = snapshots.map((snapshot) => {
    if (snapshot.semanticKind) {
      return snapshot;
    }
    const content = snapshot.message.content;
    if (!Array.isArray(content) || content.length === 0) {
      return snapshot;
    }
    const hasStructuredOutputToolUse = content.some((block) => isStructuredOutputToolUseBlock(block));
    let insertedStructuredOutputToolUse = hasStructuredOutputToolUse;
    let changedSnapshot = false;
    const nextContent: unknown[] = [];
    for (const block of content) {
      if (textBlockEqualsStructuredOutput(block, structuredOutput)) {
        changed = true;
        changedSnapshot = true;
        if (!insertedStructuredOutputToolUse) {
          nextContent.push(buildStructuredOutputToolUseMessageBlock(structuredOutputToolUseId, structuredOutput));
          insertedStructuredOutputToolUse = true;
        }
        continue;
      }
      nextContent.push(block);
    }
    if (!changedSnapshot) {
      return snapshot;
    }
    return {
      ...snapshot,
      message: {
        ...snapshot.message,
        content: nextContent,
      },
    };
  });
  return changed ? normalized : snapshots;
}

function filterAssistantSnapshots(
  snapshots: readonly AssistantEventSnapshot[] | undefined,
  suppressed: {
    readonly text: readonly string[];
    readonly reasoning: readonly string[];
    readonly snapshots: readonly AssistantEventSnapshot[];
  },
): readonly AssistantEventSnapshot[] | undefined {
  if (!snapshots) {
    return snapshots;
  }
  const remainingSuppressedSnapshotCounts = countTexts(suppressed.snapshots.map(snapshotSuppressionKey));
  if (
    suppressed.text.length === 0 &&
    suppressed.reasoning.length === 0 &&
    remainingSuppressedSnapshotCounts.size === 0
  ) {
    return snapshots.filter((snapshot) => !isEmptyReasoningOnlySnapshot(snapshot));
  }
  const remainingSuppressedTextCounts = countTexts(suppressed.text);
  const remainingSuppressedReasoningCounts = countTexts(suppressed.reasoning);
  const remainingSuppressedReasoningSegmentCounts = countSuppressedReasoningSegments(suppressed.reasoning);
  const output: AssistantEventSnapshot[] = [];
  let pendingReasoningSnapshots: AssistantEventSnapshot[] = [];
  let pendingReasoningText: string | null = null;
  const flushPendingReasoning = (): void => {
    if (pendingReasoningSnapshots.length > 0) {
      output.push(...pendingReasoningSnapshots);
      pendingReasoningSnapshots = [];
      pendingReasoningText = null;
    }
  };
  const suppressReasoningIfMatched = (): boolean => {
    if (pendingReasoningText === null) {
      return false;
    }
    const remainingCount = remainingSuppressedReasoningCounts.get(pendingReasoningText) ?? 0;
    if (remainingCount <= 0) {
      return false;
    }
    remainingSuppressedReasoningCounts.set(pendingReasoningText, remainingCount - 1);
    pendingReasoningSnapshots = [];
    pendingReasoningText = null;
    return true;
  };
  for (const snapshot of snapshots) {
    if (consumeSuppressedSnapshot(snapshot, remainingSuppressedSnapshotCounts)) {
      continue;
    }
    if (snapshot.semanticKind) {
      flushPendingReasoning();
      output.push(snapshot);
      continue;
    }
    if (isEmptyReasoningOnlySnapshot(snapshot)) {
      continue;
    }
    const text = textOnlySnapshotText(snapshot);
    if (text !== null) {
      flushPendingReasoning();
      const remainingCount = remainingSuppressedTextCounts.get(text) ?? 0;
      if (remainingCount <= 0) {
        output.push(snapshot);
        continue;
      }
      remainingSuppressedTextCounts.set(text, remainingCount - 1);
      continue;
    }
    const reasoning = reasoningOnlySnapshotText(snapshot);
    if (reasoning === null) {
      flushPendingReasoning();
      const filteredSnapshot = filterMixedAssistantSnapshot(snapshot, {
        text: remainingSuppressedTextCounts,
        reasoning: remainingSuppressedReasoningCounts,
        reasoningSegments: remainingSuppressedReasoningSegmentCounts,
      });
      if (filteredSnapshot !== null) {
        output.push(filteredSnapshot);
      }
      continue;
    }
    if (consumeSuppressedReasoning(
      reasoning,
      remainingSuppressedReasoningCounts,
      remainingSuppressedReasoningSegmentCounts,
    )) {
      continue;
    }
    pendingReasoningSnapshots.push(snapshot);
    pendingReasoningText = pendingReasoningText === null
      ? reasoning
      : `${pendingReasoningText}\n\n${reasoning}`;
    if (!hasRemainingSuppressedReasoningPrefix(pendingReasoningText, remainingSuppressedReasoningCounts)) {
      if (suppressReasoningIfMatched()) {
        continue;
      }
      flushPendingReasoning();
    }
  }
  flushPendingReasoning();
  return output;
}

function intersectSuppressedResultSnapshots(
  resultSnapshots: readonly AssistantEventSnapshot[] | undefined,
  suppressedSnapshots: readonly AssistantEventSnapshot[] | undefined,
): readonly AssistantEventSnapshot[] | undefined {
  if (!resultSnapshots || resultSnapshots.length === 0 || !suppressedSnapshots || suppressedSnapshots.length === 0) {
    return undefined;
  }
  const remainingResultSnapshotCounts = countTexts(resultSnapshots.map(snapshotSuppressionKey));
  const output: AssistantEventSnapshot[] = [];
  for (const snapshot of suppressedSnapshots) {
    if (!consumeSuppressedSnapshot(snapshot, remainingResultSnapshotCounts)) {
      continue;
    }
    output.push(snapshot);
  }
  return output.length > 0 ? output : undefined;
}

function consumeSuppressedSnapshot(snapshot: AssistantEventSnapshot, counts: Map<string, number>): boolean {
  const key = snapshotSuppressionKey(snapshot);
  const remainingCount = counts.get(key) ?? 0;
  if (remainingCount <= 0) {
    return false;
  }
  counts.set(key, remainingCount - 1);
  return true;
}

function snapshotSuppressionKey(snapshot: AssistantEventSnapshot): string {
  return JSON.stringify(snapshot);
}

function hasRemainingSuppressedReasoningPrefix(prefix: string | null, counts: ReadonlyMap<string, number>): boolean {
  if (prefix === null) {
    return false;
  }
  for (const [text, count] of counts.entries()) {
    if (count > 0 && text.startsWith(`${prefix}\n\n`)) {
      return true;
    }
  }
  return false;
}

function isEmptyReasoningOnlySnapshot(snapshot: AssistantEventSnapshot): boolean {
  const content = snapshot.message.content;
  if (!Array.isArray(content) || content.length === 0) {
    return false;
  }
  let sawReasoningBlock = false;
  for (const block of content) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) {
      return false;
    }
    const item = block as Record<string, unknown>;
    if (item.type !== 'thinking' && item.type !== 'reasoning') {
      return false;
    }
    sawReasoningBlock = true;
    const reasoningText = reasoningBlockText(item);
    if (reasoningText !== null && reasoningText.length > 0) {
      return false;
    }
  }
  return sawReasoningBlock;
}

function countTexts(texts: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const text of texts) {
    counts.set(text, (counts.get(text) ?? 0) + 1);
  }
  return counts;
}

function countSuppressedReasoningSegments(texts: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  let previousText: string | null = null;
  for (const text of texts) {
    const newText = previousText !== null && text.startsWith(`${previousText}\n\n`)
      ? text.slice(previousText.length + 2)
      : text;
    previousText = text;
    for (const segment of newText.split('\n\n')) {
      if (segment.length > 0) {
        counts.set(segment, (counts.get(segment) ?? 0) + 1);
      }
    }
  }
  return counts;
}

function textOnlySnapshotText(snapshot: AssistantEventSnapshot): string | null {
  const content = snapshot.message.content;
  if (!Array.isArray(content) || content.length === 0) {
    return null;
  }
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) {
      return null;
    }
    const item = block as Record<string, unknown>;
    if (item.type !== 'text' || typeof item.text !== 'string') {
      return null;
    }
    parts.push(item.text);
  }
  const text = parts.join('\n\n');
  return text.length > 0 ? text : null;
}

function snapshotsContainAssistantText(
  snapshots: readonly AssistantEventSnapshot[] | undefined,
  text: string,
): boolean {
  if (!snapshots || text.length === 0) {
    return false;
  }
  return snapshots.some((snapshot) =>
    !snapshot.semanticKind &&
    !snapshotHasToolPayload(snapshot) &&
    snapshotHasTerminalStop(snapshot) &&
    snapshotAssistantText(snapshot) === text
  );
}

function nonSemanticSnapshotsContainAssistantText(
  snapshots: readonly AssistantEventSnapshot[] | undefined,
  text: string,
): boolean {
  if (!snapshots || text.length === 0) {
    return false;
  }
  return snapshots.some((snapshot) =>
    !snapshot.semanticKind &&
    !snapshotHasToolPayload(snapshot) &&
    snapshotAssistantText(snapshot) === text
  );
}

function snapshotHasTerminalStop(snapshot: AssistantEventSnapshot): boolean {
  const stopReason = snapshot.message.stop_reason;
  return isTerminalAssistantStopReason(stopReason);
}

function isTerminalAssistantStopReason(stopReason: unknown): boolean {
  return stopReason === 'end_turn' ||
    stopReason === 'stop_sequence' ||
    stopReason === 'max_tokens';
}

function snapshotHasToolPayload(snapshot: AssistantEventSnapshot): boolean {
  return extractOpenPToolCalls(snapshot.message).length > 0 ||
    extractOpenPToolResults(snapshot.message).length > 0;
}

function snapshotsContainSemanticAssistantText(
  snapshots: readonly AssistantEventSnapshot[] | undefined,
  text: string,
): boolean {
  if (!snapshots || text.length === 0) {
    return false;
  }
  return snapshots.some((snapshot) => Boolean(snapshot.semanticKind) && snapshotAssistantText(snapshot) === text);
}

function snapshotAssistantText(snapshot: AssistantEventSnapshot): string | null {
  const content = snapshot.message.content;
  if (!Array.isArray(content) || content.length === 0) {
    return null;
  }
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) {
      return null;
    }
    const item = block as Record<string, unknown>;
    if (item.type === 'text' && typeof item.text === 'string') {
      parts.push(item.text);
    }
  }
  const text = parts.join('\n\n');
  return text.length > 0 ? text : null;
}

function reasoningOnlySnapshotText(snapshot: AssistantEventSnapshot): string | null {
  const content = snapshot.message.content;
  if (!Array.isArray(content) || content.length === 0) {
    return null;
  }
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) {
      return null;
    }
    const item = block as Record<string, unknown>;
    if (item.type === 'thinking') {
      const text = reasoningBlockText(item);
      if (text === null) {
        return null;
      }
      parts.push(text);
      continue;
    }
    if (item.type === 'reasoning') {
      const text = reasoningBlockText(item);
      if (text === null) {
        return null;
      }
      parts.push(text);
      continue;
    }
    return null;
  }
  const text = parts.join('\n\n');
  return text.length > 0 ? text : null;
}

function filterMixedAssistantSnapshot(
  snapshot: AssistantEventSnapshot,
  suppressed: {
    readonly text: Map<string, number>;
    readonly reasoning: Map<string, number>;
    readonly reasoningSegments: Map<string, number>;
  },
): AssistantEventSnapshot | null {
  const content = snapshot.message.content;
  if (!Array.isArray(content) || content.length === 0) {
    return snapshot;
  }
  const textParts: string[] = [];
  const reasoningParts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) {
      return snapshot;
    }
    const item = block as Record<string, unknown>;
    if (item.type === 'text' && typeof item.text === 'string') {
      textParts.push(item.text);
      continue;
    }
    if (item.type === 'thinking' || item.type === 'reasoning') {
      const reasoning = reasoningBlockText(item);
      if (reasoning !== null && reasoning.length > 0) {
        reasoningParts.push(reasoning);
      }
      continue;
    }
  }

  const text = textParts.join('\n\n');
  const reasoning = reasoningParts.join('\n\n');
  const suppressText = text.length > 0 && consumeSuppressedText(text, suppressed.text);
  const suppressReasoning = reasoning.length > 0 && consumeSuppressedReasoning(
    reasoning,
    suppressed.reasoning,
    suppressed.reasoningSegments,
  );
  if (!suppressText && !suppressReasoning) {
    return snapshot;
  }

  const filteredContent = content.filter((block) => {
    const item = block as Record<string, unknown>;
    if (suppressText && item.type === 'text') {
      return false;
    }
    if (suppressReasoning && (item.type === 'thinking' || item.type === 'reasoning')) {
      return false;
    }
    const reasoning = item.type === 'thinking' || item.type === 'reasoning'
      ? reasoningBlockText(item)
      : null;
    if ((item.type === 'thinking' || item.type === 'reasoning') && (!reasoning || reasoning.length === 0)) {
      return false;
    }
    return true;
  });
  if (filteredContent.length === 0) {
    return null;
  }
  return {
    ...snapshot,
    message: {
      ...snapshot.message,
      content: filteredContent,
    },
  };
}

function consumeSuppressedText(text: string, counts: Map<string, number>): boolean {
  const remainingCount = counts.get(text) ?? 0;
  if (remainingCount <= 0) {
    return false;
  }
  counts.set(text, remainingCount - 1);
  return true;
}

function isReasoningContentAlreadySuppressed(
  text: string | null | undefined,
  suppressedReasoningTexts: readonly string[],
): boolean {
  if (!text) {
    return false;
  }
  if (consumeSuppressedText(text, countTexts(suppressedReasoningTexts))) {
    return true;
  }
  return consumeSuppressedReasoningSegments(text, countSuppressedReasoningSegments(suppressedReasoningTexts));
}

function consumeSuppressedReasoning(
  text: string,
  exactCounts: Map<string, number>,
  segmentCounts: Map<string, number>,
): boolean {
  if (consumeSuppressedText(text, exactCounts)) {
    consumeSuppressedReasoningSegments(text, segmentCounts);
    return true;
  }
  return consumeSuppressedReasoningSegments(text, segmentCounts);
}

function consumeSuppressedReasoningSegments(text: string, counts: Map<string, number>): boolean {
  const segments = text.split('\n\n').filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    return false;
  }
  const needed = countTexts(segments);
  for (const [segment, count] of needed.entries()) {
    if ((counts.get(segment) ?? 0) < count) {
      return false;
    }
  }
  for (const [segment, count] of needed.entries()) {
    counts.set(segment, (counts.get(segment) ?? 0) - count);
  }
  return true;
}

function reasoningBlockText(block: Record<string, unknown>): string | null {
  const parts = [
    extractTextLike(block.text),
    extractTextLike(block.content),
    extractTextLike(block.summary),
    extractTextLike(block.thinking),
  ].filter((text): text is string => typeof text === 'string' && text.length > 0);
  return parts.length > 0 ? parts.join('\n\n') : null;
}

function extractTextLike(value: unknown): string | null {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    const parts = value.map(extractTextLike).filter((text): text is string => text !== null);
    return parts.length > 0 ? parts.join('\n\n') : null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const object = value as Record<string, unknown>;
  return extractTextLike(object.text) ?? extractTextLike(object.content) ?? extractTextLike(object.summary);
}

function snapshotTextEqualsStructuredOutput(snapshot: AssistantEventSnapshot, structuredOutput: unknown): boolean {
  const content = snapshot.message.content;
  if (!Array.isArray(content) || content.length === 0) {
    return false;
  }
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) {
      return false;
    }
    const item = block as Record<string, unknown>;
    if (item.type !== 'text' || typeof item.text !== 'string') {
      return false;
    }
    parts.push(item.text);
  }
  const text = parts.join('\n\n').trim();
  const candidate = extractJsonTextCandidate(text);
  try {
    return JSON.stringify(JSON.parse(candidate)) === JSON.stringify(structuredOutput);
  } catch {
    return false;
  }
}

function textBlockEqualsStructuredOutput(block: unknown, structuredOutput: unknown): boolean {
  if (!block || typeof block !== 'object' || Array.isArray(block)) {
    return false;
  }
  const item = block as Record<string, unknown>;
  if (item.type !== 'text' || typeof item.text !== 'string') {
    return false;
  }
  const candidate = extractJsonTextCandidate(item.text.trim());
  try {
    return JSON.stringify(JSON.parse(candidate)) === JSON.stringify(structuredOutput);
  } catch {
    return false;
  }
}

function extractJsonTextCandidate(text: string): string {
  const fenced = /^```json[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(text);
  return fenced?.[1]?.trim() ?? text;
}

function isStructuredOutputToolUseBlock(block: unknown): boolean {
  return Boolean(
    block &&
    typeof block === 'object' &&
    !Array.isArray(block) &&
    (block as Record<string, unknown>).type === 'tool_use' &&
    (block as Record<string, unknown>).name === 'StructuredOutput',
  );
}

function findStructuredOutputToolUseId(
  snapshots: readonly AssistantEventSnapshot[] | undefined,
): string | null {
  if (!snapshots) {
    return null;
  }
  for (const snapshot of snapshots) {
    const content = snapshot.message.content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const block of content) {
      if (
        block &&
        typeof block === 'object' &&
        !Array.isArray(block) &&
        (block as Record<string, unknown>).type === 'tool_use' &&
        (block as Record<string, unknown>).name === 'StructuredOutput' &&
        typeof (block as Record<string, unknown>).id === 'string'
      ) {
        return (block as Record<string, unknown>).id as string;
      }
    }
  }
  return null;
}

export function createStreamingMessageState(): StreamingMessageState {
  return {
    started: false,
    blockOpen: false,
    previousText: '',
    messageId: null,
    hasReasoning: false,
    reasoningBlockOpen: false,
    previousReasoningText: '',
  };
}

export function createStructuredOutputToolUseId(): string {
  return buildToolUseId();
}

export function resolveStructuredOutputToolUseId(event: {
  readonly structuredOutput: unknown;
  readonly assistantEvents?: readonly AssistantEventSnapshot[];
  readonly preferredToolUseId?: string | null;
}): string | null {
  if (event.structuredOutput === undefined) {
    return null;
  }
  return findStructuredOutputToolUseId(event.assistantEvents) ?? event.preferredToolUseId ?? buildToolUseId();
}

export function formatStreamingAnswerSnapshotEvents(
  state: StreamingMessageState,
  event: {
    readonly turnId?: string | null;
    readonly sessionId?: string | null;
    readonly model?: string | null;
    readonly text: string;
  },
): string {
  const text = event.text;
  if (!text || text === state.previousText) {
    return '';
  }

  const lines: Record<string, unknown>[] = [];
  if (!state.started) {
    state.messageId = state.messageId ?? buildMessageId();
    state.started = true;
  }
  if (!state.blockOpen) {
    state.blockOpen = true;
  }

  if (!text.startsWith(state.previousText)) {
    throw new Error('streaming answer replacement is not prefix-compatible');
  }

  const addedText = text.slice(state.previousText.length);
  if (addedText) {
    lines.push({
      openp: buildOpenPAssistantMessage({
        kind: 'answer',
        form: 'streaming',
        turnId: event.turnId ?? null,
        sessionId: event.sessionId,
        messageId: state.messageId,
        text,
        metadata: compactRecord({
          model: event.model ?? undefined,
        }),
      }),
    });
  }
  state.previousText = text;
  return lines.map((line) => `${JSON.stringify(line)}\n`).join('');
}

export function formatStreamingMessageSnapshotEvents(
  state: StreamingMessageState,
  event: {
    readonly turnId?: string | null;
    readonly sessionId?: string | null;
    readonly model?: string | null;
    readonly text: string;
    readonly reasoningText?: string | null;
  },
): string {
  const text = event.text;
  const reasoningText = event.reasoningText ?? '';
  if ((!text || text === state.previousText) && (!reasoningText || reasoningText === state.previousReasoningText)) {
    return '';
  }

  const lines: Record<string, unknown>[] = [];

  if (!state.started) {
    state.messageId = state.messageId ?? buildMessageId();
    state.started = true;
  }

  if (reasoningText && reasoningText !== state.previousReasoningText) {
    if (!reasoningText.startsWith(state.previousReasoningText)) {
      throw new Error('streaming reasoning replacement is not prefix-compatible');
    }
    if (!state.hasReasoning) {
      state.hasReasoning = true;
    }
    if (!state.reasoningBlockOpen) {
      state.reasoningBlockOpen = true;
    }
    const addedReasoningText = reasoningText.slice(state.previousReasoningText.length);
    if (addedReasoningText) {
      lines.push({
        openp: buildOpenPAssistantMessage({
          kind: 'reasoning',
          form: 'streaming',
          turnId: event.turnId ?? null,
          sessionId: event.sessionId,
          messageId: state.messageId,
          text: reasoningText,
          metadata: compactRecord({
            model: event.model ?? undefined,
          }),
        }),
      });
    }
    state.previousReasoningText = reasoningText;
  }

  if (text && text !== state.previousText) {
    const textBlockIndex = state.hasReasoning ? 1 : 0;
    if (!state.blockOpen) {
      if (state.reasoningBlockOpen) {
        state.reasoningBlockOpen = false;
      }
      void textBlockIndex;
      state.blockOpen = true;
    }

    if (!text.startsWith(state.previousText)) {
      throw new Error('streaming answer replacement is not prefix-compatible');
    }

    const addedText = text.slice(state.previousText.length);
    if (addedText) {
      lines.push({
        openp: buildOpenPAssistantMessage({
          kind: 'answer',
          form: 'streaming',
          turnId: event.turnId ?? null,
          sessionId: event.sessionId,
          messageId: state.messageId,
          text,
          metadata: compactRecord({
            model: event.model ?? undefined,
          }),
        }),
      });
    }
    state.previousText = text;
  }

  return lines.map((line) => `${JSON.stringify(line)}\n`).join('');
}

export function isStreamingReasoningReplacementError(error: unknown): boolean {
  return error instanceof Error &&
    error.message === 'streaming reasoning replacement is not prefix-compatible';
}

export function resetStreamingMessageState(state: StreamingMessageState): void {
  state.reasoningBlockOpen = false;
  state.blockOpen = false;
  state.started = false;
  state.previousText = '';
  state.previousReasoningText = '';
  state.hasReasoning = false;
  state.messageId = null;
}

function buildAssistantTextEvent(event: {
  readonly turnId: string;
  readonly text: string;
  readonly reasoningContent?: string | null;
  readonly reasoningContentBlocks?: readonly AssistantContentBlock[] | null;
  readonly structuredOutput?: unknown;
  readonly structuredOutputToolUseId?: string | null;
  readonly requestId?: string | null;
  readonly sessionId?: string | null;
  readonly messageId?: string | null;
  readonly stopReason: string | null;
  readonly metadataStopReason?: string | null;
  readonly model?: string | null;
  readonly usage?: {
    readonly inputTokens: number | null;
    readonly outputTokens: number | null;
    readonly cacheReadInputTokens: number | null;
  };
  readonly openp?: Record<string, unknown> | null;
}): Record<string, unknown> {
  const content: Record<string, unknown>[] = [];
  const resolvedMessageId = event.messageId ?? buildMessageId();
  const resolvedStructuredOutputToolUseId = event.structuredOutput !== undefined
    ? event.structuredOutputToolUseId ?? buildToolUseId()
    : null;
  if (event.reasoningContent) {
    if (event.reasoningContentBlocks && event.reasoningContentBlocks.length > 0) {
      content.push(...event.reasoningContentBlocks.map(normalizePublicContentBlock) as Record<string, unknown>[]);
    } else {
      content.push({ type: 'thinking', thinking: event.reasoningContent });
    }
  }
  if (event.structuredOutput !== undefined) {
    content.push({
      type: 'tool_use',
      id: resolvedStructuredOutputToolUseId,
      name: 'StructuredOutput',
      input: event.structuredOutput,
      caller: { type: 'direct' },
    });
  } else if (event.text) {
    content.push({ type: 'text', text: event.text });
  }

  const openp = event.openp && resolvedStructuredOutputToolUseId
    ? addOpenPStructuredOutput(event.openp, {
        id: resolvedStructuredOutputToolUseId,
        input: event.structuredOutput,
      })
    : event.openp;
  const openpWithMetadata = openp
    ? addOpenPMetadata(openp, {
        requestId: event.requestId ?? null,
        messageId: resolvedMessageId,
        model: event.model ?? null,
        stopReason: event.metadataStopReason ?? event.stopReason,
        usage: event.usage,
      })
    : openp;
  const openpWithMessageBlocks = openpWithMetadata
    ? shouldAttachOpenPMessageBlocks(openpWithMetadata)
      ? addOpenPMessageBlocks(openpWithMetadata, content)
      : openpWithMetadata
    : openpWithMetadata;

  return {
    openp: openpWithMessageBlocks ?? buildOpenPAssistantEvent({
      kind: 'metadata',
      turnId: event.turnId,
      sessionId: event.sessionId,
      messageBlocks: content,
    }),
  };
}

function shouldAttachOpenPMessageBlocks(openp: Record<string, unknown>): boolean {
  void openp;
  return true;
}

function buildOpenPStructuredOutputToolResult(toolUseId: string): Record<string, unknown> {
  return {
    toolUseId,
    type: 'tool_result',
    content: 'Structured output provided successfully',
  };
}

function buildStructuredOutputToolUseMessageBlock(toolUseId: string, input: unknown): Record<string, unknown> {
  return {
    type: 'tool_use',
    id: toolUseId,
    name: 'StructuredOutput',
    input,
    caller: { type: 'direct' },
  };
}

function buildResultEvent(event: {
  readonly turnId: string;
  readonly sessionId: string;
  readonly backend?: string | null;
  readonly text: string;
  readonly reasoningText?: string | null;
  readonly requestId?: string | null;
  readonly structuredOutput?: unknown;
  readonly structuredOutputToolUseId?: string | null;
  readonly assistantEvents?: readonly AssistantEventSnapshot[];
  readonly assistantOpenPEvents?: readonly Record<string, unknown>[];
  readonly assistantEventUsage?: BackendUsage | null;
  readonly lastSubturnUsage?: BackendUsage | null;
  readonly durationMs: number | null;
  readonly numTurns: number | null;
  readonly totalCostUsd: number | null;
  readonly stopReason: string | null;
  readonly usage: {
    readonly inputTokens: number | null;
    readonly outputTokens: number | null;
    readonly cacheReadInputTokens: number | null;
  };
  readonly rawUsage?: Record<string, unknown> | null;
  readonly contextWindow: number | null;
  readonly lastSubturnContextTokens: number | null;
  readonly model: string | null;
  readonly warnings?: readonly OutputWarning[];
}): Record<string, unknown> {
  const warnings = event.warnings ?? [];
  const resultText = event.structuredOutput === undefined ? event.text : '';
  const modelUsage = buildModelUsage(event.model, event.contextWindow, event.usage, event.totalCostUsd);
  return {
    openp: buildOpenPTurnResult({
      turnId: event.turnId,
      sessionId: event.sessionId,
      backend: event.backend ?? null,
      answerText: resultText,
      reasoningText: event.reasoningText ?? null,
      structuredOutput: event.structuredOutput,
      structuredOutputToolUseId: event.structuredOutputToolUseId ?? null,
      requestId: event.requestId ?? null,
      model: event.model,
      stopReason: event.stopReason,
      numTurns: event.numTurns,
      durationMs: event.durationMs,
      totalCostUsd: event.totalCostUsd,
      contextWindow: event.contextWindow,
      lastSubturnContextTokens: event.lastSubturnContextTokens,
      modelUsage,
      rawUsage: event.rawUsage ?? null,
      warnings,
      assistantEvents: event.assistantEvents ?? [],
      assistantOpenPEvents: event.assistantOpenPEvents,
      assistantEventUsage: event.assistantEventUsage ?? null,
      lastSubturnUsage: event.lastSubturnUsage ?? null,
      usage: event.usage,
      status: 'success',
    }),
  };
}

function buildPublicUsage(
  usage: {
    readonly inputTokens: number | null;
    readonly outputTokens: number | null;
    readonly cacheReadInputTokens: number | null;
  },
  rawUsage: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const publicUsage = rawUsage ? { ...rawUsage } : {};
  if (!Object.prototype.hasOwnProperty.call(publicUsage, 'input_tokens')) {
    publicUsage.input_tokens = usage.inputTokens;
  }
  if (!Object.prototype.hasOwnProperty.call(publicUsage, 'output_tokens')) {
    publicUsage.output_tokens = usage.outputTokens;
  }
  if (!Object.prototype.hasOwnProperty.call(publicUsage, 'cache_read_input_tokens')) {
    publicUsage.cache_read_input_tokens = usage.cacheReadInputTokens;
  }
  return publicUsage;
}

function buildModelUsage(
  model: string | null,
  contextWindow: number | null,
  usage: {
    readonly inputTokens: number | null;
    readonly outputTokens: number | null;
    readonly cacheReadInputTokens: number | null;
  },
  totalCostUsd: number | null,
): Record<string, Record<string, number>> | undefined {
  if (!model || contextWindow === null) {
    return undefined;
  }
  const modelUsage: Record<string, number> = {
    contextWindow,
  };
  if (usage.inputTokens !== null) {
    modelUsage.inputTokens = usage.inputTokens;
  }
  if (usage.outputTokens !== null) {
    modelUsage.outputTokens = usage.outputTokens;
  }
  if (usage.cacheReadInputTokens !== null) {
    modelUsage.cacheReadInputTokens = usage.cacheReadInputTokens;
  }
  if (totalCostUsd !== null) {
    modelUsage.costUSD = totalCostUsd;
  }
  return { [model]: modelUsage };
}

function buildMessageId(): string {
  return `msg_${randomUUID().replaceAll('-', '')}`;
}

function buildStableMessageId(seed: string): string {
  return `msg_${createHash('sha256').update(seed).digest('hex')}`;
}

function buildToolUseId(): string {
  return `toolu_${randomUUID().replaceAll('-', '')}`;
}
