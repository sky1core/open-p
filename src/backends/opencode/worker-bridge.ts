import type { BackendWorkerBridge } from '../../core/backend.js';
import { EXIT_CODES, OpenPError } from '../../core/errors.js';
import { isSafeSessionId } from '../../core/session-id.js';
import type { WorkerTurnRequest, WorkerTurnResult } from '../../core/worker-types.js';
import { readRequiredFirstTurnFlag } from '../../core/worker-input.js';
import { runOpenCodeTurn } from './runner.js';

export class OpenCodeWorkerBridge implements BackendWorkerBridge {
  async runTurn(request: WorkerTurnRequest): Promise<WorkerTurnResult> {
    const isFirstTurn = readRequiredFirstTurnFlag(request);
    if (!isFirstTurn && !request.sessionId) {
      throw new OpenPError('OpenCode resume requires a session id', EXIT_CODES.usage);
    }
    if (!isFirstTurn && request.sessionId && !isSafeSessionId(request.sessionId)) {
      throw new OpenPError('invalid OpenCode resume session id', EXIT_CODES.usage);
    }
    return runOpenCodeTurn({
      message: request.message,
      sessionId: isFirstTurn ? null : request.sessionId,
      isFirstTurn,
      projectRoot: request.projectRoot,
      model: request.model ?? null,
      reasoningEffort: request.reasoningEffort ?? null,
      executionMode: request.executionMode ?? null,
      nativeExecutionMode: request.nativeExecutionMode ?? null,
      tools: request.tools ?? null,
      jsonSchema: request.jsonSchema ?? null,
      backendArgs: request.binArgs ?? [],
      timeoutMs: request.timeoutMs ?? 0,
      bin: request.bin,
      env: request.env ? { ...process.env, ...request.env } : process.env,
      signal: request.signal,
      forceSignal: request.forceSignal,
      killSignal: request.killSignal,
    });
  }

  async isChildAliveForSession(_sessionId: string): Promise<boolean> {
    return false;
  }

  async shutdown(): Promise<void> {
    // no persistent process
  }
}
