import { randomUUID } from 'node:crypto';
import { throwIfAborted } from '../../core/abort.js';
import { EXIT_CODES, OpenPError } from '../../core/errors.js';
import { buildLaunchSignature } from '../../core/launch-signature.js';
import { PersistentProcessManager } from '../../core/persistent-process.js';
import type { ProcessStartRequest, ManagedBackendProcess } from '../../core/persistent-process.js';
import { prepareWorkerTurnInput } from '../../core/worker-input.js';
import { toWorkerTurnResult } from '../../core/worker-result.js';
import type { BackendWorkerBridge } from '../../core/backend.js';
import type { WorkerTurnRequest, WorkerTurnResult } from '../../core/worker-types.js';
import type { TurnResult } from '../../core/types.js';
import type { PtyProvider } from '../../runners/types.js';
import { TmuxProvider } from '../../runners/tmux.js';
import {
  type PersistentClaudeCodeTurnOptions,
  startPersistentClaudeCodeProcess,
} from './persistent-process.js';
import { resolveClaudeCodeBin } from './bin.js';
import { withClaudeCodeBackgroundSuppressionEnv } from './launch-safety.js';

export interface ClaudeCodeManagedProcess extends ManagedBackendProcess {
  sendTurn(prompt: string, options: PersistentClaudeCodeTurnOptions): Promise<TurnResult>;
}

export interface ClaudeCodeWorkerBridgeStartRequest extends ProcessStartRequest {
  readonly cwd: string;
  readonly provider: PtyProvider;
  readonly timeoutMs: number;
}

export type ClaudeCodeWorkerBridgeStarter = (request: ClaudeCodeWorkerBridgeStartRequest) => Promise<ClaudeCodeManagedProcess>;

export class ClaudeCodeWorkerBridge implements BackendWorkerBridge {
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
    const preparedInput = prepareWorkerTurnInput(request);
    if (!preparedInput.isFirstTurn && !request.sessionId) {
      throw new OpenPError('Claude Code resume requires a session id', EXIT_CODES.usage);
    }
    const backendSessionId = preparedInput.isFirstTurn ? randomUUID() : request.sessionId!;
    const launchSignature = buildLaunchSignature({
      backendId: 'claude',
      bin: request.bin ?? resolveClaudeCodeBin(),
      binArgs: request.binArgs ?? [],
      model: request.model ?? null,
      reasoningEffort: request.reasoningEffort ?? null,
      executionMode: request.executionMode ?? null,
      tools: request.tools ?? null,
      jsonSchema: request.jsonSchema ?? null,
      env: withClaudeCodeBackgroundSuppressionEnv(request.env ?? {}),
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
          timeoutMs: request.timeoutMs ?? 0,
        }),
      );
      let intermediateTextCount = 0;
      try {
        const result = await process.sendTurn(preparedInput.prompt, {
          timeoutMs: request.timeoutMs ?? 0,
          debugLog: request.debugLog ?? null,
          signal: request.signal,
          forceSignal: request.forceSignal,
          killSignal: request.killSignal,
          jsonSchema: request.jsonSchema ?? null,
          paceIntermediateEvents: request.paceIntermediateEvents === true,
          onIntermediateText: request.onIntermediateText
            ? (text, source) => {
                intermediateTextCount += 1;
                request.onIntermediateText!(text, source);
              }
            : undefined,
          onIntermediateReasoning: request.onIntermediateReasoning
            ? (text, source, contentBlocks) => {
                request.onIntermediateReasoning!(text, source, contentBlocks);
              }
            : undefined,
          onIntermediateAssistantSnapshot: request.onIntermediateAssistantSnapshot,
          onBackgroundAssistantText: undefined,
        });
        const resultSessionId = result.sessionId ?? (preparedInput.isFirstTurn ? null : backendSessionId);
        if (!resultSessionId) {
          throw new OpenPError('Claude Code did not return a backend session id', EXIT_CODES.protocolViolation);
        }
        if (!preparedInput.isFirstTurn && result.sessionId && result.sessionId !== backendSessionId) {
          throw new OpenPError('Claude Code returned a different session id for resume turn', EXIT_CODES.protocolViolation);
        }
        this.manager.rekey(backendSessionId, resultSessionId, process);
        return toWorkerTurnResult(result, resultSessionId, {
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
