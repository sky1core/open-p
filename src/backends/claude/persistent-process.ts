import { randomUUID } from 'node:crypto';
import { runAbortableOperation, throwIfAborted } from '../../core/abort.js';
import { EXIT_CODES, OpenPError } from '../../core/errors.js';
import { DEFAULT_TERMINATE_GRACE_MS, shouldTerminateOnAbort } from '../../core/graceful-interrupt.js';
import { parseJsonSchemaText } from '../../core/json-schema.js';
import type { ManagedBackendProcess, ProcessStartRequest } from '../../core/persistent-process.js';
import type {
  AssistantContentBlock,
  AssistantEventSnapshot,
  IntermediateTextSource,
  TurnRequest,
  TurnResult,
} from '../../core/types.js';
import type { LaunchSignature } from '../../core/worker-types.js';
import type { PtyProvider, PtySession } from '../../runners/types.js';
import { rejectStructuredClaudeCodeBackendArgs } from './args-validation.js';
import { ClaudeCodeBackgroundRouter, isClaudeCodeTaskNotificationLine } from './background-parser.js';
import {
  isClaudeCodeEmptyInputPromptLine,
  isClaudeCodeInputPromptLine,
  readinessTimeoutMs,
  waitForClaudeCodeInputReady,
} from './interactive.js';
import {
  findClaudeCodeSessionLog,
  getFileSize,
  isMissingCallerAfterLocalCommandError,
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
  withClaudeCodeSafeLaunchEnv,
} from './launch-safety.js';
import { createClaudePtyInterrupter } from './pty-interrupt.js';
import { assertClaudeCodeBin } from './bin.js';
import { createClaudeSessionLogIdleDebugLogger } from './diagnostics.js';

const PRE_CALLER_LOCAL_COMMAND_PROMPT_RETRY_LIMIT = 1;

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

    const interrupter = createClaudePtyInterrupter(this.pty);
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
        interrupt: () => {
          if (shouldTerminateOnAbort(options.signal)) {
            interrupter.requestForceStop();
            return;
          }
          interrupter.requestGracefulStop();
        },
        getInterruptedDraft: () => this.lastIntermediateReasoningText ?? this.lastIntermediateText,
        operation: async () => {
          const turnDeadlineMs = options.timeoutMs === 0 ? null : Date.now() + options.timeoutMs;
          let retryLogPath: string | null = null;
          let retryInitialOffset: number | null = null;
          for (let attempt = 0; ; attempt += 1) {
            const readinessAttemptTimeoutMs = remainingTurnTimeoutMs(
              turnDeadlineMs,
              request.turnId,
              () => {
                interrupter.requestGracefulStop();
              },
            );
            await waitForClaudeCodeInputReady(this.pty, readinessTimeoutMs(readinessAttemptTimeoutMs));
            if (!this.nativeSessionId && retryLogPath) {
              this.sessionLogPath = retryLogPath;
            }
            this.sessionLogPath = this.nativeSessionId
              ? await findClaudeCodeSessionLog(this.nativeSessionId, this.cwd) ?? this.sessionLogPath
              : this.sessionLogPath;
            const initialOffset = retryInitialOffset !== null &&
              retryLogPath !== null &&
              this.sessionLogPath === retryLogPath
              ? retryInitialOffset
              : await getFileSize(this.sessionLogPath ?? this.expectedLogPath);
            await submitPromptForAttempt(this.pty, prompt, attempt);
            const waitAttemptTimeoutMs = remainingTurnTimeoutMs(
              turnDeadlineMs,
              request.turnId,
              () => {
                interrupter.requestGracefulStop();
              },
            );
            try {
              const result = await waitForClaudeCodeTurnResult({
                sessionId: this.nativeSessionId,
                turnId: request.turnId,
                timeoutMs: waitAttemptTimeoutMs,
                initialOffset,
                knownLogPath: this.sessionLogPath,
                expectedLogPath: this.expectedLogPath,
                cwd: this.cwd,
                discoveryStartedAtMs: this.discoveryStartedAtMs,
                excludedLogPaths: this.excludedLogPaths,
                paceIntermediateEvents: options.paceIntermediateEvents === true,
                structuredOutputRequested: request.jsonSchema !== null && request.jsonSchema !== undefined,
                structuredOutputJsonSchema: request.jsonSchema,
                isBackendAlive: () => this.pty.isAlive(),
                onIntermediateText: (text) => {
                  publishJsonlIntermediateText(text);
                },
                onIntermediateReasoning: (text, source, contentBlocks) => {
                  this.lastIntermediateReasoningText = text;
                  options.onIntermediateReasoning?.(text, source, contentBlocks);
                },
                onIntermediateAssistantSnapshot: options.onIntermediateAssistantSnapshot,
                onSessionLogIdle: createClaudeSessionLogIdleDebugLogger({
                  debugLog: options.debugLog ?? null,
                  backendSessionId: this.sessionId,
                  nativeSessionId: this.nativeSessionId,
                  ptySessionId: this.pty.id,
                }),
                onTimeout: () => {
                  interrupter.requestGracefulStop();
                },
              });
              if (result.sessionId) {
                if (this.nativeSessionId && result.sessionId !== this.nativeSessionId) {
                  throw new OpenPError('Claude Code returned a different session id for resume turn', EXIT_CODES.protocolViolation);
                }
                this.nativeSessionId = result.sessionId;
                this.sessionId = result.sessionId;
              }
              this.sessionLogPath = this.nativeSessionId
                ? await findClaudeCodeSessionLog(this.nativeSessionId, this.cwd) ?? this.sessionLogPath
                : this.sessionLogPath;
              this.lastIntermediateText = null;
              this.lastIntermediateReasoningText = null;
              this.lastCompletedBackgroundCallback = turnBackgroundCallback;
              return result;
            } catch (error) {
              if (
                !isMissingCallerAfterLocalCommandError(error) ||
                attempt >= PRE_CALLER_LOCAL_COMMAND_PROMPT_RETRY_LIMIT
              ) {
                throw error;
              }
              lastPublishedJsonlIntermediate = null;
              this.lastIntermediateText = null;
              this.lastIntermediateReasoningText = null;
              if (!this.nativeSessionId && error.logPath) {
                retryLogPath = error.logPath;
                retryInitialOffset = error.nextOffset;
              }
            }
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
      await this.pty.exit().catch(() => undefined);
      if (await this.pty.isAlive()) {
        await forcePtyStopWithEscalation(this.pty).catch(() => undefined);
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
          ? await findClaudeCodeSessionLog(this.nativeSessionId, this.cwd)
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
  const env = withClaudeCodeSafeLaunchEnv(options.launchSignature.env);
  await assertClaudeCodeBin(options.launchSignature.bin, {
    env,
    isolateAnthropicEnv: true,
    cwd: options.cwd,
  });
  const nativeSessionId = options.resume ? options.sessionId : null;
  const expectedLogPath = nativeSessionId ? resolveClaudeCodeSessionLogPath(nativeSessionId, options.cwd) : null;
  const existingLogPath = nativeSessionId ? await findClaudeCodeSessionLog(nativeSessionId, options.cwd) : null;
  const backgroundOffset = await getFileSize(existingLogPath ?? expectedLogPath);
  const excludedLogPaths = nativeSessionId ? undefined : await snapshotClaudeCodeSessionLogPaths(options.cwd);
  const discoveryStartedAtMs = nativeSessionId ? null : Date.now() - 1000;
  const args = buildPersistentClaudeCodeArgs(options);
  const sessionName = `openp-${options.sessionId.replaceAll('-', '')}-${randomUUID().replaceAll('-', '').slice(0, 8)}`;
  const pty = await options.provider.start(options.launchSignature.bin, args, {
    cwd: options.cwd,
    sessionName,
    env,
    isolateAnthropicEnv: true,
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
  );
  try {
    await waitForClaudeCodeInputReady(pty, readinessTimeoutMs(options.timeoutMs));
    process.startBackgroundWatcher();
    return process;
  } catch (error) {
    await pty.exit().catch(() => undefined);
    if (await pty.isAlive().catch(() => false)) {
      await forcePtyStopWithEscalation(pty).catch(() => undefined);
    }
    if (await pty.isAlive().catch(() => false)) {
      throw new OpenPError(`failed to start Claude Code process and cleanup left session ${options.sessionId} alive`, EXIT_CODES.sessionBusy);
    }
    throw error;
  }
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
    tools: options.launchSignature.tools,
    backendArgs: binArgs,
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

async function submitPromptForAttempt(pty: PtySession, prompt: string, attempt: number): Promise<void> {
  const cursorLine = await pty.captureCursorLine().catch(() => null);
  const reuseExistingDraft = attempt > 0 &&
    cursorLine !== null &&
    isClaudeCodeInputPromptLine(cursorLine) &&
    !isClaudeCodeEmptyInputPromptLine(cursorLine);
  if (!reuseExistingDraft) {
    await pty.write(prompt);
    await sleep(150);
  }
  await pty.submit();
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
