import { randomUUID } from 'node:crypto';
import { runAbortableOperation, throwIfAborted } from '../../core/abort.js';
import { appendDebugLog, type DebugLogEntry } from '../../core/debug-log.js';
import { ARTIFACT_REJECTION_REASONS, EXIT_CODES, OpenPError } from '../../core/errors.js';
import { DEFAULT_TERMINATE_GRACE_MS, shouldTerminateOnAbort } from '../../core/graceful-interrupt.js';
import { SessionLockStore } from '../../core/session-lock.js';
import { settlePendingSeedBeforeResume } from '../../core/resume-preflight.js';
import { SessionStateStore, validateSessionStateCompatibility } from '../../core/session-state.js';
import type { Backend } from '../../core/backend.js';
import type { BackendRunOptions, TurnRequest, TurnResult, TurnResultWarning } from '../../core/types.js';
import type { PtyProvider, PtySession } from '../../runners/types.js';
import {
  ClaudeCodeSelectionPromptError,
  escapeClaudeComposerShellModeToggle,
  isClaudeCodeEmptyInputReady,
  isClaudeCodeSelectionPromptError,
  readClaudeCodeSelectionPromptScreen,
  waitForClaudeCodeInputReady,
} from './interactive.js';
import { rejectStructuredClaudeCodeBackendArgs } from './args-validation.js';
import {
  findClaudeCodeSessionLog,
  findRecentClaudeCodeSessionLog,
  getFileSize,
  hasClaudeCodeCallerUserTurnInSessionLogSegment,
  inspectClaudeCodeCallerUserTurnInSessionLogSegment,
  createClaudeCodeSessionLogWaitState,
  isMissingCallerAfterLocalCommandError,
  isMissingCallerAfterPromptSubmissionError,
  MissingCallerAfterPromptSubmissionError,
  resolveClaudeCodeSessionLogPath,
  snapshotClaudeCodeSessionLogPaths,
  waitForClaudeCodeTurnResult,
} from './session-log.js';
import { assertClaudeCodeBin, resolveClaudeCodeBin } from './bin.js';
import { resolveInteractivePermissionMode } from './permission-mode.js';
import { isPublishableIntermediateText } from './screen-monitor.js';
import { withThinkingSummariesSettings } from './settings.js';
import { buildClaudeToolsArgs } from './tools.js';
import { createClaudePtyInterrupter } from './pty-interrupt.js';
import {
  appendClaudeCodePtySuppressionArgs,
  CLAUDE_CODE_ISOLATED_ENV_PREFIXES,
  CLAUDE_CODE_LAUNCH_UNSET_ENV,
  withClaudeCodeAccountLaunchEnv,
} from './launch-safety.js';
import {
  createClaudeLocalCommandNameMismatchDebugLogger,
  createClaudeSessionLogIdleDebugLogger,
} from './diagnostics.js';
import { extractPromptLocalCommandName } from './prompt-command.js';
import {
  captureClaudeInputDraftSurface,
  ClaudePromptSubmissionTransportError,
  isClaudePromptSubmissionTransportError,
  sameClaudeInputDraftFingerprint,
  type ClaudeInputDraftFingerprint,
  waitForChangedClaudeInputDraftSurface,
} from './submission-recovery.js';

// The non-interactive PTY turn cannot survive tools that outlive the synchronous turn or that block on
// interactive input. openp launches Claude with these suppressed (official contract, background
// suppression):
// - env CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 removes `run_in_background` / auto-backgrounding.
// - --disallowedTools removes `Monitor`/`Workflow` (background work that outlives the turn) and
//   `AskUserQuestion` (renders a blocking multiple-choice menu the PTY cannot answer → the turn hangs;
//   with it disallowed the model asks via plain answer text instead).
// The disable levers are live-verified against Claude Code's PTY turn lifecycle.

export interface ClaudeCodeBackendOptions {
  readonly backendId?: string;
  readonly configDir?: string | null;
}

export class ClaudeCodeBackend implements Backend {
  private readonly backendId: string;
  private readonly configDir: string | null;

  constructor(
    private readonly provider: PtyProvider,
    options: ClaudeCodeBackendOptions = {},
  ) {
    this.backendId = options.backendId ?? 'claude';
    this.configDir = options.configDir ?? null;
  }

  async runTurn(request: TurnRequest, options: BackendRunOptions): Promise<TurnResult> {
    const lock = await new SessionLockStore(options.cwd).acquire(options.backendSessionId);
    let primaryError: unknown = null;
    try {
      await settlePendingSeedBeforeResume(options);
      return await this.runTurnWithLock(request, options);
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      try {
        await lock.release();
      } catch (releaseError) {
        if (primaryError === null) {
          throw releaseError;
        }
      }
    }
  }

  private async runTurnWithLock(request: TurnRequest, options: BackendRunOptions): Promise<TurnResult> {
    throwIfAborted(options.signal);
    const stateStore = new SessionStateStore(options.cwd);
    const expectedState = {
      backend: this.backendId,
      backendSessionId: options.backendSessionId,
      cwd: options.cwd,
    };
    const existingState = options.resume
      ? await stateStore.requireCompatible(expectedState)
      : await stateStore.load(options.backendSessionId);
    if (existingState) {
      validateSessionStateCompatibility(existingState, expectedState);
    }

    const claudeCodeBin = resolveClaudeCodeBin();
    const launchEnv = withClaudeCodeAccountLaunchEnv({}, this.configDir);
    await assertClaudeCodeBin(claudeCodeBin, {
      cwd: options.cwd,
      env: launchEnv,
      isolateEnvPrefixes: CLAUDE_CODE_ISOLATED_ENV_PREFIXES,
      unsetEnv: CLAUDE_CODE_LAUNCH_UNSET_ENV,
    });
    const nativeSessionId = options.resume ? options.backendSessionId : null;
    const expectedLogPath = nativeSessionId ? resolveClaudeCodeSessionLogPath(nativeSessionId, options.cwd, this.configDir) : null;
    const existingLogPath = nativeSessionId ? await findClaudeCodeSessionLog(nativeSessionId, options.cwd, this.configDir) : null;
    const excludedLogPaths = nativeSessionId ? undefined : await snapshotClaudeCodeSessionLogPaths(options.cwd, this.configDir);
    const discoveryStartedAtMs = nativeSessionId ? null : Date.now() - 1000;
    const args = buildClaudeCodeArgs(options);
    // Use the FULL normalized backend session id (not a 12-char prefix) so the reaper's
    // `openp-<sessionId>-` prefix is unique per session and matches the full-id per-session lock.
    const sessionName = `openp-${options.backendSessionId.replaceAll('-', '')}-${randomUUID().replaceAll('-', '').slice(0, 8)}`;
    const pty = await this.provider.start(claudeCodeBin, args, {
      cwd: options.cwd,
      sessionName,
      env: launchEnv,
      isolateEnvPrefixes: CLAUDE_CODE_ISOLATED_ENV_PREFIXES,
      unsetEnv: CLAUDE_CODE_LAUNCH_UNSET_ENV,
    });

    let primaryError: unknown = null;
    let inputUnsafeForExit = false;
    let promptInputUnconfirmed = false;
    const interrupter = createClaudePtyInterrupter(pty);
    const requestTurnStop = (): void => {
      if (promptInputUnconfirmed) {
        interrupter.requestForceStop();
        return;
      }
      interrupter.requestGracefulStop();
    };
    const forceHandler = (): void => {
      interrupter.requestForceStop();
    };
    const killHandler = (): void => {
      interrupter.requestKillNow();
    };
    if (options.forceSignal) {
      if (options.forceSignal.aborted) {
        forceHandler();
      } else {
        options.forceSignal.addEventListener('abort', forceHandler, { once: true });
      }
    }
    if (options.killSignal) {
      if (options.killSignal.aborted) {
        killHandler();
      } else {
        options.killSignal.addEventListener('abort', killHandler, { once: true });
      }
    }
    try {
      if (options.resume) {
        await stateStore.save({
          ...expectedState,
          lastProviderSessionId: pty.id,
          sessionLogPath: existingLogPath,
          lastTurnId: existingState?.lastTurnId ?? null,
        });
      }
      const result = await runAbortableOperation({
        signal: options.signal,
        awaitOperationAfterAbort: true,
        preserveOperationErrorAfterAbort: isMissingTurnBoundaryOpenPError,
        interrupt: () => {
          if (promptInputUnconfirmed || shouldTerminateOnAbort(options.signal)) {
            interrupter.requestForceStop();
            return;
          }
          interrupter.requestGracefulStop();
        },
        operation: async () => {
          const turnDeadlineMs = options.timeoutMs === 0 ? null : Date.now() + options.timeoutMs;
          let retryLogPath: string | null = null;
          let retryInitialOffset: number | null = null;
          let retryLocalCommandTranscriptPromptIds: ReadonlySet<string> = new Set();
          let initialSubmitDone = false;
          let recoverySubmitDone = false;
          let postWriteDraftFingerprint: ClaudeInputDraftFingerprint | null = null;
          let safetyLogPath = existingLogPath;
          let safetyOffset = 0;
          let safetyLocalCommandTranscriptPromptIds: ReadonlySet<string> = new Set();
          const sessionLogWaitState = createClaudeCodeSessionLogWaitState();
          const promptLocalCommandName = extractPromptLocalCommandName(request.prompt);
          const dischargePromptSubmissionFailure = (
            error: MissingCallerAfterPromptSubmissionError,
            submissionAttempted = true,
          ): Promise<OpenPError> => {
            inputUnsafeForExit = true;
            return dischargeResendSafetyBeforeThrow(pty, error, {
              expectedLogPath,
              cwd: options.cwd,
              discoveryStartedAtMs,
              excludedLogPaths,
              configDir: this.configDir,
              promptLocalCommandName,
              submissionAttempted,
            });
          };
          try {
            for (;;) {
            let activeLogPath: string | null;
            if (retryInitialOffset !== null) {
              activeLogPath = retryLogPath ?? existingLogPath;
            } else if (nativeSessionId) {
              activeLogPath = await findClaudeCodeSessionLog(nativeSessionId, options.cwd, this.configDir) ?? existingLogPath;
            } else {
              activeLogPath = retryLogPath ?? existingLogPath;
            }
            const initialOffset = retryInitialOffset ?? await getFileSize(activeLogPath ?? expectedLogPath);
            safetyLogPath = activeLogPath;
            safetyOffset = initialOffset;
            safetyLocalCommandTranscriptPromptIds = retryLocalCommandTranscriptPromptIds;
            let lastPublishedIntermediate: string | null = null;
            const publishIntermediateText = (text: string): void => {
              if (!shouldPublishIntermediateText(text, lastPublishedIntermediate)) {
                return;
              }
              lastPublishedIntermediate = text;
              options.onIntermediateText!(text, 'jsonl');
            };
            if (!initialSubmitDone) {
              const readinessAttemptTimeoutMs = remainingTurnTimeoutMs(
                turnDeadlineMs,
                request.turnId,
                () => {
                  requestTurnStop();
                },
              );
              // Only a session being started fresh can be facing the workspace trust prompt: the
              // prompt is a first-run gate on the directory, and a session being resumed already
              // ran a turn there. The distinction matters because a resumed session paints its own
              // transcript onto the screen, and the trust check reads the whole screen -- so any
              // transcript quoting the words it looks for would otherwise be answered as if Claude
              // Code had asked the question.
              await waitForClaudeCodeInputReady(pty, readinessAttemptTimeoutMs, {
                confirmTrustPrompt: !options.resume,
              });
              try {
                postWriteDraftFingerprint = await submitPrompt(
                  pty,
                  request.prompt,
                  () => {
                    throwIfAborted(options.signal);
                    return remainingTurnTimeoutMs(
                      turnDeadlineMs,
                      request.turnId,
                      requestTurnStop,
                    );
                  },
                  () => {
                    promptInputUnconfirmed = true;
                  },
                );
              } catch (error) {
                if (!isClaudePromptSubmissionTransportError(error)) {
                  throw error;
                }
                const safetyResult = await dischargePromptSubmissionFailure(
                  new MissingCallerAfterPromptSubmissionError(
                    request.turnId,
                    activeLogPath,
                    initialOffset,
                  ),
                  error.submissionAttempted,
                );
                if (
                  safetyResult.reasonCode === ARTIFACT_REJECTION_REASONS.promptNotExecuted
                ) {
                  throw error.cause;
                }
                throw safetyResult;
              }
              if (postWriteDraftFingerprint === null) {
                throw await dischargePromptSubmissionFailure(
                  new MissingCallerAfterPromptSubmissionError(
                    request.turnId,
                    activeLogPath,
                    initialOffset,
                  ),
                  false,
                );
              }
              initialSubmitDone = true;
            }
            try {
              const waitAttemptTimeoutMs = remainingTurnTimeoutMs(
                turnDeadlineMs,
                request.turnId,
                requestTurnStop,
              );
              const result = await waitForClaudeCodeTurnResult({
                sessionId: nativeSessionId,
                turnId: request.turnId,
                timeoutMs: waitAttemptTimeoutMs,
                initialOffset,
                knownLogPath: activeLogPath,
                expectedLogPath,
                cwd: options.cwd,
                configDir: this.configDir,
                discoveryStartedAtMs,
                excludedLogPaths,
                paceIntermediateEvents: options.paceIntermediateEvents === true,
                structuredOutputRequested: request.jsonSchema !== null && request.jsonSchema !== undefined,
                structuredOutputJsonSchema: request.jsonSchema,
                isBackendAlive: () => pty.isAlive(),
                onCallerUserTurnObserved: () => {
                  promptInputUnconfirmed = false;
                },
                // A backend parked on a selection prompt stays alive, so liveness alone reports it
                // as a turn still running. This is the reading that tells the two apart.
                readBackendSelectionPromptScreen: () => readClaudeCodeSelectionPromptScreen(pty),
                waitState: sessionLogWaitState,
                onIntermediateText: options.onIntermediateText
                  ? (text) => {
                      publishIntermediateText(text);
                    }
                  : undefined,
                onIntermediateReasoning: options.onIntermediateReasoning
                  ? (text, source, contentBlocks) => {
                      options.onIntermediateReasoning!(text, source, contentBlocks);
                    }
                  : undefined,
                onIntermediateAssistantSnapshot: options.onIntermediateAssistantSnapshot,
                promptLocalCommandName,
                initialLocalCommandTranscriptPromptIds: retryInitialOffset !== null
                  ? retryLocalCommandTranscriptPromptIds
                  : undefined,
                onSessionLogIdle: createClaudeSessionLogIdleDebugLogger({
                  debugLog: options.debugLog,
                  backendId: this.backendId,
                  backendSessionId: options.backendSessionId,
                  nativeSessionId,
                  ptySessionId: pty.id,
                  onRunActivity: options.onRunActivity,
                }),
                onLocalCommandNameMismatch: createClaudeLocalCommandNameMismatchDebugLogger({
                  debugLog: options.debugLog,
                  backendId: this.backendId,
                  backendSessionId: options.backendSessionId,
                  nativeSessionId,
                  ptySessionId: pty.id,
                }),
                onTimeout: () => {
                  requestTurnStop();
                },
              });
              promptInputUnconfirmed = false;
              return result;
            } catch (error) {
              if (!isMissingCallerAfterPromptSubmissionError(error)) {
                if (promptInputUnconfirmed) {
                  const safetyResult = await dischargePromptSubmissionFailure(
                    new MissingCallerAfterPromptSubmissionError(
                      request.turnId,
                      activeLogPath,
                      initialOffset,
                    ),
                  );
                  if (
                    safetyResult.reasonCode === ARTIFACT_REJECTION_REASONS.promptNotExecuted
                  ) {
                    throw error;
                  }
                  throw safetyResult;
                }
                throw error;
              }
              if (recoverySubmitDone) {
                retryLogPath = error.logPath ?? activeLogPath;
                retryInitialOffset = error.nextOffset;
                retryLocalCommandTranscriptPromptIds = error.localCommandTranscriptPromptIds;
                if (await hasCallerUserTurnAtRecoveryOffset(
                  retryLogPath,
                  expectedLogPath,
                  retryInitialOffset,
                  retryLocalCommandTranscriptPromptIds,
                )) {
                  continue;
                }
                const recoverySurface = await captureClaudeInputDraftSurface(pty);
                const recoveryDraftStillVisible = sameClaudeInputDraftFingerprint(
                  postWriteDraftFingerprint,
                  recoverySurface?.fingerprint ?? null,
                );
                if (
                  recoverySurface !== null &&
                  (recoveryDraftStillVisible || recoverySurface.kind !== 'menu')
                ) {
                  sessionLogWaitState.selectionPromptStallObservations = 0;
                }
                const backendReadyForNewInput = !recoveryDraftStillVisible &&
                  await isClaudeCodeEmptyInputReady(pty);
                if (recoveryDraftStillVisible || backendReadyForNewInput) {
                  if (await hasCallerUserTurnAtRecoveryOffset(
                    retryLogPath,
                    expectedLogPath,
                    retryInitialOffset,
                    retryLocalCommandTranscriptPromptIds,
                  )) {
                    continue;
                  }
                  throw await dischargePromptSubmissionFailure(error);
                }
                continue;
              }
              retryLogPath = error.logPath ?? activeLogPath;
              retryInitialOffset = error.nextOffset;
              retryLocalCommandTranscriptPromptIds = error.localCommandTranscriptPromptIds;
              if (await hasCallerUserTurnAtRecoveryOffset(
                retryLogPath,
                expectedLogPath,
                retryInitialOffset,
                retryLocalCommandTranscriptPromptIds,
              )) {
                continue;
              }
              const recoverySurface = await captureClaudeInputDraftSurface(pty);
              const stableDraft = sameClaudeInputDraftFingerprint(
                postWriteDraftFingerprint,
                recoverySurface?.fingerprint ?? null,
              );
              if (
                recoverySurface !== null &&
                (stableDraft || recoverySurface.kind !== 'menu')
              ) {
                sessionLogWaitState.selectionPromptStallObservations = 0;
              }
              if (stableDraft && retryLogPath === null && nativeSessionId === null) {
                retryLogPath = await findRecentClaudeCodeSessionLog(
                  options.cwd,
                  discoveryStartedAtMs!,
                  excludedLogPaths,
                  this.configDir,
                  promptLocalCommandName,
                );
              }
              if (stableDraft && await hasCallerUserTurnAtRecoveryOffset(
                retryLogPath,
                expectedLogPath,
                retryInitialOffset,
                retryLocalCommandTranscriptPromptIds,
              )) {
                continue;
              }
              if (stableDraft) {
                try {
                  throwIfAborted(options.signal);
                  remainingTurnTimeoutMs(
                    turnDeadlineMs,
                    request.turnId,
                    requestTurnStop,
                  );
                  await pty.submit();
                } catch (submitError) {
                  const safetyResult = await dischargePromptSubmissionFailure(error);
                  if (
                    safetyResult.reasonCode === ARTIFACT_REJECTION_REASONS.promptNotExecuted
                  ) {
                    throw submitError;
                  }
                  throw safetyResult;
                }
                recoverySubmitDone = true;
                continue;
              }
              if (await hasCallerUserTurnAtRecoveryOffset(
                retryLogPath,
                expectedLogPath,
                retryInitialOffset,
                retryLocalCommandTranscriptPromptIds,
              )) {
                continue;
              }
              if (await isClaudeCodeEmptyInputReady(pty)) {
                if (await hasCallerUserTurnAtRecoveryOffset(
                  retryLogPath,
                  expectedLogPath,
                  retryInitialOffset,
                  retryLocalCommandTranscriptPromptIds,
                )) {
                  continue;
                }
                throw await dischargePromptSubmissionFailure(error);
              }
              if (isMissingCallerAfterLocalCommandError(error)) {
                throw await dischargePromptSubmissionFailure(error);
              }
            }
            }
          } catch (error) {
            if (isClaudeCodeSelectionPromptError(error)) {
              inputUnsafeForExit = true;
              await forcePtyStopWithEscalation(pty, DEFAULT_TERMINATE_GRACE_MS)
                .catch(() => undefined);
              throw error;
            }
            if (promptInputUnconfirmed && !inputUnsafeForExit) {
              const safetyResult = await dischargePromptSubmissionFailure(
                new MissingCallerAfterPromptSubmissionError(
                  request.turnId,
                  safetyLogPath,
                  safetyOffset,
                  safetyLocalCommandTranscriptPromptIds,
                ),
              );
              if (
                safetyResult.reasonCode === ARTIFACT_REJECTION_REASONS.promptNotExecuted
              ) {
                throw error;
              }
              throw safetyResult;
            }
            throw error;
          }
        },
      });
      const resultSessionId = result.sessionId ?? (options.resume ? options.backendSessionId : null);
      if (!resultSessionId) {
        throw new OpenPError('Claude Code did not return a session id', EXIT_CODES.protocolViolation);
      }
      if (options.resume && result.sessionId && result.sessionId !== options.backendSessionId) {
        throw new OpenPError('Claude Code returned a different session id for resume turn', EXIT_CODES.protocolViolation);
      }
      const resultExpectedState = {
        ...expectedState,
        backendSessionId: resultSessionId,
      };
      await stateStore.save({
        ...resultExpectedState,
        lastProviderSessionId: pty.id,
        sessionLogPath: await findClaudeCodeSessionLog(resultSessionId, options.cwd, this.configDir) ?? expectedLogPath,
        lastTurnId: request.turnId,
      });
      const cleanupWarnings = await exitPtyAfterTurn(pty, primaryError, DEFAULT_TERMINATE_GRACE_MS, {
        debugLog: options.debugLog,
        backend: this.backendId,
        backendSessionId: resultSessionId,
        turnId: request.turnId,
      });
      primaryError = CLEANUP_ALREADY_HANDLED;
      return {
        ...result,
        sessionId: resultSessionId,
        ...(cleanupWarnings.length > 0 ? { warnings: mergeTurnWarnings(result.warnings, cleanupWarnings) } : {}),
      };
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      try {
        if (primaryError !== CLEANUP_ALREADY_HANDLED) {
          if (!inputUnsafeForExit) {
            // Failure path: exitPtyAfterTurn only escalates/propagates here; it emits
            // warnings and debug entries solely when the turn itself succeeded.
            await exitPtyAfterTurn(pty, primaryError);
          }
        }
      } finally {
        interrupter.clear();
        options.forceSignal?.removeEventListener('abort', forceHandler);
        options.killSignal?.removeEventListener('abort', killHandler);
      }
    }
  }
}

const CLEANUP_ALREADY_HANDLED = Symbol('cleanup already handled');

function isMissingTurnBoundaryOpenPError(error: unknown): boolean {
  return error instanceof OpenPError &&
    error.reasonCode === ARTIFACT_REJECTION_REASONS.missingTurnBoundary;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function remainingTurnTimeoutMs(
  deadlineMs: number | null,
  turnId: string,
  onTimeout: () => void,
): number {
  if (deadlineMs === null) {
    return 0;
  }
  const remainingMs = deadlineMs - Date.now();
  if (remainingMs <= 0) {
    onTimeout();
    throw new OpenPError(`timed out waiting for turn ${turnId}`, EXIT_CODES.timeout);
  }
  return remainingMs;
}

async function submitPrompt(
  pty: PtySession,
  prompt: string,
  assertCanSubmit: () => number,
  onWriteAttempted: () => void,
): Promise<ClaudeInputDraftFingerprint | null> {
  assertCanSubmit();
  let submissionAttempted = false;
  try {
    let beforeWriteSurface = await captureClaudeInputDraftSurface(pty);
    if (
      beforeWriteSurface?.kind === 'ambiguous' &&
      await isClaudeCodeEmptyInputReady(pty)
    ) {
      beforeWriteSurface = { fingerprint: null, kind: 'empty' };
    }
    if (beforeWriteSurface?.kind !== 'empty') {
      if (beforeWriteSurface?.kind === 'menu') {
        throw new ClaudeCodeSelectionPromptError(
          'Claude Code changed to an interactive selection prompt immediately before prompt input; open-p did not write or submit the caller prompt.',
          EXIT_CODES.backendStartFailed,
        );
      }
      throw new OpenPError(
        'Claude Code input surface was not exact and empty immediately before prompt input; open-p did not write or submit the caller prompt.',
        EXIT_CODES.backendStartFailed,
      );
    }
    assertCanSubmit();
    onWriteAttempted();
    await pty.write(escapeClaudeComposerShellModeToggle(prompt));
    const remainingMs = assertCanSubmit();
    // Do not rethrow the budget expiry here: nothing was submitted, and rethrowing would report
    // a resend-safe turn as a plain timeout. The null fingerprint carries it to the resend-safe
    // prompt_not_executed path.
    let draftFingerprint: ClaudeInputDraftFingerprint | null;
    try {
      draftFingerprint = await waitForChangedClaudeInputDraftSurface(
        pty,
        beforeWriteSurface,
        remainingMs === 0 ? Number.POSITIVE_INFINITY : remainingMs,
        assertCanSubmit,
      );
    } catch (error) {
      if (error instanceof OpenPError && error.exitCode === EXIT_CODES.timeout) {
        return null;
      }
      throw error;
    }
    if (draftFingerprint === null) {
      return null;
    }
    assertCanSubmit();
    submissionAttempted = true;
    await pty.submit();
    return draftFingerprint;
  } catch (error) {
    throw new ClaudePromptSubmissionTransportError(error, submissionAttempted);
  }
}

async function hasCallerUserTurnAtRecoveryOffset(
  activeLogPath: string | null,
  expectedLogPath: string | null,
  initialOffset: number,
  initialLocalCommandTranscriptPromptIds: ReadonlySet<string>,
): Promise<boolean> {
  const scanLogPath = activeLogPath ?? expectedLogPath;
  return scanLogPath !== null &&
    await hasClaudeCodeCallerUserTurnInSessionLogSegment(
      scanLogPath,
      initialOffset,
      initialLocalCommandTranscriptPromptIds,
    );
}

function shouldPublishIntermediateText(text: string, previousText: string | null): boolean {
  return isPublishableIntermediateText(text, previousText);
}

export function buildClaudeCodeArgs(options: BackendRunOptions, extraArgs: readonly string[] = []): string[] {
  const args: string[] = [];
  rejectStructuredClaudeCodeBackendArgs(options.backendArgs);
  rejectStructuredClaudeCodeBackendArgs(extraArgs);
  if (options.resume) {
    args.push('--resume', options.backendSessionId);
  }
  if (options.model) {
    args.push('--model', options.model);
  }
  if (options.reasoningEffort) {
    args.push('--effort', options.reasoningEffort);
  }
  const permissionMode = resolveInteractivePermissionMode({
    permissionMode: options.permissionMode,
    nativePermissionMode: options.nativePermissionMode,
  });
  if (permissionMode) {
    args.push('--permission-mode', permissionMode);
  }
  if (options.jsonSchema) {
    args.push('--json-schema', options.jsonSchema);
  }
  // Suppress tools that break the non-interactive PTY turn. The next emitted token is `--settings`
  // (from withThinkingSummariesSettings), so the variadic `--disallowedTools` value list ends here.
  appendClaudeCodePtySuppressionArgs(args);
  args.push(...withThinkingSummariesSettings(
    [...buildClaudeToolsArgs(options.tools), ...options.backendArgs, ...extraArgs],
    options.cwd,
  ));
  return args;
}

interface PromptSubmissionSafetyContext {
  readonly expectedLogPath: string | null;
  readonly cwd: string;
  readonly discoveryStartedAtMs: number | null;
  readonly excludedLogPaths: ReadonlySet<string> | undefined;
  readonly configDir: string | null;
  readonly promptLocalCommandName: string | null;
  readonly submissionAttempted: boolean;
}

// `prompt_not_executed` promises the caller that the preempted prompt can never run. Do not type a
// graceful `/exit` into an unconfirmed input surface: it can combine with a late-rendering draft and
// submit the caller's prompt. Terminate without sending input, then recheck the scoped log.
async function dischargeResendSafetyBeforeThrow(
  pty: PtySession,
  error: MissingCallerAfterPromptSubmissionError,
  context: PromptSubmissionSafetyContext,
): Promise<OpenPError> {
  await forcePtyStopWithEscalation(pty, DEFAULT_TERMINATE_GRACE_MS).catch(() => undefined);
  if (await pty.isAlive().catch(() => true)) {
    return new OpenPError(
      `Claude Code backend did not terminate after prompt submission was not confirmed for turn ${error.turnId}; the prompt may still execute. Resubmitting is not known to be safe.`,
      EXIT_CODES.protocolViolation,
      ARTIFACT_REJECTION_REASONS.missingTurnBoundary,
    );
  }
  let finalLogPath = error.logPath ?? context.expectedLogPath;
  if (
    finalLogPath === null &&
    context.submissionAttempted &&
    context.discoveryStartedAtMs !== null
  ) {
    finalLogPath = await findRecentClaudeCodeSessionLog(
      context.cwd,
      context.discoveryStartedAtMs,
      context.excludedLogPaths ?? new Set(),
      context.configDir,
      context.promptLocalCommandName,
    ).catch(() => null);
  }
  if (finalLogPath === null) {
    return context.submissionAttempted
      ? missingPromptSubmissionBoundaryError(error.turnId)
      : error;
  }
  const inspection = await inspectClaudeCodeCallerUserTurnInSessionLogSegment(
    finalLogPath,
    error.nextOffset,
    error.localCommandTranscriptPromptIds,
  );
  if (inspection.sawCallerUserTurn) {
    return new OpenPError(
      `Claude Code recorded a caller user turn while the backend was shutting down after unconfirmed prompt submission for turn ${error.turnId}; the prompt may have started executing, so resubmitting is not known to be safe.`,
      EXIT_CODES.protocolViolation,
      ARTIFACT_REJECTION_REASONS.missingTurnBoundary,
    );
  }
  if (
    !inspection.readable ||
    inspection.hasIncompleteTail ||
    inspection.hasMalformedRecord
  ) {
    return missingPromptSubmissionBoundaryError(error.turnId);
  }
  return error;
}

function missingPromptSubmissionBoundaryError(turnId: string): OpenPError {
  return new OpenPError(
    `Claude Code could not establish a complete final caller boundary after unconfirmed prompt submission for turn ${turnId}; the prompt may have started executing, so resubmitting is not known to be safe.`,
    EXIT_CODES.protocolViolation,
    ARTIFACT_REJECTION_REASONS.missingTurnBoundary,
  );
}

export async function exitPtyAfterTurn(
  pty: {
    exit(): Promise<void>;
    isAlive?(): Promise<boolean>;
    interrupt?(): Promise<void>;
    terminate(signal?: NodeJS.Signals): Promise<void>;
  },
  primaryError: unknown,
  terminateGraceMs = DEFAULT_TERMINATE_GRACE_MS,
  diagnostics: {
    readonly debugLog?: string | null;
    readonly backend?: string | null;
    readonly backendSessionId?: string | null;
    readonly turnId?: string | null;
  } = {},
): Promise<readonly TurnResultWarning[]> {
  let exitError: unknown = null;
  let forceError: unknown = null;
  let forceAttempted = false;
  try {
    await pty.exit();
  } catch (error) {
    exitError = error;
  }

  if ((exitError !== null || primaryError !== null) && await isPtyAlive(pty)) {
    try {
      forceAttempted = true;
      await forcePtyStopWithEscalation(pty, terminateGraceMs);
    } catch (error) {
      forceError = error;
    }
  }

  if (exitError !== null && primaryError === null) {
    await appendDebugLog(diagnostics.debugLog ?? null, cleanupFailureDebugEntry(
      'pty_cleanup_failure',
      exitError,
      forceError,
      diagnostics,
    )).catch(() => undefined);
    return [cleanupFailureWarning(diagnostics.debugLog ?? null, forceAttempted, forceError)];
  }
  if (forceError !== null && primaryError === null) {
    await appendDebugLog(diagnostics.debugLog ?? null, cleanupFailureDebugEntry(
      'pty_cleanup_failure',
      exitError,
      forceError,
      diagnostics,
    )).catch(() => undefined);
    return [cleanupFailureWarning(diagnostics.debugLog ?? null, forceAttempted, forceError)];
  }
  return [];
}

function cleanupFailureWarning(
  debugLogPath: string | null,
  forceAttempted: boolean,
  forceError: unknown,
): TurnResultWarning {
  const suffix = debugLogPath
    ? ` See debug log: ${debugLogPath}.`
    : ' Use --debug-log to record details.';
  const forceSuffix = forceError
    ? ' Forced backend shutdown was attempted but also reported an error.'
    : forceAttempted
      ? ' Forced backend shutdown was attempted.'
      : ' Backend process was already stopped when checked.';
  return {
    severity: 'warning',
    code: 'pty_cleanup_failure',
    message: `PTY cleanup failed after the result was confirmed; result was preserved.${forceSuffix}${suffix}`,
  };
}

function cleanupFailureDebugEntry(
  event: string,
  exitError: unknown,
  forceError: unknown,
  diagnostics: {
    readonly backend?: string | null;
    readonly backendSessionId?: string | null;
    readonly turnId?: string | null;
  },
): DebugLogEntry {
  return {
    event,
    severity: 'warning',
    ...(diagnostics.backend ? { backend: diagnostics.backend } : {}),
    ...(diagnostics.backendSessionId ? { backendSessionId: diagnostics.backendSessionId } : {}),
    ...(diagnostics.turnId ? { turnId: diagnostics.turnId } : {}),
    exitError: cleanupErrorDebugPayload(exitError),
    ...(forceError ? { forceError: cleanupErrorDebugPayload(forceError) } : {}),
  };
}

function cleanupErrorDebugPayload(error: unknown): Record<string, unknown> {
  return {
    message: errorMessage(error),
    ...(error instanceof OpenPError ? { exitCode: error.exitCode } : {}),
    ...(error instanceof OpenPError && error.reasonCode ? { reasonCode: error.reasonCode } : {}),
    ...(error instanceof OpenPError && error.details ? { details: error.details } : {}),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function mergeTurnWarnings(
  left: readonly TurnResultWarning[] | undefined,
  right: readonly TurnResultWarning[],
): readonly TurnResultWarning[] {
  return [...(left ?? []), ...right];
}

async function forcePtyStopWithEscalation(
  pty: { isAlive?(): Promise<boolean>; terminate(signal?: NodeJS.Signals): Promise<void> },
  terminateGraceMs = DEFAULT_TERMINATE_GRACE_MS,
): Promise<void> {
  await forcePtyStop(pty, 'SIGTERM');
  if (await waitForPtyStop(pty, terminateGraceMs)) {
    return;
  }
  await forcePtyStop(pty, 'SIGKILL');
}

async function forcePtyStop(
  pty: { terminate(signal?: NodeJS.Signals): Promise<void> },
  signal: NodeJS.Signals,
): Promise<void> {
  await pty.terminate(signal);
}

async function isPtyAlive(pty: { isAlive?(): Promise<boolean> }): Promise<boolean> {
  return pty.isAlive ? await pty.isAlive() : false;
}

async function waitForPtyStop(pty: { isAlive?(): Promise<boolean> }, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isPtyAlive(pty))) {
      return true;
    }
    await sleep(50);
  }
  return !(await isPtyAlive(pty));
}
