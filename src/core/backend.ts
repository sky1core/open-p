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
  // Optional native history capabilities. Providers own backend-specific artifact lookup and
  // schema interpretation so the core seed orchestrator stays backend-neutral.
  readNativeSession?(input: ReadNativeSessionInput): Promise<NativeSessionReadResult>;
  appendSessionHistory?(input: AppendSessionHistoryInput): Promise<AppendSessionHistoryResult>;
}

export interface BackendLoginStatus {
  readonly backend: string;
  readonly loggedIn: boolean;
}

export interface NativeTurnIds {
  readonly userId: string;
  readonly assistantIds: readonly string[];
  readonly completionId: string;
}

export interface NativeSessionTurn {
  readonly userText: string;
  readonly assistantText: string;
  readonly nativeIds: NativeTurnIds;
}

export interface NativeSessionReadResult {
  readonly backend: string;
  readonly sessionId: string;
  readonly turns: readonly NativeSessionTurn[];
}

export interface ReadNativeSessionInput {
  readonly sessionId: string;
  readonly cwd: string;
  readonly signal?: AbortSignal;
}

export interface SeedWriteTurn {
  readonly logicalId: string;
  readonly userText: string;
  readonly assistantText: string;
  readonly contentDigest: string;
  readonly sourceNativeIds: NativeTurnIds | null;
}

export interface NativeWrittenTurn {
  readonly logicalId: string;
  readonly contentDigest: string;
  readonly nativeIds: NativeTurnIds;
}

export interface AppendSessionHistoryInput {
  readonly sessionId: string;
  readonly cwd: string;
  readonly turns: readonly SeedWriteTurn[];
  // Writers must re-check this immediately before the log write so an interrupt received while
  // reading/building never lands a post-abort append.
  readonly signal?: AbortSignal;
}

export interface AppendSessionHistoryResult {
  readonly turns: readonly NativeWrittenTurn[];
}
