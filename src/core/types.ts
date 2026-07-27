export interface TurnRequest {
  readonly turnId: string;
  readonly prompt: string;
  readonly jsonSchema?: unknown;
}

export interface BackendUsage {
  readonly inputTokens: number | null;
  readonly cacheReadInputTokens: number | null;
  readonly cacheCreationInputTokens?: number | null;
  readonly outputTokens: number | null;
}

export type IntermediateTextSource = 'jsonl' | 'screen';

export interface TurnDiagnostics {
  readonly durationMs: number | null;
  readonly stopReason?: string | null;
  readonly toolsUsed: readonly string[];
  readonly usage: BackendUsage;
  readonly rawUsage?: Record<string, unknown> | null;
  readonly model?: string | null;
  // The reasoning effort the backend reports for the turn it just ran, which is not necessarily the
  // one the caller asked for: a backend may substitute its own without saying so. Present only when
  // the backend states it, so a caller can compare it against the requested value.
  readonly effort?: string | null;
  // The permission mode the backend reports for the turn it just ran. A policy or a managed
  // requirements file can put a turn somewhere other than what was asked for without failing it.
  readonly permissionMode?: string | null;
  readonly contextWindow?: number | null;
  readonly lastSubturnUsage?: BackendUsage | null;
  readonly lastSubturnContextTokens?: number | null;
  readonly rawEventCount: number;
}

export interface AssistantSnapshotMessage {
  readonly id: string;
  readonly type: 'message';
  readonly role: 'assistant';
  readonly content: readonly AssistantContentBlock[];
  readonly [key: string]: unknown;
}

export interface AssistantEventSnapshot {
  readonly message: AssistantSnapshotMessage;
  readonly requestId?: string | null;
  readonly semanticKind?: 'commentary' | 'progress' | 'background';
}

export interface AssistantContentBlock {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface BackendRunActivity {
  readonly kind: 'backend_wait';
  readonly backend: string;
  readonly backendSessionId: string;
  readonly nativeSessionId?: string | null;
  readonly ptySessionId?: string;
  readonly turnId: string;
  readonly stage: string;
  readonly idleMs: number;
  readonly observedAt: string;
  readonly observedLogFile?: boolean;
  readonly sawCallerUserTurn?: boolean;
}

export interface TurnResultWarning {
  readonly severity: 'warning' | 'error';
  readonly code: string;
  readonly message: string;
}

export interface TurnResult {
  readonly turnId: string;
  readonly text: string;
  readonly reasoningContent?: string | null;
  readonly structuredOutput?: unknown;
  readonly requestId?: string | null;
  readonly sessionId?: string | null;
  readonly assistantEvents?: readonly AssistantEventSnapshot[];
  readonly warnings?: readonly TurnResultWarning[];
  // Set only when a provider error (e.g. rate limit) interrupted the turn after the backend had already
  // completed some content (answer text and/or tool_use/tool_result with real side effects) and emitted
  // its completion marker. The preserved content in this result MUST still be emitted as a normal result
  // record, but the process MUST then exit with this non-zero code instead of success. Absent (undefined)
  // on every normal successful turn, so the success path is unchanged.
  readonly interruptedExitCode?: number;
  readonly diagnostics: TurnDiagnostics;
}

export interface BackendRunOptions {
  readonly cwd: string;
  readonly backendSessionId: string;
  readonly resume: boolean;
  readonly timeoutMs: number;
  readonly model: string | null;
  readonly reasoningEffort: string | null;
  readonly permissionMode: string | null;
  readonly nativePermissionMode: string | null;
  readonly tools?: string | null;
  readonly jsonSchema: string | null;
  readonly backendArgs: readonly string[];
  readonly debugLog: string | null;
  readonly paceIntermediateEvents?: boolean;
  readonly signal?: AbortSignal;
  readonly forceSignal?: AbortSignal;
  readonly killSignal?: AbortSignal;
  // CLI-owned recovery barrier. Backends invoke it only after acquiring the canonical session lock
  // and before launching an ordinary resumed native turn.
  // Required at runtime for every resumed direct-backend execution. It stays optional in the
  // shared type because first turns do not have pending seed state to settle; direct backends fail
  // closed before native launch when `resume` is true and this callback is absent.
  readonly settlePendingSeedAppend?: () => Promise<void>;
  readonly onIntermediateText?: (text: string, source: IntermediateTextSource) => void;
  readonly onIntermediateReasoning?: (
    text: string,
    source?: IntermediateTextSource,
    contentBlocks?: readonly AssistantContentBlock[] | null,
  ) => void;
  readonly onIntermediateAssistantSnapshot?: (
    snapshot: AssistantEventSnapshot,
    source?: IntermediateTextSource,
  ) => void;
  readonly onRunActivity?: (activity: BackendRunActivity) => void;
}
