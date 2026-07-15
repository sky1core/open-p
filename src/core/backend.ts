import type { BackendDescriptor, WorkerTurnRequest, WorkerTurnResult } from './worker-types.js';
import type { TurnRequest, TurnResult, BackendRunOptions } from './types.js';
import type { PtyProvider } from '../runners/types.js';
import type { SeedStorageIdentity } from './seed-storage-identity.js';

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
  // Operation receipts use this backend-owned, transcript-free identity to bind replay to the
  // same effective native storage locator without exposing backend paths to core.
  resolveSeedStorageIdentity?(input: { readonly cwd: string }): Promise<SeedStorageIdentity>;
  // Optional native history capabilities. Providers own backend-specific artifact lookup and
  // schema interpretation so the core seed orchestrator stays backend-neutral.
  readNativeSession?(input: ReadNativeSessionInput): Promise<NativeSessionReadResult>;
  appendSessionHistory?(input: AppendSessionHistoryInput): Promise<AppendSessionHistoryResult>;
  cleanupPreparedSessionHistoryAppend?(input: CleanupPreparedSessionHistoryAppendInput): Promise<void>;
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
  // Opaque SHA-256 over all backend-native state relevant to the Reader, including native records
  // that do not form a completed logical turn. Seed orchestration requires it; optional typing keeps
  // pure logical-IR helpers usable with caller-constructed reads that never cross a persistence
  // boundary.
  readonly nativeStateDigest?: string;
}

export interface ReadNativeSessionInput {
  readonly sessionId: string;
  readonly cwd: string;
  // Settlement reads must re-establish durability through the backend-owned native surface before
  // returning. File-backed Readers fsync and prove a stable snapshot; official-CLI-only Readers
  // perform their supported stable verification read.
  readonly mode?: 'logical' | 'settlement';
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

export interface PreparedSessionHistoryAppend {
  readonly before: readonly NativeSessionTurn[];
  readonly beforeNativeStateDigest: string;
  readonly candidateNativeStateDigest: string;
  readonly turns: readonly NativeWrittenTurn[];
  // Opaque backend-owned locator. It must be transcript-free and safe to persist in the pending
  // append journal. Core passes it back only to the target backend's cleanup capability.
  readonly cleanupToken?: string;
}

export interface CleanupPreparedSessionHistoryAppendInput {
  readonly sessionId: string;
  readonly cwd: string;
  readonly token: string;
  readonly signal?: AbortSignal;
}

export interface AppendSessionHistoryInput {
  readonly sessionId: string;
  readonly cwd: string;
  readonly turns: readonly SeedWriteTurn[];
  // The writer calls this exactly once after its own Reader has proved the exact candidate and
  // before any transcript-bearing native mutation or import-file creation. Core persists the
  // transcript-free settlement journal here; rejecting the promise must leave native state intact.
  readonly persistPreparedAppend: (prepared: PreparedSessionHistoryAppend) => Promise<void>;
  // Writers must re-check this immediately before the log write so an interrupt received while
  // reading/building never lands a post-abort append.
  readonly signal?: AbortSignal;
}

export interface AppendSessionHistoryResult {
  readonly sessionId: string;
  readonly turns: readonly NativeWrittenTurn[];
  // A writer that commits through an external import removes its transient artifact immediately.
  // If that cleanup fails after the native commit, core must persist provenance before surfacing
  // this bounded diagnostic. Transcript text must never be included here.
  readonly postWriteCleanupFailure?: {
    readonly message: string;
    readonly details?: Readonly<Record<string, unknown>>;
  };
}
