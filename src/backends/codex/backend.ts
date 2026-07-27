import type { Backend } from '../../core/backend.js';
import { SessionLockStore } from '../../core/session-lock.js';
import { settlePendingSeedBeforeResume } from '../../core/resume-preflight.js';
import type { BackendRunOptions, TurnRequest, TurnResult } from '../../core/types.js';

import { resolveCodexBin } from './bin.js';
import { executeCodexTurn } from './turn-executor.js';

export interface CodexBackendOptions {
  readonly homeDir?: string | null;
}

export class CodexBackend implements Backend {
  private readonly homeDir: string | null;

  constructor(options: CodexBackendOptions = {}) {
    this.homeDir = options.homeDir ?? null;
  }

  async runTurn(request: TurnRequest, options: BackendRunOptions): Promise<TurnResult> {
    const lock = await new SessionLockStore(options.cwd).acquire(options.backendSessionId);
    let primaryError: unknown = null;
    try {
      await settlePendingSeedBeforeResume(options);
      const result = await executeCodexTurn({
        bin: resolveCodexBin(),
        projectRoot: options.cwd,
        prompt: request.prompt,
        turnId: request.turnId,
        sessionId: options.resume ? options.backendSessionId : null,
        isFirstTurn: !options.resume,
        model: options.model,
        reasoningEffort: options.reasoningEffort,
        executionMode: options.permissionMode,
        tools: options.tools ?? null,
        jsonSchema: options.jsonSchema,
        binArgs: options.backendArgs,
        timeoutMs: options.timeoutMs,
        homeDir: this.homeDir,
        signal: options.signal,
        forceSignal: options.forceSignal,
        killSignal: options.killSignal,
        callbacks: {
          onAssistantText: options.onIntermediateText
            ? (text) => options.onIntermediateText!(text, 'jsonl')
            : undefined,
          onReasoningText: options.onIntermediateReasoning
            ? (text) => options.onIntermediateReasoning!(text, 'jsonl')
            : undefined,
          onAssistantSnapshot: options.onIntermediateAssistantSnapshot
            ? (snapshot) => options.onIntermediateAssistantSnapshot!(snapshot, 'jsonl')
            : undefined,
        },
      });
      return {
        turnId: request.turnId,
        text: result.content,
        reasoningContent: result.reasoningContent,
        ...(result.structuredOutput !== undefined ? { structuredOutput: result.structuredOutput } : {}),
        sessionId: result.sessionId,
        assistantEvents: result.assistantEvents.length > 0 ? result.assistantEvents : undefined,
        diagnostics: {
          durationMs: result.durationMs,
          stopReason: null,
          toolsUsed: [],
          usage: result.usage,
          rawUsage: null,
          model: result.model,
          effort: result.effort,
          contextWindow: result.contextWindow,
          lastSubturnUsage: result.lastSubturnUsage,
          lastSubturnContextTokens: result.lastSubturnContextTokens,
          rawEventCount: 0,
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
