import { randomUUID } from 'node:crypto';
import { createAbortError } from './abort.js';
import { resolveInitialTurnSessionId } from './backend-session-policy.js';
import { appendDebugLog, type DebugLogEntry } from './debug-log.js';
import { EXIT_CODES, OpenPError } from './errors.js';
import { parseStreamJsonUserEventLine, type ResolvedCliOptions } from './cli-args.js';
import { SessionLockStore, type SessionLock } from './session-lock.js';
import { SessionStateStore, validateSessionStateCompatibility, type SessionState } from './session-state.js';
import {
  buildIntermediateAssistantSnapshotEvents,
  createStreamingMessageState,
  formatBackgroundAssistantTextEvent,
  formatStreamingMessageSnapshotEvents,
  formatWorkerTurnResult,
  isStreamingReasoningReplacementError,
  resetStreamingMessageState,
  type OutputWarning,
  resolveStructuredOutputToolUseId,
} from './output.js';
import {
  StreamingResultDiagnosticTracker,
  type StreamingResultDiagnosticViolation,
} from './streaming-result-diagnostics.js';
import type { AssistantEventSnapshot } from './types.js';
import type { WorkerTurnRequest, WorkerTurnResult } from './worker-types.js';

export interface StreamJsonWorkerBridge {
  runTurn(request: WorkerTurnRequest): Promise<WorkerTurnResult>;
  shutdown?(): Promise<void>;
}

export interface StreamJsonWorkerOutputMetadata {
  readonly backend: string;
  readonly cwd: string;
  readonly model: string | null;
  readonly permissionMode: string | null;
  readonly mcpServers?: readonly unknown[];
  readonly contextWindow: number | null;
}

export async function runStreamJsonWorkerLines(input: {
  readonly options: ResolvedCliOptions;
  readonly lines: AsyncIterable<string>;
  readonly bridge: StreamJsonWorkerBridge;
  readonly projectRoot: string;
  readonly outputMetadata: StreamJsonWorkerOutputMetadata;
  readonly signal?: AbortSignal;
  readonly forceSignal?: AbortSignal;
  readonly killSignal?: AbortSignal;
  readonly stateStore?: SessionStateStore;
  readonly lockStore?: SessionLockStore;
  readonly resolveSessionLogPath?: (sessionId: string, projectRoot: string) => Promise<string | null>;
  readonly write: (chunk: string) => void;
}): Promise<number> {
  if (input.options.promptArg !== null) {
    throw new OpenPError('--input-format stream-json does not accept prompt arguments', EXIT_CODES.usage);
  }

  return runStreamJsonWorkerLinesWithLock(input);
}

async function runStreamJsonWorkerLinesWithLock(input: {
  readonly options: ResolvedCliOptions;
  readonly lines: AsyncIterable<string>;
  readonly bridge: StreamJsonWorkerBridge;
  readonly projectRoot: string;
  readonly outputMetadata: StreamJsonWorkerOutputMetadata;
  readonly signal?: AbortSignal;
  readonly forceSignal?: AbortSignal;
  readonly killSignal?: AbortSignal;
  readonly stateStore?: SessionStateStore;
  readonly lockStore?: SessionLockStore;
  readonly resolveSessionLogPath?: (sessionId: string, projectRoot: string) => Promise<string | null>;
  readonly write: (chunk: string) => void;
}): Promise<number> {
  const stateStore = input.stateStore ?? new SessionStateStore(input.projectRoot);
  const lockStore = input.lockStore ?? new SessionLockStore(input.projectRoot);
  const expectedState = {
    backend: input.options.backend,
    backendSessionId: input.options.backendSessionId,
    cwd: input.projectRoot,
  };
  let existingState: SessionState | null = null;
  let lock: SessionLock | null = null;

  let lineNumber = 0;
  let sawUserEvent = false;
  let initializedSession = false;
  let turnIndex = 0;
  const initialSessionId = resolveInitialTurnSessionId({
    resume: input.options.resume,
    backendSessionId: input.options.backendSessionId,
  });
  let resolvedBackendSessionId = initialSessionId;
  let publicSessionId: string | null = initialSessionId;
  let primaryError: unknown = null;
  let cleanupError: unknown = null;

  try {
    for await (const line of input.lines) {
      lineNumber += 1;
      const validated = parseStreamJsonUserEventLine(line, lineNumber);
      if (!validated) {
        continue;
      }
      sawUserEvent = true;

      if (!initializedSession) {
        lock = await lockStore.acquire(input.options.backendSessionId);
        existingState = input.options.resume
          ? await stateStore.requireCompatible(expectedState)
          : await stateStore.load(input.options.backendSessionId);
        if (existingState) {
          validateSessionStateCompatibility(existingState, expectedState);
        }
        initializedSession = true;
      }

      const streamingState = createStreamingMessageState();
      const streamingResultTracker = new StreamingResultDiagnosticTracker();
      const emittedAssistantSnapshots: AssistantEventSnapshot[] = [];
      const emittedAssistantEvents: Record<string, unknown>[] = [];
      let streamingSnapshotFailed = false;
      let streamingReasoningSnapshotSuppressed = false;
      let streamingSnapshotError: unknown = null;
      const publicTurnId = validated.turnId ?? randomUUID();
      const writeStreamingSnapshot = (text: string, reasoningText: string | null = null): boolean => {
        if (!input.options.streaming || streamingSnapshotFailed) {
          return false;
        }
        const reasoningForSnapshot = streamingReasoningSnapshotSuppressed ? null : reasoningText;
        try {
          const previousText = streamingState.previousText;
          const previousReasoningText = streamingState.previousReasoningText;
          const streamingOutput = formatStreamingMessageSnapshotEvents(streamingState, {
            turnId: publicTurnId,
            sessionId: publicSessionId,
            model: input.options.model,
            text,
            reasoningText: reasoningForSnapshot,
          });
          input.write(streamingOutput);
          if (text && text !== previousText) {
            streamingResultTracker.recordAnswerText(text);
          }
          if (reasoningForSnapshot && reasoningForSnapshot !== previousReasoningText) {
            streamingResultTracker.recordReasoningText(reasoningForSnapshot);
          }
          return true;
        } catch (error) {
          if (reasoningForSnapshot && isStreamingReasoningReplacementError(error)) {
            streamingReasoningSnapshotSuppressed = true;
            streamingSnapshotError ??= error;
            try {
              const previousText = streamingState.previousText;
              const streamingOutput = formatStreamingMessageSnapshotEvents(streamingState, {
                turnId: publicTurnId,
                sessionId: publicSessionId,
                model: input.options.model,
                text,
                reasoningText: null,
              });
              input.write(streamingOutput);
              if (text && text !== previousText) {
                streamingResultTracker.recordAnswerText(text);
              }
              return true;
            } catch (retryError) {
              streamingSnapshotFailed = true;
              streamingSnapshotError = retryError;
              return false;
            }
          }
          streamingSnapshotFailed = true;
          streamingSnapshotError = error;
          return false;
        }
      };
      const writeCumulativeStreamingAnswerSnapshot = (text: string): boolean => {
        return writeStreamingSnapshot(
          text,
          streamingState.previousReasoningText || null,
        );
      };
      const writeCumulativeStreamingReasoningSnapshot = (text: string): boolean => {
        return writeStreamingSnapshot(
          streamingState.previousText,
          text,
        );
      };

      const result = await input.bridge.runTurn({
        sessionId: resolvedBackendSessionId,
        isFirstTurn: turnIndex === 0 && !input.options.resume,
        projectRoot: input.projectRoot,
        message: validated.text,
        model: input.options.model,
        reasoningEffort: input.options.reasoningEffort,
        executionMode: input.options.permissionMode,
        tools: input.options.tools,
        jsonSchema: input.options.jsonSchema,
        timeoutMs: input.options.timeoutMs,
        paceIntermediateEvents: input.options.streaming,
        contextWindow: input.outputMetadata.contextWindow,
        signal: input.signal,
        forceSignal: input.forceSignal,
        killSignal: input.killSignal,
        binArgs: input.options.backendArgs,
        onIntermediateText: input.options.streaming
          ? (text, source) => {
              if (source === 'jsonl') {
                writeCumulativeStreamingAnswerSnapshot(text);
              }
            }
          : undefined,
        onIntermediateReasoning: input.options.streaming
          ? (text) => {
              writeCumulativeStreamingReasoningSnapshot(text);
            }
          : undefined,
        onIntermediateAssistantSnapshot: input.options.streaming
          ? (snapshot, source) => {
              if (source !== 'jsonl') {
                return;
              }
              const assistantEvents = buildIntermediateAssistantSnapshotEvents({
                snapshot,
                sessionId: publicSessionId,
                turnId: publicTurnId,
              }).filter((event) => snapshot.semanticKind === 'background' || !isStreamingAssistantTextEvent(event));
              emittedAssistantSnapshots.push(snapshot);
              emittedAssistantEvents.push(...assistantEvents);
              for (const assistantEvent of assistantEvents) {
                input.write(`${JSON.stringify(assistantEvent)}\n`);
              }
            }
          : undefined,
        onBackgroundAssistantText: (text) => {
          input.write(formatBackgroundAssistantTextEvent({
            turnId: publicTurnId,
            sessionId: publicSessionId,
            text,
          }));
        },
      });

      if (resolvedBackendSessionId !== null && result.sessionId !== resolvedBackendSessionId) {
        throw new OpenPError('backend returned a different session id for a resumed turn', EXIT_CODES.protocolViolation);
      }
      resolvedBackendSessionId = result.sessionId;
      if (turnIndex === 0 && !input.options.resume && result.sessionId !== input.options.backendSessionId && lock) {
        const resultLock = await lockStore.acquire(result.sessionId);
        await releaseSessionLock(lock, null);
        lock = resultLock;
      }
      publicSessionId = result.sessionId;
      let verboseWarnings: readonly OutputWarning[] = [];
      if (input.options.streaming) {
        const streamingIssues = await appendStreamingResultDiagnostic(input.options.debugLog, {
          backend: input.options.backend,
          turnId: publicTurnId,
          sessionId: publicSessionId,
          streamingSnapshotError,
          violations: streamingResultTracker.findViolations(result.content, result.reasoningContent),
        });
        verboseWarnings = input.options.verbose
          ? streamingIssuesToWarnings(streamingIssues, input.options.debugLog)
          : [];
      }
      let successOutput = '';
      if (input.options.streaming) {
        const structuredOutputToolUseId = resolveStructuredOutputToolUseId({
          structuredOutput: result.structuredOutput,
          assistantEvents: result.assistantEvents,
        });
        resetStreamingMessageState(streamingState);
        successOutput += formatWorkerTurnResult(result, {
          turnId: publicTurnId,
          backend: input.options.backend,
          model: input.options.model,
          structuredOutputToolUseId,
          suppressAssistantSnapshots: emittedAssistantSnapshots,
          previouslyEmittedAssistantEvents: emittedAssistantEvents,
          warnings: verboseWarnings,
        });
      } else {
        successOutput = formatWorkerTurnResult(result, {
          turnId: publicTurnId,
          backend: input.options.backend,
          model: input.options.model,
          warnings: verboseWarnings,
        });
      }
      await saveStreamWorkerSessionState(input, stateStore, existingState, publicTurnId, result.sessionId);
      input.write(successOutput);
      turnIndex += 1;
    }
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await shutdownBridge(input.bridge, primaryError);
    } catch (error) {
      cleanupError = error;
    }
    if (lock) {
      await releaseSessionLock(lock, primaryError ?? cleanupError);
    }
    if (primaryError === null && cleanupError) {
      throw cleanupError;
    }
  }

  if (input.signal?.aborted) {
    throw createAbortError();
  }
  if (!sawUserEvent) {
    throw new OpenPError('--input-format stream-json requires at least one user event', EXIT_CODES.usage);
  }
  return EXIT_CODES.success;
}

async function appendStreamingResultDiagnostic(
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
  await appendDebugLog(debugLogPath, {
    event: 'streaming_result_diagnostic',
    severity: 'warning',
    backend: input.backend,
    turnId: input.turnId,
    sessionId: input.sessionId,
    issueCount: issues.length,
    issues,
  });
  return issues;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function streamingIssuesToWarnings(
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

function isStreamingAssistantTextEvent(event: Record<string, unknown>): boolean {
  const openp = event.openp;
  if (!openp || typeof openp !== 'object' || Array.isArray(openp)) return false;
  const payload = openp as Record<string, unknown>;
  const output = payload.output && typeof payload.output === 'object' && !Array.isArray(payload.output)
    ? payload.output as Record<string, unknown>
    : {};
  return payload.form === 'streaming' &&
    (typeof output.answer === 'string' || typeof output.reasoning === 'string');
}

async function saveStreamWorkerSessionState(
  input: {
    readonly options: ResolvedCliOptions;
    readonly projectRoot: string;
    readonly resolveSessionLogPath?: (sessionId: string, projectRoot: string) => Promise<string | null>;
  },
  stateStore: SessionStateStore,
  existingState: SessionState | null,
  lastTurnId: string | null,
  resultSessionId: string,
): Promise<void> {
  await stateStore.save({
    backend: input.options.backend,
    backendSessionId: resultSessionId,
    cwd: input.projectRoot,
    lastProviderSessionId: null,
    sessionLogPath: input.resolveSessionLogPath
      ? await input.resolveSessionLogPath(resultSessionId, input.projectRoot)
      : existingState?.sessionLogPath ?? null,
    lastTurnId,
  });
}

async function releaseSessionLock(lock: SessionLock, primaryError: unknown): Promise<void> {
  try {
    await lock.release();
  } catch (releaseError) {
    if (primaryError === null) {
      throw releaseError;
    }
  }
}

async function shutdownBridge(bridge: StreamJsonWorkerBridge, primaryError: unknown): Promise<void> {
  try {
    await bridge.shutdown?.();
  } catch (shutdownError) {
    if (primaryError === null) {
      throw shutdownError;
    }
  }
}
