export interface TurnRequest {
  readonly turnId: string;
  readonly prompt: string;
  readonly jsonSchema?: unknown;
}

export interface BackendUsage {
  readonly inputTokens: number | null;
  readonly cacheReadInputTokens: number | null;
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
  readonly contextWindow?: number | null;
  readonly lastSubturnUsage?: BackendUsage | null;
  readonly lastSubturnContextTokens?: number | null;
  readonly rawEventCount: number;
}

export interface AssistantEventSnapshot {
  readonly message: Record<string, unknown>;
  readonly requestId?: string | null;
  readonly semanticKind?: 'commentary' | 'progress' | 'background';
}

export type AssistantContentBlock = Record<string, unknown>;

export interface TurnResult {
  readonly turnId: string;
  readonly text: string;
  readonly reasoningContent?: string | null;
  readonly structuredOutput?: unknown;
  readonly requestId?: string | null;
  readonly sessionId?: string | null;
  readonly assistantEvents?: readonly AssistantEventSnapshot[];
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
  readonly tools?: string | null;
  readonly jsonSchema: string | null;
  readonly backendArgs: readonly string[];
  readonly debugLog: string | null;
  readonly paceIntermediateEvents?: boolean;
  readonly signal?: AbortSignal;
  readonly forceSignal?: AbortSignal;
  readonly killSignal?: AbortSignal;
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
}
