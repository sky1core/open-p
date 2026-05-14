import { createHash, randomUUID } from 'node:crypto';
import type { AssistantContentBlock, AssistantEventSnapshot, TurnResult } from './types.js';
import type { WorkerTurnResult } from './worker-types.js';

export type OutputFormat = 'text' | 'json' | 'stream-json';

export interface OutputOptions {
  readonly outputFormat: OutputFormat;
  readonly backendSessionId: string;
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
  readonly suppressFallbackAssistantText?: boolean;
}

export interface PartialMessageStreamState {
  started: boolean;
  blockOpen: boolean;
  previousText: string;
  messageId: string | null;
  hasReasoning: boolean;
  reasoningBlockOpen: boolean;
  previousReasoningText: string;
}

export function formatTurnResult(result: TurnResult, options: OutputOptions): string {
  if (options.outputFormat === 'text') {
    return result.text.endsWith('\n') ? result.text : `${result.text}\n`;
  }
  const stopReason = result.diagnostics.stopReason ?? 'end_turn';

  if (options.outputFormat === 'json') {
    return `${JSON.stringify(buildResultEvent({
      turnId: result.turnId,
      sessionId: options.backendSessionId,
      text: result.text,
      structuredOutput: result.structuredOutput,
      durationMs: result.diagnostics.durationMs,
      numTurns: 1,
      totalCostUsd: null,
      stopReason,
      usage: {
        inputTokens: result.diagnostics.usage.inputTokens,
        outputTokens: result.diagnostics.usage.outputTokens,
        cacheReadInputTokens: result.diagnostics.usage.cacheReadInputTokens,
      },
      rawUsage: result.diagnostics.rawUsage ?? null,
      contextWindow: options.contextWindow ?? resolveKnownContextWindow(options.model),
      model: options.model ?? null,
    }))}\n`;
  }

  const events = [
    ...(options.includeSystemInit === false ? [] : [buildSystemInitEvent(options.backendSessionId, options)]),
  ];
  const snapshotStructuredOutputToolUseId = findStructuredOutputToolUseId(result.assistantEvents);
  const structuredOutputToolUseId = resolveStructuredOutputToolUseId({
    structuredOutput: result.structuredOutput,
    assistantEvents: result.assistantEvents,
    preferredToolUseId: options.structuredOutputToolUseId,
  });
  const filteredSnapshots = filterStructuredFallbackTextSnapshots(
    result.assistantEvents,
    result.structuredOutput,
    snapshotStructuredOutputToolUseId !== null,
  );
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
  const assistantSnapshots = filterAssistantSnapshots(filteredSnapshots, {
    text: suppressedAssistantTexts,
    reasoning: suppressedAssistantReasoningTexts,
    snapshots: options.suppressAssistantSnapshots ?? [],
  });
  const assistantEvents = buildAssistantEventsFromSnapshots(
    assistantSnapshots,
    options.backendSessionId,
  );
  const assistantSnapshotsContainResultText = snapshotsContainAssistantText(assistantSnapshots, result.text);
  if (assistantEvents.length > 0) {
    events.push(...assistantEvents);
    if (
      result.structuredOutput === undefined &&
      latestSuppressedAssistantText !== null &&
      result.text.length > 0 &&
      latestSuppressedAssistantText !== result.text &&
      !assistantSnapshotsContainResultText
    ) {
      events.push(buildAssistantTextEvent({
        turnId: result.turnId,
        sessionId: options.backendSessionId,
        text: result.text,
        requestId: result.requestId,
        stopReason: null,
        model: options.model ?? null,
        usage: {
          inputTokens: result.diagnostics.usage.inputTokens,
          outputTokens: result.diagnostics.usage.outputTokens,
          cacheReadInputTokens: result.diagnostics.usage.cacheReadInputTokens,
        },
      }));
    }
    if (result.structuredOutput !== undefined && !snapshotStructuredOutputToolUseId) {
      events.push(buildAssistantTextEvent({
        turnId: result.turnId,
        sessionId: options.backendSessionId,
        text: '',
        structuredOutput: result.structuredOutput,
        structuredOutputToolUseId,
        requestId: result.requestId,
        stopReason: null,
        model: options.model ?? null,
        usage: {
          inputTokens: result.diagnostics.usage.inputTokens,
          outputTokens: result.diagnostics.usage.outputTokens,
          cacheReadInputTokens: result.diagnostics.usage.cacheReadInputTokens,
        },
      }));
    }
  } else if (
    Boolean(fallbackReasoningContent) ||
    fallbackStructuredOutput !== undefined ||
    shouldEmitResultTextFallback(result.text, latestSuppressedAssistantText, options.suppressFallbackAssistantText)
  ) {
    events.push(
      buildAssistantTextEvent({
        turnId: result.turnId,
        sessionId: options.backendSessionId,
        text: latestSuppressedAssistantText === result.text ? '' : result.text,
        reasoningContent: fallbackReasoningContent,
        structuredOutput: fallbackStructuredOutput,
        structuredOutputToolUseId,
        requestId: result.requestId,
        stopReason: null,
        model: options.model ?? null,
        usage: {
          inputTokens: result.diagnostics.usage.inputTokens,
          outputTokens: result.diagnostics.usage.outputTokens,
          cacheReadInputTokens: result.diagnostics.usage.cacheReadInputTokens,
        },
      }),
    );
  }
  if (structuredOutputToolUseId) {
    events.push(buildStructuredOutputToolResultEvent({
      sessionId: options.backendSessionId,
      toolUseId: structuredOutputToolUseId,
    }));
  }
  events.push(
    buildResultEvent({
      turnId: result.turnId,
      sessionId: options.backendSessionId,
      text: result.text,
      structuredOutput: result.structuredOutput,
      durationMs: result.diagnostics.durationMs,
      numTurns: 1,
      totalCostUsd: null,
      stopReason,
      usage: {
        inputTokens: result.diagnostics.usage.inputTokens,
        outputTokens: result.diagnostics.usage.outputTokens,
        cacheReadInputTokens: result.diagnostics.usage.cacheReadInputTokens,
      },
      rawUsage: result.diagnostics.rawUsage ?? null,
      contextWindow: options.contextWindow ?? resolveKnownContextWindow(options.model),
      model: options.model ?? null,
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
  }))}\n`;
}

export function formatIntermediateAssistantSnapshotEvent(event: {
  readonly snapshot: AssistantEventSnapshot;
  readonly sessionId: string;
}): string {
  return `${JSON.stringify(buildAssistantEventsFromSnapshots([event.snapshot], event.sessionId)[0])}\n`;
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
    {
      type: 'user',
      ...(event.sessionId ? { session_id: event.sessionId } : {}),
      uuid: randomUUID(),
      origin: { kind: 'task-notification' },
      message: {
        role: 'user',
        content: 'background task notification',
      },
    },
    buildAssistantTextEvent({
      turnId: event.turnId,
      sessionId: event.sessionId,
      text: event.text,
      stopReason: 'end_turn',
    }),
  ].map((line) => `${JSON.stringify(line)}\n`).join('');
}

export function formatWorkerTurnResult(result: WorkerTurnResult, event: {
  readonly turnId: string;
  readonly model?: string | null;
  readonly structuredOutputToolUseId?: string | null;
  readonly suppressAssistantTexts?: readonly string[];
  readonly suppressAssistantReasoningTexts?: readonly string[];
  readonly suppressAssistantSnapshots?: readonly AssistantEventSnapshot[];
  readonly suppressFallbackAssistantText?: boolean;
}): string {
  const usage = {
    inputTokens: result.diagnostics.inputTokens,
    outputTokens: result.diagnostics.outputTokens,
    cacheReadInputTokens: result.diagnostics.cacheReadInputTokens,
  };
  const snapshotStructuredOutputToolUseId = findStructuredOutputToolUseId(result.assistantEvents);
  const structuredOutputToolUseId = resolveStructuredOutputToolUseId({
    structuredOutput: result.structuredOutput,
    assistantEvents: result.assistantEvents,
    preferredToolUseId: event.structuredOutputToolUseId,
  });
  const filteredSnapshots = filterStructuredFallbackTextSnapshots(
    result.assistantEvents,
    result.structuredOutput,
    snapshotStructuredOutputToolUseId !== null,
  );
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
  const assistantSnapshots = filterAssistantSnapshots(filteredSnapshots, {
    text: suppressedAssistantTexts,
    reasoning: suppressedAssistantReasoningTexts,
    snapshots: event.suppressAssistantSnapshots ?? [],
  });
  const assistantEvents = buildAssistantEventsFromSnapshots(
    assistantSnapshots,
    result.sessionId,
  );
  const assistantSnapshotsContainResultText = snapshotsContainAssistantText(assistantSnapshots, result.content);
  const shouldEmitFallbackAssistant = Boolean(fallbackReasoningContent)
    || fallbackStructuredOutput !== undefined
    || shouldEmitResultTextFallback(result.content, latestSuppressedAssistantText, event.suppressFallbackAssistantText);
  const textFallbackAfterSnapshots = result.structuredOutput === undefined &&
    assistantEvents.length > 0 &&
    latestSuppressedAssistantText !== null &&
    result.content.length > 0 &&
    latestSuppressedAssistantText !== result.content &&
    !assistantSnapshotsContainResultText
    ? [buildAssistantTextEvent({
        turnId: event.turnId,
        sessionId: result.sessionId,
        text: result.content,
        requestId: result.requestId,
        stopReason: null,
        model: event.model ?? null,
        usage,
      })]
    : [];
  const fallbackAssistantEvents = assistantEvents.length > 0
    ? [
        ...assistantEvents,
        ...textFallbackAfterSnapshots,
        ...(result.structuredOutput !== undefined && !snapshotStructuredOutputToolUseId
          ? [buildAssistantTextEvent({
              turnId: event.turnId,
              sessionId: result.sessionId,
              text: '',
              structuredOutput: result.structuredOutput,
              structuredOutputToolUseId,
              requestId: result.requestId,
              stopReason: null,
              model: event.model ?? null,
              usage,
            })]
          : []),
      ]
    : (shouldEmitFallbackAssistant
        ? [buildAssistantTextEvent({
            turnId: event.turnId,
            sessionId: result.sessionId,
            text: latestSuppressedAssistantText === result.content ? '' : result.content,
            reasoningContent: fallbackReasoningContent,
            structuredOutput: fallbackStructuredOutput,
            structuredOutputToolUseId,
            requestId: result.requestId,
            stopReason: null,
            model: event.model ?? null,
            usage,
          })]
        : []);

  const events = [
    ...fallbackAssistantEvents,
    ...(structuredOutputToolUseId ? [buildStructuredOutputToolResultEvent({
      sessionId: result.sessionId,
      toolUseId: structuredOutputToolUseId,
    })] : []),
    buildResultEvent({
      turnId: event.turnId,
      sessionId: result.sessionId,
      text: result.content,
      structuredOutput: result.structuredOutput,
      durationMs: result.diagnostics.durationMs,
      numTurns: result.diagnostics.numTurns,
      totalCostUsd: result.diagnostics.totalCostUsd,
      stopReason: result.diagnostics.stopReason,
      usage,
      rawUsage: result.diagnostics.rawUsage ?? null,
      contextWindow: result.diagnostics.contextWindow,
      model: event.model ?? null,
    }),
  ];
  return events.map((line) => `${JSON.stringify(line)}\n`).join('');
}

function shouldEmitResultTextFallback(
  text: string,
  latestSuppressedText: string | null,
  suppressFallback: boolean | undefined,
): boolean {
  if (!suppressFallback) {
    return true;
  }
  return text.length > 0 && latestSuppressedText !== text;
}

function buildAssistantEventsFromSnapshots(
  snapshots: readonly AssistantEventSnapshot[] | undefined,
  sessionId: string,
): Record<string, unknown>[] {
  if (!snapshots || snapshots.length === 0) {
    return [];
  }
  return snapshots.map((snapshot) => ({
    type: 'assistant',
    session_id: sessionId,
    parent_tool_use_id: null,
    uuid: randomUUID(),
    ...(snapshot.requestId ? { request_id: snapshot.requestId } : {}),
    message: normalizePublicAssistantMessage(snapshot.message),
  }));
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

function filterStructuredFallbackTextSnapshots(
  snapshots: readonly AssistantEventSnapshot[] | undefined,
  structuredOutput: unknown,
  hasStructuredOutputToolUse: boolean,
): readonly AssistantEventSnapshot[] | undefined {
  if (!snapshots || structuredOutput === undefined || hasStructuredOutputToolUse) {
    return snapshots;
  }
  return snapshots.filter((snapshot) => !snapshotTextEqualsStructuredOutput(snapshot, structuredOutput));
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
    const delta = previousText !== null && text.startsWith(`${previousText}\n\n`)
      ? text.slice(previousText.length + 2)
      : text;
    previousText = text;
    for (const segment of delta.split('\n\n')) {
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
  return snapshots.some((snapshot) => snapshotAssistantText(snapshot) === text);
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

function extractJsonTextCandidate(text: string): string {
  const fenced = /^```json[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(text);
  return fenced?.[1]?.trim() ?? text;
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

export function formatSystemInitEvent(sessionId: string, options: {
  readonly cwd?: string | null;
  readonly model?: string | null;
  readonly permissionMode?: string | null;
  readonly mcpServers?: readonly unknown[];
} = {}): string {
  return `${JSON.stringify(buildSystemInitEvent(sessionId, options))}\n`;
}

export function createPartialMessageStreamState(): PartialMessageStreamState {
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

export function formatSystemStatusEvent(event: {
  readonly sessionId: string;
  readonly status: string;
}): string {
  return `${JSON.stringify({
    type: 'system',
    subtype: 'status',
    status: event.status,
    session_id: event.sessionId,
    uuid: randomUUID(),
  })}\n`;
}

export function formatPartialTextDeltaEvents(
  state: PartialMessageStreamState,
  event: {
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
    lines.push(buildStreamEvent({
      sessionId: event.sessionId,
      event: {
        type: 'message_start',
        message: {
          ...(event.model ? { model: event.model } : {}),
          id: state.messageId,
          type: 'message',
          role: 'assistant',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          stop_details: null,
        },
      },
    }));
    state.started = true;
  }
  if (!state.blockOpen) {
    lines.push(buildStreamEvent({
      sessionId: event.sessionId,
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      },
    }));
    state.blockOpen = true;
  }

  if (!text.startsWith(state.previousText)) {
    throw new Error('partial text replacement is not prefix-compatible');
  }

  const deltaText = text.slice(state.previousText.length);
  if (deltaText) {
    lines.push(buildStreamEvent({
      sessionId: event.sessionId,
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: deltaText },
      },
    }));
  }
  state.previousText = text;
  return lines.map((line) => `${JSON.stringify(line)}\n`).join('');
}

export function formatPartialDeltaEvents(
  state: PartialMessageStreamState,
  event: {
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
    lines.push(buildStreamEvent({
      sessionId: event.sessionId,
      event: {
        type: 'message_start',
        message: {
          ...(event.model ? { model: event.model } : {}),
          id: state.messageId,
          type: 'message',
          role: 'assistant',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          stop_details: null,
        },
      },
    }));
    state.started = true;
  }

  if (reasoningText && reasoningText !== state.previousReasoningText && !state.blockOpen) {
    if (!state.hasReasoning) {
      state.hasReasoning = true;
    }
    if (!state.reasoningBlockOpen) {
      lines.push(buildStreamEvent({
        sessionId: event.sessionId,
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'thinking', thinking: '' },
        },
      }));
      state.reasoningBlockOpen = true;
    }
    if (!reasoningText.startsWith(state.previousReasoningText)) {
      throw new Error('partial reasoning replacement is not prefix-compatible');
    } else {
      const deltaText = reasoningText.slice(state.previousReasoningText.length);
      if (deltaText) {
        lines.push(buildStreamEvent({
          sessionId: event.sessionId,
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'thinking_delta', thinking: deltaText },
          },
        }));
      }
    }
    state.previousReasoningText = reasoningText;
  }

  if (text && text !== state.previousText) {
    const textBlockIndex = state.hasReasoning ? 1 : 0;
    if (!state.blockOpen) {
      if (state.reasoningBlockOpen) {
        lines.push(buildStreamEvent({
          sessionId: event.sessionId,
          event: {
            type: 'content_block_stop',
            index: 0,
          },
        }));
        state.reasoningBlockOpen = false;
      }
      lines.push(buildStreamEvent({
        sessionId: event.sessionId,
        event: {
          type: 'content_block_start',
          index: textBlockIndex,
          content_block: { type: 'text', text: '' },
        },
      }));
      state.blockOpen = true;
    }

    if (!text.startsWith(state.previousText)) {
      throw new Error('partial text replacement is not prefix-compatible');
    }

    const deltaText = text.slice(state.previousText.length);
    if (deltaText) {
      lines.push(buildStreamEvent({
        sessionId: event.sessionId,
        event: {
          type: 'content_block_delta',
          index: textBlockIndex,
          delta: { type: 'text_delta', text: deltaText },
        },
      }));
    }
    state.previousText = text;
  }

  return lines.map((line) => `${JSON.stringify(line)}\n`).join('');
}

export function formatPartialMessageLifecycleEvents(
  state: PartialMessageStreamState,
  event: {
    readonly sessionId?: string | null;
    readonly model?: string | null;
    readonly structuredOutput?: unknown;
    readonly structuredOutputToolUseId?: string | null;
    readonly usage?: {
      readonly inputTokens: number | null;
      readonly outputTokens: number | null;
      readonly cacheReadInputTokens: number | null;
    };
    readonly stopReason?: string | null;
  },
): string {
  const lines: Record<string, unknown>[] = [];
  if (!state.started) {
    state.messageId = state.messageId ?? buildMessageId();
    lines.push(buildStreamEvent({
      sessionId: event.sessionId,
      event: {
        type: 'message_start',
        message: {
          ...(event.model ? { model: event.model } : {}),
          id: state.messageId,
          type: 'message',
          role: 'assistant',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          stop_details: null,
        },
      },
    }));
    state.started = true;
  }
  if (event.structuredOutput !== undefined) {
    const toolUseId = event.structuredOutputToolUseId ?? buildToolUseId();
    lines.push(buildStreamEvent({
      sessionId: event.sessionId,
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: toolUseId,
          name: 'StructuredOutput',
          input: {},
          caller: { type: 'direct' },
        },
      },
    }));
    const partialJson = JSON.stringify(event.structuredOutput);
    if (typeof partialJson === 'string') {
      lines.push(buildStreamEvent({
        sessionId: event.sessionId,
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'input_json_delta',
            partial_json: partialJson,
          },
        },
      }));
    }
    lines.push(buildStreamEvent({
      sessionId: event.sessionId,
      event: {
        type: 'content_block_stop',
        index: 0,
      },
    }));
  }
  return `${lines.map((line) => `${JSON.stringify(line)}\n`).join('')}${formatPartialMessageStopEvents(state, event)}`;
}

export function formatPartialMessageStopEvents(
  state: PartialMessageStreamState,
  event: {
    readonly sessionId?: string | null;
    readonly usage?: {
      readonly inputTokens: number | null;
      readonly outputTokens: number | null;
      readonly cacheReadInputTokens: number | null;
    };
    readonly stopReason?: string | null;
  },
): string {
  if (!state.started) {
    return '';
  }
  const lines: Record<string, unknown>[] = [];
  if (state.reasoningBlockOpen) {
    lines.push(buildStreamEvent({
      sessionId: event.sessionId,
      event: {
        type: 'content_block_stop',
        index: 0,
      },
    }));
    state.reasoningBlockOpen = false;
  }
  if (state.blockOpen) {
    lines.push(buildStreamEvent({
      sessionId: event.sessionId,
      event: {
        type: 'content_block_stop',
        index: state.hasReasoning ? 1 : 0,
      },
    }));
    state.blockOpen = false;
  }
  lines.push(buildStreamEvent({
    sessionId: event.sessionId,
    event: {
      type: 'message_delta',
      delta: {
        stop_reason: event.stopReason ?? 'end_turn',
        stop_sequence: null,
        stop_details: null,
      },
      ...(event.usage ? { usage: buildUsage(event.usage) } : {}),
    },
  }));
  lines.push(buildStreamEvent({
    sessionId: event.sessionId,
    event: {
      type: 'message_stop',
    },
  }));
  state.started = false;
  state.previousText = '';
  state.previousReasoningText = '';
  state.hasReasoning = false;
  state.messageId = null;
  return lines.map((line) => `${JSON.stringify(line)}\n`).join('');
}

function buildSystemInitEvent(sessionId: string, options: {
  readonly cwd?: string | null;
  readonly model?: string | null;
  readonly permissionMode?: string | null;
  readonly mcpServers?: readonly unknown[];
} = {}): Record<string, unknown> {
  return {
    type: 'system',
    subtype: 'init',
    ...(options.cwd ? { cwd: options.cwd } : {}),
    session_id: sessionId,
    ...(options.mcpServers ? { mcp_servers: options.mcpServers } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options.permissionMode ? { permissionMode: options.permissionMode } : {}),
    output_style: 'default',
    uuid: randomUUID(),
    fast_mode_state: 'off',
  };
}

function buildStreamEvent(event: {
  readonly sessionId?: string | null;
  readonly event: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    type: 'stream_event',
    event: event.event,
    ...(event.event.type === 'message_start' ? { ttft_ms: null } : {}),
    ...(event.sessionId ? { session_id: event.sessionId } : {}),
    parent_tool_use_id: null,
    uuid: randomUUID(),
  };
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
  readonly model?: string | null;
  readonly usage?: {
    readonly inputTokens: number | null;
    readonly outputTokens: number | null;
    readonly cacheReadInputTokens: number | null;
  };
}): Record<string, unknown> {
  const content: Record<string, unknown>[] = [];
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
      id: event.structuredOutputToolUseId ?? buildToolUseId(),
      name: 'StructuredOutput',
      input: event.structuredOutput,
      caller: { type: 'direct' },
    });
  } else if (event.text) {
    content.push({ type: 'text', text: event.text });
  }

  return {
    type: 'assistant',
    ...(event.sessionId ? { session_id: event.sessionId } : {}),
    parent_tool_use_id: null,
    uuid: randomUUID(),
    ...(event.requestId ? { request_id: event.requestId } : {}),
    message: {
      type: 'message',
      role: 'assistant',
      id: event.messageId ?? buildMessageId(),
      ...(event.model ? { model: event.model } : {}),
      content,
      stop_reason: event.stopReason,
      stop_sequence: null,
      stop_details: null,
      usage: event.usage ? buildUsage(event.usage) : undefined,
      diagnostics: null,
      context_management: null,
    },
  };
}

function buildStructuredOutputToolResultEvent(event: {
  readonly sessionId: string;
  readonly toolUseId: string;
}): Record<string, unknown> {
  return {
    type: 'user',
    session_id: event.sessionId,
    parent_tool_use_id: null,
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    tool_use_result: 'Structured output provided successfully',
    message: {
      role: 'user',
      content: [
        {
          tool_use_id: event.toolUseId,
          type: 'tool_result',
          content: 'Structured output provided successfully',
        },
      ],
    },
  };
}

function buildResultEvent(event: {
  readonly turnId: string;
  readonly sessionId: string;
  readonly text: string;
  readonly structuredOutput?: unknown;
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
  readonly model: string | null;
}): Record<string, unknown> {
  return {
    type: 'result',
    subtype: 'success',
    session_id: event.sessionId,
    is_error: false,
    api_error_status: null,
    duration_api_ms: null,
    ttft_ms: null,
    result: event.structuredOutput === undefined ? event.text : '',
    num_turns: event.numTurns,
    duration_ms: event.durationMs,
    total_cost_usd: event.totalCostUsd,
    stop_reason: event.stopReason,
    usage: buildPublicUsage(event.usage, event.rawUsage),
    modelUsage: buildModelUsage(event.model, event.contextWindow, event.usage, event.totalCostUsd),
    permission_denials: [],
    ...(event.structuredOutput !== undefined ? { structured_output: event.structuredOutput } : {}),
    terminal_reason: 'completed',
    fast_mode_state: 'off',
    uuid: randomUUID(),
  };
}

function buildUsage(usage: {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadInputTokens: number | null;
}): Record<string, number | null> {
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    cache_read_input_tokens: usage.cacheReadInputTokens,
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

export function resolveKnownContextWindow(model: string | null | undefined): number | null {
  if (!model) {
    return null;
  }
  if (model.includes('[1m]')) {
    return 1_000_000;
  }
  if (
    model.startsWith('claude-haiku-4-5') ||
    model.startsWith('claude-opus-4-6') ||
    model.startsWith('claude-sonnet-4-6') ||
    model.startsWith('claude-opus-4-7')
  ) {
    return 200_000;
  }
  return null;
}
