import { randomUUID } from 'node:crypto';
import { throwIfAborted } from '../../core/abort.js';
import { buildLaunchSignature } from '../../core/launch-signature.js';
import { PersistentProcessManager } from '../../core/persistent-process.js';
import type { ProcessStartRequest, ManagedBackendProcess } from '../../core/persistent-process.js';
import { prepareWorkerTurnInput } from '../../core/worker-input.js';
import { toWorkerTurnResult } from '../../core/worker-result.js';
import type { WorkerTurnRequest, WorkerTurnResult } from '../../core/worker-types.js';
import type { TurnResult } from '../../core/types.js';
import type { PtyProvider } from '../../runners/types.js';
import { TmuxProvider } from '../../runners/tmux.js';
import {
  type PersistentClaudeCodeTurnOptions,
  startPersistentClaudeCodeProcess,
} from './persistent-process.js';
import { resolveClaudeCodeBin } from './bin.js';

export interface ClaudeCodeManagedProcess extends ManagedBackendProcess {
  sendTurn(prompt: string, options: PersistentClaudeCodeTurnOptions): Promise<TurnResult>;
}

export interface ClaudeCodeWorkerBridgeStartRequest extends ProcessStartRequest {
  readonly cwd: string;
  readonly provider: PtyProvider;
  readonly appendSystemPrompt: string | null;
  readonly timeoutMs: number;
}

export type ClaudeCodeWorkerBridgeStarter = (request: ClaudeCodeWorkerBridgeStartRequest) => Promise<ClaudeCodeManagedProcess>;

export class ClaudeCodeWorkerBridge {
  private readonly manager: PersistentProcessManager<ClaudeCodeManagedProcess>;
  private readonly startProcess: ClaudeCodeWorkerBridgeStarter;

  constructor(
    private readonly provider: PtyProvider = new TmuxProvider(),
    manager?: PersistentProcessManager<ClaudeCodeManagedProcess>,
    startProcess: ClaudeCodeWorkerBridgeStarter = startPersistentClaudeCodeProcess,
  ) {
    this.manager = manager ?? new PersistentProcessManager<ClaudeCodeManagedProcess>();
    this.startProcess = startProcess;
  }

  async runTurn(request: WorkerTurnRequest): Promise<WorkerTurnResult> {
    throwIfAborted(request.signal);
    const backendSessionId = request.sessionId ?? randomUUID();
    const preparedInput = prepareWorkerTurnInput(request);
    const launchSignature = buildLaunchSignature({
      backendId: 'claude-code',
      bin: request.bin ?? resolveClaudeCodeBin(),
      binArgs: request.binArgs ?? [],
      model: request.model ?? null,
      reasoningEffort: request.reasoningEffort ?? null,
      executionMode: request.executionMode ?? null,
      appendSystemPrompt: request.appendSystemPrompt ?? null,
      jsonSchema: request.jsonSchema ?? null,
      env: request.env ?? {},
      local: request.local ?? false,
    });

    return this.manager.runExclusive(backendSessionId, async () => {
      const process = await this.manager.getOrStart(
        backendSessionId,
        launchSignature,
        !preparedInput.isFirstTurn,
        (startRequest) => this.startProcess({
          ...startRequest,
          cwd: request.projectRoot,
          provider: this.provider,
          appendSystemPrompt: request.appendSystemPrompt ?? null,
          timeoutMs: request.timeoutMs ?? 120_000,
        }),
      );
      let intermediateTextCount = 0;
      try {
        const result = await process.sendTurn(preparedInput.prompt, {
          timeoutMs: request.timeoutMs ?? 120_000,
          signal: request.signal,
          jsonSchema: request.jsonSchema ?? null,
          paceIntermediateEvents: request.paceIntermediateEvents === true,
          onIntermediateText: (text, source) => {
            intermediateTextCount += 1;
            request.onIntermediateText?.(text, source);
          },
          onIntermediateReasoning: request.onIntermediateReasoning
            ? (text, source, contentBlocks) => {
                request.onIntermediateReasoning!(text, source, contentBlocks);
              }
            : undefined,
          onIntermediateAssistantSnapshot: request.onIntermediateAssistantSnapshot,
          onBackgroundAssistantText: request.onBackgroundAssistantText,
        });
        return toWorkerTurnResult(result, backendSessionId, {
          contextWindow: resolveRequestContextWindow(request),
          intermediateTextCount,
        });
      } catch (error) {
        await this.manager.discard(backendSessionId, process).catch(() => undefined);
        throw error;
      }
    });
  }

  async isChildAliveForSession(sessionId: string): Promise<boolean> {
    return this.manager.isAliveForSession(sessionId);
  }

  async shutdown(): Promise<void> {
    await this.manager.shutdownAll();
  }
}

function resolveRequestContextWindow(request: WorkerTurnRequest): number | null {
  if (request.model && request.contextWindowsByModel && Number.isFinite(request.contextWindowsByModel[request.model])) {
    return request.contextWindowsByModel[request.model]!;
  }
  return typeof request.contextWindow === 'number' && Number.isFinite(request.contextWindow) ? request.contextWindow : null;
}
