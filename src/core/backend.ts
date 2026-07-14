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
  probeLogin?(): Promise<BackendLoginStatus>;
  createBackend(provider: PtyProvider): Backend;
  createWorkerBridge(): BackendWorkerBridge;
  resolveSessionLogPath(sessionId: string, cwd: string): Promise<string | null>;
  // Optional seeding capability. Absence means the backend does not support `openp seed`
  // (opencode). The provider owns instance-config resolution (configDir/homeDir) so the
  // core seed orchestrator stays backend-neutral and holds no session-log schema knowledge.
  appendSessionHistory?(input: AppendSessionHistoryInput): Promise<void>;
}

export interface BackendLoginStatus {
  readonly backend: string;
  readonly loggedIn: boolean;
}

// A single prior conversation turn to record into a native backend session. open-p does not own
// the conversation ledger; the caller supplies these text turns and open-p appends them.
export interface SessionHistoryTurn {
  readonly role: 'user' | 'assistant';
  readonly text: string;
}

export interface AppendSessionHistoryInput {
  readonly sessionId: string;
  readonly cwd: string;
  readonly turns: readonly SessionHistoryTurn[];
  // Writers must re-check this immediately before the log write so an interrupt received while
  // reading/building never lands a post-abort append.
  readonly signal?: AbortSignal;
}
