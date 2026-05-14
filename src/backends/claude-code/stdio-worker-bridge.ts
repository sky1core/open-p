import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { createAbortError, throwIfAborted } from '../../core/abort.js';
import { buildChildEnv, execFileText } from '../../core/command.js';
import { EXIT_CODES, OpenPError } from '../../core/errors.js';
import { buildLaunchSignature } from '../../core/launch-signature.js';
import { PersistentProcessManager, type ManagedBackendProcess, type ProcessStartRequest } from '../../core/persistent-process.js';
import { parseStreamJsonLines } from '../../core/stream-json-parser.js';
import { prepareWorkerTurnInput } from '../../core/worker-input.js';
import type { LaunchSignature, WorkerTurnRequest, WorkerTurnResult } from '../../core/worker-types.js';
import { resolveClaudeCodeBin } from './bin.js';
import { resolveInteractivePermissionMode } from './permission-mode.js';
import { withThinkingSummariesSettings } from './settings.js';

interface StdioChild {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly killed: boolean;
  readonly exitCode: number | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: 'error', listener: (error: Error) => void): this;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
}

export interface ClaudeCodeStdioWorkerProcessStartRequest extends ProcessStartRequest {
  readonly cwd: string;
  readonly timeoutMs: number;
}

export type ClaudeCodeStdioSpawner = (
  command: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
  },
) => StdioChild;

export type ClaudeCodeStdioWorkerStarter = (
  request: ClaudeCodeStdioWorkerProcessStartRequest,
) => Promise<ClaudeCodeStdioWorkerProcess>;

export class ClaudeCodeStdioWorkerBridge {
  private readonly manager: PersistentProcessManager<ClaudeCodeStdioWorkerProcess>;

  constructor(
    manager?: PersistentProcessManager<ClaudeCodeStdioWorkerProcess>,
    private readonly startProcess: ClaudeCodeStdioWorkerStarter = startClaudeCodeStdioWorkerProcess,
  ) {
    this.manager = manager ?? new PersistentProcessManager<ClaudeCodeStdioWorkerProcess>();
  }

  async runTurn(request: WorkerTurnRequest): Promise<WorkerTurnResult> {
    throwIfAborted(request.signal);
    const backendSessionId = request.sessionId ?? randomUUID();
    const preparedInput = prepareWorkerTurnInput(request);
    const launchSignature = buildLaunchSignature({
      backendId: 'claude-code',
      bin: request.bin ?? resolveClaudeCodeBin(),
      binArgs: request.binArgs ?? [],
      model: request.model ?? null,
      reasoningEffort: request.reasoningEffort ?? null,
      executionMode: request.executionMode ?? null,
      appendSystemPrompt: request.appendSystemPrompt ?? null,
      jsonSchema: request.jsonSchema ?? null,
      env: request.env ?? {},
      local: request.local ?? false,
    });

    return this.manager.runExclusive(backendSessionId, async () => {
      const process = await this.manager.getOrStart(
        backendSessionId,
        launchSignature,
        !preparedInput.isFirstTurn,
        (startRequest) => this.startProcess({
          ...startRequest,
          cwd: request.projectRoot,
          timeoutMs: request.timeoutMs ?? 120_000,
        }),
      );
      try {
        return await process.sendTurn(preparedInput.prompt, request);
      } catch (error) {
        await this.manager.discard(backendSessionId, process).catch(() => undefined);
        throw error;
      }
    });
  }

  async isChildAliveForSession(sessionId: string): Promise<boolean> {
    return this.manager.isAliveForSession(sessionId);
  }

  async shutdown(): Promise<void> {
    await this.manager.shutdownAll();
  }
}

export class ClaudeCodeStdioWorkerProcess implements ManagedBackendProcess {
  private readonly stdoutLines: string[] = [];
  private stderrText = '';
  private stdoutLoop: Promise<void>;
  private activeTurn: ActiveTurn | null = null;
  private exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;

  constructor(
    readonly sessionId: string,
    readonly launchSignature: LaunchSignature,
    private readonly cwd: string,
    private readonly child: StdioChild,
  ) {
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string | Buffer) => {
      this.stderrText += String(chunk);
    });
    child.once('exit', (code, signal) => {
      this.exited = { code, signal };
      this.rejectActiveTurn(new OpenPError(
        `Claude CLI process exited unexpectedly (${signal ?? `code ${code}`})${this.stderrText.trim() ? `: ${this.stderrText.trim()}` : ''}`,
        EXIT_CODES.backendExited,
      ));
    });
    child.once('error', (error) => {
      this.rejectActiveTurn(error);
    });
    this.stdoutLoop = this.readStdout();
  }

  async sendTurn(prompt: string, request: WorkerTurnRequest): Promise<WorkerTurnResult> {
    throwIfAborted(request.signal);
    if (this.activeTurn !== null) {
      throw new OpenPError(`session ${this.sessionId} is busy`, EXIT_CODES.sessionBusy);
    }
    if (!(await this.isAlive())) {
      throw new OpenPError(`Claude CLI process is not alive for session ${this.sessionId}`, EXIT_CODES.backendExited);
    }

    const timeoutMs = request.timeoutMs ?? 120_000;
    const turn: ActiveTurn = {
      startedAt: Date.now(),
      startLineIndex: this.stdoutLines.length,
      text: '',
      reasoningText: '',
      intermediateTextCount: 0,
      request,
      timer: null,
      resolve: () => undefined,
      reject: () => undefined,
    };
    this.activeTurn = turn;

    const promise = new Promise<WorkerTurnResult>((resolve, reject) => {
      turn.resolve = resolve;
      turn.reject = reject;
    });

    const abortHandler = (): void => {
      this.child.kill('SIGTERM');
      this.rejectActiveTurn(createAbortError());
    };
    request.signal?.addEventListener('abort', abortHandler, { once: true });
    if (timeoutMs > 0) {
      turn.timer = setTimeout(() => {
        this.child.kill('SIGTERM');
        this.rejectActiveTurn(new OpenPError(
          `timed out waiting for Claude Code stream-json result after ${timeoutMs}ms`,
          EXIT_CODES.timeout,
        ));
      }, timeoutMs);
    }

    try {
      this.child.stdin.write(`${JSON.stringify(buildUserInputEvent(prompt))}\n`);
      return await promise;
    } finally {
      if (turn.timer !== null) {
        clearTimeout(turn.timer);
      }
      request.signal?.removeEventListener('abort', abortHandler);
      if (this.activeTurn === turn) {
        this.activeTurn = null;
      }
    }
  }

  async isAlive(): Promise<boolean> {
    return this.exited === null && !this.child.killed && this.child.exitCode === null;
  }

  async shutdown(): Promise<void> {
    if (this.activeTurn) {
      this.rejectActiveTurn(createAbortError('operation aborted during shutdown'));
    }
    this.child.stdin.end();
    if (await this.isAlive()) {
      this.child.kill('SIGTERM');
    }
    await this.stdoutLoop.catch(() => undefined);
  }

  private async readStdout(): Promise<void> {
    const lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    for await (const line of lines) {
      this.stdoutLines.push(line);
      this.consumeLine(line);
    }
  }

  private consumeLine(line: string): void {
    const turn = this.activeTurn;
    if (!turn) {
      return;
    }
    const event = parseJsonObject(line);
    if (!event) {
      return;
    }
    publishStructuredDelta(turn, event);
    if (event.type === 'result') {
      this.resolveActiveTurnFromResult(turn);
    }
  }

  private resolveActiveTurnFromResult(turn: ActiveTurn): void {
    const lines = this.stdoutLines.slice(turn.startLineIndex);
    let parsed;
    try {
      parsed = parseStreamJsonLines(lines, {
        contextWindow: resolveRequestContextWindow(turn.request),
        contextWindowsByModel: turn.request.contextWindowsByModel,
      });
    } catch (error) {
      this.rejectSpecificTurn(turn, error);
      return;
    }
    if (!parsed) {
      this.rejectSpecificTurn(turn, new OpenPError('Claude stream-json result did not contain final content', EXIT_CODES.protocolViolation));
      return;
    }
    for (const text of parsed.backgroundTexts) {
      turn.request.onBackgroundAssistantText?.(text);
    }
    const sessionId = parsed.sessionId ?? this.sessionId;
    const result: WorkerTurnResult = {
      content: parsed.content,
      reasoningContent: parsed.reasoningContent,
      ...(parsed.structuredOutput !== undefined ? { structuredOutput: parsed.structuredOutput } : {}),
      sessionId,
      diagnostics: {
        ...parsed.diagnostics,
        contextWindow: resolveRequestContextWindow(turn.request),
        intermediateTextCount: turn.intermediateTextCount,
      },
    };
    this.resolveSpecificTurn(turn, result);
  }

  private resolveSpecificTurn(turn: ActiveTurn, result: WorkerTurnResult): void {
    if (this.activeTurn === turn) {
      this.activeTurn = null;
    }
    turn.resolve(result);
  }

  private rejectSpecificTurn(turn: ActiveTurn, error: unknown): void {
    if (this.activeTurn === turn) {
      this.activeTurn = null;
    }
    turn.reject(error);
  }

  private rejectActiveTurn(error: unknown): void {
    const turn = this.activeTurn;
    if (!turn) {
      return;
    }
    this.activeTurn = null;
    turn.reject(error);
  }
}

export async function startClaudeCodeStdioWorkerProcess(
  request: ClaudeCodeStdioWorkerProcessStartRequest,
  spawnClaude: ClaudeCodeStdioSpawner = defaultSpawnClaudeCode,
): Promise<ClaudeCodeStdioWorkerProcess> {
  await execFileText(request.launchSignature.bin, ['--version'], {
    env: request.launchSignature.env,
    isolateAnthropicEnv: request.launchSignature.local,
  });
  const args = buildClaudeCodeStdioWorkerArgs({
    sessionId: request.sessionId,
    resume: request.resume,
    cwd: request.cwd,
    launchSignature: request.launchSignature,
  });
  const child = spawnClaude(request.launchSignature.bin, args, {
    cwd: request.cwd,
    env: buildChildEnv(request.launchSignature.env, request.launchSignature.local),
  });
  return new ClaudeCodeStdioWorkerProcess(
    request.sessionId,
    request.launchSignature,
    request.cwd,
    child,
  );
}

export function buildClaudeCodeStdioWorkerArgs(options: {
  readonly sessionId: string;
  readonly resume: boolean;
  readonly cwd: string;
  readonly launchSignature: LaunchSignature;
}): string[] {
  const args: string[] = [];
  if (options.resume) {
    args.push('--resume', options.sessionId);
  } else {
    args.push('--session-id', options.sessionId);
  }
  args.push(
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
  );
  if (options.launchSignature.model) {
    args.push('--model', options.launchSignature.model);
  }
  if (options.launchSignature.reasoningEffort) {
    args.push('--effort', options.launchSignature.reasoningEffort);
  }
  const binArgs = filterCallerBackendArgs(options.launchSignature.binArgs);
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
  args.push(...withThinkingSummariesSettings(binArgs, options.cwd));
  if (options.launchSignature.appendSystemPrompt?.trim()) {
    args.push('--append-system-prompt', options.launchSignature.appendSystemPrompt.trim());
  }
  return args;
}

function filterCallerBackendArgs(args: readonly string[]): string[] {
  const output: string[] = [];
  const valueFlags = new Set(['--input-format', '--output-format']);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '-p' || arg === '--print' || arg === '--verbose' || arg === '--include-partial-messages') {
      continue;
    }
    if (valueFlags.has(arg)) {
      index += 1;
      continue;
    }
    output.push(arg);
  }
  return output;
}

function defaultSpawnClaudeCode(
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
): ChildProcessWithoutNullStreams {
  return spawn(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

interface ActiveTurn {
  readonly startedAt: number;
  readonly startLineIndex: number;
  text: string;
  reasoningText: string;
  intermediateTextCount: number;
  readonly request: WorkerTurnRequest;
  timer: NodeJS.Timeout | null;
  resolve: (result: WorkerTurnResult) => void;
  reject: (error: unknown) => void;
}

function buildUserInputEvent(prompt: string): Record<string, unknown> {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: prompt,
    },
  };
}

function publishStructuredDelta(turn: ActiveTurn, event: Record<string, unknown>): void {
  const streamEvent = asObject(event.event);
  if (event.type !== 'stream_event' || !streamEvent || streamEvent.type !== 'content_block_delta') {
    return;
  }
  const delta = asObject(streamEvent.delta);
  if (!delta || typeof delta.type !== 'string') {
    return;
  }
  if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text.length > 0) {
    turn.text += delta.text;
    turn.intermediateTextCount += 1;
    turn.request.onIntermediateText?.(turn.text, 'jsonl');
    return;
  }
  if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking.length > 0) {
    turn.reasoningText += delta.thinking;
    turn.request.onIntermediateReasoning?.(turn.reasoningText, 'jsonl');
  }
}

function parseJsonObject(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith('{')) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return asObject(parsed);
  } catch {
    return null;
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function resolveRequestContextWindow(request: WorkerTurnRequest): number | null {
  if (request.model && request.contextWindowsByModel && Number.isFinite(request.contextWindowsByModel[request.model])) {
    return request.contextWindowsByModel[request.model]!;
  }
  return typeof request.contextWindow === 'number' && Number.isFinite(request.contextWindow) ? request.contextWindow : null;
}
