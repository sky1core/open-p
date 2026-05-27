import type { TurnResult } from './types.js';
import type { WorkerTurnResult } from './worker-types.js';

export interface WorkerResultMappingOptions {
  readonly contextWindow?: number | null;
  readonly numTurns?: number | null;
  readonly stopReason?: string | null;
  readonly totalCostUsd?: number | null;
  readonly autoCompacted?: boolean | null;
  readonly intermediateTextCount?: number | null;
}

export function toWorkerTurnResult(
  result: TurnResult,
  fallbackSessionId: string,
  options: WorkerResultMappingOptions = {},
): WorkerTurnResult {
  const inputTokens = result.diagnostics.usage.inputTokens;
  const cacheReadInputTokens = result.diagnostics.usage.cacheReadInputTokens;
  const lastSubturnUsage = result.diagnostics.lastSubturnUsage ?? null;
  const lastSubturnContextTokens = result.diagnostics.lastSubturnContextTokens ??
    (lastSubturnUsage
      ? addNullable(lastSubturnUsage.inputTokens, lastSubturnUsage.cacheReadInputTokens)
      : null);
  const sessionId = result.sessionId ?? fallbackSessionId;
  return {
    content: result.text,
    reasoningContent: result.reasoningContent ?? null,
    ...(result.structuredOutput !== undefined ? { structuredOutput: result.structuredOutput } : {}),
    ...(result.requestId ? { requestId: result.requestId } : {}),
    ...(result.assistantEvents ? { assistantEvents: result.assistantEvents } : {}),
    sessionId,
    diagnostics: {
      numTurns: options.numTurns ?? null,
      inputTokens,
      outputTokens: result.diagnostics.usage.outputTokens,
      cacheReadInputTokens,
      ...(result.diagnostics.rawUsage ? { rawUsage: result.diagnostics.rawUsage } : {}),
      ...(result.diagnostics.model ? { model: result.diagnostics.model } : {}),
      contextWindow: result.diagnostics.contextWindow ?? options.contextWindow ?? null,
      ...(lastSubturnUsage ? { lastSubturnUsage } : {}),
      lastSubturnContextTokens,
      durationMs: result.diagnostics.durationMs,
      totalCostUsd: options.totalCostUsd ?? null,
      stopReason: (options.stopReason ?? result.diagnostics.stopReason) ?? null,
      toolsUsed: result.diagnostics.toolsUsed,
      autoCompacted: options.autoCompacted ?? null,
      intermediateTextCount: options.intermediateTextCount ?? null,
    },
  };
}

function addNullable(left: number | null, right: number | null): number | null {
  if (left === null || right === null) {
    return null;
  }
  return left + right;
}
