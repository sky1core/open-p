import type { BackendWorkerBridge } from '../../core/backend.js';
import { EXIT_CODES, OpenPError } from '../../core/errors.js';
import type { WorkerTurnRequest, WorkerTurnResult, WorkerTurnDiagnostics } from '../../core/worker-types.js';

import { buildKiroAcpArgs } from './args.js';
import { resolveKiroBin } from './bin.js';
import { validateKiroReasoningEffort } from './effort.js';
import { runKiroAcp } from './acp-runner.js';

export class KiroWorkerBridge implements BackendWorkerBridge {
  async runTurn(request: WorkerTurnRequest): Promise<WorkerTurnResult> {
    rejectUnsupportedOptions(request);

    const isFirstTurn = request.isFirstTurn ?? !request.sessionId;
    const { args, trustAllTools } = buildKiroAcpArgs({
      model: request.model,
      executionMode: request.executionMode,
      tools: request.tools,
      backendArgs: request.binArgs ?? [],
    });
    const result = await runKiroAcp({
      bin: request.bin ?? resolveKiroBin(),
      args,
      cwd: request.projectRoot,
      prompt: request.message,
      sessionId: isFirstTurn ? null : request.sessionId,
      isFirstTurn,
      reasoningEffort: request.reasoningEffort,
      timeoutMs: request.timeoutMs ?? 0,
      trustAllTools,
      env: request.env ? { ...process.env, ...request.env } : undefined,
      signal: request.signal,
      forceSignal: request.forceSignal,
      killSignal: request.killSignal,
      onAssistantText: request.onIntermediateText
        ? (text) => {
            request.onIntermediateText!(text, 'jsonl');
          }
        : undefined,
    });

    const diagnostics: WorkerTurnDiagnostics = {
      numTurns: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadInputTokens: null,
      rawUsage: result.rawUsage,
      contextWindow: null,
      lastSubturnContextTokens: null,
      durationMs: result.durationMs,
      totalCostUsd: null,
      stopReason: result.stopReason,
      toolsUsed: result.toolsUsed,
      autoCompacted: null,
      intermediateTextCount: result.intermediateTextCount,
    };

    return {
      content: result.content,
      reasoningContent: null,
      sessionId: result.sessionId,
      assistantEvents: result.assistantEvents.length > 0 ? result.assistantEvents : undefined,
      diagnostics,
    };
  }

  async isChildAliveForSession(_sessionId: string): Promise<boolean> {
    return false;
  }

  async shutdown(): Promise<void> {
    // Kiro ACP is launched as a one-shot process per turn.
  }
}

function rejectUnsupportedOptions(request: WorkerTurnRequest): void {
  if (request.jsonSchema) {
    throw new OpenPError('Kiro backend does not support jsonSchema', EXIT_CODES.unsupportedOption);
  }
  validateKiroReasoningEffort(request.reasoningEffort);
  if (request.local === true) {
    throw new OpenPError('Kiro backend does not support local worker mode', EXIT_CODES.unsupportedOption);
  }
}
