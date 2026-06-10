import type { Backend } from '../../core/backend.js';
import { EXIT_CODES, OpenPError } from '../../core/errors.js';
import { SessionLockStore } from '../../core/session-lock.js';
import type { TurnRequest, TurnResult, BackendRunOptions } from '../../core/types.js';

import { buildKiroAcpArgs } from './args.js';
import { resolveKiroBin } from './bin.js';
import { validateKiroReasoningEffort } from './effort.js';
import { runKiroAcp } from './acp-runner.js';

export class KiroBackend implements Backend {
  async runTurn(request: TurnRequest, options: BackendRunOptions): Promise<TurnResult> {
    const lock = await new SessionLockStore(options.cwd).acquire(options.backendSessionId);
    let primaryError: unknown = null;
    try {
      return await this.runTurnWithLock(request, options);
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      try {
        await lock.release();
      } catch (releaseError) {
        if (primaryError === null) {
          throw releaseError;
        }
      }
    }
  }

  private async runTurnWithLock(request: TurnRequest, options: BackendRunOptions): Promise<TurnResult> {
    rejectUnsupportedOptions({
      jsonSchema: options.jsonSchema,
      reasoningEffort: options.reasoningEffort,
    });

    const startMs = Date.now();
    const { args, trustAllTools } = buildKiroAcpArgs({
      model: options.model,
      reasoningEffort: options.reasoningEffort,
      executionMode: options.permissionMode,
      tools: options.tools,
      backendArgs: options.backendArgs,
    });
    const result = await runKiroAcp({
      bin: resolveKiroBin(),
      args,
      cwd: options.cwd,
      prompt: request.prompt,
      sessionId: options.resume ? options.backendSessionId : null,
      isFirstTurn: !options.resume,
      timeoutMs: options.timeoutMs,
      trustAllTools,
      signal: options.signal,
      forceSignal: options.forceSignal,
      killSignal: options.killSignal,
      onAssistantText: options.onIntermediateText
        ? (text) => {
            options.onIntermediateText!(text, 'jsonl');
          }
        : undefined,
    });

    return {
      turnId: request.turnId,
      text: result.content,
      reasoningContent: null,
      sessionId: result.sessionId,
      assistantEvents: result.assistantEvents.length > 0 ? result.assistantEvents : undefined,
      diagnostics: {
        durationMs: result.durationMs ?? Date.now() - startMs,
        stopReason: result.stopReason,
        toolsUsed: result.toolsUsed,
        usage: {
          inputTokens: null,
          outputTokens: null,
          cacheReadInputTokens: null,
        },
        rawUsage: result.rawUsage,
        rawEventCount: result.rawEventCount,
      },
    };
  }
}

function rejectUnsupportedOptions(options: {
  readonly jsonSchema: string | null;
  readonly reasoningEffort: string | null;
}): void {
  if (options.jsonSchema) {
    throw new OpenPError('Kiro backend does not support --json-schema', EXIT_CODES.unsupportedOption);
  }
  validateKiroReasoningEffort(options.reasoningEffort);
}
