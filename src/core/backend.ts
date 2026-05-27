import type { BackendDescriptor, WorkerTurnRequest, WorkerTurnResult } from './worker-types.js';
import type { TurnRequest, TurnResult, BackendRunOptions } from './types.js';
import type { PtyProvider } from '../runners/types.js';

export interface Backend {
  runTurn(request: TurnRequest, options: BackendRunOptions): Promise<TurnResult>;
}

export interface BackendWorkerBridge {
  runTurn(request: WorkerTurnRequest): Promise<WorkerTurnResult>;
  isChildAliveForSession(sessionId: string): Promise<boolean>;
  shutdown(): Promise<void>;
}

export interface BackendProvider {
  readonly id: string;
  readonly descriptor: BackendDescriptor;
  createBackend(provider: PtyProvider): Backend;
  createWorkerBridge(): BackendWorkerBridge;
  resolveSessionLogPath(sessionId: string, cwd: string): Promise<string | null>;
}
