import { randomUUID } from 'node:crypto';
import { runAbortableOperation, throwIfAborted } from '../../core/abort.js';
import { EXIT_CODES, OpenPError } from '../../core/errors.js';
import { DEFAULT_TERMINATE_GRACE_MS, shouldTerminateOnAbort } from '../../core/graceful-interrupt.js';
import { SessionLockStore } from '../../core/session-lock.js';
import { SessionStateStore, validateSessionStateCompatibility } from '../../core/session-state.js';
import type { Backend } from '../../core/backend.js';
import type { BackendRunOptions, TurnRequest, TurnResult } from '../../core/types.js';
import type { PtyProvider, PtySession } from '../../runners/types.js';
import {
  isClaudeCodeEmptyInputPromptLine,
  isClaudeCodeInputPromptLine,
  readinessTimeoutMs,
  waitForClaudeCodeInputReady,
} from './interactive.js';
import { rejectStructuredClaudeCodeBackendArgs } from './args-validation.js';
import {
  findClaudeCodeSessionLog,
  getFileSize,
  isMissingCallerAfterLocalCommandError,
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
  CLAUDE_CODE_BACKGROUND_SUPPRESSION_ENV,
} from './launch-safety.js';
import { createClaudeSessionLogIdleDebugLogger } from './diagnostics.js';

// The non-interactive PTY turn cannot survive tools that outlive the synchronous turn or that block on
// interactive input. openp launches Claude with these suppressed (official contract — see
// src/backends/claude/SPEC.md "Background Suppression"):
// - env CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 removes `run_in_background` / auto-backgrounding.
// - --disallowedTools removes `Monitor`/`Workflow` (background work that outlives the turn) and
//   `AskUserQuestion` (renders a blocking multiple-choice menu the PTY cannot answer → the turn hangs;
//   with it disallowed the model asks via plain answer text instead).
// The disable levers are live-verified
// (.agents/references/ad-hoc/20260530-pty-kickoff-monitor-turn-lifecycle/observations.md §11).

const PRE_CALLER_LOCAL_COMMAND_PROMPT_RETRY_LIMIT = 1;

export class ClaudeCodeBackend implements Backend {
  constructor(private readonly provider: PtyProvider) {}

  async runTurn(request: TurnRequest, options: BackendRunOptions): Promise<TurnResult> {
    const lock = await new SessionLockStore(options.cwd).acquire(options.backendSessionId);
    let primaryError: unknown = null;
    try {
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
      backend: 'claude' as const,
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
    await assertClaudeCodeBin(claudeCodeBin, { cwd: options.cwd, isolateAnthropicEnv: true });
    const nativeSessionId = options.resume ? options.backendSessionId : null;
    const expectedLogPath = nativeSessionId ? resolveClaudeCodeSessionLogPath(nativeSessionId, options.cwd) : null;
    const existingLogPath = nativeSessionId ? await findClaudeCodeSessionLog(nativeSessionId, options.cwd) : null;
    const excludedLogPaths = nativeSessionId ? undefined : await snapshotClaudeCodeSessionLogPaths(options.cwd);
    const discoveryStartedAtMs = nativeSessionId ? null : Date.now() - 1000;
    const args = buildClaudeCodeArgs(options);
    // Use the FULL normalized backend session id (not a 12-char prefix) so the reaper's
    // `openp-<sessionId>-` prefix is unique per session and matches the full-id per-session lock.
    const sessionName = `openp-${options.backendSessionId.replaceAll('-', '')}-${randomUUID().replaceAll('-', '').slice(0, 8)}`;
    const pty = await this.provider.start(claudeCodeBin, args, {
      cwd: options.cwd,
      sessionName,
      env: CLAUDE_CODE_BACKGROUND_SUPPRESSION_ENV,
      isolateAnthropicEnv: true,
    });

    let primaryError: unknown = null;
    const interrupter = createClaudePtyInterrupter(pty);
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
        interrupt: () => {
          if (shouldTerminateOnAbort(options.signal)) {
            interrupter.requestForceStop();
            return;
          }
          interrupter.requestGracefulStop();
        },
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
            await waitForClaudeCodeInputReady(pty, readinessTimeoutMs(readinessAttemptTimeoutMs));
            const activeLogPath = nativeSessionId
              ? await findClaudeCodeSessionLog(nativeSessionId, options.cwd) ?? existingLogPath
              : retryLogPath ?? existingLogPath;
            const initialOffset = retryInitialOffset !== null &&
              retryLogPath !== null &&
              activeLogPath === retryLogPath
              ? retryInitialOffset
              : await getFileSize(activeLogPath ?? expectedLogPath);
            let lastPublishedIntermediate: string | null = null;
            const publishIntermediateText = (text: string): void => {
              if (!shouldPublishIntermediateText(text, lastPublishedIntermediate)) {
                return;
              }
              lastPublishedIntermediate = text;
              options.onIntermediateText!(text, 'jsonl');
            };
            await submitPromptForAttempt(pty, request.prompt, attempt);
            const waitAttemptTimeoutMs = remainingTurnTimeoutMs(
              turnDeadlineMs,
              request.turnId,
              () => {
                interrupter.requestGracefulStop();
              },
            );
            try {
              const result = await waitForClaudeCodeTurnResult({
                sessionId: nativeSessionId,
                turnId: request.turnId,
                timeoutMs: waitAttemptTimeoutMs,
                initialOffset,
                knownLogPath: activeLogPath,
                expectedLogPath,
                cwd: options.cwd,
                discoveryStartedAtMs,
                excludedLogPaths,
                paceIntermediateEvents: options.paceIntermediateEvents === true,
                structuredOutputRequested: request.jsonSchema !== null && request.jsonSchema !== undefined,
                structuredOutputJsonSchema: request.jsonSchema,
                isBackendAlive: () => pty.isAlive(),
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
                onSessionLogIdle: createClaudeSessionLogIdleDebugLogger({
                  debugLog: options.debugLog,
                  backendSessionId: options.backendSessionId,
                  nativeSessionId,
                  ptySessionId: pty.id,
                }),
                onTimeout: () => {
                  interrupter.requestGracefulStop();
                },
              });
              return result;
            } catch (error) {
              if (
                !isMissingCallerAfterLocalCommandError(error) ||
                attempt >= PRE_CALLER_LOCAL_COMMAND_PROMPT_RETRY_LIMIT
              ) {
                throw error;
              }
              if (nativeSessionId === null && error.logPath) {
                retryLogPath = error.logPath;
                retryInitialOffset = error.nextOffset;
              }
            }
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
        sessionLogPath: await findClaudeCodeSessionLog(resultSessionId, options.cwd) ?? expectedLogPath,
        lastTurnId: request.turnId,
      });
      return {
        ...result,
        sessionId: resultSessionId,
      };
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      try {
        await exitPtyAfterTurn(pty, primaryError);
      } finally {
        interrupter.clear();
        options.forceSignal?.removeEventListener('abort', forceHandler);
        options.killSignal?.removeEventListener('abort', killHandler);
      }
    }
  }
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
    tools: options.tools,
    backendArgs: options.backendArgs,
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

export async function exitPtyAfterTurn(
  pty: {
    exit(): Promise<void>;
    isAlive?(): Promise<boolean>;
    interrupt?(): Promise<void>;
    terminate(signal?: NodeJS.Signals): Promise<void>;
  },
  primaryError: unknown,
  terminateGraceMs = DEFAULT_TERMINATE_GRACE_MS,
): Promise<void> {
  let exitError: unknown = null;
  let forceError: unknown = null;
  try {
    await pty.exit();
  } catch (error) {
    exitError = error;
  }

  if (primaryError !== null && await isPtyAlive(pty)) {
    try {
      await forcePtyStopWithEscalation(pty, terminateGraceMs);
    } catch (error) {
      forceError = error;
    }
  }

  if (exitError !== null && primaryError === null) {
    throw exitError;
  }
  if (forceError !== null && primaryError === null) {
    throw forceError;
  }
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
