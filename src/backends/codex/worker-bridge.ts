import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BackendWorkerBridge } from '../../core/backend.js';
import { createAbortError } from '../../core/abort.js';
import { ARTIFACT_REJECTION_REASONS, EXIT_CODES, OpenPError } from '../../core/errors.js';
import { isSafeSessionId } from '../../core/session-id.js';
import type { WorkerTurnRequest, WorkerTurnResult, WorkerTurnDiagnostics } from '../../core/worker-types.js';
import { readRequiredFirstTurnFlag } from '../../core/worker-input.js';

import { resolveCodexBin } from './bin.js';
import { buildFirstTurnArgs, buildResumeTurnArgs, validateCodexBackendArgs } from './args.js';
import {
  parseCodexOutput,
  processCodexStdoutLine,
  type CodexStreamState,
  type CodexStreamCallbacks,
} from './jsonl-parser.js';
import { getCodexSessionLogBaseline, readCodexSessionLogResultSinceBaseline } from './session-log.js';
import { addNullable, hasCodexResultArtifacts, safeUnlink, selectCodexResultSource } from './shared-result.js';
import { runCodexExec } from './exec-runner.js';
import { parseCodexStructuredOutputFallback, parseCodexStructuredOutputSchema } from './structured-output.js';
import { createCodexNonZeroExitError } from './exit-diagnostics.js';

export class CodexWorkerBridge implements BackendWorkerBridge {
  async runTurn(request: WorkerTurnRequest): Promise<WorkerTurnResult> {
    const startMs = Date.now();
    const bin = request.bin ?? resolveCodexBin();
    const isFirstTurn = readRequiredFirstTurnFlag(request);
    if (request.local === true) {
      throw new OpenPError('Codex backend does not support local worker mode', EXIT_CODES.unsupportedOption);
    }
    if (!isFirstTurn && !request.sessionId) {
      throw new OpenPError('Codex resume requires a session id', EXIT_CODES.usage);
    }
    if (!isFirstTurn && request.sessionId && !isSafeSessionId(request.sessionId)) {
      throw new OpenPError('unsafe Codex resume session id', EXIT_CODES.usage);
    }
    const outputLastMessagePath = join(tmpdir(), `openp-codex-last-${randomUUID()}.txt`);
    let outputSchemaPath: string | null = null;

    const structuredOutputSchema = parseCodexStructuredOutputSchema(request.jsonSchema ?? null);
    if (request.jsonSchema) {
      const schemaDir = join(tmpdir(), 'openp-codex-schemas');
      await mkdir(schemaDir, { recursive: true });
      outputSchemaPath = join(schemaDir, `schema-${randomUUID()}.json`);
      await writeFile(outputSchemaPath, request.jsonSchema, 'utf8');
    }

    validateCodexBackendArgs(request.binArgs ?? []);

    const argsOptions = {
      model: request.model,
      reasoningEffort: request.reasoningEffort ?? null,
      executionMode: request.executionMode,
      tools: request.tools,
      outputLastMessagePath,
      outputSchemaPath,
      cwd: request.projectRoot,
    };

    const args = isFirstTurn
      ? buildFirstTurnArgs(request.message, argsOptions)
      : buildResumeTurnArgs(request.sessionId!, request.message, argsOptions);

    const streamState: CodexStreamState = {
      assistantText: '',
      reasoningText: '',
      lastAssistantText: null,
      lastAgentMessageMirrorCandidate: null,
      assistantEventSequence: 0,
      streamFinalAssistantText: structuredOutputSchema === null,
    };
    const callbacks: CodexStreamCallbacks = {
      onAssistantText: request.onIntermediateText
        ? (text) => {
            request.onIntermediateText!(text, 'jsonl');
          }
        : undefined,
      onReasoningText: request.onIntermediateReasoning
        ? (text) => {
            request.onIntermediateReasoning!(text, 'jsonl');
          }
        : undefined,
      onAssistantSnapshot: request.onIntermediateAssistantSnapshot
        ? (snapshot) => {
            request.onIntermediateAssistantSnapshot!(snapshot, 'jsonl');
          }
        : undefined,
    };

    const resumeLogBaseline = !isFirstTurn && request.sessionId
      ? await getCodexSessionLogBaseline(request.sessionId)
      : null;

    try {
      const result = await runCodexExec({
        bin,
        args,
        cwd: request.projectRoot,
        env: request.env ? { ...process.env, ...request.env } : undefined,
        timeoutMs: request.timeoutMs ?? 0,
        signal: request.signal,
        forceSignal: request.forceSignal,
        killSignal: request.killSignal,
        onStdoutLine: (line) => {
          processCodexStdoutLine(line, streamState, callbacks);
        },
      });

      if (result.signal && !result.timedOut) {
        if (request.signal?.aborted) {
          throw createAbortError();
        }
        throw new OpenPError(`Codex CLI stopped due to signal ${result.signal}`, EXIT_CODES.backendExited);
      }

      if (result.timedOut) {
        const timeoutSec = Math.round((request.timeoutMs ?? 0) / 1000);
        const stderrSnippet = result.stderr.trim().slice(0, 200);
        const details = stderrSnippet ? `: ${stderrSnippet}` : '';
        throw new OpenPError(`Codex did not respond within ${timeoutSec}s${details}`, EXIT_CODES.timeout);
      }

      if (result.exitCode !== 0) {
        throw await createCodexNonZeroExitError({
          exitCode: result.exitCode,
          stderr: result.stderr,
          stdout: result.stdout,
          outputLastMessagePath,
          sessionId: isFirstTurn ? null : request.sessionId ?? null,
          sessionLogBaseline: resumeLogBaseline,
        });
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
      if (!isFirstTurn && stdoutParsed.sessionId && stdoutParsed.sessionId !== request.sessionId) {
        throw new OpenPError('Codex CLI returned a different session id for resume turn', EXIT_CODES.protocolViolation);
      }
      const resultSessionId = stdoutParsed.sessionId ?? request.sessionId;
      if (!resultSessionId) {
        throw new OpenPError('Codex CLI did not return a session id', EXIT_CODES.protocolViolation);
      }

      const sessionLog = await readCodexSessionLogResultSinceBaseline(resultSessionId, resumeLogBaseline);
      if (!isFirstTurn && resumeLogBaseline?.preexisting && !sessionLog) {
        throw new OpenPError(
          'Codex session log became unavailable for resume turn',
          EXIT_CODES.protocolViolation,
        );
      }

      const resultSource = selectCodexResultSource(sessionLog, stdoutParsed);
      const reasoningContent = resultSource.reasoningContent;
      const commentaryEvents = resultSource.assistantEvents;
      const resultContent = resultSource.content;
      if (!resultContent && !reasoningContent && !hasCodexResultArtifacts(commentaryEvents)) {
        throw new OpenPError(
          'Codex CLI returned an empty response',
          EXIT_CODES.protocolViolation,
          ARTIFACT_REJECTION_REASONS.unsupportedArtifactShape,
        );
      }
      const structuredOutput = parseCodexStructuredOutputFallback(
        resultContent,
        structuredOutputSchema,
        'codex-worker-turn',
      );

      const durationMs = Date.now() - startMs;
      const usage = {
        inputTokens: resultSource.usage.inputTokens,
        outputTokens: resultSource.usage.outputTokens,
        cacheReadInputTokens: resultSource.usage.cacheReadInputTokens,
      };
      const lastSubturnUsage = resultSource.lastSubturnUsage;

      const diagnostics: WorkerTurnDiagnostics = {
        numTurns: null,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadInputTokens: usage.cacheReadInputTokens,
        rawUsage: null,
        model: request.model ?? resultSource.model ?? null,
        contextWindow: resultSource.contextWindow,
        lastSubturnUsage,
        lastSubturnContextTokens: addNullable(
          lastSubturnUsage?.inputTokens ?? null,
          lastSubturnUsage?.cacheReadInputTokens ?? null,
        ),
        durationMs,
        totalCostUsd: null,
        stopReason: null,
        toolsUsed: [],
        autoCompacted: null,
        intermediateTextCount: null,
      };

      return {
        content: resultContent,
        reasoningContent,
        ...(structuredOutput !== undefined ? { structuredOutput } : {}),
        sessionId: resultSessionId,
        assistantEvents: commentaryEvents.length > 0 ? commentaryEvents : undefined,
        diagnostics,
      };
    } finally {
      await safeUnlink(outputLastMessagePath);
      if (outputSchemaPath) {
        await safeUnlink(outputSchemaPath);
      }
    }
  }

  async isChildAliveForSession(_sessionId: string): Promise<boolean> {
    return false;
  }

  async shutdown(): Promise<void> {
    // no persistent processes to clean up
  }
}
