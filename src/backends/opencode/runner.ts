import net from 'node:net';
import { createAbortError } from '../../core/abort.js';
import { EXIT_CODES, OpenPError } from '../../core/errors.js';
import type { WorkerTurnDiagnostics, WorkerTurnResult } from '../../core/worker-types.js';
import { buildOpenCodeArgs, requireLocalModel, type OpenCodeLocalModel } from './args.js';
import { resolveOpenCodeBin } from './bin.js';
import { buildOpenCodePrivateEnv } from './env.js';
import { runOpenCodeExec } from './exec-runner.js';
import { parseOpenCodeJsonOutput } from './output-parser.js';
import { buildLocalhostOnlySandboxCommand } from './sandbox.js';

const OPENCODE_PROVIDER_CONNECTIVITY_TIMEOUT_MS = 2_000;

export interface OpenCodeTurnResult extends WorkerTurnResult {
  readonly rawEventCount: number;
}

export interface OpenCodeTurnInput {
  readonly message: string;
  readonly sessionId: string | null;
  readonly isFirstTurn: boolean;
  readonly projectRoot: string;
  readonly model: string | null;
  readonly reasoningEffort: string | null;
  readonly executionMode: string | null;
  readonly nativeExecutionMode?: string | null;
  readonly tools: string | null;
  readonly jsonSchema: string | null;
  readonly backendArgs: readonly string[];
  readonly timeoutMs: number;
  readonly bin?: string | null;
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly forceSignal?: AbortSignal;
  readonly killSignal?: AbortSignal;
}

export async function runOpenCodeTurn(input: OpenCodeTurnInput): Promise<OpenCodeTurnResult> {
  const startMs = Date.now();
  const localModel = requireLocalModel(input.model);
  const args = buildOpenCodeArgs({
    message: input.message,
    sessionId: input.sessionId,
    isFirstTurn: input.isFirstTurn,
    options: {
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      executionMode: input.executionMode,
      nativeExecutionMode: input.nativeExecutionMode ?? null,
      tools: input.tools,
      jsonSchema: input.jsonSchema,
      backendArgs: input.backendArgs,
    },
  });
  const privateEnv = await buildOpenCodePrivateEnv(input.projectRoot, input.env ?? process.env, localModel);
  const command = buildLocalhostOnlySandboxCommand(input.bin ?? resolveOpenCodeBin(), args);
  await assertOpenCodeProviderReachable(localModel, input.signal);

  const result = await runOpenCodeExec({
    bin: command.bin,
    args: command.args,
    cwd: input.projectRoot,
    env: privateEnv.env,
    timeoutMs: input.timeoutMs,
    signal: input.signal,
    forceSignal: input.forceSignal,
    killSignal: input.killSignal,
  });

  if (result.signal && !result.timedOut) {
    if (input.signal?.aborted) {
      throw createAbortError();
    }
    throw new OpenPError(`OpenCode CLI stopped due to signal ${result.signal}`, EXIT_CODES.backendExited);
  }
  if (result.timedOut) {
    const timeoutSec = Math.round(input.timeoutMs / 1000);
    throw new OpenPError(`OpenCode did not respond within ${timeoutSec}s`, EXIT_CODES.timeout);
  }

  if (result.exitCode !== 0) {
    throw createOpenCodeNonZeroExitError(result.exitCode, result.stdout, result.stderr);
  }
  const parsed = parseOpenCodeJsonOutput(result.stdout);
  if (parsed.errorMessage) {
    throw new OpenPError(parsed.errorMessage, EXIT_CODES.backendExited);
  }
  if (!parsed.sessionId) {
    throw new OpenPError('OpenCode CLI did not return a session id', EXIT_CODES.protocolViolation);
  }
  if (!input.isFirstTurn && input.sessionId && parsed.sessionId !== input.sessionId) {
    throw new OpenPError('OpenCode CLI returned a different session id for resume turn', EXIT_CODES.protocolViolation);
  }
  if (!parsed.content.trim()) {
    throw new OpenPError('OpenCode CLI returned an empty response', EXIT_CODES.protocolViolation);
  }

  const diagnostics: WorkerTurnDiagnostics = {
    numTurns: null,
    inputTokens: parsed.usage.inputTokens,
    outputTokens: parsed.usage.outputTokens,
    cacheReadInputTokens: parsed.usage.cacheReadInputTokens,
    rawUsage: parsed.rawUsage,
    model: input.model ?? parsed.model,
    contextWindow: null,
    lastSubturnUsage: null,
    lastSubturnContextTokens: null,
    durationMs: Date.now() - startMs,
    totalCostUsd: null,
    stopReason: null,
    toolsUsed: parsed.toolsUsed,
    autoCompacted: null,
    intermediateTextCount: null,
  };

  return {
    content: parsed.content,
    reasoningContent: null,
    sessionId: parsed.sessionId,
    assistantEvents: parsed.assistantEvents.length > 0 ? parsed.assistantEvents : undefined,
    rawEventCount: parsed.rawEventCount,
    diagnostics,
  };
}

// open-p is what points OpenCode at this endpoint, so it also owns the check that the endpoint can
// be reached. When it cannot, OpenCode retries the connection on a backoff that levels off around
// half a minute and never stops on its own, and none of those attempts reach stdout. A turn started
// that way therefore produces no result and no end. Failing here keeps that outcome observable.
async function assertOpenCodeProviderReachable(model: OpenCodeLocalModel, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    throw createAbortError();
  }
  const baseURL = model.providerConfig.baseURL;
  const endpoint = parseProviderEndpoint(baseURL);

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const socket = net.createConnection({ host: endpoint.host, port: endpoint.port });

    const cleanup = (): void => {
      socket.removeAllListeners();
      signal?.removeEventListener('abort', onAbort);
      socket.destroy();
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const succeed = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const unreachable = (detail: string): OpenPError => new OpenPError(
      `OpenCode local provider "${model.provider}" is not serving ${baseURL} (${endpoint.host}:${endpoint.port}): ` +
      `${detail}. Confirm that provider's local model server is running and that this address reaches it.`,
      EXIT_CODES.backendStartFailed,
    );
    const onAbort = (): void => {
      fail(createAbortError());
    };

    socket.once('connect', succeed);
    // The socket error carries why the address is unusable — refused, reset, unresolvable, or a
    // local resource limit — and those need different fixes, so report it rather than assume one.
    socket.once('error', (error) => fail(unreachable(`the connection failed with ${describeSocketError(error)}`)));
    // This is a connectivity preflight for the provider endpoint that open-p injects into
    // OpenCode, not a turn execution timeout. Long-running turns still use input.timeoutMs.
    socket.setTimeout(
      OPENCODE_PROVIDER_CONNECTIVITY_TIMEOUT_MS,
      () => fail(unreachable(
        `the address accepted no connection within ${OPENCODE_PROVIDER_CONNECTIVITY_TIMEOUT_MS}ms, which a firewall or a stalled process can cause`,
      )),
    );
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function describeSocketError(error: unknown): string {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? (error as { readonly code?: unknown }).code
    : undefined;
  return typeof code === 'string' && code.length > 0 ? code : 'an unidentified socket error';
}

function parseProviderEndpoint(baseURL: string): { readonly host: string; readonly port: number } {
  let url: URL;
  try {
    url = new URL(baseURL);
  } catch {
    throw new OpenPError(`OpenCode local provider endpoint is not a valid URL: ${baseURL}`, EXIT_CODES.backendStartFailed);
  }
  const port = url.port
    ? Number(url.port)
    : url.protocol === 'https:'
      ? 443
      : 80;
  if (!url.hostname || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new OpenPError(`OpenCode local provider endpoint is not connectable: ${baseURL}`, EXIT_CODES.backendStartFailed);
  }
  return { host: url.hostname, port };
}

function createOpenCodeNonZeroExitError(exitCode: number | null, stdout: string, stderr: string): OpenPError {
  const stdoutDiagnostic = stdout.trim().slice(0, 500);
  const stderrDiagnostic = stderr.trim().slice(0, 500);
  const diagnostics = [stdoutDiagnostic, stderrDiagnostic].filter((value, index, values) => (
    value.length > 0 && values.indexOf(value) === index
  ));
  const details = diagnostics.length > 0 ? `: ${diagnostics.join(' | ').slice(0, 700)}` : '';
  return new OpenPError(`OpenCode CLI exited with code ${exitCode ?? 'unknown'}${details}`, EXIT_CODES.backendExited);
}
