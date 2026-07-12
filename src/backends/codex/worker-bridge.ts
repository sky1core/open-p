import type { BackendWorkerBridge } from '../../core/backend.js';
import { EXIT_CODES, OpenPError } from '../../core/errors.js';
import type { WorkerTurnDiagnostics, WorkerTurnRequest, WorkerTurnResult } from '../../core/worker-types.js';
import { readRequiredFirstTurnFlag } from '../../core/worker-input.js';

import { resolveCodexBin } from './bin.js';
import { executeCodexTurn } from './turn-executor.js';

export interface CodexWorkerBridgeOptions {
  readonly homeDir?: string | null;
}

export class CodexWorkerBridge implements BackendWorkerBridge {
  private readonly homeDir: string | null;

  constructor(options: CodexWorkerBridgeOptions = {}) {
    this.homeDir = options.homeDir ?? null;
  }

  async runTurn(request: WorkerTurnRequest): Promise<WorkerTurnResult> {
    if (request.local === true) {
      throw new OpenPError('Codex backend does not support local worker mode', EXIT_CODES.unsupportedOption);
    }
    const result = await executeCodexTurn({
      bin: request.bin ?? resolveCodexBin(),
      projectRoot: request.projectRoot,
      prompt: request.message,
      turnId: request.turnId ?? 'codex-worker-turn',
      sessionId: request.sessionId,
      isFirstTurn: readRequiredFirstTurnFlag(request),
      model: request.model ?? null,
      reasoningEffort: request.reasoningEffort ?? null,
      executionMode: request.executionMode ?? null,
      tools: request.tools ?? null,
      jsonSchema: request.jsonSchema ?? null,
      binArgs: request.binArgs ?? [],
      timeoutMs: request.timeoutMs ?? 0,
      env: request.env ? { ...process.env, ...request.env } : undefined,
      homeDir: this.homeDir,
      signal: request.signal,
      forceSignal: request.forceSignal,
      killSignal: request.killSignal,
      callbacks: {
        onAssistantText: request.onIntermediateText
          ? (text) => request.onIntermediateText!(text, 'jsonl')
          : undefined,
        onReasoningText: request.onIntermediateReasoning
          ? (text) => request.onIntermediateReasoning!(text, 'jsonl')
          : undefined,
        onAssistantSnapshot: request.onIntermediateAssistantSnapshot
          ? (snapshot) => request.onIntermediateAssistantSnapshot!(snapshot, 'jsonl')
          : undefined,
      },
    });
    const diagnostics: WorkerTurnDiagnostics = {
      numTurns: null,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cacheReadInputTokens: result.usage.cacheReadInputTokens,
      rawUsage: null,
      model: result.model,
      contextWindow: result.contextWindow,
      lastSubturnUsage: result.lastSubturnUsage,
      lastSubturnContextTokens: result.lastSubturnContextTokens,
      durationMs: result.durationMs,
      totalCostUsd: null,
      stopReason: null,
      toolsUsed: [],
      autoCompacted: null,
      intermediateTextCount: null,
    };
    return {
      content: result.content,
      reasoningContent: result.reasoningContent,
      ...(result.structuredOutput !== undefined ? { structuredOutput: result.structuredOutput } : {}),
      sessionId: result.sessionId,
      assistantEvents: result.assistantEvents.length > 0 ? result.assistantEvents : undefined,
      diagnostics,
    };
  }

  async isChildAliveForSession(_sessionId: string): Promise<boolean> {
    return false;
  }

  async shutdown(): Promise<void> {
    // Codex exec is one-shot and has no persistent child after a turn.
  }
}
