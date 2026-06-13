import { appendDebugLog, type DebugLogEntry } from './debug-log.js';
import {
  formatStreamingMessageSnapshotEvents,
  isStreamingReasoningReplacementError,
  type OutputWarning,
  type StreamingMessageState,
} from './output.js';
import {
  StreamingResultDiagnosticTracker,
  type StreamingResultDiagnosticViolation,
} from './streaming-result-diagnostics.js';

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function appendStreamingResultDiagnostic(
  debugLogPath: string | null,
  input: {
    readonly backend: string;
    readonly turnId: string;
    readonly sessionId: string | null;
    readonly streamingSnapshotError: unknown;
    readonly violations: readonly StreamingResultDiagnosticViolation[];
  },
): Promise<readonly DebugLogEntry[]> {
  const issues: DebugLogEntry[] = [];
  if (input.streamingSnapshotError) {
    issues.push({
      event: 'streaming_snapshot_rejected',
      message: 'streaming snapshot replacement is not prefix-compatible with the current stream message',
      errorMessage: errorMessage(input.streamingSnapshotError),
    });
  }
  issues.push(...input.violations.map((violation) => ({
    event: 'streaming_result_mismatch',
    ...violation,
  })));
  if (issues.length === 0) {
    return issues;
  }
  // Streaming diagnostics are non-fatal; a write failure must not discard the confirmed result.
  await appendDebugLog(debugLogPath, {
    event: 'streaming_result_diagnostic',
    severity: 'warning',
    backend: input.backend,
    turnId: input.turnId,
    sessionId: input.sessionId,
    issueCount: issues.length,
    issues,
  }).catch(() => undefined);
  return issues;
}

export function streamingIssuesToWarnings(
  issues: readonly DebugLogEntry[],
  debugLogPath: string | null,
): readonly OutputWarning[] {
  if (issues.length === 0) {
    return [];
  }
  const message = debugLogPath
    ? `Streaming result diagnostics were recorded (${issues.length}); result was preserved. See debug log: ${debugLogPath}.`
    : `Streaming result diagnostics were detected (${issues.length}); result was preserved. Use --debug-log to record details.`;
  return [{
    severity: 'warning',
    code: 'streaming_result_diagnostic',
    message,
  }];
}

export function isStreamingAssistantTextEvent(event: Record<string, unknown>): boolean {
  const openp = event.openp;
  if (!openp || typeof openp !== 'object' || Array.isArray(openp)) return false;
  const payload = openp as Record<string, unknown>;
  const output = payload.output && typeof payload.output === 'object' && !Array.isArray(payload.output)
    ? payload.output as Record<string, unknown>
    : {};
  return payload.form === 'streaming' &&
    (typeof output.answer === 'string' || typeof output.reasoning === 'string');
}

export interface StreamingSnapshotWriter {
  /**
   * Emit the cumulative streaming snapshot for the given answer/reasoning text.
   * The session id is the one bound when the writer was created (the turn's
   * initial public session id), matching the prior closure behavior on both
   * the direct CLI and worker paths.
   */
  writeStreamingSnapshot(text: string, reasoningText?: string | null): boolean;
  writeCumulativeStreamingAnswerSnapshot(text: string): boolean;
  writeCumulativeStreamingReasoningSnapshot(text: string): boolean;
  /** The first snapshot error that suppressed reasoning or failed snapshots, if any. */
  readonly snapshotError: unknown;
}

export interface StreamingSnapshotWriterConfig {
  readonly streamingState: StreamingMessageState;
  readonly resultTracker: StreamingResultDiagnosticTracker;
  readonly write: (chunk: string) => void;
  readonly turnId: string;
  readonly sessionId: string | null;
  readonly model: string | null;
  /**
   * When false, snapshot writes are short-circuited to `false` without emitting.
   * The direct CLI path only constructs the writer inside a streaming context,
   * so it passes `true`; the worker path mirrors its prior `input.options.streaming`
   * guard.
   */
  readonly streamingEnabled: boolean;
}

export function createStreamingSnapshotWriter(
  config: StreamingSnapshotWriterConfig,
): StreamingSnapshotWriter {
  let snapshotFailed = false;
  let reasoningSnapshotSuppressed = false;
  let snapshotError: unknown = null;

  const writeStreamingSnapshot = (text: string, reasoningText: string | null = null): boolean => {
    if (!config.streamingEnabled || snapshotFailed) {
      return false;
    }
    const reasoningForSnapshot = reasoningSnapshotSuppressed ? null : reasoningText;
    try {
      const previousText = config.streamingState.previousText;
      const previousReasoningText = config.streamingState.previousReasoningText;
      const streamingOutput = formatStreamingMessageSnapshotEvents(config.streamingState, {
        turnId: config.turnId,
        sessionId: config.sessionId,
        model: config.model,
        text,
        reasoningText: reasoningForSnapshot,
      });
      config.write(streamingOutput);
      if (text && text !== previousText) {
        config.resultTracker.recordAnswerText(text);
      }
      if (reasoningForSnapshot && reasoningForSnapshot !== previousReasoningText) {
        config.resultTracker.recordReasoningText(reasoningForSnapshot);
      }
      return true;
    } catch (error) {
      if (reasoningForSnapshot && isStreamingReasoningReplacementError(error)) {
        reasoningSnapshotSuppressed = true;
        snapshotError ??= error;
        try {
          const previousText = config.streamingState.previousText;
          const streamingOutput = formatStreamingMessageSnapshotEvents(config.streamingState, {
            turnId: config.turnId,
            sessionId: config.sessionId,
            model: config.model,
            text,
            reasoningText: null,
          });
          config.write(streamingOutput);
          if (text && text !== previousText) {
            config.resultTracker.recordAnswerText(text);
          }
          return true;
        } catch (retryError) {
          snapshotFailed = true;
          snapshotError = retryError;
          return false;
        }
      }
      snapshotFailed = true;
      snapshotError = error;
      return false;
    }
  };

  const writeCumulativeStreamingAnswerSnapshot = (text: string): boolean => {
    return writeStreamingSnapshot(
      text,
      config.streamingState.previousReasoningText || null,
    );
  };

  const writeCumulativeStreamingReasoningSnapshot = (text: string): boolean => {
    return writeStreamingSnapshot(
      config.streamingState.previousText,
      text,
    );
  };

  return {
    writeStreamingSnapshot,
    writeCumulativeStreamingAnswerSnapshot,
    writeCumulativeStreamingReasoningSnapshot,
    get snapshotError() {
      return snapshotError;
    },
  };
}
