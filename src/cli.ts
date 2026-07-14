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
import { appendDebugLog, resolveDefaultDebugLogPath } from './core/debug-log.js';
import { EXIT_CODES, OpenPError, toExitCode } from './core/errors.js';
import { installProcessSignalHandlers } from './core/graceful-interrupt.js';
import { parseJsonSchemaText } from './core/json-schema.js';
import {
  openRunEventLog,
  statusFromExitCode,
  type RunEventLog,
} from './core/run-event-log.js';
import {
  buildIntermediateAssistantSnapshotEvents,
  createStreamingMessageState,
  formatTurnResult,
  resetStreamingMessageState,
  type OutputWarning,
  resolveStructuredOutputToolUseId,
} from './core/output.js';
import {
  StreamingResultDiagnosticTracker,
} from './core/streaming-result-diagnostics.js';
import {
  appendStreamingResultDiagnostic,
  createStreamingSnapshotWriter,
  isStreamingAssistantTextEvent,
  streamingIssuesToWarnings,
} from './core/streaming-output-helpers.js';
import { SessionStateStore, validateSessionStateCompatibility } from './core/session-state.js';
import { parseSeedArgs } from './core/seed-args.js';
import { loadSeedHistoryFile } from './core/seed-history.js';
import { runSeed } from './core/seed.js';
import { runStreamJsonWorkerLines } from './core/stream-json-worker-runner.js';
import type { AssistantEventSnapshot, TurnResult } from './core/types.js';
import { TmuxProvider } from './runners/tmux.js';
import {
  registerBackend,
  getBackendProvider,
  getKnownBackendNames,
  getRegisteredBackendIds,
  resolveRegisteredBackendId,
} from './core/backend-registry.js';
import { loadConfiguredBackendInstances } from './core/configured-backend-instances.js';
import { collectBackendLoginStatuses, formatBackendLoginStatuses } from './core/auth-status.js';
import { getOpenPVersion } from './core/version.js';
import { claudeBackendProvider, createClaudeBackendProvider } from './backends/claude/index.js';
import { codexBackendProvider, createCodexBackendProvider } from './backends/codex/index.js';
import { kiroBackendProvider } from './backends/kiro/index.js';
import { opencodeBackendProvider } from './backends/opencode/index.js';

registerBackend(claudeBackendProvider);
registerBackend(codexBackendProvider);
registerBackend(kiroBackendProvider);
registerBackend(opencodeBackendProvider);

const HELP = `openp

Prompt-turn compatibility runner for local agent CLIs.

Usage:
  openp [options] <backend> [options] [prompt]
  echo "prompt" | openp [options] <backend> [options]

Backends:
  claude    Claude Code interactive backend
  codex     Codex exec backend
  kiro      Kiro ACP backend
  opencode  OpenCode local-private backend
  Configured backend instances from \${XDG_CONFIG_HOME:-~/.config}/open-p/instances.yaml are selectable like built-in backends.

Core options:
  --resume <session-id>       Resume a previously returned open-p session id
  --timeout <seconds>         Wall-clock turn timeout. Default: disabled; 0 disables
  --input-format <fmt>        text or stream-json
  --output-format <fmt>       text, json, or stream-json
  --model <model>             Backend model where supported
  --effort <level>            Backend reasoning effort where supported
  --tools <tools>             Tool allowlist where supported
  --json-schema <json>        Validate and return structured output
  --run-id <id>               Caller-supplied invocation identifier for process discovery
  --event-log <path>          Append stream-json records and lifecycle/activity records to a file
  --dangerously-skip-permissions
                              Trust backend tool execution where supported

Streaming and diagnostics:
  --streaming                 Opt in to active-turn streaming snapshots
  --debug-log                 Write runner diagnostics to the default open-p state log
  --verbose                   Mark verbose text output and include diagnostics

Top-level commands:
  openp auth-status           Print Claude, Codex, and Kiro CLI login booleans as JSON
  openp seed <backend> --history <path> [--resume <id>]
                              Seed or extend a native backend session from prior turns
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
  let eventLog: RunEventLog | null = null;
  let safeStdio: SafeProcessStdio | null = null;
  let disposeUncaughtExceptionHandler: (() => void) | null = null;
  let eventLogGuardState: EventLogSignalGuardState | null = null;
  let disposeEventLogSignalGuard: (() => void) | null = null;
  try {
    await registerConfiguredBackendInstances();
    if (argv[0] === 'auth-status') {
      if (argv.length !== 1) {
        throw new OpenPError('auth-status does not accept options or arguments', EXIT_CODES.usage);
      }
      const providers = getRegisteredBackendIds().map((id) => getBackendProvider(id));
      const statuses = await collectBackendLoginStatuses(providers);
      process.stdout.write(formatBackendLoginStatuses(statuses));
      return EXIT_CODES.success;
    }
    if (argv[0] === 'seed') {
      const seedOptions = parseSeedArgs(argv.slice(1), getKnownBackendNames());
      const registeredId = resolveRegisteredBackendId(seedOptions.backend);
      const provider = getBackendProvider(registeredId);
      const turns = await loadSeedHistoryFile(seedOptions.historyPath);
      const signalHandlers = installProcessSignalHandlers();
      try {
        const result = await runSeed({
          options: { ...seedOptions, backend: registeredId },
          provider,
          createBackend: () => provider.createBackend(new TmuxProvider()),
          cwd,
          turns,
          debugLog: debugLogPath,
          signal: signalHandlers.signal,
          forceSignal: signalHandlers.forceSignal,
          killSignal: signalHandlers.killSignal,
        });
        process.stdout.write(`${JSON.stringify({ seed: result })}\n`);
        return EXIT_CODES.success;
      } finally {
        signalHandlers.dispose();
      }
    }
    const rawOptions = parseCliArgs(argv, getKnownBackendNames());
    const registeredBackendId = resolveRegisteredBackendId(rawOptions.backend);
    const registeredOptions = { ...rawOptions, backend: registeredBackendId } as typeof rawOptions;
    const options: ResolvedCliOptions = {
      ...registeredOptions,
      debugLog: resolveDebugLogPath(registeredOptions.debugLog, cwd),
    };
    debugLogPath = options.debugLog;
    verbose = options.verbose;
    if (options.eventLogPath !== null) {
      safeStdio = installSafeProcessStdio();
      // Arm the guard before the event-log file becomes visible: the file's existence is the
      // caller's readiness signal, so signal handling must already be in place by then. The guard
      // stays registered for the whole invocation — removing and re-adding process signal
      // listeners drops signals that were received but not yet dispatched.
      eventLogGuardState = { eventLog: null, delegate: null };
      disposeEventLogSignalGuard = installEventLogSignalGuard(eventLogGuardState);
      eventLog = openRunEventLog(options.eventLogPath, {
        runId: options.runId,
        pid: process.pid,
        startedAt: new Date().toISOString(),
        backend: options.backend,
        resume: options.resume ? options.backendSessionId : null,
      }, (message) => safeStdio?.writeStderr(message));
      eventLogGuardState.eventLog = eventLog;
      disposeUncaughtExceptionHandler = installRunEventLogUncaughtExceptionHandler(eventLog);
    }
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
    const streamingEnabled = options.outputFormat === 'stream-json' && options.streaming;
    const snapshotWriter = createStreamingSnapshotWriter({
      streamingState,
      resultTracker: streamingResultTracker,
      write: (chunk) => writeStdout(chunk, eventLog, safeStdio),
      turnId: options.turnId,
      sessionId: initialPublicSessionId,
      model: options.model,
      streamingEnabled,
    });
    const {
      writeCumulativeStreamingAnswerSnapshot,
      writeCumulativeStreamingReasoningSnapshot,
    } = snapshotWriter;
    // With the event-log guard active, the guard remains the only process signal listener and
    // forwards into the interrupt chain, so no listener swap can drop an in-flight signal.
    const signalHandlers = installProcessSignalHandlers(
      eventLogGuardState ? { registerProcessListeners: false } : {},
    );
    if (eventLogGuardState) {
      eventLogGuardState.delegate = signalHandlers.handleSignal;
    }
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
                  writeStdout(`${JSON.stringify(assistantEvent)}\n`, eventLog, safeStdio);
                }
              }
            : undefined,
          onRunActivity: eventLog
            ? (activity) => {
                eventLog?.writeActivity(activity);
              }
            : undefined,
        },
      );
    } finally {
      if (eventLogGuardState) {
        eventLogGuardState.delegate = null;
      }
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
    // Third emit path: a provider-error interruption returns a real (partial) result that is emitted like
    // a success record, but the process then exits with the interruption's non-zero code instead of 0.
    // On normal turns interruptedExitCode is undefined and finalExitCode stays success — path unchanged.
    const finalExitCode = result.interruptedExitCode ?? EXIT_CODES.success;
    let successOutput = '';
    let verboseWarnings: readonly OutputWarning[] = [];
    if (options.outputFormat === 'stream-json' && options.streaming) {
      const streamingIssues = await appendStreamingResultDiagnostic(debugLogPath, {
        backend: options.backend,
        turnId: result.turnId,
        sessionId: resultSessionId,
        streamingSnapshotError: snapshotWriter.snapshotError,
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
        structuredOutputToolUseId,
        suppressAssistantSnapshots: emittedAssistantSnapshots,
        previouslyEmittedAssistantEvents: emittedAssistantEvents,
        warnings: verboseWarningsForResult(result, verboseWarnings, options),
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
      writeStdout(successOutput, eventLog, safeStdio);
      eventLog?.writeTerminal({
        status: statusFromExitCode(finalExitCode),
        exitCode: finalExitCode,
        reasonCode: null,
        message: interruptedTerminalMessage(result, finalExitCode),
        endedAt: new Date().toISOString(),
      });
      return finalExitCode;
    }
    successOutput = formatTurnResult(result, {
      outputFormat: options.outputFormat,
      backendSessionId: resultSessionId,
      warnings: verboseWarningsForResult(result, verboseWarnings, options),
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
    writeStdout(successOutput, eventLog, safeStdio);
    eventLog?.writeTerminal({
      status: statusFromExitCode(finalExitCode),
      exitCode: finalExitCode,
      reasonCode: null,
      message: interruptedTerminalMessage(result, finalExitCode),
      endedAt: new Date().toISOString(),
    });
    return finalExitCode;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const exitCode = toExitCode(error);
    const reasonCode = error instanceof OpenPError ? error.reasonCode : undefined;
    const details = error instanceof OpenPError ? error.details : undefined;
    await appendDebugLog(debugLogPath, {
      event: 'error',
      message,
      exitCode,
      ...(reasonCode ? { reasonCode } : {}),
      ...(details ? { details } : {}),
    }).catch(() => undefined);
    writeStderr(`${message}\n`, safeStdio);
    if (verbose) {
      writeStderr(formatVerboseError(exitCode, debugLogPath, reasonCode), safeStdio);
    }
    eventLog?.writeTerminal({
      status: statusFromExitCode(exitCode),
      exitCode,
      reasonCode: reasonCode ?? null,
      message,
      endedAt: new Date().toISOString(),
    });
    return exitCode;
  } finally {
    disposeEventLogSignalGuard?.();
    disposeUncaughtExceptionHandler?.();
    eventLog?.close();
  }
}

interface EventLogSignalGuardState {
  eventLog: RunEventLog | null;
  delegate: ((signal: NodeJS.Signals) => void) | null;
}

// The single process signal listener while --event-log is in use; without it the default signal
// disposition is unchanged. Armed before the event-log file is created (a signal before creation
// still exits 130, just without a terminal record) and kept registered for the whole invocation.
// While a turn is active it forwards into the graceful interrupt chain via `delegate`; outside a
// turn it records an interrupted terminal and exits.
function installEventLogSignalGuard(state: EventLogSignalGuardState): () => void {
  const onSignal = (signal: NodeJS.Signals): void => {
    if (state.delegate) {
      state.delegate(signal);
      return;
    }
    state.eventLog?.writeTerminal({
      status: 'interrupted',
      exitCode: EXIT_CODES.interrupted,
      reasonCode: null,
      message: `interrupted by ${signal} outside an active backend turn`,
      endedAt: new Date().toISOString(),
    });
    state.eventLog?.close();
    process.exit(EXIT_CODES.interrupted);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  return () => {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  };
}

interface SafeProcessStdio {
  writeStdout(chunk: string): void;
  writeStderr(chunk: string): void;
}

function writeStdout(chunk: string, eventLog: RunEventLog | null, safeStdio: SafeProcessStdio | null): void {
  eventLog?.appendMirroredStdout(chunk);
  if (safeStdio) {
    safeStdio.writeStdout(chunk);
    return;
  }
  process.stdout.write(chunk);
}

function writeStderr(chunk: string, safeStdio: SafeProcessStdio | null): void {
  if (safeStdio) {
    safeStdio.writeStderr(chunk);
    return;
  }
  process.stderr.write(chunk);
}

function installSafeProcessStdio(): SafeProcessStdio {
  let stdoutClosed = false;
  let stderrClosed = false;
  const onStdoutError = (error: Error): void => {
    if (isClosedStdIoError(error)) {
      stdoutClosed = true;
      return;
    }
    throw error;
  };
  const onStderrError = (error: Error): void => {
    if (isClosedStdIoError(error)) {
      stderrClosed = true;
      return;
    }
    throw error;
  };
  process.stdout.on('error', onStdoutError);
  process.stderr.on('error', onStderrError);

  return {
    writeStdout(chunk: string): void {
      if (stdoutClosed) {
        return;
      }
      try {
        process.stdout.write(chunk);
      } catch (error) {
        if (isClosedStdIoError(error)) {
          stdoutClosed = true;
          return;
        }
        throw error;
      }
    },
    writeStderr(chunk: string): void {
      if (stderrClosed) {
        return;
      }
      try {
        process.stderr.write(chunk);
      } catch (error) {
        if (isClosedStdIoError(error)) {
          stderrClosed = true;
          return;
        }
        throw error;
      }
    },
  };
}

function isClosedStdIoError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const code = 'code' in error ? String(error.code) : '';
  return code === 'EPIPE' ||
    code === 'EBADF' ||
    code === 'ERR_STREAM_DESTROYED' ||
    code === 'ERR_STREAM_WRITE_AFTER_END';
}

function installRunEventLogUncaughtExceptionHandler(eventLog: RunEventLog): () => void {
  const handler = (error: unknown): void => {
    // Rethrowing below makes Node pick the actual crash exit code; recording a guessed
    // code here would fabricate a value, so the unknown exit code is recorded as null.
    eventLog.writeTerminal({
      status: 'failed',
      exitCode: null,
      reasonCode: error instanceof OpenPError ? error.reasonCode ?? null : null,
      message: error instanceof Error ? error.message : String(error),
      endedAt: new Date().toISOString(),
    });
    eventLog.close();
    process.removeListener('uncaughtException', handler);
    throw error;
  };
  process.on('uncaughtException', handler);
  return () => {
    process.removeListener('uncaughtException', handler);
  };
}

// Terminal record message for the interrupted (non-zero) emit path. Reuses the provider-error warning
// text already attached to the result so the event log records why the turn exited non-zero.
function interruptedTerminalMessage(result: TurnResult, finalExitCode: number): string | null {
  if (finalExitCode === EXIT_CODES.success) {
    return null;
  }
  return result.warnings?.find((warning) => warning.code === 'provider_error_interrupted')?.message ?? null;
}

function verboseWarningsForResult(
  result: TurnResult,
  warnings: readonly OutputWarning[],
  options: ResolvedCliOptions,
): readonly OutputWarning[] {
  if (options.outputFormat === 'text') {
    return options.verbose ? [...(result.warnings ?? []), ...warnings] : warnings;
  }
  return warnings;
}

async function registerConfiguredBackendInstances(): Promise<void> {
  for (const instance of await loadConfiguredBackendInstances()) {
    if (instance.backend === 'claude') {
      registerBackend(createClaudeBackendProvider({
        id: instance.id,
        configDir: instance.configDir,
      }));
      continue;
    }
    if (instance.backend === 'codex') {
      registerBackend(createCodexBackendProvider({
        id: instance.id,
        homeDir: instance.homeDir,
      }));
    }
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

function formatVerboseError(exitCode: number, debugLogPath: string | null, reasonCode?: string): string {
  const reason = reasonCode ? `\n[openp error] reason_code: ${reasonCode}` : '';
  const debugLog = debugLogPath ? `\n[openp error] debug_log: ${debugLogPath}` : '';
  return `[openp error] exit_code: ${exitCode}${reason}${debugLog}\n`;
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
