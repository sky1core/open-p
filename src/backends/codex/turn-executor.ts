import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAbortError } from '../../core/abort.js';
import { ARTIFACT_REJECTION_REASONS, EXIT_CODES, OpenPError } from '../../core/errors.js';
import { isSafeSessionId } from '../../core/session-id.js';
import type { AssistantEventSnapshot, BackendUsage } from '../../core/types.js';

import { buildFirstTurnArgs, buildResumeTurnArgs, validateCodexBackendArgs } from './args.js';
import { createCodexNonZeroExitError } from './exit-diagnostics.js';
import { runCodexExec } from './exec-runner.js';
import {
  createCodexStreamState,
  parseCodexOutput,
  processCodexStdoutLine,
  type CodexStreamCallbacks,
} from './jsonl-parser.js';
import { getCodexSessionLogBaseline, readCodexSessionLogResultSinceBaseline } from './session-log.js';
import { addNullable, hasCodexResultArtifacts, safeUnlink, selectCodexResultSource } from './shared-result.js';
import { parseCodexStructuredOutputFallback, parseCodexStructuredOutputSchema } from './structured-output.js';

export interface CodexTurnExecutionInput {
  readonly bin: string;
  readonly projectRoot: string;
  readonly prompt: string;
  readonly turnId: string;
  readonly sessionId: string | null;
  readonly isFirstTurn: boolean;
  readonly model: string | null;
  readonly reasoningEffort: string | null;
  readonly executionMode: string | null;
  readonly tools: string | null;
  readonly jsonSchema: string | null;
  readonly binArgs: readonly string[];
  readonly timeoutMs: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly forceSignal?: AbortSignal;
  readonly killSignal?: AbortSignal;
  readonly callbacks: CodexStreamCallbacks;
}

export interface CodexTurnExecutionResult {
  readonly content: string;
  readonly reasoningContent: string | null;
  readonly structuredOutput?: unknown;
  readonly sessionId: string;
  readonly assistantEvents: readonly AssistantEventSnapshot[];
  readonly usage: BackendUsage;
  readonly model: string | null;
  readonly contextWindow: number | null;
  readonly lastSubturnUsage: BackendUsage | null;
  readonly lastSubturnContextTokens: number | null;
  readonly durationMs: number;
}

export async function executeCodexTurn(input: CodexTurnExecutionInput): Promise<CodexTurnExecutionResult> {
  if (!input.isFirstTurn && !input.sessionId) {
    throw new OpenPError('Codex resume requires a session id', EXIT_CODES.usage);
  }
  if (!input.isFirstTurn && input.sessionId && !isSafeSessionId(input.sessionId)) {
    throw new OpenPError('unsafe Codex resume session id', EXIT_CODES.usage);
  }

  const startMs = Date.now();
  const outputLastMessagePath = join(tmpdir(), `openp-codex-last-${randomUUID()}.txt`);
  let outputSchemaPath: string | null = null;
  const structuredOutputSchema = parseCodexStructuredOutputSchema(input.jsonSchema);
  validateCodexBackendArgs(input.binArgs);

  try {
    if (input.jsonSchema) {
      const schemaDir = join(tmpdir(), 'openp-codex-schemas');
      await mkdir(schemaDir, { recursive: true });
      outputSchemaPath = join(schemaDir, `schema-${randomUUID()}.json`);
      await writeFile(outputSchemaPath, input.jsonSchema, 'utf8');
    }

    const argsOptions = {
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      executionMode: input.executionMode,
      tools: input.tools,
      outputLastMessagePath,
      outputSchemaPath,
      cwd: input.projectRoot,
    };
    const args = input.isFirstTurn
      ? buildFirstTurnArgs(input.prompt, argsOptions)
      : buildResumeTurnArgs(input.sessionId!, input.prompt, argsOptions);
    const streamState = createCodexStreamState(structuredOutputSchema === null);
    const resumeLogBaseline = !input.isFirstTurn && input.sessionId
      ? await getCodexSessionLogBaseline(input.sessionId)
      : null;
    const result = await runCodexExec({
      bin: input.bin,
      args,
      cwd: input.projectRoot,
      env: input.env,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
      forceSignal: input.forceSignal,
      killSignal: input.killSignal,
      onStdoutLine: (line) => processCodexStdoutLine(line, streamState, input.callbacks),
    });

    if (result.signal && !result.timedOut) {
      if (input.signal?.aborted) {
        throw createAbortError();
      }
      throw new OpenPError(`Codex CLI stopped due to signal ${result.signal}`, EXIT_CODES.backendExited);
    }
    if (result.timedOut) {
      throw buildCodexTimeoutError(input.timeoutMs, result.stderr);
    }
    if (result.exitCode !== 0) {
      throw await createCodexNonZeroExitError({
        exitCode: result.exitCode,
        stderr: result.stderr,
        stdout: result.stdout,
        outputLastMessagePath,
        sessionId: input.isFirstTurn ? null : input.sessionId,
        sessionLogBaseline: resumeLogBaseline,
      });
    }

    let lastMessageContent: string | null = null;
    try {
      lastMessageContent = await readFile(outputLastMessagePath, 'utf8');
    } catch {
      // Codex may omit the optional last-message artifact.
    }
    const stdoutParsed = parseCodexOutput(result.stdout, lastMessageContent);
    if (!stdoutParsed.sessionId && input.isFirstTurn) {
      throw new OpenPError('Codex CLI did not return a session id', EXIT_CODES.protocolViolation);
    }
    if (!input.isFirstTurn && stdoutParsed.sessionId && stdoutParsed.sessionId !== input.sessionId) {
      throw new OpenPError('Codex CLI returned a different session id for resume turn', EXIT_CODES.protocolViolation);
    }
    const resultSessionId = stdoutParsed.sessionId ?? input.sessionId;
    if (!resultSessionId) {
      throw new OpenPError('Codex CLI did not return a session id', EXIT_CODES.protocolViolation);
    }

    const sessionLog = await readCodexSessionLogResultSinceBaseline(resultSessionId, resumeLogBaseline);
    if (!input.isFirstTurn && resumeLogBaseline?.preexisting && !sessionLog) {
      throw new OpenPError('Codex session log became unavailable for resume turn', EXIT_CODES.protocolViolation);
    }
    const resultSource = selectCodexResultSource(sessionLog, stdoutParsed);
    if (!resultSource.content && !resultSource.reasoningContent && !hasCodexResultArtifacts(resultSource.assistantEvents)) {
      throw new OpenPError(
        'Codex CLI returned an empty response',
        EXIT_CODES.protocolViolation,
        ARTIFACT_REJECTION_REASONS.unsupportedArtifactShape,
      );
    }
    const structuredOutput = parseCodexStructuredOutputFallback(
      resultSource.content,
      structuredOutputSchema,
      input.turnId,
    );
    const usage: BackendUsage = {
      inputTokens: resultSource.usage.inputTokens,
      outputTokens: resultSource.usage.outputTokens,
      cacheReadInputTokens: resultSource.usage.cacheReadInputTokens,
    };
    const lastSubturnUsage = resultSource.lastSubturnUsage;

    return {
      content: resultSource.content,
      reasoningContent: resultSource.reasoningContent,
      ...(structuredOutput !== undefined ? { structuredOutput } : {}),
      sessionId: resultSessionId,
      assistantEvents: resultSource.assistantEvents,
      usage,
      model: resultSource.model ?? input.model,
      contextWindow: resultSource.contextWindow,
      lastSubturnUsage,
      lastSubturnContextTokens: addNullable(
        lastSubturnUsage?.inputTokens ?? null,
        lastSubturnUsage?.cacheReadInputTokens ?? null,
      ),
      durationMs: Date.now() - startMs,
    };
  } finally {
    await safeUnlink(outputLastMessagePath);
    if (outputSchemaPath) {
      await safeUnlink(outputSchemaPath);
    }
  }
}

function buildCodexTimeoutError(timeoutMs: number, stderr: string): OpenPError {
  const timeoutSec = Math.round(timeoutMs / 1000);
  const stderrSnippet = stderr.trim().slice(0, 200);
  const details = stderrSnippet ? `: ${stderrSnippet}` : '';
  return new OpenPError(`Codex did not respond within ${timeoutSec}s${details}`, EXIT_CODES.timeout);
}
