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
  const cacheCreationInputTokens = result.diagnostics.usage.cacheCreationInputTokens;
  const lastSubturnUsage = result.diagnostics.lastSubturnUsage ?? null;
  const lastSubturnContextTokens = result.diagnostics.lastSubturnContextTokens ??
    (lastSubturnUsage
      ? contextTokensFromUsage(lastSubturnUsage)
      : null);
  const sessionId = result.sessionId ?? fallbackSessionId;
  return {
    content: result.text,
    reasoningContent: result.reasoningContent ?? null,
    ...(result.structuredOutput !== undefined ? { structuredOutput: result.structuredOutput } : {}),
    ...(result.requestId ? { requestId: result.requestId } : {}),
    ...(result.assistantEvents ? { assistantEvents: result.assistantEvents } : {}),
    ...(result.warnings && result.warnings.length > 0 ? { warnings: result.warnings } : {}),
    ...(result.interruptedExitCode !== undefined ? { interruptedExitCode: result.interruptedExitCode } : {}),
    sessionId,
    diagnostics: {
      numTurns: options.numTurns ?? null,
      inputTokens,
      outputTokens: result.diagnostics.usage.outputTokens,
      cacheReadInputTokens,
      ...(cacheCreationInputTokens !== undefined ? { cacheCreationInputTokens } : {}),
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

function contextTokensFromUsage(usage: {
  readonly inputTokens: number | null;
  readonly cacheReadInputTokens: number | null;
  readonly cacheCreationInputTokens?: number | null;
}): number | null {
  if (usage.inputTokens === null || usage.cacheReadInputTokens === null) {
    return null;
  }
  // Only Claude reports cache creation tokens; other backends omit/null this field and contribute 0.
  const cacheCreationInputTokens =
    typeof usage.cacheCreationInputTokens === 'number' ? usage.cacheCreationInputTokens : 0;
  return usage.inputTokens + usage.cacheReadInputTokens + cacheCreationInputTokens;
}
