import { createAbortError } from '../../core/abort.js';
import { EXIT_CODES, OpenPError } from '../../core/errors.js';
import type { WorkerTurnDiagnostics, WorkerTurnResult } from '../../core/worker-types.js';
import { buildOpenCodeArgs, requireLocalModel } from './args.js';
import { resolveOpenCodeBin } from './bin.js';
import { buildOpenCodePrivateEnv } from './env.js';
import { runOpenCodeExec } from './exec-runner.js';
import { parseOpenCodeJsonOutput } from './output-parser.js';
import { buildLocalhostOnlySandboxCommand } from './sandbox.js';

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
      tools: input.tools,
      jsonSchema: input.jsonSchema,
      backendArgs: input.backendArgs,
    },
  });
  const privateEnv = await buildOpenCodePrivateEnv(input.projectRoot, input.env ?? process.env, localModel);
  const command = buildLocalhostOnlySandboxCommand(input.bin ?? resolveOpenCodeBin(), args);

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

  const parsed = parseOpenCodeJsonOutput(result.stdout);
  if (result.exitCode !== 0) {
    const message = parsed.errorMessage ?? (result.stderr.trim() || `OpenCode exited with status ${result.exitCode}`);
    throw new OpenPError(message, EXIT_CODES.backendExited);
  }
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
