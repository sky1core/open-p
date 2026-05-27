import { randomUUID } from 'node:crypto';
import { readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Backend } from '../../core/backend.js';
import { createAbortError } from '../../core/abort.js';
import { EXIT_CODES, OpenPError } from '../../core/errors.js';
import { SessionLockStore } from '../../core/session-lock.js';
import type { AssistantEventSnapshot, TurnRequest, TurnResult, BackendRunOptions } from '../../core/types.js';

import { resolveCodexBin } from './bin.js';
import { buildFirstTurnArgs, buildResumeTurnArgs, validateCodexBackendArgs } from './args.js';
import {
  parseCodexOutput,
  processCodexStdoutLine,
  type CodexStreamState,
  type CodexStreamCallbacks,
} from './jsonl-parser.js';
import { getCodexSessionLogSize, readCodexSessionLogResult, type CodexSessionLogResult } from './session-log.js';
import { runCodexExec } from './exec-runner.js';
import { parseCodexStructuredOutputFallback, parseCodexStructuredOutputSchema } from './structured-output.js';

export class CodexBackend implements Backend {
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
    const startMs = Date.now();
    const bin = resolveCodexBin();
    const isFirstTurn = !options.resume;
    const outputLastMessagePath = join(tmpdir(), `openp-codex-last-${randomUUID()}.txt`);
    let outputSchemaPath: string | null = null;

    const structuredOutputSchema = parseCodexStructuredOutputSchema(options.jsonSchema);
    if (options.jsonSchema) {
      const schemaDir = join(tmpdir(), 'openp-codex-schemas');
      await mkdir(schemaDir, { recursive: true });
      outputSchemaPath = join(schemaDir, `schema-${randomUUID()}.json`);
      await writeFile(outputSchemaPath, options.jsonSchema, 'utf8');
    }

    const argsOptions = {
      model: options.model,
      reasoningEffort: options.reasoningEffort,
      executionMode: options.permissionMode,
      tools: options.tools,
      outputLastMessagePath,
      outputSchemaPath,
      cwd: options.cwd,
    };

    validateCodexBackendArgs(options.backendArgs);

    const args = isFirstTurn
      ? buildFirstTurnArgs(request.prompt, argsOptions)
      : buildResumeTurnArgs(options.backendSessionId, request.prompt, argsOptions);

    const streamState: CodexStreamState = {
      assistantText: '',
      reasoningText: '',
      lastAssistantText: null,
      lastAgentMessageMirrorCandidate: null,
      assistantEventSequence: 0,
      streamFinalAssistantText: structuredOutputSchema === null,
    };
    const callbacks: CodexStreamCallbacks = {
      onAssistantText: options.onIntermediateText
        ? (text) => {
            options.onIntermediateText!(text, 'jsonl');
          }
        : undefined,
      onReasoningText: options.onIntermediateReasoning
        ? (text) => {
            options.onIntermediateReasoning!(text, 'jsonl');
          }
        : undefined,
      onAssistantSnapshot: options.onIntermediateAssistantSnapshot
        ? (snapshot) => {
            options.onIntermediateAssistantSnapshot!(snapshot, 'jsonl');
          }
        : undefined,
    };

    const resumeLogOffset = !isFirstTurn
      ? await getCodexSessionLogSize(options.backendSessionId)
      : null;
    const initialLogOffset = isFirstTurn ? 0 : requireCodexResumeLogOffset(resumeLogOffset);

    try {
      const result = await runCodexExec({
        bin,
        args,
        cwd: options.cwd,
        timeoutMs: options.timeoutMs,
        signal: options.signal,
        forceSignal: options.forceSignal,
        killSignal: options.killSignal,
        onStdoutLine: (line) => {
          processCodexStdoutLine(line, streamState, callbacks);
        },
      });

      if (result.signal && !result.timedOut) {
        if (options.signal?.aborted) {
          throw createAbortError();
        }
        throw new OpenPError(`Codex CLI stopped due to signal ${result.signal}`, EXIT_CODES.backendExited);
      }

      if (result.timedOut) {
        const timeoutSec = Math.round(options.timeoutMs / 1000);
        throw new OpenPError(`Codex did not respond within ${timeoutSec}s`, EXIT_CODES.timeout);
      }

      if (result.exitCode !== 0) {
        const stderrSnippet = result.stderr.trim().slice(0, 500);
        const details = stderrSnippet ? `: ${stderrSnippet}` : '';
        throw new OpenPError(`Codex CLI exited with code ${result.exitCode}${details}`, EXIT_CODES.backendExited);
      }

      let lastMessageContent: string | null = null;
      try {
        lastMessageContent = await readFile(outputLastMessagePath, 'utf8');
      } catch {
        // file may not exist
      }

      const stdoutParsed = parseCodexOutput(result.stdout, lastMessageContent);

      if (!stdoutParsed.sessionId && isFirstTurn) {
        throw new OpenPError('Codex CLI did not return a session id', EXIT_CODES.protocolViolation);
      }
      if (!isFirstTurn && stdoutParsed.sessionId && stdoutParsed.sessionId !== options.backendSessionId) {
        throw new OpenPError('Codex CLI returned a different session id for resume turn', EXIT_CODES.protocolViolation);
      }
      const resolvedSessionId = stdoutParsed.sessionId ?? options.backendSessionId;

      const sessionLog = resolvedSessionId
        ? await readCodexSessionLogResult(resolvedSessionId, initialLogOffset)
        : null;
      if (!isFirstTurn && !sessionLog) {
        throw new OpenPError('Codex session log became unavailable for resume turn', EXIT_CODES.protocolViolation);
      }

      const resultSource = selectCodexResultSource(sessionLog, stdoutParsed);
      const reasoningContent = resultSource.reasoningContent;
      const commentaryEvents = resultSource.assistantEvents;
      const resultText = resultSource.content;
      if (!resultText && !reasoningContent && !hasCodexResultArtifacts(commentaryEvents)) {
        throw new OpenPError('Codex CLI returned an empty response', EXIT_CODES.protocolViolation);
      }
      const structuredOutput = parseCodexStructuredOutputFallback(
        resultText,
        structuredOutputSchema,
        request.turnId,
      );

      const durationMs = Date.now() - startMs;
      const usage = {
        inputTokens: resultSource.usage.inputTokens,
        outputTokens: resultSource.usage.outputTokens,
        cacheReadInputTokens: resultSource.usage.cacheReadInputTokens,
      };
      const lastSubturnUsage = resultSource.lastSubturnUsage;

      return {
        turnId: request.turnId,
        text: resultText,
        reasoningContent,
        ...(structuredOutput !== undefined ? { structuredOutput } : {}),
        sessionId: resolvedSessionId,
        assistantEvents: commentaryEvents.length > 0 ? commentaryEvents : undefined,
        diagnostics: {
          durationMs,
          stopReason: 'end_turn',
          toolsUsed: [],
          usage,
          rawUsage: null,
          model: options.model ?? resultSource.model ?? null,
          contextWindow: resultSource.contextWindow,
          lastSubturnUsage,
          lastSubturnContextTokens: addNullable(
            lastSubturnUsage?.inputTokens ?? null,
            lastSubturnUsage?.cacheReadInputTokens ?? null,
          ),
          rawEventCount: 0,
        },
      };
    } finally {
      await safeUnlink(outputLastMessagePath);
      if (outputSchemaPath) {
        await safeUnlink(outputSchemaPath);
      }
    }
  }
}

function selectCodexResultSource(
  sessionLog: CodexSessionLogResult | null,
  stdoutParsed: {
    readonly content: string | null;
    readonly reasoningContent: string | null;
    readonly assistantEvents: readonly AssistantEventSnapshot[];
    readonly usage: {
      readonly inputTokens: number | null;
      readonly outputTokens: number | null;
      readonly cacheReadInputTokens: number | null;
    };
  },
): {
  readonly content: string;
  readonly reasoningContent: string | null;
  readonly assistantEvents: readonly AssistantEventSnapshot[];
  readonly usage: {
    readonly inputTokens: number | null;
    readonly outputTokens: number | null;
    readonly cacheReadInputTokens: number | null;
  };
  readonly model: string | null;
  readonly contextWindow: number | null;
  readonly lastSubturnUsage: {
    readonly inputTokens: number | null;
    readonly outputTokens: number | null;
    readonly cacheReadInputTokens: number | null;
  } | null;
} {
  if (sessionLog) {
    if (!sessionLog.hasCompletionEvidence) {
      throw new OpenPError('Codex session log is missing completion evidence for the active turn', EXIT_CODES.protocolViolation);
    }
    return {
      content: sessionLog.content ?? '',
      reasoningContent: sessionLog.reasoningContent,
      assistantEvents: sessionLog.commentaryEvents,
      usage: sessionLog.usage,
      model: sessionLog.model,
      contextWindow: sessionLog.contextWindow,
      lastSubturnUsage: sessionLog.lastSubturnUsage,
    };
  }
  return {
    content: stdoutParsed.content ?? '',
    reasoningContent: stdoutParsed.reasoningContent,
    assistantEvents: stdoutParsed.assistantEvents,
    usage: stdoutParsed.usage,
    model: null,
    contextWindow: null,
    lastSubturnUsage: null,
  };
}

function addNullable(left: number | null, right: number | null): number | null {
  if (left === null || right === null) {
    return null;
  }
  return left + right;
}

function hasCodexResultArtifacts(events: readonly AssistantEventSnapshot[]): boolean {
  return events.some((event) => {
    const content = event.message.content;
    return Array.isArray(content) && content.some((block) => {
      if (!block || typeof block !== 'object' || Array.isArray(block)) {
        return false;
      }
      const type = (block as Record<string, unknown>).type;
      if (type === 'text' && typeof (block as Record<string, unknown>).text === 'string') {
        return ((block as Record<string, unknown>).text as string).trim().length > 0;
      }
      return type === 'tool_use' || type === 'server_tool_use' || type === 'tool_result';
    });
  });
}

function requireCodexResumeLogOffset(offset: number | null): number {
  if (offset === null) {
    throw new OpenPError('Codex resume session log offset is unavailable', EXIT_CODES.protocolViolation);
  }
  return offset;
}

async function safeUnlink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // best-effort cleanup
  }
}
