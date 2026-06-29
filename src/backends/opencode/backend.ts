import type { Backend } from '../../core/backend.js';
import { SessionLockStore } from '../../core/session-lock.js';
import type { BackendRunOptions, TurnRequest, TurnResult } from '../../core/types.js';
import { runOpenCodeTurn } from './runner.js';

export class OpenCodeBackend implements Backend {
  async runTurn(request: TurnRequest, options: BackendRunOptions): Promise<TurnResult> {
    const lock = await new SessionLockStore(options.cwd).acquire(options.backendSessionId);
    let primaryError: unknown = null;
    try {
      const result = await runOpenCodeTurn({
        message: request.prompt,
        sessionId: options.resume ? options.backendSessionId : null,
        isFirstTurn: !options.resume,
        projectRoot: options.cwd,
        model: options.model,
        reasoningEffort: options.reasoningEffort,
        executionMode: options.permissionMode,
        tools: options.tools ?? null,
        jsonSchema: options.jsonSchema,
        backendArgs: options.backendArgs,
        timeoutMs: options.timeoutMs,
        signal: options.signal,
        forceSignal: options.forceSignal,
        killSignal: options.killSignal,
      });
      return {
        turnId: request.turnId,
        text: result.content,
        reasoningContent: result.reasoningContent ?? null,
        sessionId: result.sessionId,
        assistantEvents: result.assistantEvents,
        diagnostics: {
          durationMs: result.diagnostics.durationMs,
          stopReason: result.diagnostics.stopReason,
          toolsUsed: result.diagnostics.toolsUsed,
          usage: {
            inputTokens: result.diagnostics.inputTokens,
            outputTokens: result.diagnostics.outputTokens,
            cacheReadInputTokens: result.diagnostics.cacheReadInputTokens,
          },
          rawUsage: result.diagnostics.rawUsage,
          model: result.diagnostics.model,
          contextWindow: result.diagnostics.contextWindow,
          lastSubturnUsage: result.diagnostics.lastSubturnUsage,
          lastSubturnContextTokens: result.diagnostics.lastSubturnContextTokens,
          rawEventCount: result.rawEventCount,
        },
      };
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
}
