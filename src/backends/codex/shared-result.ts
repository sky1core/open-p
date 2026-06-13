import { unlink } from 'node:fs/promises';

import { ARTIFACT_REJECTION_REASONS, EXIT_CODES, OpenPError } from '../../core/errors.js';
import type { AssistantEventSnapshot } from '../../core/types.js';

import type { CodexSessionLogResult } from './session-log.js';

export function selectCodexResultSource(
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
      throw new OpenPError(
        'Codex session log is missing completion evidence for the active turn',
        EXIT_CODES.protocolViolation,
        ARTIFACT_REJECTION_REASONS.missingCompletion,
      );
    }
    return {
      content: sessionLog.content ?? '',
      reasoningContent: sessionLog.reasoningContent,
      assistantEvents: sessionLog.commentaryEvents,
      usage: hasCodexUsageSnapshot(sessionLog.usage) ? sessionLog.usage : emptyCodexUsage(),
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

export function addNullable(left: number | null, right: number | null): number | null {
  if (left === null || right === null) {
    return null;
  }
  return left + right;
}

export function hasCodexUsageSnapshot(usage: {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadInputTokens: number | null;
}): boolean {
  return usage.inputTokens !== null ||
    usage.outputTokens !== null ||
    usage.cacheReadInputTokens !== null;
}

export function emptyCodexUsage(): {
  readonly inputTokens: null;
  readonly outputTokens: null;
  readonly cacheReadInputTokens: null;
} {
  return {
    inputTokens: null,
    outputTokens: null,
    cacheReadInputTokens: null,
  };
}

export function hasCodexResultArtifacts(events: readonly AssistantEventSnapshot[]): boolean {
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

export async function safeUnlink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // best-effort cleanup
  }
}
