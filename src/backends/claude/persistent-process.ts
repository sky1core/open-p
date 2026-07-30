import { randomUUID } from 'node:crypto';
import { runAbortableOperation, throwIfAborted } from '../../core/abort.js';
import { ARTIFACT_REJECTION_REASONS, EXIT_CODES, OpenPError } from '../../core/errors.js';
import { DEFAULT_TERMINATE_GRACE_MS, shouldTerminateOnAbort } from '../../core/graceful-interrupt.js';
import { parseJsonSchemaText } from '../../core/json-schema.js';
import type { ManagedBackendProcess, ProcessStartRequest } from '../../core/persistent-process.js';
import type {
  AssistantContentBlock,
  AssistantEventSnapshot,
  BackendRunActivity,
  IntermediateTextSource,
  TurnRequest,
  TurnResult,
} from '../../core/types.js';
import type { LaunchSignature } from '../../core/worker-types.js';
import type { PtyProvider, PtySession } from '../../runners/types.js';
import { rejectStructuredClaudeCodeBackendArgs } from './args-validation.js';
import { ClaudeCodeBackgroundRouter, isClaudeCodeTaskNotificationLine } from './background-parser.js';
import {
  ClaudeCodeSelectionPromptError,
  escapeClaudeComposerShellModeToggle,
  isClaudeCodeEmptyInputReady,
  isClaudeCodeSelectionPromptError,
  readClaudeCodeSelectionPromptScreen,
  waitForClaudeCodeInputReady,
} from './interactive.js';
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
  readNewText,
  resolveClaudeCodeSessionLogPath,
  snapshotClaudeCodeSessionLogPaths,
  waitForClaudeCodeTurnResult,
} from './session-log.js';
import { resolveInteractivePermissionMode } from './permission-mode.js';
import { isPublishableIntermediateText } from './screen-monitor.js';
import { withThinkingSummariesSettings } from './settings.js';
import { buildClaudeToolsArgs } from './tools.js';
import {
  appendClaudeCodePtySuppressionArgs,
  CLAUDE_CODE_ISOLATED_ENV_PREFIXES,
  CLAUDE_CODE_LAUNCH_UNSET_ENV,
  CLAUDE_CONFIG_DIR_ENV_KEY,
  withClaudeCodeAccountLaunchEnv,
} from './launch-safety.js';
import { createClaudePtyInterrupter } from './pty-interrupt.js';
import { assertClaudeCodeBin } from './bin.js';
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

export interface StartPersistentClaudeCodeProcessOptions extends ProcessStartRequest {
  readonly cwd: string;
  readonly provider: PtyProvider;
  readonly timeoutMs: number;
}

export interface PersistentClaudeCodeTurnOptions {
  readonly timeoutMs: number;
  readonly debugLog?: string | null;
  readonly jsonSchema?: string | null;
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
  readonly onRunActivity?: (activity: BackendRunActivity) => void;
  readonly onBackgroundAssistantText?: (text: string) => void;
}

export class PersistentClaudeCodeProcess implements ManagedBackendProcess {
  private lastIntermediateText: string | null = null;
  private lastIntermediateReasoningText: string | null = null;
  private lastCompletedBackgroundCallback: ((text: string) => void) | null = null;
  private activeBackgroundTaskCallback: ((text: string) => void) | null = null;
  private activeTurn: {
    readonly turnId: string;
    readonly backgroundCallback: ((text: string) => void) | null;
  } | null = null;
  private readonly backgroundRouter = new ClaudeCodeBackgroundRouter();
  private backgroundRemainder = '';
  private backgroundStopped = false;
  private backgroundWatchPromise: Promise<void> | null = null;
  private readonly deferredInterruptCleanup: Array<() => void> = [];
  private inputUnsafeForExit = false;

  constructor(
    public sessionId: string,
    readonly launchSignature: LaunchSignature,
    private readonly cwd: string,
    private readonly pty: PtySession,
    private sessionLogPath: string | null,
    private readonly expectedLogPath: string | null,
    private backgroundOffset: number,
    private nativeSessionId: string | null = sessionId,
    private readonly discoveryStartedAtMs: number | null = null,
    private readonly excludedLogPaths?: ReadonlySet<string>,
    private readonly configDir: string | null = null,
  ) {}

  async sendTurn(prompt: string, options: PersistentClaudeCodeTurnOptions): Promise<TurnResult> {
    throwIfAborted(options.signal);
    this.lastIntermediateText = null;
    this.lastIntermediateReasoningText = null;
    const request = buildTurnRequest(prompt, options.jsonSchema ?? null);
    const turnBackgroundCallback = options.onBackgroundAssistantText ?? null;
    let lastPublishedJsonlIntermediate: string | null = null;
    const publishJsonlIntermediateText = (text: string): void => {
      if (!shouldPublishIntermediateText(text, lastPublishedJsonlIntermediate)) {
        return;
      }
      lastPublishedJsonlIntermediate = text;
      const shouldPublishPublic = shouldPublishIntermediateText(text, this.lastIntermediateText);
      this.lastIntermediateText = text;
      if (shouldPublishPublic) {
        options.onIntermediateText?.(text, 'jsonl');
      }
    };
    this.activeTurn = {
      turnId: request.turnId,
      backgroundCallback: turnBackgroundCallback,
    };

    let promptInputUnconfirmed = false;
    const interrupter = createClaudePtyInterrupter(this.pty);
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
    const cleanupInterruptListeners = (): void => {
      interrupter.clear();
      options.forceSignal?.removeEventListener('abort', forceHandler);
      options.killSignal?.removeEventListener('abort', killHandler);
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

    let keepInterruptListenersForShutdown = false;
    try {
      return await runAbortableOperation({
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
        getInterruptedDraft: () => this.lastIntermediateReasoningText,
        operation: async () => {
          const turnDeadlineMs = options.timeoutMs === 0 ? null : Date.now() + options.timeoutMs;
          let retryLogPath: string | null = null;
          let retryInitialOffset: number | null = null;
          let retryLocalCommandTranscriptPromptIds: ReadonlySet<string> = new Set();
          let initialSubmitDone = false;
          let recoverySubmitDone = false;
          let postWriteDraftFingerprint: ClaudeInputDraftFingerprint | null = null;
          let safetyLogPath = this.sessionLogPath;
          let safetyOffset = 0;
          let safetyLocalCommandTranscriptPromptIds: ReadonlySet<string> = new Set();
          const sessionLogWaitState = createClaudeCodeSessionLogWaitState();
          const promptLocalCommandName = extractPromptLocalCommandName(prompt);
          const dischargePromptSubmissionFailure = (
            error: MissingCallerAfterPromptSubmissionError,
            submissionAttempted = true,
          ): Promise<OpenPError> => {
            this.inputUnsafeForExit = true;
            return dischargeResendSafetyBeforeThrow(this.pty, error, {
              expectedLogPath: this.expectedLogPath,
              cwd: this.cwd,
              discoveryStartedAtMs: this.discoveryStartedAtMs,
              excludedLogPaths: this.excludedLogPaths,
              configDir: this.configDir,
              promptLocalCommandName,
              submissionAttempted,
            });
          };
          try {
            for (;;) {
            if (retryLogPath) {
              this.sessionLogPath = retryLogPath;
            }
            this.sessionLogPath = retryInitialOffset === null && this.nativeSessionId
              ? await findClaudeCodeSessionLog(this.nativeSessionId, this.cwd, this.configDir) ?? this.sessionLogPath
              : this.sessionLogPath;
            const initialOffset = retryInitialOffset ?? await getFileSize(this.sessionLogPath ?? this.expectedLogPath);
            safetyLogPath = this.sessionLogPath;
            safetyOffset = initialOffset;
            safetyLocalCommandTranscriptPromptIds = retryLocalCommandTranscriptPromptIds;
            if (!initialSubmitDone) {
              const readinessAttemptTimeoutMs = remainingTurnTimeoutMs(
                turnDeadlineMs,
                request.turnId,
                requestTurnStop,
              );
              await waitForClaudeCodeInputReady(
                this.pty,
                readinessAttemptTimeoutMs,
                { confirmTrustPrompt: false },
              );
              try {
                postWriteDraftFingerprint = await submitPrompt(
                  this.pty,
                  prompt,
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
                    this.sessionLogPath,
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
                    this.sessionLogPath,
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
                sessionId: this.nativeSessionId,
                turnId: request.turnId,
                timeoutMs: waitAttemptTimeoutMs,
                initialOffset,
                knownLogPath: this.sessionLogPath,
                expectedLogPath: this.expectedLogPath,
                cwd: this.cwd,
                configDir: this.configDir,
                discoveryStartedAtMs: this.discoveryStartedAtMs,
                excludedLogPaths: this.excludedLogPaths,
                paceIntermediateEvents: options.paceIntermediateEvents === true,
                structuredOutputRequested: request.jsonSchema !== null && request.jsonSchema !== undefined,
                structuredOutputJsonSchema: request.jsonSchema,
                isBackendAlive: () => this.pty.isAlive(),
                onCallerUserTurnObserved: () => {
                  promptInputUnconfirmed = false;
                },
                // A backend parked on a selection prompt stays alive, so liveness alone reports it
                // as a turn still running. This is the reading that tells the two apart.
                readBackendSelectionPromptScreen: () => readClaudeCodeSelectionPromptScreen(this.pty),
                waitState: sessionLogWaitState,
                onIntermediateText: (text) => {
                  publishJsonlIntermediateText(text);
                },
                promptLocalCommandName,
                initialLocalCommandTranscriptPromptIds: retryInitialOffset !== null
                  ? retryLocalCommandTranscriptPromptIds
                  : undefined,
                onIntermediateReasoning: (text, source, contentBlocks) => {
                  this.lastIntermediateReasoningText = text;
                  options.onIntermediateReasoning?.(text, source, contentBlocks);
                },
                onIntermediateAssistantSnapshot: options.onIntermediateAssistantSnapshot,
                onSessionLogIdle: createClaudeSessionLogIdleDebugLogger({
                  debugLog: options.debugLog ?? null,
                  backendId: this.launchSignature.backendId,
                  backendSessionId: this.sessionId,
                  nativeSessionId: this.nativeSessionId,
                  ptySessionId: this.pty.id,
                  onRunActivity: options.onRunActivity,
                }),
                onLocalCommandNameMismatch: createClaudeLocalCommandNameMismatchDebugLogger({
                  debugLog: options.debugLog ?? null,
                  backendId: this.launchSignature.backendId,
                  backendSessionId: this.sessionId,
                  nativeSessionId: this.nativeSessionId,
                  ptySessionId: this.pty.id,
                }),
                onTimeout: () => {
                  requestTurnStop();
                },
              });
              promptInputUnconfirmed = false;
              if (result.sessionId) {
                if (this.nativeSessionId && result.sessionId !== this.nativeSessionId) {
                  throw new OpenPError('Claude Code returned a different session id for resume turn', EXIT_CODES.protocolViolation);
                }
                this.nativeSessionId = result.sessionId;
                this.sessionId = result.sessionId;
              }
              this.sessionLogPath = this.nativeSessionId
                ? await findClaudeCodeSessionLog(this.nativeSessionId, this.cwd, this.configDir) ?? this.sessionLogPath
                : this.sessionLogPath;
              this.lastIntermediateText = null;
              this.lastIntermediateReasoningText = null;
              this.lastCompletedBackgroundCallback = turnBackgroundCallback;
              return result;
            } catch (error) {
              if (!isMissingCallerAfterPromptSubmissionError(error)) {
                if (promptInputUnconfirmed) {
                  const safetyResult = await dischargePromptSubmissionFailure(
                    new MissingCallerAfterPromptSubmissionError(
                      request.turnId,
                      this.sessionLogPath,
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
                retryLogPath = error.logPath ?? this.sessionLogPath;
                retryInitialOffset = error.nextOffset;
                retryLocalCommandTranscriptPromptIds = error.localCommandTranscriptPromptIds;
                if (await hasCallerUserTurnAtRecoveryOffset(
                  retryLogPath,
                  this.expectedLogPath,
                  retryInitialOffset,
                  retryLocalCommandTranscriptPromptIds,
                )) {
                  continue;
                }
                const recoverySurface = await captureClaudeInputDraftSurface(this.pty);
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
                  await isClaudeCodeEmptyInputReady(this.pty);
                if (recoveryDraftStillVisible || backendReadyForNewInput) {
                  if (await hasCallerUserTurnAtRecoveryOffset(
                    retryLogPath,
                    this.expectedLogPath,
                    retryInitialOffset,
                    retryLocalCommandTranscriptPromptIds,
                  )) {
                    continue;
                  }
                  throw await dischargePromptSubmissionFailure(error);
                }
                continue;
              }
              lastPublishedJsonlIntermediate = null;
              this.lastIntermediateText = null;
              this.lastIntermediateReasoningText = null;
              retryLogPath = error.logPath ?? this.sessionLogPath;
              retryInitialOffset = error.nextOffset;
              retryLocalCommandTranscriptPromptIds = error.localCommandTranscriptPromptIds;
              if (await hasCallerUserTurnAtRecoveryOffset(
                retryLogPath,
                this.expectedLogPath,
                retryInitialOffset,
                retryLocalCommandTranscriptPromptIds,
              )) {
                continue;
              }
              const recoverySurface = await captureClaudeInputDraftSurface(this.pty);
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
              if (stableDraft && retryLogPath === null && this.nativeSessionId === null) {
                retryLogPath = await findRecentClaudeCodeSessionLog(
                  this.cwd,
                  this.discoveryStartedAtMs!,
                  this.excludedLogPaths,
                  this.configDir,
                  promptLocalCommandName,
                );
              }
              if (stableDraft && await hasCallerUserTurnAtRecoveryOffset(
                retryLogPath,
                this.expectedLogPath,
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
                  await this.pty.submit();
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
                this.expectedLogPath,
                retryInitialOffset,
                retryLocalCommandTranscriptPromptIds,
              )) {
                continue;
              }
              if (await isClaudeCodeEmptyInputReady(this.pty)) {
                if (await hasCallerUserTurnAtRecoveryOffset(
                  retryLogPath,
                  this.expectedLogPath,
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
              this.inputUnsafeForExit = true;
              await forcePtyStopWithEscalation(this.pty).catch(() => undefined);
              throw error;
            }
            if (promptInputUnconfirmed && !this.inputUnsafeForExit) {
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
    } catch (error) {
      keepInterruptListenersForShutdown = true;
      this.deferredInterruptCleanup.push(cleanupInterruptListeners);
      throw error;
    } finally {
      if (!keepInterruptListenersForShutdown) {
        cleanupInterruptListeners();
      }
      if (this.activeTurn?.turnId === request.turnId) {
        this.activeTurn = null;
      }
    }
  }

  async isAlive(): Promise<boolean> {
    return this.pty.isAlive();
  }

  async shutdown(): Promise<void> {
    this.backgroundStopped = true;
    try {
      if (this.inputUnsafeForExit) {
        if (await this.pty.isAlive().catch(() => true)) {
          await forcePtyStopWithEscalation(this.pty).catch(() => undefined);
        }
      } else {
        await this.pty.exit().catch(() => undefined);
        if (await this.pty.isAlive().catch(() => true)) {
          await forcePtyStopWithEscalation(this.pty).catch(() => undefined);
        }
      }
      await this.backgroundWatchPromise?.catch(() => undefined);
    } finally {
      this.clearDeferredInterruptCleanup();
    }
  }

  startBackgroundWatcher(): void {
    if (this.backgroundWatchPromise) {
      return;
    }
    this.backgroundWatchPromise = this.watchBackgroundAssistantText();
  }

  private async watchBackgroundAssistantText(): Promise<void> {
    while (!this.backgroundStopped) {
      if (!(await this.pty.isAlive())) {
        return;
      }
      if (!this.sessionLogPath) {
        this.sessionLogPath = this.nativeSessionId
          ? await findClaudeCodeSessionLog(this.nativeSessionId, this.cwd, this.configDir)
          : null;
      }
      if (this.sessionLogPath) {
        const chunk = await readNewText(this.sessionLogPath, this.backgroundOffset);
        this.backgroundOffset = chunk.nextOffset;
        if (chunk.text) {
          const combined = this.backgroundRemainder + chunk.text;
          const parts = combined.split('\n');
          this.backgroundRemainder = parts.pop() ?? '';
          for (const line of parts) {
            if (isClaudeCodeTaskNotificationLine(line)) {
              this.flushBackgroundRouterLine(line);
              this.activeBackgroundTaskCallback = this.activeTurn?.backgroundCallback ?? this.lastCompletedBackgroundCallback;
              continue;
            }
            this.flushBackgroundRouterLine(line);
          }
        }
      }
      await sleep(500);
    }
  }

  private flushBackgroundRouterLine(line: string): void {
    for (const text of this.backgroundRouter.consumeLine(line)) {
      this.activeBackgroundTaskCallback?.(text);
      this.activeBackgroundTaskCallback = null;
    }
  }

  private clearDeferredInterruptCleanup(): void {
    for (const cleanup of this.deferredInterruptCleanup.splice(0)) {
      cleanup();
    }
  }
}

export async function startPersistentClaudeCodeProcess(
  options: StartPersistentClaudeCodeProcessOptions,
): Promise<PersistentClaudeCodeProcess> {
  const configDir = resolveLaunchSignatureConfigDir(options.launchSignature);
  const env = withClaudeCodeAccountLaunchEnv(options.launchSignature.env, configDir);
  await assertClaudeCodeBin(options.launchSignature.bin, {
    env,
    isolateEnvPrefixes: CLAUDE_CODE_ISOLATED_ENV_PREFIXES,
    unsetEnv: CLAUDE_CODE_LAUNCH_UNSET_ENV,
    cwd: options.cwd,
  });
  const nativeSessionId = options.resume ? options.sessionId : null;
  const expectedLogPath = nativeSessionId ? resolveClaudeCodeSessionLogPath(nativeSessionId, options.cwd, configDir) : null;
  const existingLogPath = nativeSessionId ? await findClaudeCodeSessionLog(nativeSessionId, options.cwd, configDir) : null;
  const backgroundOffset = await getFileSize(existingLogPath ?? expectedLogPath);
  const excludedLogPaths = nativeSessionId ? undefined : await snapshotClaudeCodeSessionLogPaths(options.cwd, configDir);
  const discoveryStartedAtMs = nativeSessionId ? null : Date.now() - 1000;
  const args = buildPersistentClaudeCodeArgs(options);
  const sessionName = `openp-${options.sessionId.replaceAll('-', '')}-${randomUUID().replaceAll('-', '').slice(0, 8)}`;
  const pty = await options.provider.start(options.launchSignature.bin, args, {
    cwd: options.cwd,
    sessionName,
    env,
    isolateEnvPrefixes: CLAUDE_CODE_ISOLATED_ENV_PREFIXES,
    unsetEnv: CLAUDE_CODE_LAUNCH_UNSET_ENV,
  });
  const process = new PersistentClaudeCodeProcess(
    options.sessionId,
    options.launchSignature,
    options.cwd,
    pty,
    existingLogPath,
    expectedLogPath,
    backgroundOffset,
    nativeSessionId,
    discoveryStartedAtMs,
    excludedLogPaths,
    configDir,
  );
  try {
    // Only a session being started fresh can be facing the workspace trust prompt: the prompt is a
    // first-run gate on the directory, and a session being resumed already ran a turn there. The
    // distinction matters because a resumed session paints its own transcript onto the screen, and
    // the trust check reads the whole screen -- so any transcript quoting the words it looks for
    // would otherwise be answered as if Claude Code had asked the question.
    await waitForClaudeCodeInputReady(pty, options.timeoutMs, {
      confirmTrustPrompt: !options.resume,
    });
    process.startBackgroundWatcher();
    return process;
  } catch (error) {
    if (isClaudeCodeSelectionPromptError(error)) {
      await forcePtyStopWithEscalation(pty).catch(() => undefined);
    } else {
      await pty.exit().catch(() => undefined);
      if (await pty.isAlive().catch(() => false)) {
        await forcePtyStopWithEscalation(pty).catch(() => undefined);
      }
    }
    if (await pty.isAlive().catch(() => false)) {
      throw new OpenPError(`failed to start Claude Code process and cleanup left session ${options.sessionId} alive`, EXIT_CODES.sessionBusy);
    }
    throw error;
  }
}

function resolveLaunchSignatureConfigDir(launchSignature: LaunchSignature): string | null {
  return launchSignature.env[CLAUDE_CONFIG_DIR_ENV_KEY] || null;
}

export function buildPersistentClaudeCodeArgs(options: {
  readonly sessionId: string;
  readonly resume: boolean;
  readonly cwd: string;
  readonly launchSignature: LaunchSignature;
}, extraArgs: readonly string[] = []): string[] {
  const args: string[] = [];
  const binArgs = options.launchSignature.binArgs.filter((arg) => arg !== '--verbose' && arg !== '--brief');
  rejectStructuredClaudeCodeBackendArgs(binArgs);
  rejectStructuredClaudeCodeBackendArgs(extraArgs);
  if (options.resume) {
    args.push('--resume', options.sessionId);
  }
  args.push('--verbose', '--brief');
  if (options.launchSignature.model) {
    args.push('--model', options.launchSignature.model);
  }
  if (options.launchSignature.reasoningEffort) {
    args.push('--effort', options.launchSignature.reasoningEffort);
  }
  const permissionMode = resolveInteractivePermissionMode({
    permissionMode: options.launchSignature.executionMode,
    nativePermissionMode: options.launchSignature.nativeExecutionMode ?? null,
  });
  if (permissionMode) {
    args.push('--permission-mode', permissionMode);
  }
  if (options.launchSignature.jsonSchema) {
    args.push('--json-schema', options.launchSignature.jsonSchema);
  }
  appendClaudeCodePtySuppressionArgs(args);
  args.push(...withThinkingSummariesSettings(
    [...buildClaudeToolsArgs(options.launchSignature.tools), ...binArgs, ...extraArgs],
    options.cwd,
  ));
  return args;
}

function buildTurnRequest(prompt: string, jsonSchema: string | null): TurnRequest {
  return {
    turnId: randomUUID(),
    prompt,
    jsonSchema: jsonSchema ? parseJsonSchemaText(jsonSchema) : null,
  };
}

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
  sessionLogPath: string | null,
  expectedLogPath: string | null,
  initialOffset: number,
  initialLocalCommandTranscriptPromptIds: ReadonlySet<string>,
): Promise<boolean> {
  const scanLogPath = sessionLogPath ?? expectedLogPath;
  return scanLogPath !== null &&
    await hasClaudeCodeCallerUserTurnInSessionLogSegment(
      scanLogPath,
      initialOffset,
      initialLocalCommandTranscriptPromptIds,
    );
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
  await forcePtyStopWithEscalation(pty).catch(() => undefined);
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

async function forcePtyStopWithEscalation(
  pty: { isAlive(): Promise<boolean>; terminate(signal?: NodeJS.Signals): Promise<void> },
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

async function waitForPtyStop(pty: { isAlive(): Promise<boolean> }, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await pty.isAlive())) {
      return true;
    }
    await sleep(50);
  }
  return !(await pty.isAlive());
}

function shouldPublishIntermediateText(text: string, previousText: string | null): boolean {
  return isPublishableIntermediateText(text, previousText);
}
