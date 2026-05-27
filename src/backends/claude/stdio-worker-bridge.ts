import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { createAbortError, throwIfAborted } from '../../core/abort.js';
import { buildChildEnv } from '../../core/command.js';
import { EXIT_CODES, OpenPError } from '../../core/errors.js';
import { GracefulInterrupt, shouldTerminateOnAbort } from '../../core/graceful-interrupt.js';
import { buildLaunchSignature } from '../../core/launch-signature.js';
import { PersistentProcessManager, type ManagedBackendProcess, type ProcessStartRequest } from '../../core/persistent-process.js';
import { parseStreamJsonLines } from '../../core/stream-json-parser.js';
import { prepareWorkerTurnInput } from '../../core/worker-input.js';
import type { BackendWorkerBridge } from '../../core/backend.js';
import type { LaunchSignature, WorkerTurnRequest, WorkerTurnResult } from '../../core/worker-types.js';
import { rejectStructuredClaudeCodeBackendArgs } from './args-validation.js';
import { assertClaudeCodeBin, resolveClaudeCodeBin } from './bin.js';
import { resolveInteractivePermissionMode } from './permission-mode.js';
import { withThinkingSummariesSettings } from './settings.js';
import { buildClaudeToolsArgs } from './tools.js';

const DEFAULT_SHUTDOWN_EOF_GRACE_MS = 50;
const DEFAULT_SHUTDOWN_STDOUT_CLOSE_EXIT_GRACE_MS = 5000;
const DEFAULT_SHUTDOWN_TERMINATE_GRACE_MS = 5000;
const DEFAULT_SHUTDOWN_KILL_GRACE_MS = 1000;

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

export class ClaudeCodeStdioWorkerBridge implements BackendWorkerBridge {
  private readonly manager: PersistentProcessManager<ClaudeCodeStdioWorkerProcess>;

  constructor(
    manager?: PersistentProcessManager<ClaudeCodeStdioWorkerProcess>,
    private readonly startProcess: ClaudeCodeStdioWorkerStarter = startClaudeCodeStdioWorkerProcess,
  ) {
    this.manager = manager ?? new PersistentProcessManager<ClaudeCodeStdioWorkerProcess>();
  }

  async runTurn(request: WorkerTurnRequest): Promise<WorkerTurnResult> {
    throwIfAborted(request.signal);
    const preparedInput = prepareWorkerTurnInput(request);
    if (!preparedInput.isFirstTurn && !request.sessionId) {
      throw new OpenPError('Claude Code resume requires a session id', EXIT_CODES.usage);
    }
    const backendSessionId = preparedInput.isFirstTurn ? randomUUID() : request.sessionId!;
    const launchSignature = buildLaunchSignature({
      backendId: 'claude',
      bin: request.bin ?? resolveClaudeCodeBin(),
      binArgs: request.binArgs ?? [],
      model: request.model ?? null,
      reasoningEffort: request.reasoningEffort ?? null,
      executionMode: request.executionMode ?? null,
      tools: request.tools ?? null,
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
          timeoutMs: request.timeoutMs ?? 0,
        }),
      );
      try {
        const result = await process.sendTurn(preparedInput.prompt, {
          ...request,
          isFirstTurn: preparedInput.isFirstTurn,
        });
        this.manager.rekey(backendSessionId, result.sessionId, process);
        return result;
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
  private readonly exitPromise: Promise<void>;
  private readonly stdoutClosedPromise: Promise<void>;
  private resolveExit: () => void = () => undefined;
  private resolveStdoutClosed: () => void = () => undefined;
  private stdoutClosed = false;
  private activeTurn: ActiveTurn | null = null;
  private exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;

  constructor(
    public sessionId: string,
    readonly launchSignature: LaunchSignature,
    private readonly cwd: string,
    private readonly child: StdioChild,
    private readonly shutdownTiming: {
      readonly eofGraceMs?: number;
      readonly stdoutCloseExitGraceMs?: number;
      readonly terminateGraceMs?: number;
      readonly killGraceMs?: number;
    } = {},
  ) {
    this.exitPromise = new Promise<void>((resolve) => {
      this.resolveExit = resolve;
    });
    this.stdoutClosedPromise = new Promise<void>((resolve) => {
      this.resolveStdoutClosed = resolve;
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string | Buffer) => {
      this.stderrText += String(chunk);
    });
    child.once('exit', (code, signal) => {
      this.exited = { code, signal };
      this.resolveExit();
      if (this.activeTurn?.timeoutError) {
        this.rejectActiveTurn(this.activeTurn.timeoutError);
        return;
      }
      if (this.activeTurn?.aborted) {
        this.rejectActiveTurn(createAbortError());
        return;
      }
      this.rejectActiveTurn(new OpenPError(
        `Claude CLI process exited unexpectedly (${signal ?? `code ${code}`})${this.stderrText.trim() ? `: ${this.stderrText.trim()}` : ''}`,
        EXIT_CODES.backendExited,
      ));
    });
    child.once('error', (error) => {
      this.resolveExit();
      this.rejectActiveTurn(error);
    });
    this.stdoutLoop = this.readStdout().finally(() => {
      this.stdoutClosed = true;
      this.resolveStdoutClosed();
    });
  }

  async sendTurn(prompt: string, request: WorkerTurnRequest): Promise<WorkerTurnResult> {
    throwIfAborted(request.signal);
    if (this.activeTurn !== null) {
      throw new OpenPError(`session ${this.sessionId} is busy`, EXIT_CODES.sessionBusy);
    }
    if (!(await this.isAlive())) {
      throw new OpenPError(`Claude CLI process is not alive for session ${this.sessionId}`, EXIT_CODES.backendExited);
    }

    const timeoutMs = request.timeoutMs ?? 0;
    const turn: ActiveTurn = {
      startedAt: Date.now(),
      startLineIndex: this.stdoutLines.length,
      text: '',
      reasoningText: '',
      intermediateTextCount: 0,
      request,
      timer: null,
      aborted: false,
      timeoutError: null,
      resolve: () => undefined,
      reject: () => undefined,
      streamMessage: null,
    };
    this.activeTurn = turn;

    const promise = new Promise<WorkerTurnResult>((resolve, reject) => {
      turn.resolve = resolve;
      turn.reject = reject;
    });
    const interrupter = new GracefulInterrupt({
      isAlive: () => this.exited === null && this.child.exitCode === null,
      sendSignal: (signal) => {
        this.child.kill(signal);
      },
    });

    const abortHandler = (): void => {
      if (turn.timeoutError) {
        interrupter.requestForceStop();
        return;
      }
      turn.aborted = true;
      if (turn.timer !== null) {
        clearTimeout(turn.timer);
        turn.timer = null;
      }
      if (shouldTerminateOnAbort(request.signal)) {
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
    if (request.signal) {
      if (request.signal.aborted) {
        abortHandler();
      } else {
        request.signal.addEventListener('abort', abortHandler, { once: true });
      }
    }
    if (request.forceSignal) {
      if (request.forceSignal.aborted) {
        forceHandler();
      } else {
        request.forceSignal.addEventListener('abort', forceHandler, { once: true });
      }
    }
    if (request.killSignal) {
      if (request.killSignal.aborted) {
        killHandler();
      } else {
        request.killSignal.addEventListener('abort', killHandler, { once: true });
      }
    }
    if (timeoutMs > 0) {
      turn.timer = setTimeout(() => {
        turn.timeoutError = new OpenPError(
          `timed out waiting for Claude Code stream-json result after ${timeoutMs}ms`,
          EXIT_CODES.timeout,
        );
        interrupter.requestGracefulStop();
      }, timeoutMs);
    }

    try {
      this.child.stdin.write(`${JSON.stringify(buildUserInputEvent(prompt))}\n`);
      return await promise;
    } finally {
      if (turn.timer !== null) {
        clearTimeout(turn.timer);
      }
      interrupter.clear();
      request.signal?.removeEventListener('abort', abortHandler);
      request.forceSignal?.removeEventListener('abort', forceHandler);
      request.killSignal?.removeEventListener('abort', killHandler);
      if (this.activeTurn === turn) {
        this.activeTurn = null;
      }
    }
  }

  async isAlive(): Promise<boolean> {
    return this.exited === null && this.child.exitCode === null;
  }

  async shutdown(): Promise<void> {
    if (this.activeTurn) {
      this.rejectActiveTurn(createAbortError('operation aborted during shutdown'));
    }
    this.child.stdin.end();
    const gracefulResult = await this.waitForExitOrStdoutClose(
      this.shutdownTiming.eofGraceMs ?? DEFAULT_SHUTDOWN_EOF_GRACE_MS,
    );
    if (gracefulResult === 'stdout-closed') {
      await this.waitForExit(
        this.shutdownTiming.stdoutCloseExitGraceMs ?? DEFAULT_SHUTDOWN_STDOUT_CLOSE_EXIT_GRACE_MS,
      );
    }
    if (!(await this.isAlive())) {
      await this.stdoutLoop.catch(() => undefined);
      return;
    }
    if (gracefulResult !== 'exited') {
      this.child.kill('SIGTERM');
    }
    if (!(await this.waitForExit(this.shutdownTiming.terminateGraceMs ?? DEFAULT_SHUTDOWN_TERMINATE_GRACE_MS)) && await this.isAlive()) {
      this.child.kill('SIGKILL');
    }
    await this.waitForExit(this.shutdownTiming.killGraceMs ?? DEFAULT_SHUTDOWN_KILL_GRACE_MS);
    await this.stdoutLoop.catch(() => undefined);
  }

  private async waitForExit(timeoutMs: number): Promise<boolean> {
    if (!(await this.isAlive())) {
      return true;
    }
    return raceWithTimeout(this.exitPromise.then(() => true), timeoutMs, false);
  }

  private async waitForExitOrStdoutClose(timeoutMs: number): Promise<'exited' | 'stdout-closed' | 'timeout'> {
    if (!(await this.isAlive())) {
      return 'exited';
    }
    if (this.stdoutClosed) {
      return 'stdout-closed';
    }
    return raceWithTimeout(
      Promise.race([
        this.exitPromise.then(() => 'exited' as const),
        this.stdoutClosedPromise.then(() => 'stdout-closed' as const),
      ]),
      timeoutMs,
      'timeout',
    );
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
      if (isExplicitErrorResult(event)) {
        this.rejectSpecificTurn(turn, buildResultError(event));
        return;
      }
      if (!isEmptyLifecycleResult(event)) {
        this.resolveActiveTurnFromResult(turn);
      }
    }
  }

  private resolveActiveTurnFromResult(turn: ActiveTurn): void {
    if (turn.timeoutError) {
      this.rejectSpecificTurn(turn, turn.timeoutError);
      return;
    }
    if (turn.aborted) {
      this.rejectSpecificTurn(turn, createAbortError());
      return;
    }
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
      this.rejectSpecificTurn(turn, new OpenPError('Claude stream-json result did not contain result content', EXIT_CODES.protocolViolation));
      return;
    }
    for (const text of parsed.backgroundTexts) {
      turn.request.onBackgroundAssistantText?.(text);
    }
    const sessionId = parsed.sessionId ?? (turn.request.isFirstTurn ? null : this.sessionId);
    if (!sessionId) {
      this.rejectSpecificTurn(turn, new OpenPError('Claude stream-json result did not contain a backend session id', EXIT_CODES.protocolViolation));
      return;
    }
    if (!turn.request.isFirstTurn && parsed.sessionId && parsed.sessionId !== this.sessionId) {
      this.rejectSpecificTurn(turn, new OpenPError('Claude stream-json result returned a different session id for resume turn', EXIT_CODES.protocolViolation));
      return;
    }
    this.sessionId = sessionId;
    const result: WorkerTurnResult = {
      content: parsed.content,
      reasoningContent: parsed.reasoningContent,
      ...(parsed.structuredOutput !== undefined ? { structuredOutput: parsed.structuredOutput } : {}),
      ...(parsed.assistantEvents && parsed.assistantEvents.length > 0
        ? { assistantEvents: parsed.assistantEvents }
        : {}),
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
  await assertClaudeCodeBin(request.launchSignature.bin, {
    env: request.launchSignature.env,
    isolateAnthropicEnv: request.launchSignature.local,
    cwd: request.cwd,
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
  }
  args.push(
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--brief',
  );
  if (options.launchSignature.model) {
    args.push('--model', options.launchSignature.model);
  }
  if (options.launchSignature.reasoningEffort) {
    args.push('--effort', options.launchSignature.reasoningEffort);
  }
  rejectStructuredClaudeCodeBackendArgs(options.launchSignature.binArgs);
  const binArgs = filterCallerBackendArgs(options.launchSignature.binArgs);
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
  args.push(...withThinkingSummariesSettings(
    [...buildClaudeToolsArgs(options.launchSignature.tools), ...binArgs],
    options.cwd,
  ));
  return args;
}

function filterCallerBackendArgs(args: readonly string[]): string[] {
  const output: string[] = [];
  const valueFlags = new Set(['--input-format', '--output-format']);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '-p' || arg === '--print' || arg === '--verbose' || arg === '--include-partial-messages' || arg === '--brief') {
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
  aborted: boolean;
  timeoutError: OpenPError | null;
  resolve: (result: WorkerTurnResult) => void;
  reject: (error: unknown) => void;
  streamMessage: ActiveStreamMessage | null;
}

interface ActiveStreamMessage {
  baseText: string;
  text: string;
  baseReasoningText: string;
  reasoningText: string;
  stopReason: string | null;
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

function isEmptyLifecycleResult(event: Record<string, unknown>): boolean {
  if (typeof event.result !== 'string' || event.result.trim().length > 0) {
    return false;
  }
  if (isExplicitErrorResult(event)) {
    return false;
  }
  return !Object.prototype.hasOwnProperty.call(event, 'structured_output') &&
    !Object.prototype.hasOwnProperty.call(event, 'structuredOutput');
}

function isExplicitErrorResult(event: Record<string, unknown>): boolean {
  if (event.is_error === true) {
    return true;
  }
  if (typeof event.subtype === 'string' && event.subtype !== 'success') {
    return true;
  }
  if (event.api_error_status !== null && event.api_error_status !== undefined) {
    return true;
  }
  return Object.prototype.hasOwnProperty.call(event, 'error');
}

function buildResultError(event: Record<string, unknown>): OpenPError {
  const details = [
    typeof event.result === 'string' && event.result.trim().length > 0 ? event.result.trim() : null,
    extractErrorMessage(event.error),
    typeof event.subtype === 'string' && event.subtype !== 'success' ? `subtype=${event.subtype}` : null,
    event.api_error_status !== null && event.api_error_status !== undefined
      ? `api_error_status=${String(event.api_error_status)}`
      : null,
  ].filter((value): value is string => value !== null && value.length > 0);
  return new OpenPError(
    `Claude stream-json result returned an error${details.length > 0 ? `: ${details.join('; ')}` : ''}`,
    EXIT_CODES.backendExited,
  );
}

function extractErrorMessage(error: unknown): string | null {
  const errorObject = asObject(error);
  if (typeof errorObject?.message === 'string' && errorObject.message.trim().length > 0) {
    return errorObject.message.trim();
  }
  if (typeof error === 'string' && error.trim().length > 0) {
    return error.trim();
  }
  return null;
}

function publishStructuredDelta(turn: ActiveTurn, event: Record<string, unknown>): void {
  const streamEvent = asObject(event.event);
  if (event.type !== 'stream_event' || !streamEvent) {
    return;
  }
  if (streamEvent.type === 'message_start') {
    turn.streamMessage = createActiveStreamMessage(turn);
    return;
  }
  if (streamEvent.type === 'content_block_start') {
    ensureActiveStreamMessage(turn);
    return;
  }
  if (streamEvent.type === 'message_delta') {
    const message = ensureActiveStreamMessage(turn);
    const delta = asObject(streamEvent.delta);
    if (typeof delta?.stop_reason === 'string') {
      message.stopReason = delta.stop_reason;
    }
    return;
  }
  if (streamEvent.type === 'message_stop') {
    turn.streamMessage = null;
    return;
  }
  if (streamEvent.type !== 'content_block_delta') {
    return;
  }
  const delta = asObject(streamEvent.delta);
  if (!delta || typeof delta.type !== 'string') {
    return;
  }
  if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text.length > 0) {
    const message = turn.streamMessage;
    if (message) {
      message.text += delta.text;
      publishIntermediateTextSnapshot(turn, appendStreamingTextSnapshot(message.baseText, message.text));
      return;
    }
    publishIntermediateTextSnapshot(turn, turn.text + delta.text);
    return;
  }
  if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking.length > 0) {
    const message = turn.streamMessage;
    if (message) {
      message.reasoningText += delta.thinking;
      publishIntermediateReasoningSnapshot(
        turn,
        appendStreamingTextSnapshot(message.baseReasoningText, message.reasoningText),
      );
      return;
    }
    publishIntermediateReasoningSnapshot(turn, turn.reasoningText + delta.thinking);
  }
}

function createActiveStreamMessage(turn: ActiveTurn): ActiveStreamMessage {
  return {
    baseText: turn.text,
    text: '',
    baseReasoningText: turn.reasoningText,
    reasoningText: '',
    stopReason: null,
  };
}

function ensureActiveStreamMessage(turn: ActiveTurn): ActiveStreamMessage {
  turn.streamMessage ??= createActiveStreamMessage(turn);
  return turn.streamMessage;
}

function appendStreamingTextSnapshot(baseText: string, currentText: string): string {
  if (!baseText) {
    return currentText;
  }
  if (!currentText) {
    return baseText;
  }
  return `${baseText}\n\n${currentText}`;
}

function publishIntermediateTextSnapshot(turn: ActiveTurn, text: string): void {
  turn.text = text;
  turn.intermediateTextCount += 1;
  turn.request.onIntermediateText?.(turn.text, 'jsonl');
}

function publishIntermediateReasoningSnapshot(turn: ActiveTurn, reasoningText: string): void {
  turn.reasoningText = reasoningText;
  turn.request.onIntermediateReasoning?.(turn.reasoningText, 'jsonl');
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

async function raceWithTimeout<T, TTimeout>(promise: Promise<T>, timeoutMs: number, timeoutValue: TTimeout): Promise<T | TTimeout> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<TTimeout>((resolve) => {
        timer = setTimeout(() => resolve(timeoutValue), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function resolveRequestContextWindow(request: WorkerTurnRequest): number | null {
  if (request.model && request.contextWindowsByModel && Number.isFinite(request.contextWindowsByModel[request.model])) {
    return request.contextWindowsByModel[request.model]!;
  }
  return typeof request.contextWindow === 'number' && Number.isFinite(request.contextWindow) ? request.contextWindow : null;
}
