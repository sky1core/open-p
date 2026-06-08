import type { AssistantContentBlock, AssistantEventSnapshot, BackendUsage, IntermediateTextSource } from './types.js';

export interface WorkerTurnRequest {
  readonly sessionId: string | null;
  readonly isFirstTurn: boolean;
  readonly projectRoot: string;
  readonly message: string;
  readonly transcript?: unknown;
  readonly seedContext?: string | null;
  readonly model?: string | null;
  readonly reasoningEffort?: string | null;
  readonly executionMode?: string | null;
  readonly tools?: string | null;
  readonly jsonSchema?: string | null;
  readonly bin?: string | null;
  readonly binArgs?: readonly string[];
  readonly local?: boolean;
  readonly timeoutMs?: number;
  readonly debugLog?: string | null;
  readonly paceIntermediateEvents?: boolean;
  readonly env?: Readonly<Record<string, string>>;
  readonly contextWindowsByModel?: Readonly<Record<string, number>>;
  readonly contextWindow?: number | null;
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
  readonly onBackgroundAssistantText?: (text: string) => void;
}

export interface WorkerTurnDiagnostics {
  readonly numTurns: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadInputTokens: number | null;
  readonly rawUsage?: Record<string, unknown> | null;
  readonly model?: string | null;
  readonly contextWindow: number | null;
  readonly lastSubturnUsage?: BackendUsage | null;
  readonly lastSubturnContextTokens: number | null;
  readonly durationMs: number | null;
  readonly totalCostUsd: number | null;
  readonly stopReason: string | null;
  readonly toolsUsed: readonly string[];
  readonly autoCompacted: boolean | null;
  readonly intermediateTextCount: number | null;
}

export interface WorkerTurnResult {
  readonly content: string;
  readonly reasoningContent: string | null;
  readonly structuredOutput?: unknown;
  readonly requestId?: string | null;
  readonly assistantEvents?: readonly import('./types.js').AssistantEventSnapshot[];
  readonly sessionId: string;
  readonly diagnostics: WorkerTurnDiagnostics;
}

export interface BackendCapabilities {
  readonly streaming: boolean;
  readonly streamingGranularity: 'none' | 'subturn' | 'token';
  readonly backgroundAssistant: boolean;
  readonly reasoningContent: boolean;
  readonly abort: boolean;
  readonly persistentProcess: boolean;
}

export interface BackendDescriptor {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly commandDisplay: string;
  readonly pendingReplyMessage: string;
  readonly assistantLabel: string;
  readonly sessionIdLabel: string;
  readonly defaultModel: string | null;
  readonly models: readonly string[];
  readonly modelSource: string;
  readonly executionModes: readonly string[];
  readonly defaultReasoningEffort: string | null;
  readonly defaultReasoningEffortsByModel: Readonly<Record<string, string>>;
  readonly reasoningEfforts: readonly string[];
  readonly reasoningEffortsByModel: Readonly<Record<string, readonly string[]>>;
  readonly contextWindowsByModel: Readonly<Record<string, number>>;
  readonly contextWindow: number | null;
  readonly capabilities: BackendCapabilities;
}

export interface LaunchSignature {
  readonly backendId: string;
  readonly bin: string;
  readonly binArgs: readonly string[];
  readonly model: string | null;
  readonly reasoningEffort: string | null;
  readonly executionMode: string | null;
  readonly tools: string | null;
  readonly jsonSchema: string | null;
  readonly env: Readonly<Record<string, string>>;
  readonly local: boolean;
}
