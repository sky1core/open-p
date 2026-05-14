import { randomUUID } from 'node:crypto';
import { runAbortableOperation, throwIfAborted } from '../../core/abort.js';
import { execFileText } from '../../core/command.js';
import { EXIT_CODES, OpenPError } from '../../core/errors.js';
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
import { ClaudeCodeBackgroundRouter, isClaudeCodeTaskNotificationLine } from './background-parser.js';
import { readinessTimeoutMs, waitForClaudeCodeInputReady } from './interactive.js';
import {
  findClaudeCodeSessionLog,
  getFileSize,
  readNewText,
  resolveClaudeCodeSessionLogPath,
  waitForClaudeCodeTurnResult,
} from './session-log.js';
import { resolveInteractivePermissionMode } from './permission-mode.js';
import { shouldPublishPrefixIntermediate } from './screen-monitor.js';
import { withThinkingSummariesSettings } from './settings.js';

export interface StartPersistentClaudeCodeProcessOptions extends ProcessStartRequest {
  readonly cwd: string;
  readonly provider: PtyProvider;
  readonly appendSystemPrompt: string | null;
  readonly timeoutMs: number;
}

export interface PersistentClaudeCodeTurnOptions {
  readonly timeoutMs: number;
  readonly jsonSchema?: string | null;
  readonly paceIntermediateEvents?: boolean;
  readonly signal?: AbortSignal;
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

  constructor(
    readonly sessionId: string,
    readonly launchSignature: LaunchSignature,
    private readonly cwd: string,
    private readonly pty: PtySession,
    private sessionLogPath: string | null,
    private readonly expectedLogPath: string,
    private backgroundOffset: number,
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

    return runAbortableOperation({
      signal: options.signal,
      interrupt: () => this.pty.interrupt(),
      getInterruptedDraft: () => this.lastIntermediateReasoningText ?? this.lastIntermediateText,
      operation: async () => {
        await waitForClaudeCodeInputReady(this.pty, readinessTimeoutMs(options.timeoutMs));
        this.sessionLogPath = await findClaudeCodeSessionLog(this.sessionId, this.cwd) ?? this.sessionLogPath;
        const initialOffset = await getFileSize(this.sessionLogPath ?? this.expectedLogPath);
        await this.pty.write(prompt);
        await sleep(150);
        await this.pty.submit();
        const result = await waitForClaudeCodeTurnResult({
          sessionId: this.sessionId,
          turnId: request.turnId,
          timeoutMs: options.timeoutMs,
          initialOffset,
          knownLogPath: this.sessionLogPath,
          expectedLogPath: this.expectedLogPath,
          cwd: this.cwd,
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
        });
        this.sessionLogPath = await findClaudeCodeSessionLog(this.sessionId, this.cwd) ?? this.sessionLogPath;
        this.lastIntermediateText = null;
        this.lastIntermediateReasoningText = null;
        this.lastCompletedBackgroundCallback = turnBackgroundCallback;
        return result;
      },
    }).finally(() => {
      if (this.activeTurn?.turnId === request.turnId) {
        this.activeTurn = null;
      }
    });
  }

  async isAlive(): Promise<boolean> {
    return this.pty.isAlive();
  }

  async shutdown(): Promise<void> {
    this.backgroundStopped = true;
    await this.pty.exit();
    await this.backgroundWatchPromise?.catch(() => undefined);
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
        this.sessionLogPath = await findClaudeCodeSessionLog(this.sessionId, this.cwd);
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
}

export async function startPersistentClaudeCodeProcess(
  options: StartPersistentClaudeCodeProcessOptions,
): Promise<PersistentClaudeCodeProcess> {
  await execFileText(options.launchSignature.bin, ['--version'], {
    env: options.launchSignature.env,
    isolateAnthropicEnv: options.launchSignature.local,
  });
  const expectedLogPath = resolveClaudeCodeSessionLogPath(options.sessionId, options.cwd);
  const existingLogPath = await findClaudeCodeSessionLog(options.sessionId, options.cwd);
  const backgroundOffset = await getFileSize(existingLogPath ?? expectedLogPath);
  const args = buildPersistentClaudeCodeArgs(options);
  const sessionName = `openp-${options.sessionId.replaceAll('-', '').slice(0, 12)}-${randomUUID().replaceAll('-', '').slice(0, 8)}`;
  const pty = await options.provider.start(options.launchSignature.bin, args, {
    cwd: options.cwd,
    sessionName,
    env: options.launchSignature.env,
    isolateAnthropicEnv: options.launchSignature.local,
  });
  const process = new PersistentClaudeCodeProcess(
    options.sessionId,
    options.launchSignature,
    options.cwd,
    pty,
    existingLogPath,
    expectedLogPath,
    backgroundOffset,
  );
  try {
    await waitForClaudeCodeInputReady(pty, readinessTimeoutMs(options.timeoutMs));
    process.startBackgroundWatcher();
    return process;
  } catch (error) {
    await pty.exit().catch(() => undefined);
    if (await pty.isAlive().catch(() => false)) {
      throw new OpenPError(`failed to start Claude Code process and graceful cleanup left session ${options.sessionId} alive`, EXIT_CODES.sessionBusy);
    }
    throw error;
  }
}

export function buildPersistentClaudeCodeArgs(options: {
  readonly sessionId: string;
  readonly resume: boolean;
  readonly cwd: string;
  readonly launchSignature: LaunchSignature;
  readonly appendSystemPrompt: string | null;
}, extraArgs: readonly string[] = []): string[] {
  const args: string[] = [];
  const binArgs = options.launchSignature.binArgs.filter((arg) => arg !== '--verbose' && arg !== '--brief');
  if (options.resume) {
    args.push('--resume', options.sessionId);
  } else {
    args.push('--session-id', options.sessionId);
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
    backendArgs: binArgs,
  });
  if (permissionMode) {
    args.push('--permission-mode', permissionMode);
  }
  if (options.launchSignature.jsonSchema) {
    args.push('--json-schema', options.launchSignature.jsonSchema);
  }
  args.push(...withThinkingSummariesSettings(
    [...binArgs, ...extraArgs],
    options.cwd,
  ));
  if (options.appendSystemPrompt?.trim()) {
    args.push('--append-system-prompt', options.appendSystemPrompt.trim());
  }
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

function shouldPublishIntermediateText(text: string, previousText: string | null): boolean {
  return shouldPublishPrefixIntermediate(text, previousText);
}
