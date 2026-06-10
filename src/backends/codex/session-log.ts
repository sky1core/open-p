import { homedir } from 'node:os';
import { join } from 'node:path';
import { readdir, readFile, stat } from 'node:fs/promises';

import { ARTIFACT_REJECTION_REASONS, EXIT_CODES, OpenPError } from '../../core/errors.js';
import { isSafeSessionId } from '../../core/session-id.js';
import type { AssistantEventSnapshot } from '../../core/types.js';
import { buildAssistantAnswerSnapshot, buildAssistantSnapshot, buildCodexToolSnapshot } from './jsonl-parser.js';

export interface CodexSessionDiagnostics {
  readonly model: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadInputTokens: number | null;
  readonly contextWindow: number | null;
}

export interface CodexSessionLogResult {
  readonly content: string | null;
  readonly reasoningContent: string | null;
  readonly commentaryEvents: readonly AssistantEventSnapshot[];
  readonly sessionId: string | null;
  readonly hasCompletionEvidence: boolean;
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
}

export interface CodexSessionLogBaseline {
  readonly offsetBytes: number;
  readonly preexisting: boolean;
  readonly logPath: string | null;
}

interface CodexSessionLogAgentMessageMirrorCandidate {
  readonly phase: string;
  readonly text: string;
}

function getCodexHome(): string {
  const envHome = process.env.CODEX_HOME?.trim();
  return envHome || join(homedir(), '.codex');
}

export async function findCodexSessionLogPath(sessionId: string): Promise<string | null> {
  const normalizedId = sessionId.trim();
  if (!normalizedId) return null;

  const sessionsRoot = join(getCodexHome(), 'sessions');
  return findMatchingLog(sessionsRoot, normalizedId);
}

export async function getCodexSessionLogSize(sessionId: string): Promise<number | null> {
  const logPath = await findCodexSessionLogPath(sessionId);
  if (!logPath) return null;
  try {
    const st = await stat(logPath);
    return st.size;
  } catch {
    return null;
  }
}

export async function getCodexSessionLogBaseline(sessionId: string): Promise<CodexSessionLogBaseline> {
  const logPath = await findCodexSessionLogPath(sessionId);
  if (!logPath) {
    return { offsetBytes: 0, preexisting: false, logPath: null };
  }
  try {
    const st = await stat(logPath);
    return { offsetBytes: st.size, preexisting: true, logPath };
  } catch {
    throw new OpenPError(
      'Codex session log became unavailable before resume launch',
      EXIT_CODES.protocolViolation,
    );
  }
}

async function findMatchingLog(dir: string, sessionId: string): Promise<string | null> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }
    throw new OpenPError('Codex session log directory is unreadable', EXIT_CODES.protocolViolation);
  }

  const candidates: string[] = [];
  const subdirs: string[] = [];

  for (const entry of entries) {
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      subdirs.push(entryPath);
      continue;
    }
    if (entry.isFile() && isCodexSessionLogName(entry.name, sessionId)) {
      candidates.push(entryPath);
    }
  }

  for (const subdir of subdirs) {
    const found = await findMatchingLog(subdir, sessionId);
    if (found) {
      candidates.push(found);
    }
  }

  if (candidates.length > 1) {
    throw new OpenPError(
      `ambiguous Codex session log paths for session ${sessionId}`,
      EXIT_CODES.protocolViolation,
      ARTIFACT_REJECTION_REASONS.ambiguousCandidate,
    );
  }
  return candidates[0] ?? null;
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'ENOENT';
}

function isCodexSessionLogName(name: string, sessionId: string): boolean {
  return name === `${sessionId}.jsonl` || name.endsWith(`-${sessionId}.jsonl`);
}

export async function readCodexSessionLogResult(
  sessionId: string,
  offsetBytes = 0,
): Promise<CodexSessionLogResult | null> {
  const logPath = await findCodexSessionLogPath(sessionId);
  if (!logPath) return null;
  return readCodexSessionLogResultAtPath(
    logPath,
    offsetBytes,
    'Codex session log became unavailable after discovery',
  );
}

export async function readCodexSessionLogResultSinceBaseline(
  sessionId: string,
  baseline: CodexSessionLogBaseline | null,
): Promise<CodexSessionLogResult | null> {
  if (baseline?.preexisting) {
    return baseline.logPath
      ? readCodexSessionLogResultAtPath(baseline.logPath, baseline.offsetBytes)
      : null;
  }
  return readCodexSessionLogResult(sessionId, baseline?.offsetBytes ?? 0);
}

async function readCodexSessionLogResultAtPath(
  logPath: string,
  offsetBytes: number,
  readFailureMessage: string | null = null,
): Promise<CodexSessionLogResult | null> {
  let buf: Buffer;
  try {
    buf = await readFile(logPath);
  } catch {
    if (readFailureMessage) {
      throw new OpenPError(
        readFailureMessage,
        EXIT_CODES.protocolViolation,
      );
    }
    return null;
  }
  const raw = buf.subarray(offsetBytes).toString('utf8');
  return extractSessionLogResult(raw);
}

export function extractSessionLogResult(rawLog: string): CodexSessionLogResult {
  const lines = rawLog.split(/\r?\n/);

  let content: string | null = null;
  let sessionId: string | null = null;
  let tokenCountUsageSum: { inputTokens: number | null; outputTokens: number | null; cacheReadInputTokens: number | null } | null = null;
  const reasoningParts: string[] = [];
  const commentaryEvents: AssistantEventSnapshot[] = [];
  let lastFinalResponseItemText: string | null = null;
  let currentTurnModel: string | null = null;
  let latestTokenCount: CodexSessionDiagnostics | null = null;
  let hasCompletionEvidence = false;
  let callerUserTurnCount = 0;
  let lastAgentMessageMirrorCandidate: CodexSessionLogAgentMessageMirrorCandidate | null = null;
  let assistantEventSequence = 0;
  const nextAssistantEventId = (nativeId: unknown): string => {
    if (typeof nativeId === 'string' && nativeId.trim()) {
      return nativeId.trim();
    }
    assistantEventSequence += 1;
    return `seq_${assistantEventSequence}`;
  };
  const pushAnswerSnapshot = (text: string, phase: unknown, nativeId: unknown): void => {
    commentaryEvents.push(buildAssistantAnswerSnapshot(text, phase, nextAssistantEventId(nativeId)));
  };
  const pushCommentarySnapshot = (text: string, phase: unknown, nativeId: unknown): void => {
    commentaryEvents.push(buildAssistantSnapshot(text, String(phase), nextAssistantEventId(nativeId)));
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      throw new OpenPError(
        'Codex session log contains malformed JSONL',
        EXIT_CODES.protocolViolation,
        ARTIFACT_REJECTION_REASONS.unsupportedArtifactShape,
      );
    }

    const type = event.type as string | undefined;
    const payload = asObject(event.payload);

    if (type === 'turn_context') {
      currentTurnModel = payload && typeof payload.model === 'string' && payload.model.trim()
        ? payload.model.trim()
        : null;
      continue;
    }

    if (type === 'thread.started') {
      if (!sessionId && typeof event.thread_id === 'string') {
        const candidateId = event.thread_id.trim();
        if (candidateId && isSafeSessionId(candidateId)) {
          sessionId = candidateId;
        }
      }
      continue;
    }

    if (type === 'turn.completed') {
      hasCompletionEvidence = true;
      if (typeof event.result === 'string' && event.result.trim()) {
        content = event.result.trim();
      }
      if (typeof event.session_id === 'string') {
        const candidateId = event.session_id.trim();
        if (candidateId && isSafeSessionId(candidateId)) {
          sessionId = candidateId;
        }
      }
      // `turn.completed` is a stdout event; observed Codex session logs never contain
      // one, so it is not a session-log usage source. Aggregate usage comes from
      // `event_msg` `token_count` `last_token_usage` sums instead.
      continue;
    }

    if (type === 'response_item') {
      if (!payload) continue;

      if (payload.type === 'reasoning') {
        lastAgentMessageMirrorCandidate = null;
        const text = extractSummaryText(payload);
        if (text) reasoningParts.push(text);
        continue;
      }

      if (payload.type === 'message' && payload.role === 'assistant') {
        const text = extractOutputText(payload);
        if (text) {
          if (isCodexSessionLogAgentMessageMirror(lastAgentMessageMirrorCandidate, payload.phase, text)) {
            lastAgentMessageMirrorCandidate = null;
            continue;
          }
          lastAgentMessageMirrorCandidate = null;
          if (isFinalPhase(payload.phase)) {
            lastFinalResponseItemText = text;
            pushAnswerSnapshot(text, payload.phase, payload.id);
          } else if (isCommentaryPhase(payload.phase)) {
            pushCommentarySnapshot(text, payload.phase, payload.id);
          } else {
            lastFinalResponseItemText ??= text;
            pushAnswerSnapshot(text, payload.phase, payload.id);
          }
        }
        lastAgentMessageMirrorCandidate = null;
        continue;
      }
      lastAgentMessageMirrorCandidate = null;
      const toolSnapshot = buildCodexToolSnapshot(payload);
      if (toolSnapshot) {
        commentaryEvents.push(toolSnapshot);
      }
      continue;
    }

    if (type === 'event_msg') {
      if (!payload) continue;
      if (payload.type === 'user_message') {
        lastAgentMessageMirrorCandidate = null;
        callerUserTurnCount += 1;
      }
      if (payload.type === 'agent_message') {
        if (typeof payload.message === 'string' && payload.message.trim()) {
          const text = payload.message.trim();
          if (isFinalPhase(payload.phase)) {
            lastFinalResponseItemText = text;
            pushAnswerSnapshot(text, payload.phase, payload.id);
          } else if (isCommentaryPhase(payload.phase)) {
            pushCommentarySnapshot(text, payload.phase, payload.id);
          } else {
            lastFinalResponseItemText ??= text;
            pushAnswerSnapshot(text, payload.phase, payload.id);
          }
          lastAgentMessageMirrorCandidate = buildCodexSessionLogAgentMessageMirrorCandidate(payload.phase, text);
        } else {
          lastAgentMessageMirrorCandidate = null;
        }
      } else if (payload.type !== 'user_message') {
        lastAgentMessageMirrorCandidate = null;
      }
      const toolSnapshot = buildCodexToolSnapshot(payload, type);
      if (toolSnapshot) {
        lastAgentMessageMirrorCandidate = null;
        commentaryEvents.push(toolSnapshot);
      }
      if (payload.type === 'token_count') {
        lastAgentMessageMirrorCandidate = null;
        const tokenDiag = extractTokenCountFromPayload(payload, currentTurnModel);
        if (tokenDiag) {
          latestTokenCount = tokenDiag;
          tokenCountUsageSum = addSubturnUsage(tokenCountUsageSum, tokenDiag);
        }
      }
      if (payload.type === 'task_complete') {
        lastAgentMessageMirrorCandidate = null;
        hasCompletionEvidence = true;
      }
      continue;
    }

    if (type === 'item.started' || type === 'item.completed') {
      lastAgentMessageMirrorCandidate = null;
      const item = asObject(event.item);
      if (!item) continue;
      if (item.type === 'agent_message' && typeof item.text === 'string' && item.text.trim()) {
        if (isFinalPhase(item.phase)) {
          lastFinalResponseItemText = item.text.trim();
          pushAnswerSnapshot(item.text.trim(), item.phase, item.id);
        } else if (isCommentaryPhase(item.phase)) {
          pushCommentarySnapshot(item.text.trim(), item.phase, item.id);
        } else {
          lastFinalResponseItemText ??= item.text.trim();
          pushAnswerSnapshot(item.text.trim(), item.phase, item.id);
        }
        continue;
      }
      const toolSnapshot = buildCodexToolSnapshot(item, type);
      if (toolSnapshot) {
        commentaryEvents.push(toolSnapshot);
      }
      continue;
    }
  }

  if (callerUserTurnCount === 0) {
    throw new OpenPError(
      'Codex session log is missing active turn boundary',
      EXIT_CODES.protocolViolation,
      ARTIFACT_REJECTION_REASONS.missingTurnBoundary,
    );
  }
  if (callerUserTurnCount > 1) {
    throw new OpenPError(
      'Codex session log contains multiple active turn boundaries',
      EXIT_CODES.protocolViolation,
      ARTIFACT_REJECTION_REASONS.multipleTurnBoundaries,
    );
  }

  if (!content) {
    content = lastFinalResponseItemText;
  }

  const usage = tokenCountUsageSum ?? {
    inputTokens: null,
    outputTokens: null,
    cacheReadInputTokens: null,
  };

  return {
    content,
    reasoningContent: reasoningParts.length > 0 ? reasoningParts.join('\n\n') : null,
    commentaryEvents,
    sessionId,
    hasCompletionEvidence,
    usage,
    model: currentTurnModel,
    contextWindow: latestTokenCount?.contextWindow ?? null,
    lastSubturnUsage: latestTokenCount
      ? {
          inputTokens: latestTokenCount.inputTokens,
          outputTokens: latestTokenCount.outputTokens,
          cacheReadInputTokens: latestTokenCount.cacheReadInputTokens,
        }
      : null,
  };
}

function extractSummaryText(payload: Record<string, unknown>): string | null {
  const summaryArr = payload.summary;
  if (!Array.isArray(summaryArr)) return null;
  const parts: string[] = [];
  for (const item of summaryArr) {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const record = item as Record<string, unknown>;
      if (typeof record.text === 'string' && record.text.trim()) {
        parts.push(record.text.trim());
      }
    }
  }
  return parts.length > 0 ? parts.join('\n\n') : null;
}

function extractOutputText(payload: Record<string, unknown>): string | null {
  const contentArr = payload.content;
  if (!Array.isArray(contentArr)) return null;
  const parts: string[] = [];
  for (const block of contentArr) {
    if (block && typeof block === 'object' && !Array.isArray(block)) {
      const record = block as Record<string, unknown>;
      if (record.type === 'output_text' && typeof record.text === 'string' && record.text.trim()) {
        parts.push(record.text.trim());
      }
    }
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

function extractTokenCountFromPayload(
  payload: Record<string, unknown>,
  model: string | null,
): CodexSessionDiagnostics | null {
  const info = asObject(payload.info);
  if (!info) return null;
  const usage = info.last_token_usage && typeof info.last_token_usage === 'object'
    ? info.last_token_usage as Record<string, unknown>
    : null;
  const inputTokens = typeof usage?.input_tokens === 'number' ? usage.input_tokens : null;
  if (inputTokens === null || inputTokens <= 0) return null;
  return {
    model,
    inputTokens,
    outputTokens: typeof usage?.output_tokens === 'number' ? usage.output_tokens : null,
    cacheReadInputTokens: typeof usage?.cached_input_tokens === 'number' ? usage.cached_input_tokens : null,
    contextWindow: typeof info.model_context_window === 'number' ? info.model_context_window : null,
  };
}

function addSubturnUsage(
  sum: { inputTokens: number | null; outputTokens: number | null; cacheReadInputTokens: number | null } | null,
  subturn: CodexSessionDiagnostics,
): { inputTokens: number | null; outputTokens: number | null; cacheReadInputTokens: number | null } {
  return {
    inputTokens: addNullableTokens(sum?.inputTokens ?? null, subturn.inputTokens),
    outputTokens: addNullableTokens(sum?.outputTokens ?? null, subturn.outputTokens),
    cacheReadInputTokens: addNullableTokens(sum?.cacheReadInputTokens ?? null, subturn.cacheReadInputTokens),
  };
}

function addNullableTokens(sum: number | null, next: number | null): number | null {
  if (next === null) return sum;
  return (sum ?? 0) + next;
}

function isFinalPhase(phase: unknown): boolean {
  return phase === undefined || phase === 'final_answer';
}

function isCommentaryPhase(phase: unknown): phase is string {
  return phase === 'commentary' || phase === 'progress';
}

function buildCodexSessionLogAgentMessageMirrorCandidate(
  phase: unknown,
  text: string,
): CodexSessionLogAgentMessageMirrorCandidate {
  return {
    phase: codexSessionLogPhaseKey(phase),
    text,
  };
}

function isCodexSessionLogAgentMessageMirror(
  candidate: CodexSessionLogAgentMessageMirrorCandidate | null,
  phase: unknown,
  text: string,
): boolean {
  return candidate !== null &&
    candidate.phase === codexSessionLogPhaseKey(phase) &&
    candidate.text === text;
}

function codexSessionLogPhaseKey(phase: unknown): string {
  return typeof phase === 'string' && phase.trim() ? phase.trim() : 'final_answer';
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

export function extractLatestTokenCount(rawLog: string): CodexSessionDiagnostics | null {
  const lines = rawLog.split(/\r?\n/);
  let currentTurnModel: string | null = null;
  let latest: CodexSessionDiagnostics | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    const payload = event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
      ? event.payload as Record<string, unknown>
      : null;

    if (isCodexTurnBoundary(event, payload)) {
      currentTurnModel = null;
      continue;
    }

    if (event.type === 'turn_context') {
      currentTurnModel = payload && typeof payload.model === 'string' && payload.model.trim()
        ? payload.model.trim()
        : null;
      continue;
    }

    if (!payload || payload.type !== 'token_count') continue;

    const info = payload.info && typeof payload.info === 'object' && !Array.isArray(payload.info)
      ? payload.info as Record<string, unknown>
      : null;
    if (!info) continue;

    const usage = info.last_token_usage && typeof info.last_token_usage === 'object'
      ? info.last_token_usage as Record<string, unknown>
      : null;

    const inputTokens = typeof usage?.input_tokens === 'number' ? usage.input_tokens : null;
    const contextWindow = typeof info.model_context_window === 'number' ? info.model_context_window : null;

    if (inputTokens === null || inputTokens <= 0) continue;

    latest = {
      model: currentTurnModel,
      inputTokens,
      outputTokens: typeof usage?.output_tokens === 'number' ? usage.output_tokens : null,
      cacheReadInputTokens: typeof usage?.cached_input_tokens === 'number' ? usage.cached_input_tokens : null,
      contextWindow,
    };
  }

  return latest;
}

function isCodexTurnBoundary(event: Record<string, unknown>, payload: Record<string, unknown> | null): boolean {
  if (event.type === 'turn.completed') {
    return true;
  }
  return event.type === 'event_msg' && payload?.type === 'task_complete';
}
