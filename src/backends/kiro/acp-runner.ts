import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';

import { createAbortError } from '../../core/abort.js';
import { EXIT_CODES, OpenPError } from '../../core/errors.js';
import { GracefulInterrupt, shouldTerminateOnAbort } from '../../core/graceful-interrupt.js';
import { isSafeSessionId } from '../../core/session-id.js';
import type { AssistantEventSnapshot } from '../../core/types.js';
import { getOpenPVersion } from '../../core/version.js';
import { validateKiroReasoningEffort } from './effort.js';
import {
  readKiroSessionLogOffset,
  waitForKiroPromptScopedAssistantTexts,
  waitForKiroTurnResult,
} from './session-log.js';

type JsonObject = Record<string, unknown>;
type JsonRpcId = string | number;
const KIRO_SESSION_LOG_FLUSH_GRACE_MS = 1000;
const KIRO_SETUP_COMMAND_LOG_FLUSH_GRACE_MS = 500;

export interface KiroAcpRunOptions {
  readonly bin: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly prompt: string;
  readonly sessionId: string | null;
  readonly isFirstTurn: boolean;
  readonly reasoningEffort?: string | null;
  readonly timeoutMs: number;
  readonly trustAllTools: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly forceSignal?: AbortSignal;
  readonly killSignal?: AbortSignal;
  readonly interruptGraceMs?: number;
  readonly terminateGraceMs?: number;
  readonly onAssistantText?: (text: string) => void;
}

export interface KiroAcpRunResult {
  readonly content: string;
  readonly sessionId: string;
  readonly stopReason: string | null;
  readonly toolsUsed: readonly string[];
  readonly durationMs: number | null;
  readonly rawUsage: Record<string, unknown> | null;
  readonly rawEventCount: number;
  readonly intermediateTextCount: number;
  readonly assistantEvents: readonly AssistantEventSnapshot[];
}

export async function runKiroAcp(options: KiroAcpRunOptions): Promise<KiroAcpRunResult> {
  validateKiroReasoningEffort(options.reasoningEffort);
  const client = new KiroAcpClient(options);
  try {
    return await client.run();
  } finally {
    await client.shutdown();
  }
}

class KiroAcpClient {
  private child: ChildProcess | null = null;
  private stdoutLines: Interface | null = null;
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly toolsUsed = new Set<string>();
  private assistantText = '';
  private setupCommandText = '';
  private activePrompt = false;
  private activeSetupCommand = false;
  private completed = false;
  private shuttingDown = false;
  private timeoutTimer: NodeJS.Timeout | undefined;
  private shutdownForceKillTimer: NodeJS.Timeout | undefined;
  private interrupter: GracefulInterrupt | null = null;
  private aborted = false;
  private timeoutError: OpenPError | null = null;
  private fatalReject: ((error: unknown) => void) | null = null;
  private readonly fatalPromise: Promise<never>;
  private stderr = '';
  private rawEventCount = 0;
  private intermediateTextCount = 0;
  private resolvedSessionId: string | null = null;
  private latestMetadata: Record<string, unknown> | null = null;
  private metadataDurationMs: number | null = null;

  constructor(private readonly options: KiroAcpRunOptions) {
    this.fatalPromise = new Promise<never>((_resolve, reject) => {
      this.fatalReject = reject;
    });
  }

  async run(): Promise<KiroAcpRunResult> {
    if (this.options.signal?.aborted) {
      throw createAbortError();
    }

    const timeoutDeadlineMs = this.options.timeoutMs > 0 ? Date.now() + this.options.timeoutMs : null;
    this.start();
    const initialize = await this.raceFatal<JsonObject>(this.sendRequest('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: {
        name: 'open-p',
        version: getOpenPVersion(),
      },
    }));
    this.throwIfInterruptedOrTimedOut();

    if (!this.options.isFirstTurn && !extractLoadSessionCapability(initialize)) {
      throw new OpenPError('Kiro ACP initialize did not advertise loadSession support', EXIT_CODES.protocolViolation);
    }

    if (this.options.isFirstTurn) {
      const sessionNew = await this.raceFatal<JsonObject>(this.sendRequest('session/new', {
        cwd: this.options.cwd,
        mcpServers: [],
      }));
      this.throwIfInterruptedOrTimedOut();
      const sessionId = extractSessionId(sessionNew);
      if (!sessionId) {
        throw new OpenPError('Kiro ACP session/new did not return a session id', EXIT_CODES.protocolViolation);
      }
      this.resolvedSessionId = sessionId;
    } else {
      if (!this.options.sessionId) {
        throw new OpenPError('Kiro resume requires a session id', EXIT_CODES.usage);
      }
      this.resolvedSessionId = this.options.sessionId;
      const sessionLoad = await this.raceFatal<JsonObject>(this.sendRequest('session/load', {
        sessionId: this.resolvedSessionId,
        cwd: this.options.cwd,
        mcpServers: [],
      }));
      this.throwIfInterruptedOrTimedOut();
      const loadedSessionId = extractSessionId(sessionLoad);
      if (loadedSessionId && loadedSessionId !== this.resolvedSessionId) {
        throw new OpenPError('Kiro ACP session/load returned a different session id for resume turn', EXIT_CODES.protocolViolation);
      }
    }

    const promptSessionId = this.resolvedSessionId;
    if (!promptSessionId) {
      throw new OpenPError('Kiro ACP session id was not resolved before prompt', EXIT_CODES.protocolViolation);
    }

    await this.applyReasoningEffort(promptSessionId);
    this.throwIfInterruptedOrTimedOut();

    const promptLogOffset = await readKiroSessionLogOffset(promptSessionId, this.options.env);
    this.throwIfInterruptedOrTimedOut();
    this.activePrompt = true;
    const promptResult = await this.raceFatal<JsonObject>(this.sendRequest('session/prompt', {
      sessionId: promptSessionId,
      prompt: [{ type: 'text', text: this.options.prompt }],
    }));
    this.activePrompt = false;
    this.throwIfInterruptedOrTimedOut();
    this.completed = true;

    const turnResult = await waitForKiroTurnResult({
      sessionId: promptSessionId,
      fromOffset: promptLogOffset,
      env: this.options.env,
      deadlineMs: Math.min(
        timeoutDeadlineMs ?? Number.POSITIVE_INFINITY,
        Date.now() + KIRO_SESSION_LOG_FLUSH_GRACE_MS,
      ),
      throwIfStopped: () => this.throwIfInterruptedOrTimedOut(),
    });
    this.throwIfInterruptedOrTimedOut();

    const hasResultArtifacts = hasToolArtifacts(turnResult.assistantEvents);
    if (!turnResult.text && !hasResultArtifacts) {
      throw new OpenPError('Kiro session log did not contain a scoped turn result', EXIT_CODES.protocolViolation);
    }

    return {
      content: turnResult.text ?? '',
      sessionId: promptSessionId,
      stopReason: typeof promptResult.stopReason === 'string' ? promptResult.stopReason : null,
      toolsUsed: [...new Set([...this.toolsUsed, ...turnResult.toolsUsed])],
      durationMs: this.metadataDurationMs,
      rawUsage: this.latestMetadata,
      rawEventCount: this.rawEventCount,
      intermediateTextCount: this.intermediateTextCount,
      assistantEvents: turnResult.assistantEvents,
    };
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    clearTimeout(this.timeoutTimer);
    this.interrupter?.clear();
    if (this.options.signal) {
      this.options.signal.removeEventListener('abort', this.onAbort);
    }
    if (this.options.forceSignal) {
      this.options.forceSignal.removeEventListener('abort', this.onForce);
    }
    if (this.options.killSignal) {
      this.options.killSignal.removeEventListener('abort', this.onKill);
    }
    for (const pending of this.pending.values()) {
      pending.reject(createAbortError('Kiro ACP process shut down'));
    }
    this.pending.clear();
    this.stdoutLines?.close();

    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      return;
    }

    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(this.shutdownForceKillTimer);
        resolve();
      };
      child.once('close', done);
      this.terminate('SIGTERM');
      this.shutdownForceKillTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          this.terminate('SIGKILL');
        }
      }, 1000);
    });
  }

  private start(): void {
    const child = spawn(this.options.bin, [...this.options.args], {
      cwd: this.options.cwd,
      env: this.options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    this.child = child;
    this.interrupter = new GracefulInterrupt({
      interruptGraceMs: this.options.interruptGraceMs,
      terminateGraceMs: this.options.terminateGraceMs,
      isAlive: () => child.exitCode === null && child.signalCode === null,
      sendSignal: (signal) => this.terminate(signal),
    });

    if (!child.stdout || !child.stdin || !child.stderr) {
      this.fail(new OpenPError('Kiro ACP process did not expose stdio pipes', EXIT_CODES.backendStartFailed));
      return;
    }

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.stderr += chunk;
    });

    this.stdoutLines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.stdoutLines.on('line', (line) => this.handleStdoutLine(line));

    child.on('error', (error) => {
      if (this.completed || this.shuttingDown) {
        return;
      }
      this.fail(error);
    });
    child.on('close', (code, signal) => {
      if (this.completed || this.shuttingDown) {
        return;
      }
      if (this.timeoutError) {
        this.fail(this.timeoutError);
        return;
      }
      if (this.aborted) {
        this.fail(createAbortError());
        return;
      }
      const stderrSnippet = this.stderr.trim().slice(0, 500);
      const details = stderrSnippet ? `: ${stderrSnippet}` : '';
      if (signal) {
        this.fail(new OpenPError(`Kiro ACP stopped due to signal ${signal}${details}`, EXIT_CODES.backendExited));
        return;
      }
      this.fail(new OpenPError(`Kiro ACP exited with code ${code ?? 'unknown'}${details}`, EXIT_CODES.backendExited));
    });

    this.timeoutTimer = this.options.timeoutMs > 0
      ? setTimeout(() => {
          const timeoutSec = Math.round(this.options.timeoutMs / 1000);
          const stderrSnippet = this.stderr.trim().slice(0, 200);
          const details = stderrSnippet ? `: ${stderrSnippet}` : '';
          this.timeoutError = new OpenPError(`Kiro ACP did not respond within ${timeoutSec}s${details}`, EXIT_CODES.timeout);
          this.interrupter?.requestGracefulStop();
        }, this.options.timeoutMs)
      : undefined;

    if (this.options.signal) {
      if (this.options.signal.aborted) {
        this.onAbort();
      } else {
        this.options.signal.addEventListener('abort', this.onAbort, { once: true });
      }
    }
    if (this.options.forceSignal) {
      if (this.options.forceSignal.aborted) {
        this.onForce();
      } else {
        this.options.forceSignal.addEventListener('abort', this.onForce, { once: true });
      }
    }
    if (this.options.killSignal) {
      if (this.options.killSignal.aborted) {
        this.onKill();
      } else {
        this.options.killSignal.addEventListener('abort', this.onKill, { once: true });
      }
    }
  }

  private readonly onAbort = (): void => {
    if (this.timeoutError) {
      this.interrupter?.requestForceStop();
      return;
    }
    this.aborted = true;
    clearTimeout(this.timeoutTimer);
    if (shouldTerminateOnAbort(this.options.signal)) {
      this.interrupter?.requestForceStop();
      return;
    }
    this.interrupter?.requestGracefulStop();
  };

  private readonly onForce = (): void => {
    this.interrupter?.requestForceStop();
  };

  private readonly onKill = (): void => {
    this.interrupter?.requestKillNow();
  };

  private terminate(signal: NodeJS.Signals): void {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    if (child.pid) {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch {
        // fall through to direct child signal
      }
    }
    child.kill(signal);
  }

  private throwIfInterruptedOrTimedOut(): void {
    if (this.timeoutError) {
      throw this.timeoutError;
    }
    if (this.aborted) {
      throw createAbortError();
    }
  }

  private sendRequest(method: string, params: JsonObject): Promise<JsonObject> {
    const id = this.nextId;
    this.nextId += 1;
    const request = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };
    return new Promise<JsonObject>((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      this.child?.stdin?.write(`${JSON.stringify(request)}\n`, (error) => {
        if (error) {
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  private async applyReasoningEffort(sessionId: string): Promise<void> {
    const effort = validateKiroReasoningEffort(this.options.reasoningEffort);
    if (!effort) {
      return;
    }

    const commandText = `/effort ${effort}`;
    const commandLogOffset = await readKiroSessionLogOffset(sessionId, this.options.env);
    this.setupCommandText = '';
    this.activeSetupCommand = true;
    try {
      await this.raceFatal<JsonObject>(this.sendRequest('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: commandText }],
      }));
    } finally {
      this.activeSetupCommand = false;
    }

    this.throwIfInterruptedOrTimedOut();
    if (isKiroEffortCommandFailure(this.setupCommandText)) {
      throw new OpenPError(`Kiro effort setup failed: ${this.setupCommandText.trim()}`, EXIT_CODES.unsupportedOption);
    }

    const setupLogTexts = await waitForKiroPromptScopedAssistantTexts({
      sessionId,
      fromOffset: commandLogOffset,
      env: this.options.env,
      deadlineMs: Date.now() + KIRO_SETUP_COMMAND_LOG_FLUSH_GRACE_MS,
      throwIfStopped: () => this.throwIfInterruptedOrTimedOut(),
    });
    const failedSetupLogText = setupLogTexts.find(isKiroEffortCommandFailure);
    if (failedSetupLogText) {
      throw new OpenPError(`Kiro effort setup failed: ${failedSetupLogText.trim()}`, EXIT_CODES.unsupportedOption);
    }
  }

  private raceFatal<T>(operation: Promise<T>): Promise<T> {
    return Promise.race([operation, this.fatalPromise]);
  }

  private handleStdoutLine(line: string): void {
    let message: JsonObject;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return;
      }
      message = parsed as JsonObject;
    } catch {
      return;
    }

    this.rawEventCount += 1;

    const id = extractId(message);
    const method = typeof message.method === 'string' ? message.method : null;
    if (id !== null && method) {
      this.handleClientRequest(id, method, asObject(message.params));
      return;
    }

    if (id !== null) {
      this.handleResponse(id, message);
      return;
    }

    if (method) {
      this.handleNotification(method, asObject(message.params));
    }
  }

  private handleResponse(id: JsonRpcId, message: JsonObject): void {
    const pending = this.pending.get(id);
    if (!pending) {
      return;
    }
    const interruptError = this.currentInterruptError();
    if (interruptError) {
      this.fail(interruptError);
      return;
    }
    this.pending.delete(id);
    if (pending.method === 'session/prompt') {
      this.activePrompt = false;
    }
    const error = asObject(message.error);
    if (error) {
      const detail = typeof error.message === 'string' ? error.message : JSON.stringify(error);
      pending.reject(new OpenPError(`Kiro ACP request ${id} failed: ${detail}`, EXIT_CODES.backendExited));
      return;
    }
    const result = asObject(message.result);
    pending.resolve(result ?? {});
  }

  private handleClientRequest(id: JsonRpcId, method: string, params: JsonObject | null): void {
    const interruptError = this.currentInterruptError();
    if (interruptError) {
      this.fail(interruptError);
      return;
    }
    if (method === 'session/request_permission') {
      this.writeResponse({
        jsonrpc: '2.0',
        id,
        error: {
          code: -32601,
          message: 'open-p does not answer Kiro ACP permission prompts',
        },
      });
      const title = extractPermissionTitle(params);
      const modeHint = this.options.trustAllTools
        ? 'Kiro requested permission despite --trust-all-tools'
        : 'Kiro requested tool permission; rerun with --dangerously-skip-permissions for trusted Kiro tools';
      this.fail(new OpenPError(title ? `${modeHint}: ${title}` : modeHint, EXIT_CODES.usage));
      return;
    }

    this.writeResponse({
      jsonrpc: '2.0',
      id,
      error: {
        code: -32601,
        message: `unsupported ACP client method: ${method}`,
      },
    });
  }

  private handleNotification(method: string, params: JsonObject | null): void {
    if (method === '_kiro.dev/metadata') {
      this.handleMetadata(params);
      return;
    }
    if (method !== 'session/update' && method !== '_kiro.dev/session/update') {
      return;
    }
    if ((!this.activePrompt && !this.activeSetupCommand) || !params || params.sessionId !== this.resolvedSessionId) {
      return;
    }
    const update = asObject(params.update);
    if (!update || typeof update.sessionUpdate !== 'string') {
      return;
    }

    if (update.sessionUpdate === 'agent_message_chunk') {
      const content = asObject(update.content);
      if (content?.type === 'text' && typeof content.text === 'string') {
        if (this.activeSetupCommand) {
          this.setupCommandText += content.text;
          return;
        }
        this.assistantText += content.text;
        this.intermediateTextCount += 1;
        this.options.onAssistantText?.(this.assistantText);
      }
      return;
    }

    if (update.sessionUpdate.startsWith('tool_call')) {
      const toolName = extractToolName(update);
      if (toolName) {
        this.toolsUsed.add(toolName);
      }
    }
  }

  private handleMetadata(params: JsonObject | null): void {
    if (!params || (this.resolvedSessionId && params.sessionId !== this.resolvedSessionId)) {
      return;
    }
    this.latestMetadata = params;
    this.metadataDurationMs = typeof params.turnDurationMs === 'number' ? params.turnDurationMs : this.metadataDurationMs;
  }

  private writeResponse(response: JsonObject): void {
    this.child?.stdin?.write(`${JSON.stringify(response)}\n`);
  }

  private fail(error: unknown): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
    this.fatalReject?.(error);
  }

  private currentInterruptError(): unknown | null {
    if (this.timeoutError) {
      return this.timeoutError;
    }
    if (this.aborted) {
      return createAbortError();
    }
    return null;
  }

}

interface PendingRequest {
  readonly method: string;
  readonly resolve: (result: JsonObject) => void;
  readonly reject: (error: unknown) => void;
}

function extractSessionId(result: JsonObject): string | null {
  const sessionId = result.sessionId;
  return typeof sessionId === 'string' && isSafeSessionId(sessionId) ? sessionId : null;
}

function hasToolArtifacts(events: readonly AssistantEventSnapshot[]): boolean {
  return events.some((event) => {
    const content = event.message.content;
    return Array.isArray(content) && content.some((block) => {
      if (!block || typeof block !== 'object' || Array.isArray(block)) {
        return false;
      }
      const type = (block as Record<string, unknown>).type;
      return type === 'tool_use' || type === 'server_tool_use' || type === 'tool_result';
    });
  });
}

function extractLoadSessionCapability(result: JsonObject): boolean {
  const capabilities = asObject(result.agentCapabilities);
  return capabilities?.loadSession === true;
}

function extractId(message: JsonObject): JsonRpcId | null {
  if (!Object.prototype.hasOwnProperty.call(message, 'id')) {
    return null;
  }
  const id = message.id;
  return typeof id === 'string' || typeof id === 'number' ? id : null;
}

function extractPermissionTitle(params: JsonObject | null): string | null {
  const toolCall = asObject(params?.toolCall);
  return typeof toolCall?.title === 'string' ? toolCall.title : null;
}

function extractToolName(update: JsonObject): string | null {
  const rawInput = asObject(update.rawInput);
  if (typeof rawInput?.command === 'string' && rawInput.command.trim()) {
    return rawInput.command.trim();
  }
  if (typeof update.title === 'string' && update.title.trim()) {
    return update.title.trim();
  }
  if (typeof update.kind === 'string' && update.kind.trim()) {
    return update.kind.trim();
  }
  return null;
}

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function isKiroEffortCommandFailure(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return normalized.includes('not available')
    || normalized.includes('not supported')
    || normalized.includes('does not support')
    || normalized.includes('do not support')
    || normalized.includes('unsupported')
    || normalized.includes('unknown command')
    || normalized.includes('invalid effort');
}
