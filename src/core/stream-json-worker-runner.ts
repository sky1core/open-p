import { randomUUID } from 'node:crypto';
import { createAbortError } from './abort.js';
import { EXIT_CODES, OpenPError } from './errors.js';
import { parseStreamJsonUserEventLine, type CliOptions } from './cli-args.js';
import { SessionLockStore, type SessionLock } from './session-lock.js';
import { SessionStateStore, validateSessionStateCompatibility, type SessionState } from './session-state.js';
import { isPreviewCompatibleWithFinalText } from './preview-compat.js';
import {
  createPartialMessageStreamState,
  extractAssistantSnapshotReasoningText,
  extractAssistantSnapshotText,
  formatBackgroundAssistantTextEvent,
  formatIntermediateAssistantSnapshotEvent,
  formatIntermediateReasoningEvent,
  formatIntermediateTextEvent,
  formatPartialDeltaEvents,
  formatPartialMessageLifecycleEvents,
  formatPartialMessageStopEvents,
  formatSystemInitEvent,
  formatSystemStatusEvent,
  formatWorkerTurnResult,
  resolveStructuredOutputToolUseId,
} from './output.js';
import type { AssistantEventSnapshot } from './types.js';
import type { WorkerTurnRequest, WorkerTurnResult } from './worker-types.js';

export interface StreamJsonWorkerBridge {
  runTurn(request: WorkerTurnRequest): Promise<WorkerTurnResult>;
  shutdown?(): Promise<void>;
}

export interface StreamJsonWorkerOutputMetadata {
  readonly cwd: string;
  readonly model: string | null;
  readonly permissionMode: string | null;
  readonly mcpServers?: readonly unknown[];
  readonly contextWindow: number | null;
}

export async function runStreamJsonWorkerLines(input: {
  readonly options: CliOptions;
  readonly lines: AsyncIterable<string>;
  readonly bridge: StreamJsonWorkerBridge;
  readonly projectRoot: string;
  readonly outputMetadata: StreamJsonWorkerOutputMetadata;
  readonly signal?: AbortSignal;
  readonly stateStore?: SessionStateStore;
  readonly lockStore?: SessionLockStore;
  readonly resolveSessionLogPath?: (sessionId: string, projectRoot: string) => Promise<string | null>;
  readonly write: (chunk: string) => void;
}): Promise<number> {
  if (input.options.promptArg !== null) {
    throw new OpenPError('--input-format stream-json does not accept prompt arguments', EXIT_CODES.usage);
  }

  return runStreamJsonWorkerLinesWithLock(input);
}

async function runStreamJsonWorkerLinesWithLock(input: {
  readonly options: CliOptions;
  readonly lines: AsyncIterable<string>;
  readonly bridge: StreamJsonWorkerBridge;
  readonly projectRoot: string;
  readonly outputMetadata: StreamJsonWorkerOutputMetadata;
  readonly signal?: AbortSignal;
  readonly stateStore?: SessionStateStore;
  readonly lockStore?: SessionLockStore;
  readonly resolveSessionLogPath?: (sessionId: string, projectRoot: string) => Promise<string | null>;
  readonly write: (chunk: string) => void;
}): Promise<number> {
  const stateStore = input.stateStore ?? new SessionStateStore(input.projectRoot);
  const lockStore = input.lockStore ?? new SessionLockStore(input.projectRoot);
  const expectedState = {
    backend: 'claude-code' as const,
    provider: input.options.provider,
    backendSessionId: input.options.backendSessionId,
    cwd: input.projectRoot,
  };
  let existingState: SessionState | null = null;
  let lock: SessionLock | null = null;

  let lineNumber = 0;
  let sawUserEvent = false;
  let emittedInit = false;
  let initializedSession = false;
  let turnIndex = 0;
  let primaryError: unknown = null;
  let cleanupError: unknown = null;

  try {
    for await (const line of input.lines) {
      lineNumber += 1;
      const validated = parseStreamJsonUserEventLine(line, lineNumber);
      if (!validated) {
        continue;
      }
      sawUserEvent = true;

      if (!initializedSession) {
        lock = await lockStore.acquire(input.options.backendSessionId);
        existingState = input.options.resume
          ? await stateStore.requireCompatible(expectedState)
          : await stateStore.load(input.options.backendSessionId);
        if (existingState) {
          validateSessionStateCompatibility(existingState, expectedState);
        }
        initializedSession = true;
      }

      if (!emittedInit) {
        input.write(formatSystemInitEvent(input.options.backendSessionId, input.outputMetadata));
        if (input.options.includePartialMessages) {
          input.write(formatSystemStatusEvent({
            sessionId: input.options.backendSessionId,
            status: 'requesting',
          }));
        }
        emittedInit = true;
      }

      const partialState = createPartialMessageStreamState();
      let partialDeltaFailed = false;
      let latestReasoningText: string | null = null;
      let latestIntermediateText: string | null = null;
      const emittedIntermediateTexts: string[] = [];
      const emittedIntermediateReasoningTexts: string[] = [];
      const emittedIntermediateSnapshots: AssistantEventSnapshot[] = [];
      const publicTurnId = validated.turnId ?? randomUUID();
      const writePartialDelta = (text: string, reasoningText: string | null = latestReasoningText): boolean => {
        if (!input.options.includePartialMessages || input.options.jsonSchema || partialDeltaFailed) {
          return false;
        }
        try {
          input.write(formatPartialDeltaEvents(partialState, {
            sessionId: input.options.backendSessionId,
            model: input.options.model,
            text,
            reasoningText,
          }));
          return true;
        } catch {
          partialDeltaFailed = true;
          return false;
        }
      };
      const writeIntermediateText = (text: string, source: 'jsonl' | 'screen'): boolean => {
        if (source === 'screen' || input.options.jsonSchema || input.options.includePartialMessages) {
          return false;
        }
        if (
          !text ||
          text === latestIntermediateText ||
          (latestIntermediateText !== null &&
            (text.length <= latestIntermediateText.length || !text.startsWith(latestIntermediateText)))
        ) {
          return false;
        }
        latestIntermediateText = text;
        emittedIntermediateTexts.push(text);
        input.write(formatIntermediateTextEvent({
          turnId: publicTurnId,
          sessionId: input.options.backendSessionId,
          text,
          model: input.options.model,
        }));
        return true;
      };
      const writeIntermediateReasoning = (
        text: string,
        _source?: 'jsonl' | 'screen',
        contentBlocks?: readonly Record<string, unknown>[] | null,
      ): void => {
        if (
          input.options.includePartialMessages ||
          input.options.jsonSchema ||
          !text ||
          text === latestReasoningText
        ) {
          return;
        }
        latestReasoningText = text;
        emittedIntermediateReasoningTexts.push(text);
        input.write(formatIntermediateReasoningEvent({
          turnId: publicTurnId,
          sessionId: input.options.backendSessionId,
          text,
          contentBlocks,
          model: input.options.model,
        }));
      };
      const writeIntermediateSnapshot = (snapshot: AssistantEventSnapshot): void => {
        if (input.options.includePartialMessages || input.options.jsonSchema) {
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
        input.write(formatIntermediateAssistantSnapshotEvent({
          snapshot,
          sessionId: input.options.backendSessionId,
        }));
      };

      const result = await input.bridge.runTurn({
        sessionId: input.options.backendSessionId,
        isFirstTurn: turnIndex === 0 && !input.options.resume,
        projectRoot: input.projectRoot,
        message: validated.text,
        model: input.options.model,
        executionMode: input.options.permissionMode,
        appendSystemPrompt: input.options.appendSystemPrompt,
        jsonSchema: input.options.jsonSchema,
        timeoutMs: input.options.timeoutMs,
        paceIntermediateEvents: !input.options.includePartialMessages && !input.options.jsonSchema,
        contextWindow: input.outputMetadata.contextWindow,
        signal: input.signal,
        binArgs: input.options.backendArgs,
        onIntermediateText: !input.options.jsonSchema
          ? (text, source) => {
              if (input.options.includePartialMessages) {
                if (source === 'jsonl') {
                  writePartialDelta(text);
                }
                return;
              }
              writeIntermediateText(text, source);
            }
          : undefined,
        onIntermediateReasoning: input.options.includePartialMessages && !input.options.jsonSchema
          ? (text) => {
              latestReasoningText = text;
              writePartialDelta(partialState.previousText, text);
            }
          : !input.options.jsonSchema
            ? writeIntermediateReasoning
            : undefined,
        onIntermediateAssistantSnapshot: !input.options.includePartialMessages && !input.options.jsonSchema
          ? writeIntermediateSnapshot
          : undefined,
        onBackgroundAssistantText: (text) => {
          input.write(formatBackgroundAssistantTextEvent({
            turnId: publicTurnId,
            sessionId: input.options.backendSessionId,
            text,
          }));
        },
      });

      await saveStreamWorkerSessionState(input, stateStore, existingState, publicTurnId);
      if (input.options.includePartialMessages) {
        const structuredOutputToolUseId = resolveStructuredOutputToolUseId({
          structuredOutput: result.structuredOutput,
          assistantEvents: result.assistantEvents,
        });
        const partialStop = {
          sessionId: result.sessionId,
          stopReason: result.diagnostics.stopReason,
          usage: {
            inputTokens: result.diagnostics.inputTokens,
            outputTokens: result.diagnostics.outputTokens,
            cacheReadInputTokens: result.diagnostics.cacheReadInputTokens,
          },
        };
        if (result.structuredOutput === undefined) {
          writePartialDelta(result.content, selectFinalReasoningText(latestReasoningText, result.reasoningContent));
          input.write(formatPartialMessageStopEvents(partialState, partialStop));
        } else {
          input.write(formatPartialMessageLifecycleEvents(partialState, {
            model: input.options.model,
            structuredOutput: result.structuredOutput,
            structuredOutputToolUseId,
            ...partialStop,
          }));
        }
        input.write(formatWorkerTurnResult(result, {
          turnId: publicTurnId,
          model: input.options.model,
          structuredOutputToolUseId,
        }));
      } else {
        const latestEmittedIntermediateText = emittedIntermediateTexts.at(-1) ?? null;
        const suppressFinalAssistantText = isPreviewCompatibleWithFinalText(latestEmittedIntermediateText, result.content);
        const suppressAssistantTexts = suppressFinalAssistantText
          ? [...emittedIntermediateTexts, result.content]
          : emittedIntermediateTexts;
        input.write(formatWorkerTurnResult(result, {
          turnId: publicTurnId,
          model: input.options.model,
          suppressAssistantTexts,
          suppressAssistantReasoningTexts: emittedIntermediateReasoningTexts,
          suppressAssistantSnapshots: emittedIntermediateSnapshots,
          suppressFallbackAssistantText: suppressFinalAssistantText,
        }));
      }
      turnIndex += 1;
    }
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await shutdownBridge(input.bridge, primaryError);
    } catch (error) {
      cleanupError = error;
    }
    if (lock) {
      await releaseSessionLock(lock, primaryError ?? cleanupError);
    }
    if (primaryError === null && cleanupError) {
      throw cleanupError;
    }
  }

  if (input.signal?.aborted) {
    throw createAbortError();
  }
  if (!sawUserEvent) {
    throw new OpenPError('--input-format stream-json requires at least one user event', EXIT_CODES.usage);
  }
  return EXIT_CODES.success;
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

async function saveStreamWorkerSessionState(
  input: {
    readonly options: CliOptions;
    readonly projectRoot: string;
    readonly resolveSessionLogPath?: (sessionId: string, projectRoot: string) => Promise<string | null>;
  },
  stateStore: SessionStateStore,
  existingState: SessionState | null,
  lastTurnId: string | null,
): Promise<void> {
  await stateStore.save({
    backend: 'claude-code',
    provider: input.options.provider,
    backendSessionId: input.options.backendSessionId,
    cwd: input.projectRoot,
    lastProviderSessionId: null,
    sessionLogPath: input.resolveSessionLogPath
      ? await input.resolveSessionLogPath(input.options.backendSessionId, input.projectRoot)
      : existingState?.sessionLogPath ?? null,
    lastTurnId,
  });
}

async function releaseSessionLock(lock: SessionLock, primaryError: unknown): Promise<void> {
  try {
    await lock.release();
  } catch (releaseError) {
    if (primaryError === null) {
      throw releaseError;
    }
  }
}

async function shutdownBridge(bridge: StreamJsonWorkerBridge, primaryError: unknown): Promise<void> {
  try {
    await bridge.shutdown?.();
  } catch (shutdownError) {
    if (primaryError === null) {
      throw shutdownError;
    }
  }
}
