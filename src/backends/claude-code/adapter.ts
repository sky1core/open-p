import { randomUUID } from 'node:crypto';
import { runAbortableOperation, throwIfAborted } from '../../core/abort.js';
import { execFileText } from '../../core/command.js';
import { SessionLockStore } from '../../core/session-lock.js';
import { SessionStateStore, validateSessionStateCompatibility } from '../../core/session-state.js';
import type { BackendRunOptions, TurnRequest, TurnResult } from '../../core/types.js';
import type { PtyProvider } from '../../runners/types.js';
import { readinessTimeoutMs, waitForClaudeCodeInputReady } from './interactive.js';
import {
  findClaudeCodeSessionLog,
  getFileSize,
  resolveClaudeCodeSessionLogPath,
  waitForClaudeCodeTurnResult,
} from './session-log.js';
import { resolveClaudeCodeBin } from './bin.js';
import { resolveInteractivePermissionMode } from './permission-mode.js';
import { shouldPublishPrefixIntermediate } from './screen-monitor.js';
import { withThinkingSummariesSettings } from './settings.js';

export class ClaudeCodeBackend {
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
      backend: 'claude-code' as const,
      provider: options.provider,
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
    await execFileText(claudeCodeBin, ['--version']);
    const expectedLogPath = resolveClaudeCodeSessionLogPath(options.backendSessionId, options.cwd);
    const existingLogPath = await findClaudeCodeSessionLog(options.backendSessionId, options.cwd);
    const args = buildClaudeCodeArgs(options);
    const sessionName = `openp-${options.backendSessionId.replaceAll('-', '').slice(0, 12)}-${randomUUID().replaceAll('-', '').slice(0, 8)}`;
    const pty = await this.provider.start(claudeCodeBin, args, {
      cwd: options.cwd,
      sessionName,
    });

    let primaryError: unknown = null;
    try {
      await stateStore.save({
        ...expectedState,
        lastProviderSessionId: pty.id,
        sessionLogPath: existingLogPath,
        lastTurnId: existingState?.lastTurnId ?? null,
      });
      const result = await runAbortableOperation({
        signal: options.signal,
        interrupt: () => pty.interrupt(),
        operation: async () => {
          await waitForClaudeCodeInputReady(pty, readinessTimeoutMs(options.timeoutMs));
          const activeLogPath = await findClaudeCodeSessionLog(options.backendSessionId, options.cwd) ?? existingLogPath;
          const initialOffset = await getFileSize(activeLogPath ?? expectedLogPath);
          let lastPublishedIntermediate: string | null = null;
          const publishIntermediateText = (text: string): void => {
            if (!shouldPublishIntermediateText(text, lastPublishedIntermediate)) {
              return;
            }
            lastPublishedIntermediate = text;
            options.onIntermediateText?.(text, 'jsonl');
          };
          await pty.write(request.prompt);
          await sleep(150);
          await pty.submit();
          const result = await waitForClaudeCodeTurnResult({
            sessionId: options.backendSessionId,
            turnId: request.turnId,
            timeoutMs: options.timeoutMs,
            initialOffset,
            knownLogPath: activeLogPath,
            expectedLogPath,
            cwd: options.cwd,
            paceIntermediateEvents: options.paceIntermediateEvents === true,
            structuredOutputRequested: request.jsonSchema !== null && request.jsonSchema !== undefined,
            structuredOutputJsonSchema: request.jsonSchema,
            isBackendAlive: () => pty.isAlive(),
            onIntermediateText: (text) => {
              publishIntermediateText(text);
            },
            onIntermediateReasoning: options.onIntermediateReasoning
              ? (text, source, contentBlocks) => {
                  options.onIntermediateReasoning!(text, source, contentBlocks);
                }
              : undefined,
            onIntermediateAssistantSnapshot: options.onIntermediateAssistantSnapshot,
          });
          return result;
        },
      });
      await stateStore.save({
        ...expectedState,
        lastProviderSessionId: pty.id,
        sessionLogPath: await findClaudeCodeSessionLog(options.backendSessionId, options.cwd) ?? expectedLogPath,
        lastTurnId: request.turnId,
      });
      return result;
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      await exitPtyAfterTurn(pty, primaryError);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldPublishIntermediateText(text: string, previousText: string | null): boolean {
  return shouldPublishPrefixIntermediate(text, previousText);
}

export function buildClaudeCodeArgs(options: BackendRunOptions, extraArgs: readonly string[] = []): string[] {
  const args: string[] = [];
  if (options.resume) {
    args.push('--resume', options.backendSessionId);
  } else {
    args.push('--session-id', options.backendSessionId);
  }
  if (options.model) {
    args.push('--model', options.model);
  }
  const permissionMode = resolveInteractivePermissionMode({
    permissionMode: options.permissionMode,
    backendArgs: options.backendArgs,
  });
  if (permissionMode) {
    args.push('--permission-mode', permissionMode);
  }
  if (options.jsonSchema) {
    args.push('--json-schema', options.jsonSchema);
  }
  args.push(...withThinkingSummariesSettings(
    [...options.backendArgs, ...extraArgs],
    options.cwd,
  ));
  if (options.appendSystemPrompt?.trim()) {
    args.push('--append-system-prompt', options.appendSystemPrompt.trim());
  }
  return args;
}

export async function exitPtyAfterTurn(pty: { exit(): Promise<void> }, primaryError: unknown): Promise<void> {
  try {
    await pty.exit();
  } catch (exitError) {
    if (primaryError === null) {
      throw exitError;
    }
  }
}
