#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { stdin } from 'node:process';
import { parseCliArgs, resolvePrompt, type CliOptions } from './core/cli-args.js';
import { createAbortError } from './core/abort.js';
import { appendDebugLog } from './core/debug-log.js';
import { EXIT_CODES, OpenPError, toExitCode } from './core/errors.js';
import { parseJsonSchemaText } from './core/json-schema.js';
import { isPreviewCompatibleWithFinalText } from './core/preview-compat.js';
import {
  createPartialMessageStreamState,
  extractAssistantSnapshotReasoningText,
  extractAssistantSnapshotText,
  formatBackgroundAssistantTextEvent,
  formatIntermediateAssistantSnapshotEvent,
  formatIntermediateReasoningEvent,
  formatIntermediateTextEvent,
  formatPartialMessageLifecycleEvents,
  formatPartialMessageStopEvents,
  formatPartialDeltaEvents,
  formatSystemInitEvent,
  formatSystemStatusEvent,
  formatTurnResult,
  formatWorkerTurnResult,
  resolveKnownContextWindow,
  resolveStructuredOutputToolUseId,
} from './core/output.js';
import { SessionStateStore, validateSessionStateCompatibility } from './core/session-state.js';
import { runStreamJsonWorkerLines } from './core/stream-json-worker-runner.js';
import type { AssistantEventSnapshot } from './core/types.js';
import { TmuxProvider } from './runners/tmux.js';
import { registerBackend, getBackendProvider, getKnownBackendNames, resolveCanonicalBackendId } from './core/backend-registry.js';
import { claudeCodeBackendProvider } from './backends/claude-code/index.js';

registerBackend(claudeCodeBackendProvider);

const HELP = `openp

PTY-based prompt runner for interactive agent CLIs.

Usage:
  openp <backend> [options] [prompt]
  openp --backend <id> [options] [prompt]

Backends:
  claude               Claude Code interactive CLI (alias for claude-code)

Options:
  --backend <id>       Backend id (alternative to positional)
  --provider <id>      PTY provider. Default: tmux
  --session-id <uuid>  Use or create a backend session with this id
  --resume <uuid>      Resume a backend session with this id
  --timeout <seconds>  Turn timeout
  --input-format <fmt>   text or stream-json
  --output-format <fmt>  text, json, or stream-json
  --model <model>      Backend model
  --permission-mode <mode>
  --effort <level>     Backend reasoning effort pass-through
  --brief              Backend SendUserMessage compatibility pass-through
  --verbose            Backend verbose mode pass-through
  --append-system-prompt <text>
  --system-prompt <text>
  --json-schema <json> Validate and return structured output
  --include-partial-messages
  --dangerously-skip-permissions
  --debug-log <path>   Write runner diagnostics to a local file
  --version            Show version
  -h, --help           Show this help
`;

const VERSION = '0.1.0';

async function main(argv: readonly string[]): Promise<number> {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    process.stdout.write(HELP);
    return EXIT_CODES.success;
  }
  if (argv.length === 1 && argv[0] === '--version') {
    process.stdout.write(`openp ${VERSION}\n`);
    return EXIT_CODES.success;
  }

  let debugLogPath: string | null = null;
  try {
    const rawOptions = parseCliArgs(argv, getKnownBackendNames());
    const canonicalBackend = resolveCanonicalBackendId(rawOptions.backend);
    const options = canonicalBackend !== rawOptions.backend
      ? { ...rawOptions, backend: canonicalBackend } as typeof rawOptions
      : rawOptions;
    debugLogPath = options.debugLog;
    if (options.inputFormat === 'stream-json' && options.outputFormat === 'stream-json') {
      return await runStreamJsonWorker(options);
    }
    const prompt = await resolvePrompt(options.promptArg, options.inputFormat);
    await appendDebugLog(debugLogPath, {
      event: 'start',
      backend: options.backend,
      provider: options.provider,
      backendSessionId: options.backendSessionId,
      resume: options.resume,
      outputFormat: options.outputFormat,
      turnId: options.turnId,
    });
    const backendProvider = getBackendProvider(options.backend);
    const provider = new TmuxProvider();
    const backend = backendProvider.createBackend(provider);
    const wroteStreamInit = options.outputFormat === 'stream-json';
    const outputMetadata = buildOutputMetadata(options, process.cwd());
    if (wroteStreamInit) {
      process.stdout.write(formatSystemInitEvent(options.backendSessionId, outputMetadata));
      if (options.includePartialMessages) {
        process.stdout.write(formatSystemStatusEvent({
          sessionId: options.backendSessionId,
          status: 'requesting',
        }));
      }
    }
    const partialState = createPartialMessageStreamState();
    let partialDeltaFailed = false;
    let latestReasoningText: string | null = null;
    let latestIntermediateText: string | null = null;
    const emittedIntermediateTexts: string[] = [];
    const emittedIntermediateReasoningTexts: string[] = [];
    const emittedIntermediateSnapshots: AssistantEventSnapshot[] = [];
    const writeIntermediateSnapshot = (snapshot: AssistantEventSnapshot): void => {
      if (
        options.outputFormat !== 'stream-json' ||
        options.includePartialMessages ||
        options.jsonSchema
      ) {
        return;
      }
      const text = extractAssistantSnapshotText(snapshot);
      const reasoningText = extractAssistantSnapshotReasoningText(snapshot);
      if (text) {
        if (emittedIntermediateTexts.length > 0) {
          const publishedText = writeIntermediateText(text, 'jsonl');
          if (publishedText || text === latestIntermediateText) {
            if (reasoningText) {
              writeIntermediateReasoning(reasoningText, 'jsonl');
            }
            return;
          }
          return;
        }
        latestIntermediateText = text;
        emittedIntermediateTexts.push(text);
      }
      if (reasoningText) {
        latestReasoningText = reasoningText;
        emittedIntermediateReasoningTexts.push(reasoningText);
      }
      emittedIntermediateSnapshots.push(snapshot);
      process.stdout.write(formatIntermediateAssistantSnapshotEvent({
        snapshot,
        sessionId: options.backendSessionId,
      }));
    };
    const writeIntermediateReasoning = (
      text: string,
      _source?: 'jsonl' | 'screen',
      contentBlocks?: readonly Record<string, unknown>[] | null,
    ): void => {
      if (
        options.outputFormat !== 'stream-json' ||
        options.includePartialMessages ||
        options.jsonSchema ||
        !text ||
        text === latestReasoningText
      ) {
        return;
      }
      latestReasoningText = text;
      emittedIntermediateReasoningTexts.push(text);
      process.stdout.write(formatIntermediateReasoningEvent({
        turnId: options.turnId,
        sessionId: options.backendSessionId,
        text,
        contentBlocks,
        model: options.model,
      }));
    };
    const writeIntermediateText = (text: string, source: 'jsonl' | 'screen'): boolean => {
      if (
        options.outputFormat !== 'stream-json' ||
        options.includePartialMessages ||
        options.jsonSchema ||
        source === 'screen' ||
        !text ||
        text === latestIntermediateText ||
        (latestIntermediateText !== null &&
          (text.length <= latestIntermediateText.length || !text.startsWith(latestIntermediateText)))
      ) {
        return false;
      }
      latestIntermediateText = text;
      emittedIntermediateTexts.push(text);
      process.stdout.write(formatIntermediateTextEvent({
        turnId: options.turnId,
        sessionId: options.backendSessionId,
        text,
        model: options.model,
      }));
      return true;
    };
    const writePartialDelta = (text: string, reasoningText: string | null = latestReasoningText): void => {
      if (partialDeltaFailed) {
        return;
      }
      try {
        process.stdout.write(formatPartialDeltaEvents(partialState, {
          sessionId: options.backendSessionId,
          model: options.model,
          text,
          reasoningText,
        }));
      } catch {
        partialDeltaFailed = true;
      }
    };
    const streamingEnabled = options.outputFormat === 'stream-json' && options.includePartialMessages && !options.jsonSchema;
    const result = await backend.runTurn(
      {
        turnId: options.turnId,
        prompt,
        jsonSchema: options.jsonSchema ? parseJsonSchemaText(options.jsonSchema) : null,
      },
      {
        cwd: process.cwd(),
        provider: options.provider,
        backendSessionId: options.backendSessionId,
        resume: options.resume,
        timeoutMs: options.timeoutMs,
        model: options.model,
        permissionMode: options.permissionMode,
        appendSystemPrompt: options.appendSystemPrompt,
        jsonSchema: options.jsonSchema,
        backendArgs: options.backendArgs,
        debugLog: options.debugLog,
        paceIntermediateEvents: options.outputFormat === 'stream-json' && !options.includePartialMessages && !options.jsonSchema,
        onIntermediateText: streamingEnabled
          ? (text, source) => {
              if (source === 'jsonl') {
                writePartialDelta(text);
              }
            }
          : writeIntermediateText,
        onIntermediateReasoning: streamingEnabled
          ? (text) => {
              latestReasoningText = text;
              writePartialDelta(partialState.previousText, text);
            }
          : writeIntermediateReasoning,
        onIntermediateAssistantSnapshot: streamingEnabled ? undefined : writeIntermediateSnapshot,
      },
    );
    await appendDebugLog(debugLogPath, {
      event: 'success',
      backendSessionId: options.backendSessionId,
      turnId: result.turnId,
      diagnostics: result.diagnostics,
    });
    if (options.outputFormat === 'stream-json' && options.includePartialMessages) {
      const structuredOutputToolUseId = resolveStructuredOutputToolUseId({
        structuredOutput: result.structuredOutput,
        assistantEvents: result.assistantEvents,
      });
      const partialStop = {
        sessionId: options.backendSessionId,
        stopReason: result.diagnostics.stopReason,
        usage: {
          inputTokens: result.diagnostics.usage.inputTokens,
          outputTokens: result.diagnostics.usage.outputTokens,
          cacheReadInputTokens: result.diagnostics.usage.cacheReadInputTokens,
        },
      };
      const partialTextTail = result.structuredOutput === undefined && !partialDeltaFailed
        ? formatPartialTextDeltaBestEffort(partialState, {
            sessionId: options.backendSessionId,
            model: options.model,
            text: result.text,
            reasoningText: selectFinalReasoningText(latestReasoningText, result.reasoningContent ?? null),
          })
        : null;
      process.stdout.write(result.structuredOutput === undefined
        ? `${partialTextTail ?? ''}${formatPartialMessageStopEvents(partialState, partialStop)}`
        : formatPartialMessageLifecycleEvents(partialState, {
            model: options.model,
            structuredOutput: result.structuredOutput,
            structuredOutputToolUseId,
            ...partialStop,
          }));
      process.stdout.write(formatTurnResult(result, {
        outputFormat: options.outputFormat,
        backendSessionId: options.backendSessionId,
        includeSystemInit: !wroteStreamInit,
        structuredOutputToolUseId,
        ...outputMetadata,
      }));
      return EXIT_CODES.success;
    }
    const latestEmittedIntermediateText = emittedIntermediateTexts.at(-1) ?? null;
    const suppressFinalAssistantText = options.outputFormat === 'stream-json' &&
      isPreviewCompatibleWithFinalText(latestEmittedIntermediateText, result.text);
    const suppressAssistantTexts = suppressFinalAssistantText
      ? [...emittedIntermediateTexts, result.text]
      : emittedIntermediateTexts;
    const finalOutput = formatTurnResult(result, {
      outputFormat: options.outputFormat,
      backendSessionId: options.backendSessionId,
      includeSystemInit: !wroteStreamInit,
      suppressAssistantTexts,
      suppressAssistantReasoningTexts: emittedIntermediateReasoningTexts,
      suppressAssistantSnapshots: emittedIntermediateSnapshots,
      suppressFallbackAssistantText: suppressFinalAssistantText,
      ...outputMetadata,
    });
    if (options.outputFormat === 'stream-json') {
      process.stdout.write(finalOutput);
    } else {
      process.stdout.write(finalOutput);
    }
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
    return exitCode;
  }
}

async function runStreamJsonWorker(options: CliOptions): Promise<number> {
  if (stdin.isTTY === true) {
    throw new OpenPError('--input-format stream-json requires stdin', EXIT_CODES.usage);
  }
  const abortController = new AbortController();
  const handleSignal = (): void => {
    abortController.abort();
  };
  process.once('SIGINT', handleSignal);
  process.once('SIGTERM', handleSignal);
  try {
    const backendProvider = getBackendProvider(options.backend);
    return await runStreamJsonWorkerLines({
      options,
      lines: readStdinLines(abortController.signal),
      bridge: backendProvider.createWorkerBridge(),
      projectRoot: process.cwd(),
      outputMetadata: buildOutputMetadata(options, process.cwd()),
      signal: abortController.signal,
      resolveSessionLogPath: (sessionId, cwd) => backendProvider.resolveSessionLogPath(sessionId, cwd),
      write: (chunk) => process.stdout.write(chunk),
    });
  } finally {
    process.removeListener('SIGINT', handleSignal);
    process.removeListener('SIGTERM', handleSignal);
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

function selectFinalReasoningText(latestReasoningText: string | null, finalReasoningText: string | null): string | null {
  if (!finalReasoningText) {
    return latestReasoningText;
  }
  if (!latestReasoningText || finalReasoningText.startsWith(latestReasoningText)) {
    return finalReasoningText;
  }
  return latestReasoningText;
}

function buildOutputMetadata(options: CliOptions, cwd: string): {
  readonly cwd: string;
  readonly model: string | null;
  readonly permissionMode: string | null;
  readonly mcpServers?: readonly unknown[];
  readonly contextWindow: number | null;
} {
  return {
    cwd,
    model: options.model,
    permissionMode: options.permissionMode,
    contextWindow: resolveKnownContextWindow(options.model),
    ...(options.backendArgs.includes('--mcp-config') ? {} : { mcpServers: [] }),
  };
}

function formatPartialTextDeltaBestEffort(
  state: ReturnType<typeof createPartialMessageStreamState>,
  event: Parameters<typeof formatPartialDeltaEvents>[1],
): string | null {
  try {
    return formatPartialDeltaEvents(state, event);
  } catch {
    return null;
  }
}

process.exitCode = await main(process.argv.slice(2));
