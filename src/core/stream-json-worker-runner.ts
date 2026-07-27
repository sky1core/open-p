import { randomUUID } from 'node:crypto';
import { createAbortError } from './abort.js';
import { resolveInitialTurnSessionId } from './backend-session-policy.js';
import { appendDebugLog, type DebugLogEntry } from './debug-log.js';
import { EXIT_CODES, OpenPError, toExitCode } from './errors.js';
import { parseStreamJsonUserEventLine, type ResolvedCliOptions } from './cli-args.js';
import { SessionLockStore, type SessionLock } from './session-lock.js';
import { SessionStateStore, validateSessionStateCompatibility, type SessionState } from './session-state.js';
import {
  buildIntermediateAssistantSnapshotEvents,
  createStreamingMessageState,
  formatBackgroundAssistantTextEvent,
  formatWorkerTurnResult,
  resetStreamingMessageState,
  type OutputWarning,
  resolveStructuredOutputToolUseId,
} from './output.js';
import {
  StreamingResultDiagnosticTracker,
} from './streaming-result-diagnostics.js';
import {
  appendStreamingResultDiagnostic,
  createStreamingSnapshotWriter,
  errorMessage,
  isStreamingAssistantTextEvent,
  streamingIssuesToWarnings,
} from './streaming-output-helpers.js';
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
  readonly requestedPermissionMode: string | null;
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
  readonly settlePendingSeedAppend?: () => Promise<void>;
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
  readonly settlePendingSeedAppend?: () => Promise<void>;
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
  let emittedResultRecord = false;
  let interruptedExitCode: number | null = null;

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
          ? await stateStore.requireCompatibleForPendingSeedSettlement(expectedState)
          : await stateStore.load(input.options.backendSessionId);
        if (existingState) {
          validateSessionStateCompatibility(existingState, expectedState);
        }
        if (input.options.resume) {
          if (!input.settlePendingSeedAppend) {
            throw new OpenPError(
              'resumed stream-json worker requires pending seed settlement',
              EXIT_CODES.protocolViolation,
            );
          }
          await input.settlePendingSeedAppend();
          existingState = await stateStore.requireCompatible(expectedState);
        }
        initializedSession = true;
      }

      const streamingState = createStreamingMessageState();
      const streamingResultTracker = new StreamingResultDiagnosticTracker();
      const emittedAssistantSnapshots: AssistantEventSnapshot[] = [];
      const emittedAssistantEvents: Record<string, unknown>[] = [];
      const publicTurnId = validated.turnId ?? randomUUID();
      const snapshotWriter = createStreamingSnapshotWriter({
        streamingState,
        resultTracker: streamingResultTracker,
        write: (chunk) => input.write(chunk),
        turnId: publicTurnId,
        sessionId: publicSessionId,
        model: input.options.model,
        streamingEnabled: input.options.streaming,
      });
      const {
        writeCumulativeStreamingAnswerSnapshot,
        writeCumulativeStreamingReasoningSnapshot,
      } = snapshotWriter;

      const result = await input.bridge.runTurn({
        turnId: publicTurnId,
        sessionId: resolvedBackendSessionId,
        isFirstTurn: turnIndex === 0 && !input.options.resume,
        projectRoot: input.projectRoot,
        message: validated.text,
        model: input.options.model,
        reasoningEffort: input.options.reasoningEffort,
        executionMode: input.options.permissionMode,
        nativeExecutionMode: input.options.nativePermissionMode,
        tools: input.options.tools,
        jsonSchema: input.options.jsonSchema,
        timeoutMs: input.options.timeoutMs,
        debugLog: input.options.debugLog,
        paceIntermediateEvents: input.options.streaming,
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
        const provisionalLock = lock;
        lock = resultLock;
        await releaseSessionLock(provisionalLock, null, input.options.debugLog);
      }
      publicSessionId = result.sessionId;
      let verboseWarnings: readonly OutputWarning[] = [];
      if (input.options.streaming) {
        const streamingIssues = await appendStreamingResultDiagnostic(input.options.debugLog, {
          backend: input.options.backend,
          turnId: publicTurnId,
          sessionId: publicSessionId,
          streamingSnapshotError: snapshotWriter.snapshotError,
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
          requestedEffort: input.options.reasoningEffort,
          requestedPermissionMode: input.options.nativePermissionMode,
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
          requestedEffort: input.options.reasoningEffort,
          requestedPermissionMode: input.options.nativePermissionMode,
          warnings: verboseWarnings,
        });
      }
      await saveStreamWorkerSessionState(input, stateStore, existingState, publicTurnId, result.sessionId);
      input.write(successOutput);
      emittedResultRecord = true;
      // Third emit path: the result record is emitted like a success, then the worker stops and exits
      // with the interruption's non-zero code. A provider error interrupted the session, so further
      // queued user events are not run — the caller resumes the session instead of resubmitting.
      if (result.interruptedExitCode !== undefined) {
        interruptedExitCode = result.interruptedExitCode;
        break;
      }
      turnIndex += 1;
    }
  } catch (error) {
    primaryError = error;
    await appendDebugLog(input.options.debugLog, errorDebugLogEntry(error)).catch(() => undefined);
    throw error;
  } finally {
    try {
      await shutdownBridge(input.bridge, primaryError);
    } catch (error) {
      cleanupError = error;
    }
    if (lock) {
      await releaseSessionLock(lock, primaryError ?? cleanupError, input.options.debugLog);
    }
    if (primaryError === null && cleanupError) {
      if (emittedResultRecord) {
        await appendDebugLog(input.options.debugLog, cleanupDebugLogEntry('worker_shutdown_failure', cleanupError))
          .catch(() => undefined);
        cleanupError = null;
      }
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
  if (interruptedExitCode !== null) {
    return interruptedExitCode;
  }
  return EXIT_CODES.success;
}

function errorDebugLogEntry(error: unknown): DebugLogEntry {
  const reasonCode = error instanceof OpenPError ? error.reasonCode : undefined;
  const details = error instanceof OpenPError ? error.details : undefined;
  return {
    event: 'error',
    message: errorMessage(error),
    exitCode: toExitCode(error),
    ...(reasonCode ? { reasonCode } : {}),
    ...(details ? { details } : {}),
  };
}

function cleanupDebugLogEntry(event: string, error: unknown): DebugLogEntry {
  const reasonCode = error instanceof OpenPError ? error.reasonCode : undefined;
  const details = error instanceof OpenPError ? error.details : undefined;
  return {
    event,
    severity: 'warning',
    message: errorMessage(error),
    exitCode: toExitCode(error),
    ...(reasonCode ? { reasonCode } : {}),
    ...(details ? { details } : {}),
  };
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

async function releaseSessionLock(
  lock: SessionLock,
  primaryError: unknown,
  debugLog: string | null,
): Promise<void> {
  try {
    await lock.release();
  } catch (releaseError) {
    if (primaryError === null) {
      throw releaseError;
    }
    await appendDebugLog(debugLog, cleanupDebugLogEntry('session_lock_release_failure', releaseError))
      .catch(() => undefined);
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
