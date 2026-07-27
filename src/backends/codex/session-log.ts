import { homedir } from 'node:os';
import { join } from 'node:path';
import { readdir, readFile, stat } from 'node:fs/promises';

import { ARTIFACT_REJECTION_REASONS, EXIT_CODES, OpenPError } from '../../core/errors.js';
import { isSafeSessionId } from '../../core/session-id.js';
import type { AssistantEventSnapshot } from '../../core/types.js';
import { buildAssistantAnswerSnapshot, buildAssistantSnapshot, buildCodexToolSnapshot } from './jsonl-parser.js';
import { type CodexNativeAssistantClassification, CodexNativeAssistantClassifier } from './native-assistant.js';

export interface CodexSessionDiagnostics {
  readonly model: string | null;
  readonly effort: string | null;
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
  readonly effort: string | null;
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

export interface CodexSessionLogOptions {
  readonly homeDir?: string | null;
}

export function resolveCodexHome(homeDir?: string | null, env: NodeJS.ProcessEnv = process.env): string {
  if (homeDir) {
    return homeDir;
  }
  const envHome = env.CODEX_HOME?.trim();
  return envHome || join(homedir(), '.codex');
}

export async function findCodexSessionLogPath(
  sessionId: string,
  homeDir?: string | null,
): Promise<string | null> {
  const normalizedId = sessionId.trim();
  if (!normalizedId) return null;

  const sessionsRoot = join(resolveCodexHome(homeDir), 'sessions');
  return findMatchingLog(sessionsRoot, normalizedId);
}

export async function getCodexSessionLogSize(
  sessionId: string,
  options: CodexSessionLogOptions = {},
): Promise<number | null> {
  const logPath = await findCodexSessionLogPath(sessionId, options.homeDir);
  if (!logPath) return null;
  try {
    const st = await stat(logPath);
    return st.size;
  } catch {
    return null;
  }
}

export async function getCodexSessionLogBaseline(
  sessionId: string,
  options: CodexSessionLogOptions = {},
): Promise<CodexSessionLogBaseline> {
  const logPath = await findCodexSessionLogPath(sessionId, options.homeDir);
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
  options: CodexSessionLogOptions = {},
): Promise<CodexSessionLogResult | null> {
  const logPath = await findCodexSessionLogPath(sessionId, options.homeDir);
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
  options: CodexSessionLogOptions = {},
): Promise<CodexSessionLogResult | null> {
  if (baseline?.preexisting) {
    return baseline.logPath
      ? readCodexSessionLogResultAtPath(baseline.logPath, baseline.offsetBytes)
      : null;
  }
  return readCodexSessionLogResult(sessionId, baseline?.offsetBytes ?? 0, options);
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

interface CodexLogEntry {
  readonly event: Record<string, unknown>;
  readonly type: string | undefined;
  readonly payload: Record<string, unknown> | null;
}

function parseSessionLogEntries(rawLog: string): CodexLogEntry[] {
  const entries: CodexLogEntry[] = [];
  for (const rawLine of rawLog.split(/\r?\n/)) {
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
    entries.push({ event, type: event.type as string | undefined, payload: asObject(event.payload) });
  }
  return entries;
}

function isCallerMirrorRecord(entry: CodexLogEntry | undefined): boolean {
  return entry !== undefined && entry.type === 'event_msg' && entry.payload?.type === 'user_message';
}

function readPassthroughTurnId(payload: Record<string, unknown>): string | null {
  const passthrough = asObject(payload.internal_chat_message_metadata_passthrough);
  if (passthrough && typeof passthrough.turn_id === 'string' && passthrough.turn_id.length > 0) {
    return passthrough.turn_id;
  }
  return null;
}

function readLifecycleTurnId(payload: Record<string, unknown>): string | null {
  return typeof payload.turn_id === 'string' && payload.turn_id.length > 0 ? payload.turn_id : null;
}

interface CodexSegmentAttribution {
  readonly ownTurnCallerCount: number;
  // Records whose output belongs to a concurrently running other turn. Only ever populated for
  // concurrent segments; empty for the single-caller-turn segments that are the common case.
  readonly foreignRecordIndexes: ReadonlySet<number>;
}

// Active-turn boundary counting and, for concurrent segments only, output attribution.
//
// A caller is a `response_item` user message whose immediately following record is its
// `event_msg user_message` mirror, which opens an active turn segment. Injected transcript records
// (`<environment_context>`, `# AGENTS.md instructions`, ...) carry a passthrough `turn_id` but no
// mirror, so they are not callers. Each caller binds to its passthrough `turn_id`, else to the top
// of the open-window stack (`task_started` .. `task_complete`/`turn_aborted`), which is `null` for
// the implicit first `codex exec` window that has no `task_started`. The segment starts at the
// offset captured immediately before openp submits, so its first caller is openp's own prompt; only
// callers bound to that same turn are this turn's boundaries. A concurrently running other turn's
// caller is that turn's boundary, not this one's.
//
// When a second controller opened its own turn inside this segment, this turn's output must not
// absorb that turn's output. Output records are bound to a turn only by evidence carried on the
// record: a passthrough `turn_id`, an `event_msg agent_message`'s mirror partner passthrough, or an
// `event_msg` tool artifact's lifecycle `turn_id`. Open-window position is not used as output
// evidence: measured against passthrough ground truth over the 2026-06..07 corpus it misbinds real
// records (16 disagreements while more than one window is open, including this turn's own
// interleaved message while another turn's window is on top). A concurrent segment holding any
// output record without that evidence is therefore not resolvable and keeps failing exactly as it
// does today, rather than guessing and answering from the wrong turn.
function analyzeSegmentAttribution(
  entries: readonly CodexLogEntry[],
  classifications: readonly CodexNativeAssistantClassification[],
): CodexSegmentAttribution {
  const openWindowStack: string[] = [];
  const callerTurnKeys = new Set<string | null>();
  let ownTurnKey: string | null = null;
  let ownTurnKeyResolved = false;
  let ownTurnCallerCount = 0;
  const outputTurnByIndex = new Map<number, string | null>();
  const unattributableOutputIndexes: number[] = [];

  for (let index = 0; index < entries.length; index += 1) {
    const { type, payload } = entries[index]!;
    if (!payload) continue;

    if (type === 'event_msg' && payload.type === 'task_started') {
      const lifecycleTurnId = readLifecycleTurnId(payload);
      if (lifecycleTurnId) openWindowStack.push(lifecycleTurnId);
      continue;
    }
    if (type === 'event_msg' && (payload.type === 'task_complete' || payload.type === 'turn_aborted')) {
      const lifecycleTurnId = readLifecycleTurnId(payload);
      if (lifecycleTurnId) {
        const at = openWindowStack.lastIndexOf(lifecycleTurnId);
        if (at !== -1) openWindowStack.splice(at, 1);
      }
      continue;
    }

    if (type === 'response_item' && payload.type === 'message' && payload.role === 'user') {
      if (!isCallerMirrorRecord(entries[index + 1])) continue;
      const turnKey = readPassthroughTurnId(payload)
        ?? (openWindowStack.length > 0 ? openWindowStack[openWindowStack.length - 1]! : null);
      if (!ownTurnKeyResolved) {
        ownTurnKey = turnKey;
        ownTurnKeyResolved = true;
      }
      callerTurnKeys.add(turnKey);
      if (turnKey === ownTurnKey) ownTurnCallerCount += 1;
      continue;
    }

    const outputTurn = readOutputRecordTurn(entries, classifications, index);
    if (outputTurn === undefined) continue;
    if (outputTurn === null) unattributableOutputIndexes.push(index);
    else outputTurnByIndex.set(index, outputTurn);
  }

  if (callerTurnKeys.size <= 1) {
    // Single caller turn: every output in the segment is this turn's, so nothing is filtered and no
    // attribution evidence is required.
    return { ownTurnCallerCount, foreignRecordIndexes: new Set() };
  }

  if (unattributableOutputIndexes.length > 0) {
    throw new OpenPError(
      'Codex session log contains multiple active turn boundaries',
      EXIT_CODES.protocolViolation,
      ARTIFACT_REJECTION_REASONS.multipleTurnBoundaries,
    );
  }

  const foreignRecordIndexes = new Set<number>();
  for (const [index, turnKey] of outputTurnByIndex) {
    if (turnKey !== ownTurnKey) foreignRecordIndexes.add(index);
  }
  return { ownTurnCallerCount, foreignRecordIndexes };
}

// The turn a record's output belongs to: `undefined` when the record produces no output, `null`
// when it produces output that carries no turn evidence.
function readOutputRecordTurn(
  entries: readonly CodexLogEntry[],
  classifications: readonly CodexNativeAssistantClassification[],
  index: number,
): string | null | undefined {
  const { type, payload } = entries[index]!;
  if (!payload) return undefined;
  const classification = classifications[index]!;

  if (classification.assistant?.source === 'event_msg') {
    // An `event_msg agent_message` carries no turn id of its own. When its adjacent
    // `response_item` mirror is the record that carries the passthrough, that mirror is dropped as
    // a duplicate and this record is the surviving artifact, so it binds to its partner's turn.
    const mirrorIndex = index + 1;
    if (!classifications[mirrorIndex]?.mirrored) return null;
    return readPassthroughTurnId(entries[mirrorIndex]!.payload!);
  }
  if (classification.assistant?.source === 'response_item') {
    if (classification.mirrored) return undefined;
    return readPassthroughTurnId(payload);
  }

  if (type === 'response_item') {
    if (payload.type === 'reasoning') {
      return extractSummaryText(payload) ? readPassthroughTurnId(payload) : undefined;
    }
    if (payload.type === 'message') return undefined;
    return buildCodexToolSnapshot(payload) ? readPassthroughTurnId(payload) : undefined;
  }
  if (type === 'event_msg') {
    return buildCodexToolSnapshot(payload, type) ? readLifecycleTurnId(payload) : undefined;
  }
  if (type === 'item.started' || type === 'item.completed') {
    const item = asObject(entries[index]!.event.item);
    if (!item) return undefined;
    const producesOutput = (item.type === 'agent_message' && typeof item.text === 'string' && item.text.trim())
      || buildCodexToolSnapshot(item, type) !== null;
    return producesOutput ? null : undefined;
  }
  return undefined;
}

export function extractSessionLogResult(rawLog: string): CodexSessionLogResult {
  const entries = parseSessionLogEntries(rawLog);

  let content: string | null = null;
  let sessionId: string | null = null;
  let tokenCountUsageSum: { inputTokens: number | null; outputTokens: number | null; cacheReadInputTokens: number | null } | null = null;
  const reasoningParts: string[] = [];
  const commentaryEvents: AssistantEventSnapshot[] = [];
  let lastFinalResponseItemText: string | null = null;
  let currentTurnModel: string | null = null;
  let currentTurnEffort: string | null = null;
  let latestTokenCount: CodexSessionDiagnostics | null = null;
  let hasCompletionEvidence = false;
  // Classify once so the attribution pre-pass and the extraction loop below make identical
  // mirror decisions from the same classifier state.
  const assistantClassifier = new CodexNativeAssistantClassifier();
  const classifications = entries.map((entry) => assistantClassifier.classify(entry.event));
  const attribution = analyzeSegmentAttribution(entries, classifications);
  const callerUserTurnCount = attribution.ownTurnCallerCount;
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

  for (let index = 0; index < entries.length; index += 1) {
    const { event, type, payload } = entries[index]!;
    // Output of a concurrently running other turn is not this turn's result. Only ever non-empty
    // for concurrent segments, and only holds records whose sole effect is producing output.
    if (attribution.foreignRecordIndexes.has(index)) continue;
    const assistantClassification = classifications[index]!;

    if (type === 'turn_context') {
      currentTurnModel = payload && typeof payload.model === 'string' && payload.model.trim()
        ? payload.model.trim()
        : null;
      currentTurnEffort = payload && typeof payload.effort === 'string' && payload.effort.trim()
        ? payload.effort.trim()
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
        const text = extractSummaryText(payload);
        if (text) reasoningParts.push(text);
        continue;
      }

      if (payload.type === 'message' && payload.role === 'assistant') {
        const assistant = assistantClassification.assistant;
        if (assistant?.source === 'response_item') {
          if (assistantClassification.mirrored) {
            continue;
          }
          if (isFinalPhase(assistant.phase)) {
            lastFinalResponseItemText = assistant.text;
            pushAnswerSnapshot(assistant.text, assistant.phase, assistant.nativeId);
          } else if (isCommentaryPhase(assistant.phase)) {
            pushCommentarySnapshot(assistant.text, assistant.phase, assistant.nativeId);
          } else {
            lastFinalResponseItemText ??= assistant.text;
            pushAnswerSnapshot(assistant.text, assistant.phase, assistant.nativeId);
          }
        }
        continue;
      }
      const toolSnapshot = buildCodexToolSnapshot(payload);
      if (toolSnapshot) {
        commentaryEvents.push(toolSnapshot);
      }
      continue;
    }

    if (type === 'event_msg') {
      if (!payload) continue;
      if (payload.type === 'agent_message') {
        const assistant = assistantClassification.assistant;
        if (assistant?.source === 'event_msg') {
          if (isFinalPhase(assistant.phase)) {
            lastFinalResponseItemText = assistant.text;
            pushAnswerSnapshot(assistant.text, assistant.phase, assistant.nativeId);
          } else if (isCommentaryPhase(assistant.phase)) {
            pushCommentarySnapshot(assistant.text, assistant.phase, assistant.nativeId);
          } else {
            lastFinalResponseItemText ??= assistant.text;
            pushAnswerSnapshot(assistant.text, assistant.phase, assistant.nativeId);
          }
        }
      }
      const toolSnapshot = buildCodexToolSnapshot(payload, type);
      if (toolSnapshot) {
        commentaryEvents.push(toolSnapshot);
      }
      if (payload.type === 'token_count') {
        const tokenDiag = extractTokenCountFromPayload(payload, currentTurnModel, currentTurnEffort);
        if (tokenDiag) {
          latestTokenCount = tokenDiag;
          tokenCountUsageSum = addSubturnUsage(tokenCountUsageSum, tokenDiag);
        }
      }
      if (payload.type === 'task_complete') {
        hasCompletionEvidence = true;
      }
      continue;
    }

    if (type === 'item.started' || type === 'item.completed') {
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
    effort: currentTurnEffort,
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

function extractTokenCountFromPayload(
  payload: Record<string, unknown>,
  model: string | null,
  effort: string | null,
): CodexSessionDiagnostics | null {
  const info = asObject(payload.info);
  if (!info) return null;
  const usage = info.last_token_usage && typeof info.last_token_usage === 'object'
    ? info.last_token_usage as Record<string, unknown>
    : null;
  const rawInputTokens = typeof usage?.input_tokens === 'number' ? usage.input_tokens : null;
  if (rawInputTokens === null || rawInputTokens <= 0) return null;
  const cacheReadInputTokens = typeof usage?.cached_input_tokens === 'number' ? usage.cached_input_tokens : null;
  return {
    model,
    effort,
    inputTokens: normalizeCodexInputTokens(rawInputTokens, cacheReadInputTokens),
    outputTokens: typeof usage?.output_tokens === 'number' ? usage.output_tokens : null,
    cacheReadInputTokens,
    contextWindow: typeof info.model_context_window === 'number' ? info.model_context_window : null,
  };
}

function normalizeCodexInputTokens(rawInputTokens: number, cacheReadInputTokens: number | null): number {
  // Codex token_count input_tokens includes cached_input_tokens; normalize to
  // the root Anthropic-style contract where inputTokens excludes cache reads.
  // Evidence: a live codex run's session log, where total_tokens = input_tokens + output_tokens.
  return Math.max(0, rawInputTokens - (cacheReadInputTokens ?? 0));
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

function asObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

export function extractLatestTokenCount(rawLog: string): CodexSessionDiagnostics | null {
  const lines = rawLog.split(/\r?\n/);
  let currentTurnModel: string | null = null;
  let currentTurnEffort: string | null = null;
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
      currentTurnEffort = null;
      continue;
    }

    if (event.type === 'turn_context') {
      currentTurnModel = payload && typeof payload.model === 'string' && payload.model.trim()
        ? payload.model.trim()
        : null;
      currentTurnEffort = payload && typeof payload.effort === 'string' && payload.effort.trim()
        ? payload.effort.trim()
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

    const rawInputTokens = typeof usage?.input_tokens === 'number' ? usage.input_tokens : null;
    const cacheReadInputTokens = typeof usage?.cached_input_tokens === 'number' ? usage.cached_input_tokens : null;
    const contextWindow = typeof info.model_context_window === 'number' ? info.model_context_window : null;

    if (rawInputTokens === null || rawInputTokens <= 0) continue;

    latest = {
      model: currentTurnModel,
      effort: currentTurnEffort,
      inputTokens: normalizeCodexInputTokens(rawInputTokens, cacheReadInputTokens),
      outputTokens: typeof usage?.output_tokens === 'number' ? usage.output_tokens : null,
      cacheReadInputTokens,
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
