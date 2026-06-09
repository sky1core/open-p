#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { stdin } from 'node:process';
import { resolveInitialTurnSessionId } from './core/backend-session-policy.js';
import {
  parseCliArgs,
  parseDebugLogOption,
  parseVerboseOption,
  resolvePrompt,
  type CliOptions,
  type DebugLogOption,
  type ResolvedCliOptions,
} from './core/cli-args.js';
import { createAbortError } from './core/abort.js';
import { appendDebugLog, resolveDefaultDebugLogPath, type DebugLogEntry } from './core/debug-log.js';
import { EXIT_CODES, OpenPError, toExitCode } from './core/errors.js';
import { installProcessSignalHandlers } from './core/graceful-interrupt.js';
import { parseJsonSchemaText } from './core/json-schema.js';
import {
  buildIntermediateAssistantSnapshotEvents,
  createStreamingMessageState,
  formatStreamingMessageSnapshotEvents,
  formatTurnResult,
  isStreamingReasoningReplacementError,
  resetStreamingMessageState,
  type OutputWarning,
  resolveStructuredOutputToolUseId,
} from './core/output.js';
import {
  StreamingResultDiagnosticTracker,
  type StreamingResultDiagnosticViolation,
} from './core/streaming-result-diagnostics.js';
import { SessionStateStore, validateSessionStateCompatibility } from './core/session-state.js';
import { runStreamJsonWorkerLines } from './core/stream-json-worker-runner.js';
import type { AssistantEventSnapshot, TurnResult } from './core/types.js';
import { TmuxProvider } from './runners/tmux.js';
import { registerBackend, getBackendProvider, getKnownBackendNames, resolveRegisteredBackendId } from './core/backend-registry.js';
import { getOpenPVersion } from './core/version.js';
import { claudeBackendProvider } from './backends/claude/index.js';
import { codexBackendProvider } from './backends/codex/index.js';
import { kiroBackendProvider } from './backends/kiro/index.js';

registerBackend(claudeBackendProvider);
registerBackend(codexBackendProvider);
registerBackend(kiroBackendProvider);

const HELP = `openp

Prompt-turn compatibility runner for local agent CLIs.

Usage:
  openp [options] <backend> [options] [prompt]
  echo "prompt" | openp [options] <backend> [options]

Backends:
  claude    Claude Code interactive backend
  codex     Codex exec backend
  kiro      Kiro ACP backend

Core options:
  --resume <session-id>       Resume a previously returned open-p session id
  --timeout <seconds>         Wall-clock turn timeout. Default: disabled; 0 disables
  --input-format <fmt>        text or stream-json
  --output-format <fmt>       text, json, or stream-json
  --model <model>             Backend model where supported
  --effort <level>            Backend reasoning effort where supported
  --tools <tools>             Tool allowlist where supported
  --json-schema <json>        Validate and return structured output
  --dangerously-skip-permissions
                              Trust backend tool execution where supported

Streaming and diagnostics:
  --streaming                 Opt in to active-turn streaming snapshots
  --debug-log                 Write runner diagnostics to the default open-p state log
  --verbose                   Mark verbose text output and include diagnostics

Top-level commands:
  openp --version             Show version
  openp -h, openp --help      Show this help

Contract:
  Backend selection is the first non-option positional argument.
  Public options may appear before or after the backend.
  Default stream-json output is result-only. Use --streaming for active-turn streaming.
  Only the options listed above are public openp options.
`;

async function main(argv: readonly string[]): Promise<number> {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    process.stdout.write(HELP);
    return EXIT_CODES.success;
  }
  if (argv.length === 1 && argv[0] === '--version') {
    process.stdout.write(`openp ${getOpenPVersion()}\n`);
    return EXIT_CODES.success;
  }

  const cwd = process.cwd();
  let debugLogPath = resolveDebugLogPath(parseDebugLogOption(argv), cwd);
  let verbose = parseVerboseOption(argv);
  try {
    const rawOptions = parseCliArgs(argv, getKnownBackendNames());
    const registeredBackendId = resolveRegisteredBackendId(rawOptions.backend);
    const registeredOptions = { ...rawOptions, backend: registeredBackendId } as typeof rawOptions;
    const options: ResolvedCliOptions = {
      ...registeredOptions,
      debugLog: resolveDebugLogPath(registeredOptions.debugLog, cwd),
    };
    debugLogPath = options.debugLog;
    verbose = options.verbose;
    if (options.inputFormat === 'stream-json' && options.outputFormat === 'stream-json') {
      return await runStreamJsonWorker(options);
    }
    const prompt = await resolvePrompt(options.promptArg, options.inputFormat);
    await appendDebugLog(debugLogPath, {
      event: 'start',
      backend: options.backend,
      backendSessionId: options.backendSessionId,
      resume: options.resume,
      outputFormat: options.outputFormat,
      turnId: options.turnId,
    });
    const backendProvider = getBackendProvider(options.backend);
    const provider = new TmuxProvider();
    const backend = backendProvider.createBackend(provider);
    const stateStore = new SessionStateStore(cwd);
    const expectedState = {
      backend: options.backend,
      backendSessionId: options.backendSessionId,
      cwd,
    };
    const existingState = options.resume
      ? await stateStore.requireCompatible(expectedState)
      : await stateStore.load(options.backendSessionId);
    if (existingState) {
      validateSessionStateCompatibility(existingState, expectedState);
    }
    const initialPublicSessionId = resolveInitialTurnSessionId({
      resume: options.resume,
      backendSessionId: options.backendSessionId,
    });
    const outputMetadata = buildOutputMetadata(options, cwd);
    const streamingState = createStreamingMessageState();
    const streamingResultTracker = new StreamingResultDiagnosticTracker();
    const emittedAssistantSnapshots: AssistantEventSnapshot[] = [];
    const emittedAssistantEvents: Record<string, unknown>[] = [];
    let streamingSnapshotFailed = false;
    let streamingReasoningSnapshotSuppressed = false;
    let streamingSnapshotError: unknown = null;
    const writeStreamingSnapshot = (
      text: string,
      reasoningText: string | null = null,
      sessionId: string | null = initialPublicSessionId,
    ): boolean => {
      if (streamingSnapshotFailed) {
        return false;
      }
      const reasoningForSnapshot = streamingReasoningSnapshotSuppressed ? null : reasoningText;
      try {
        const previousText = streamingState.previousText;
        const previousReasoningText = streamingState.previousReasoningText;
        const streamingOutput = formatStreamingMessageSnapshotEvents(streamingState, {
          turnId: options.turnId,
          sessionId,
          model: options.model,
          text,
          reasoningText: reasoningForSnapshot,
        });
        process.stdout.write(streamingOutput);
        if (text && text !== previousText) {
          streamingResultTracker.recordAnswerText(text);
        }
        if (reasoningForSnapshot && reasoningForSnapshot !== previousReasoningText) {
          streamingResultTracker.recordReasoningText(reasoningForSnapshot);
        }
        return true;
      } catch (error) {
        if (reasoningForSnapshot && isStreamingReasoningReplacementError(error)) {
          streamingReasoningSnapshotSuppressed = true;
          streamingSnapshotError ??= error;
          try {
            const previousText = streamingState.previousText;
            const streamingOutput = formatStreamingMessageSnapshotEvents(streamingState, {
              turnId: options.turnId,
              sessionId,
              model: options.model,
              text,
              reasoningText: null,
            });
            process.stdout.write(streamingOutput);
            if (text && text !== previousText) {
              streamingResultTracker.recordAnswerText(text);
            }
            return true;
          } catch (retryError) {
            streamingSnapshotFailed = true;
            streamingSnapshotError = retryError;
            return false;
          }
        }
        streamingSnapshotFailed = true;
        streamingSnapshotError = error;
        return false;
      }
    };
    const writeCumulativeStreamingAnswerSnapshot = (text: string): boolean => {
      return writeStreamingSnapshot(
        text,
        streamingState.previousReasoningText || null,
      );
    };
    const writeCumulativeStreamingReasoningSnapshot = (text: string): boolean => {
      return writeStreamingSnapshot(
        streamingState.previousText,
        text,
      );
    };
    const streamingEnabled = options.outputFormat === 'stream-json' && options.streaming;
    const signalHandlers = installProcessSignalHandlers();
    let result: TurnResult;
    try {
      result = await backend.runTurn(
        {
          turnId: options.turnId,
          prompt,
          jsonSchema: options.jsonSchema ? parseJsonSchemaText(options.jsonSchema) : null,
        },
        {
          cwd,
          backendSessionId: options.backendSessionId,
          resume: options.resume,
          timeoutMs: options.timeoutMs,
          model: options.model,
          reasoningEffort: options.reasoningEffort,
          permissionMode: options.permissionMode,
          tools: options.tools,
          jsonSchema: options.jsonSchema,
          backendArgs: options.backendArgs,
          debugLog: options.debugLog,
          paceIntermediateEvents: streamingEnabled,
          signal: signalHandlers.signal,
          forceSignal: signalHandlers.forceSignal,
          killSignal: signalHandlers.killSignal,
          onIntermediateText: streamingEnabled
              ? (text, source) => {
                if (source === 'jsonl') {
                  writeCumulativeStreamingAnswerSnapshot(text);
                }
              }
            : undefined,
          onIntermediateReasoning: streamingEnabled
            ? (text) => {
                writeCumulativeStreamingReasoningSnapshot(text);
              }
            : undefined,
            onIntermediateAssistantSnapshot: streamingEnabled
              ? (snapshot, source) => {
                if (source !== 'jsonl') {
                  return;
                }
                const assistantEvents = buildIntermediateAssistantSnapshotEvents({
                  snapshot,
                  sessionId: initialPublicSessionId,
                  turnId: options.turnId,
                }).filter((event) => snapshot.semanticKind === 'background' || !isStreamingAssistantTextEvent(event));
                emittedAssistantSnapshots.push(snapshot);
                emittedAssistantEvents.push(...assistantEvents);
                for (const assistantEvent of assistantEvents) {
                  process.stdout.write(`${JSON.stringify(assistantEvent)}\n`);
                }
              }
            : undefined,
        },
      );
    } finally {
      signalHandlers.dispose();
    }
    if (signalHandlers.signal.aborted) {
      throw createAbortError();
    }
    // The backend turn already completed; a diagnostics write failure must not discard the result.
    await appendDebugLog(debugLogPath, {
      event: 'success',
      backendSessionId: options.backendSessionId,
      turnId: result.turnId,
      diagnostics: result.diagnostics,
    }).catch(() => undefined);
    if (options.resume && result.sessionId && result.sessionId !== options.backendSessionId) {
      throw new OpenPError('backend returned a different session id for a resumed turn', EXIT_CODES.protocolViolation);
    }
    const resultSessionId = result.sessionId ?? (options.resume ? options.backendSessionId : null);
    if (!resultSessionId) {
      throw new OpenPError('backend did not return a session id', EXIT_CODES.protocolViolation);
    }
    let successOutput = '';
    let verboseWarnings: readonly OutputWarning[] = [];
    if (options.outputFormat === 'stream-json' && options.streaming) {
      const streamingIssues = await appendStreamingResultDiagnostic(debugLogPath, {
        backend: options.backend,
        turnId: result.turnId,
        sessionId: resultSessionId,
        streamingSnapshotError,
        violations: streamingResultTracker.findViolations(result.text, result.reasoningContent ?? null),
      });
      verboseWarnings = options.verbose ? streamingIssuesToWarnings(streamingIssues, debugLogPath) : [];
    }
    if (options.outputFormat === 'stream-json' && options.streaming) {
      const structuredOutputToolUseId = resolveStructuredOutputToolUseId({
        structuredOutput: result.structuredOutput,
        assistantEvents: result.assistantEvents,
      });
      resetStreamingMessageState(streamingState);
      successOutput += formatTurnResult(result, {
        outputFormat: options.outputFormat,
        backendSessionId: resultSessionId,
        includeSystemInit: false,
        structuredOutputToolUseId,
        suppressAssistantSnapshots: emittedAssistantSnapshots,
        previouslyEmittedAssistantEvents: emittedAssistantEvents,
        warnings: verboseWarnings,
        verbose: options.verbose,
        ...outputMetadata,
      });
      await stateStore.save({
        backend: options.backend,
        backendSessionId: resultSessionId,
        cwd,
        lastProviderSessionId: existingState?.lastProviderSessionId ?? null,
        sessionLogPath: resultSessionId
          ? await backendProvider.resolveSessionLogPath(resultSessionId, cwd)
          : existingState?.sessionLogPath ?? null,
        lastTurnId: result.turnId,
      });
      process.stdout.write(successOutput);
      return EXIT_CODES.success;
    }
    successOutput = formatTurnResult(result, {
      outputFormat: options.outputFormat,
      backendSessionId: resultSessionId,
      includeSystemInit: false,
      warnings: verboseWarnings,
      verbose: options.verbose,
      ...outputMetadata,
    });
    await stateStore.save({
      backend: options.backend,
      backendSessionId: resultSessionId,
      cwd,
      lastProviderSessionId: existingState?.lastProviderSessionId ?? null,
      sessionLogPath: resultSessionId
        ? await backendProvider.resolveSessionLogPath(resultSessionId, cwd)
        : existingState?.sessionLogPath ?? null,
      lastTurnId: result.turnId,
    });
    process.stdout.write(successOutput);
    return EXIT_CODES.success;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const exitCode = toExitCode(error);
    await appendDebugLog(debugLogPath, {
      event: 'error',
      message,
      exitCode,
    }).catch(() => undefined);
    process.stderr.write(`${message}\n`);
    if (verbose) {
      process.stderr.write(formatVerboseError(exitCode, debugLogPath));
    }
    return exitCode;
  }
}

async function runStreamJsonWorker(options: ResolvedCliOptions): Promise<number> {
  if (stdin.isTTY === true) {
    throw new OpenPError('--input-format stream-json requires stdin', EXIT_CODES.usage);
  }
  const signalHandlers = installProcessSignalHandlers();
  try {
    const backendProvider = getBackendProvider(options.backend);
    return await runStreamJsonWorkerLines({
      options,
      lines: readStdinLines(signalHandlers.signal),
      bridge: backendProvider.createWorkerBridge(),
      projectRoot: process.cwd(),
      outputMetadata: buildOutputMetadata(options, process.cwd()),
      signal: signalHandlers.signal,
      forceSignal: signalHandlers.forceSignal,
      killSignal: signalHandlers.killSignal,
      resolveSessionLogPath: (sessionId, cwd) => backendProvider.resolveSessionLogPath(sessionId, cwd),
      write: (chunk) => process.stdout.write(chunk),
    });
  } finally {
    signalHandlers.dispose();
  }
}

async function* readStdinLines(signal: AbortSignal): AsyncIterable<string> {
  const lines = createInterface({ input: stdin, crlfDelay: Infinity });
  let aborted = signal.aborted;
  const closeOnAbort = (): void => {
    aborted = true;
    lines.close();
  };
  if (signal.aborted) {
    lines.close();
  } else {
    signal.addEventListener('abort', closeOnAbort, { once: true });
  }
  try {
    for await (const line of lines) {
      if (aborted) {
        break;
      }
      yield line;
    }
    if (aborted) {
      throw createAbortError();
    }
  } finally {
    signal.removeEventListener('abort', closeOnAbort);
    lines.close();
  }
}

async function appendStreamingResultDiagnostic(
  debugLogPath: string | null,
  input: {
    readonly backend: string;
    readonly turnId: string;
    readonly sessionId: string;
    readonly streamingSnapshotError: unknown;
    readonly violations: readonly StreamingResultDiagnosticViolation[];
  },
): Promise<readonly DebugLogEntry[]> {
  const issues: DebugLogEntry[] = [];
  if (input.streamingSnapshotError) {
    issues.push({
      event: 'streaming_snapshot_rejected',
      message: 'streaming snapshot replacement is not prefix-compatible with the current stream message',
      errorMessage: errorMessage(input.streamingSnapshotError),
    });
  }
  issues.push(...input.violations.map((violation) => ({
    event: 'streaming_result_mismatch',
    ...violation,
  })));
  if (issues.length === 0) {
    return issues;
  }
  // Streaming diagnostics are non-fatal; a write failure must not discard the confirmed result.
  await appendDebugLog(debugLogPath, {
    event: 'streaming_result_diagnostic',
    severity: 'warning',
    backend: input.backend,
    turnId: input.turnId,
    sessionId: input.sessionId,
    issueCount: issues.length,
    issues,
  }).catch(() => undefined);
  return issues;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function streamingIssuesToWarnings(
  issues: readonly DebugLogEntry[],
  debugLogPath: string | null,
): readonly OutputWarning[] {
  if (issues.length === 0) {
    return [];
  }
  const message = debugLogPath
    ? `Streaming result diagnostics were recorded (${issues.length}); result was preserved. See debug log: ${debugLogPath}.`
    : `Streaming result diagnostics were detected (${issues.length}); result was preserved. Use --debug-log to record details.`;
  return [{
    severity: 'warning',
    code: 'streaming_result_diagnostic',
    message,
  }];
}

function isStreamingAssistantTextEvent(event: Record<string, unknown>): boolean {
  const openp = event.openp;
  if (!openp || typeof openp !== 'object' || Array.isArray(openp)) return false;
  const output = (openp as Record<string, unknown>).output;
  if (!output || typeof output !== 'object' || Array.isArray(output)) return false;
  return (openp as Record<string, unknown>).form === 'streaming' &&
    (typeof (output as Record<string, unknown>).answer === 'string' ||
      typeof (output as Record<string, unknown>).reasoning === 'string');
}

function formatVerboseError(exitCode: number, debugLogPath: string | null): string {
  const debugLog = debugLogPath ? `\n[openp error] debug_log: ${debugLogPath}` : '';
  return `[openp error] exit_code: ${exitCode}${debugLog}\n`;
}

function buildOutputMetadata(options: ResolvedCliOptions, cwd: string): {
  readonly backend: string;
  readonly cwd: string;
  readonly model: string | null;
  readonly permissionMode: string | null;
  readonly mcpServers?: readonly unknown[];
  readonly contextWindow: number | null;
} {
  return {
    backend: options.backend,
    cwd,
    model: options.model,
    permissionMode: options.permissionMode,
    contextWindow: null,
    mcpServers: [],
  };
}

function resolveDebugLogPath(option: DebugLogOption, cwd: string): string | null {
  switch (option.kind) {
    case 'off':
      return null;
    case 'default':
      return resolveDefaultDebugLogPath(cwd);
  }
}

process.exitCode = await main(process.argv.slice(2));
