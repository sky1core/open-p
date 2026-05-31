import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { opendir, stat, readFile, realpath } from 'node:fs/promises';
import { createReadStream, watch } from 'node:fs';
import { createInterface } from 'node:readline';
import { EXIT_CODES, OpenPError } from '../../core/errors.js';
import { isSafeSessionId } from '../../core/session-id.js';
import { extractClaudeCodeIntermediateContent, isLocalCommandTranscriptText, parseClaudeCodeJsonlTurn } from './turn-parser.js';
import { isClaudeCodeTaskNotificationLine } from './background-parser.js';
import type {
  AssistantContentBlock,
  AssistantEventSnapshot,
  IntermediateTextSource,
  TurnResult,
} from '../../core/types.js';

const SESSION_LOG_DISCOVERY_POLL_INTERVAL_MS = 250;
const ACTIVE_TURN_LOG_POLL_INTERVAL_MS = 25;
const MAX_ASSISTANT_REPLAY_DELAY_MS = 100;
const MISSING_CALLER_LOG_IDLE_GRACE_MS = 1_000;
const SESSION_LOG_IDLE_DIAGNOSTIC_INTERVAL_MS = 30_000;

export interface ClaudeCodeSessionLogIdleDiagnostic {
  readonly turnId: string;
  readonly stage: 'discovering_log' | 'waiting_for_caller_user_turn' | 'waiting_for_completion';
  readonly logPath: string | null;
  readonly offset: number;
  readonly idleMs: number;
  readonly observedLogFile: boolean;
  readonly sawCallerUserTurn: boolean;
}

export class MissingCallerAfterLocalCommandError extends OpenPError {
  constructor(
    readonly turnId: string,
    readonly logPath: string | null = null,
    readonly nextOffset: number = 0,
  ) {
    super(
      `Claude Code session log became idle after local command output before logging caller user turn for turn ${turnId}`,
      EXIT_CODES.protocolViolation,
    );
    this.name = 'MissingCallerAfterLocalCommandError';
  }
}

export function isMissingCallerAfterLocalCommandError(error: unknown): error is MissingCallerAfterLocalCommandError {
  return error instanceof MissingCallerAfterLocalCommandError;
}

export function resolveClaudeCodeSessionLogPath(sessionId: string, cwd: string): string {
  assertValidSessionId(sessionId);
  return join(resolveClaudeCodeProjectLogDir(cwd), `${sessionId}.jsonl`);
}

export function resolveClaudeCodeProjectLogDir(cwd: string): string {
  return join(resolveClaudeCodeSessionLogRoot(), encodeClaudeCodeProjectPath(cwd));
}

function encodeClaudeCodeProjectPath(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

export async function findClaudeCodeSessionLog(sessionId: string, cwd?: string | null): Promise<string | null> {
  assertValidSessionId(sessionId);
  if (cwd) {
    const direct = resolveClaudeCodeSessionLogPath(sessionId, cwd);
    try {
      const directStat = await stat(direct);
      if (directStat.isFile()) return direct;
    } catch {
      // Fall through to recursive lookup for older or unexpected Claude Code path encodings.
    }
  }
  const root = resolveClaudeCodeSessionLogRoot();
  try {
    const rootStat = await stat(root);
    if (!rootStat.isDirectory()) return null;
  } catch {
    return null;
  }
  return findJsonlByBasename(root, `${sessionId}.jsonl`, cwd ? await cwdCandidates(cwd) : null);
}

export async function snapshotClaudeCodeSessionLogPaths(_cwd: string): Promise<ReadonlySet<string>> {
  const output = new Set<string>();
  for (const logDir of await projectLogDirsForCwd(_cwd)) {
    await collectTopLevelJsonlLogPaths(logDir, output);
  }
  return output;
}

export async function findRecentClaudeCodeSessionLog(
  cwd: string,
  changedAfterMs: number,
  excludedLogPaths: ReadonlySet<string> = new Set(),
): Promise<string | null> {
  const validCwds = await cwdCandidates(cwd);
  const candidates: LogCandidate[] = [];
  for (const logDir of await projectLogDirsForCwd(cwd)) {
    candidates.push(...await findRecentJsonlLogs(
      logDir,
      changedAfterMs,
      validCwds,
      excludedLogPaths,
    ));
  }
  if (candidates.length === 0) {
    return null;
  }
  if (candidates.length > 1) {
    throw new OpenPError('ambiguous Claude Code session log discovery for backend-generated first-turn session id', EXIT_CODES.protocolViolation);
  }
  return candidates[0]!.path;
}

async function findRecentClaudeCodePreCallerIdleLog(
  cwd: string,
  changedAfterMs: number,
  excludedLogPaths: ReadonlySet<string> = new Set(),
): Promise<string | null> {
  const validCwds = await cwdCandidates(cwd);
  const candidates: LogCandidate[] = [];
  for (const logDir of await projectLogDirsForCwd(cwd)) {
    candidates.push(...await findRecentJsonlLogs(
      logDir,
      changedAfterMs,
      validCwds,
      excludedLogPaths,
      'pre-caller-terminal-local-command',
    ));
  }
  if (candidates.length === 0) {
    return null;
  }
  if (candidates.length > 1) {
    throw new OpenPError('ambiguous Claude Code pre-caller local-command session log discovery for backend-generated first-turn session id', EXIT_CODES.protocolViolation);
  }
  return candidates[0]!.path;
}

export async function waitForClaudeCodeTurnResult(options: {
  readonly sessionId: string | null;
  readonly turnId: string;
  readonly timeoutMs: number;
  readonly initialOffset: number;
  readonly knownLogPath: string | null;
  readonly expectedLogPath?: string | null;
  readonly cwd?: string | null;
  readonly discoveryStartedAtMs?: number | null;
  readonly excludedLogPaths?: ReadonlySet<string>;
  readonly paceIntermediateEvents?: boolean;
  readonly structuredOutputRequested?: boolean;
  readonly structuredOutputJsonSchema?: unknown;
  readonly isBackendAlive?: () => Promise<boolean>;
  readonly sessionLogIdleDiagnosticIntervalMs?: number;
  readonly onIntermediateText?: (text: string, source: IntermediateTextSource) => void;
  readonly onIntermediateReasoning?: (
    text: string,
    source: IntermediateTextSource,
    contentBlocks?: readonly AssistantContentBlock[] | null,
  ) => void;
  readonly onIntermediateAssistantSnapshot?: (
    snapshot: AssistantEventSnapshot,
    source: IntermediateTextSource,
  ) => void;
  readonly onTimeout?: () => Promise<void> | void;
  readonly onSessionLogIdle?: (diagnostic: ClaudeCodeSessionLogIdleDiagnostic) => Promise<void> | void;
}): Promise<TurnResult> {
  const deadline = options.timeoutMs === 0 ? null : Date.now() + options.timeoutMs;
  let logPath = options.knownLogPath;
  let offset = options.initialOffset;
  let remainder = '';
  let observedLogFile = options.knownLogPath !== null;
  const lines: string[] = [];
  let lastPublishedIntermediate: string | null = null;
  let lastPublishedReasoning: string | null = null;
  let lastPublishedSnapshot: string | null = null;
  let lastAssistantEventTimestampMs: number | null = null;
  let lastAssistantEventProcessedAtMs: number | null = null;
  let sawCallerUserTurn = false;
  let preCallerTerminalLocalCommandObservedAtMs: number | null = null;
  const activeTurnLocalCommandPromptIds = new Set<string>();
  let nextFallbackDiscoveryAtMs = options.knownLogPath ? Date.now() + SESSION_LOG_DISCOVERY_POLL_INTERVAL_MS : Date.now();
  let timeoutNotified = false;
  let lastSessionLogProgressAtMs = Date.now();
  let lastSessionLogIdleDiagnosticAtMs = Date.now();
  const sessionLogIdleDiagnosticIntervalMs =
    options.sessionLogIdleDiagnosticIntervalMs ?? SESSION_LOG_IDLE_DIAGNOSTIC_INTERVAL_MS;
  const notifyTimeout = async (): Promise<void> => {
    if (timeoutNotified) {
      return;
    }
    timeoutNotified = true;
    await options.onTimeout?.();
  };
  const publishIntermediate = (text: string | null, source: IntermediateTextSource): void => {
    if (!shouldPublishIntermediate(text, lastPublishedIntermediate)) {
      return;
    }
    lastPublishedIntermediate = text;
    options.onIntermediateText?.(text, source);
  };
  const publishReasoning = (
    text: string | null,
    source: IntermediateTextSource,
    contentBlocks?: readonly AssistantContentBlock[] | null,
  ): void => {
    if (!shouldPublishIntermediate(text, lastPublishedReasoning)) {
      return;
    }
    lastPublishedReasoning = text;
    options.onIntermediateReasoning?.(text, source, contentBlocks);
  };
  const publishIntermediateContent = (): void => {
    const intermediateContent = extractClaudeCodeIntermediateContent(lines, {
      includeTerminalAssistant: true,
    });
    if (intermediateContent.reasoningText) {
      publishReasoning(
        intermediateContent.reasoningText,
        'jsonl',
        intermediateContent.reasoningContentBlocks,
      );
    }
    if (intermediateContent.text) {
      publishIntermediate(intermediateContent.text, 'jsonl');
    }
    if (intermediateContent.assistantSnapshot && options.onIntermediateAssistantSnapshot) {
      const snapshotKey = JSON.stringify(intermediateContent.assistantSnapshot);
      if (snapshotKey !== lastPublishedSnapshot) {
        lastPublishedSnapshot = snapshotKey;
        options.onIntermediateAssistantSnapshot(intermediateContent.assistantSnapshot, 'jsonl');
      }
    }
  };
  const assertCallerUserTurnDidNotDisappear = (): void => {
    if (sawCallerUserTurn || preCallerTerminalLocalCommandObservedAtMs === null) {
      return;
    }
    if (Date.now() - preCallerTerminalLocalCommandObservedAtMs >= MISSING_CALLER_LOG_IDLE_GRACE_MS) {
      throw new MissingCallerAfterLocalCommandError(options.turnId, logPath, offset);
    }
  };
  const reportSessionLogIdleIfNeeded = async (): Promise<void> => {
    if (sessionLogIdleDiagnosticIntervalMs <= 0) {
      return;
    }
    const now = Date.now();
    const idleMs = now - lastSessionLogProgressAtMs;
    if (idleMs < sessionLogIdleDiagnosticIntervalMs) {
      return;
    }
    if (now - lastSessionLogIdleDiagnosticAtMs < sessionLogIdleDiagnosticIntervalMs) {
      return;
    }
    lastSessionLogIdleDiagnosticAtMs = now;
    await options.onSessionLogIdle?.({
      turnId: options.turnId,
      stage: resolveSessionLogWaitStage(logPath, sawCallerUserTurn),
      logPath,
      offset,
      idleMs,
      observedLogFile,
      sawCallerUserTurn,
    });
  };

  while (deadline === null || Date.now() < deadline) {
    if (!logPath) {
      logPath = await discoverClaudeCodeSessionLog(options);
      if (!logPath) {
        if (options.expectedLogPath) {
          logPath = options.expectedLogPath;
          offset = 0;
        } else {
          const preCallerLogPath = await discoverClaudeCodePreCallerIdleLog(options);
          if (preCallerLogPath) {
            logPath = preCallerLogPath;
            observedLogFile = true;
            offset = 0;
            continue;
          }
          if (await backendExited(options.isBackendAlive)) {
            throw new OpenPError(`backend exited while waiting for session log for turn ${options.turnId}`, EXIT_CODES.backendExited);
          }
          assertCallerUserTurnDidNotDisappear();
          await reportSessionLogIdleIfNeeded();
          await sleep(SESSION_LOG_DISCOVERY_POLL_INTERVAL_MS);
          continue;
        }
      } else {
        observedLogFile = true;
        offset = 0;
      }
    }

    observedLogFile = observedLogFile || await fileExists(logPath);
    if (!observedLogFile && Date.now() >= nextFallbackDiscoveryAtMs) {
      const discoveredLogPath = await discoverClaudeCodeSessionLog(options);
      if (discoveredLogPath && discoveredLogPath !== logPath) {
        logPath = discoveredLogPath;
        offset = 0;
        remainder = '';
        observedLogFile = true;
      }
      nextFallbackDiscoveryAtMs = Date.now() + SESSION_LOG_DISCOVERY_POLL_INTERVAL_MS;
    }

    const chunk = await readNewText(logPath, offset);
    offset = chunk.nextOffset;
    if (chunk.text) {
      lastSessionLogProgressAtMs = Date.now();
      lastSessionLogIdleDiagnosticAtMs = lastSessionLogProgressAtMs;
      const combined = remainder + chunk.text;
      const parts = combined.split('\n');
      remainder = parts.pop() ?? '';
      for (const line of parts) {
        const event = parseLineObject(line);
        if (event) {
          rememberLocalCommandTranscriptPromptId(activeTurnLocalCommandPromptIds, event);
          if (isCallerUserTurn(event, line, activeTurnLocalCommandPromptIds)) {
            sawCallerUserTurn = true;
            preCallerTerminalLocalCommandObservedAtMs = null;
          } else if (!sawCallerUserTurn) {
            if (isPreCallerTerminalLocalCommandEvent(event, activeTurnLocalCommandPromptIds)) {
              preCallerTerminalLocalCommandObservedAtMs = Date.now();
            } else if (preCallerTerminalLocalCommandObservedAtMs !== null) {
              preCallerTerminalLocalCommandObservedAtMs = Date.now();
            }
          }
        }
        const assistantTimestampMs = assistantContentTimestampMs(line);
        if (
          options.paceIntermediateEvents === true &&
          assistantTimestampMs !== null &&
          lastAssistantEventTimestampMs !== null &&
          lastAssistantEventProcessedAtMs !== null
        ) {
          const targetDelayMs = Math.min(
            Math.max(0, assistantTimestampMs - lastAssistantEventTimestampMs),
            MAX_ASSISTANT_REPLAY_DELAY_MS,
          );
          const elapsedMs = Date.now() - lastAssistantEventProcessedAtMs;
          if (targetDelayMs > elapsedMs) {
            await sleepWithinDeadline(targetDelayMs - elapsedMs, deadline, options.turnId, notifyTimeout);
          }
        }
        lines.push(line);
        if (isClaudeCodeTaskNotificationLine(line)) {
          continue;
        }
        publishIntermediateContent();
        if (assistantTimestampMs !== null) {
          lastAssistantEventTimestampMs = assistantTimestampMs;
          lastAssistantEventProcessedAtMs = Date.now();
        }
      }
      const result = parseClaudeCodeJsonlTurn(lines, options.turnId, {
        structuredOutputRequested: options.structuredOutputRequested ?? false,
        jsonSchema: options.structuredOutputJsonSchema,
      });
      if (result) {
        await assertDiscoveredLogStillUnambiguous(options, logPath);
        return result;
      }
    }
    if (await backendExited(options.isBackendAlive)) {
      throw new OpenPError(`backend exited during active turn ${options.turnId}`, EXIT_CODES.backendExited);
    }
    assertCallerUserTurnDidNotDisappear();
    await reportSessionLogIdleIfNeeded();
    await waitForLogChange(logPath, ACTIVE_TURN_LOG_POLL_INTERVAL_MS);
  }

  if (!logPath || !observedLogFile) {
    const sessionLabel = options.sessionId ? `session ${options.sessionId}` : 'a backend-generated session id';
    throw new OpenPError(`Claude Code session log not found for ${sessionLabel}. The interactive CLI may be waiting for workspace trust or startup input. Open the workspace once with Claude Code and trust it before running openp unattended.`, EXIT_CODES.sessionLogNotFound);
  }
  await notifyTimeout();
  throw new OpenPError(`timed out waiting for turn ${options.turnId}`, EXIT_CODES.timeout);
}

function resolveSessionLogWaitStage(
  logPath: string | null,
  sawCallerUserTurn: boolean,
): ClaudeCodeSessionLogIdleDiagnostic['stage'] {
  if (!logPath) {
    return 'discovering_log';
  }
  return sawCallerUserTurn ? 'waiting_for_completion' : 'waiting_for_caller_user_turn';
}

async function discoverClaudeCodeSessionLog(options: {
  readonly sessionId: string | null;
  readonly cwd?: string | null;
  readonly discoveryStartedAtMs?: number | null;
  readonly excludedLogPaths?: ReadonlySet<string>;
}): Promise<string | null> {
  if (options.sessionId) {
    return findClaudeCodeSessionLog(options.sessionId, options.cwd);
  }
  if (!options.cwd || options.discoveryStartedAtMs === null || options.discoveryStartedAtMs === undefined) {
    return null;
  }
  return findRecentClaudeCodeSessionLog(
    options.cwd,
    options.discoveryStartedAtMs,
    options.excludedLogPaths,
  );
}

async function discoverClaudeCodePreCallerIdleLog(options: {
  readonly sessionId: string | null;
  readonly cwd?: string | null;
  readonly discoveryStartedAtMs?: number | null;
  readonly excludedLogPaths?: ReadonlySet<string>;
}): Promise<string | null> {
  if (options.sessionId || !options.cwd || options.discoveryStartedAtMs === null || options.discoveryStartedAtMs === undefined) {
    return null;
  }
  return findRecentClaudeCodePreCallerIdleLog(
    options.cwd,
    options.discoveryStartedAtMs,
    options.excludedLogPaths,
  );
}

export async function getFileSize(path: string | null): Promise<number> {
  if (!path) return 0;
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const pathStat = await stat(path);
    return pathStat.isFile();
  } catch {
    return false;
  }
}

async function findJsonlByBasename(
  dir: string,
  basename: string,
  validCwds: ReadonlySet<string> | null,
  depth = 0,
): Promise<string | null> {
  let entries;
  try {
    entries = await opendir(dir);
  } catch {
    return null;
  }

  for await (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isFile() && entry.name === basename) {
      if (validCwds && !(await logFileHasCwd(path, validCwds))) {
        continue;
      }
      return path;
    }
    if (entry.isDirectory() && entry.name !== 'subagents' && depth < 2) {
      const found = await findJsonlByBasename(path, basename, validCwds, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function resolveClaudeCodeSessionLogRoot(): string {
  return join(homedir(), '.claude', 'projects');
}

interface LogCandidate {
  readonly path: string;
  readonly mtimeMs: number;
}

async function findRecentJsonlLogs(
  dir: string,
  changedAfterMs: number,
  validCwds: ReadonlySet<string>,
  excludedLogPaths: ReadonlySet<string>,
  mode: 'completed-caller-turn' | 'pre-caller-terminal-local-command' = 'completed-caller-turn',
): Promise<LogCandidate[]> {
  let entries;
  try {
    entries = await opendir(dir);
  } catch {
    return [];
  }

  const candidates: LogCandidate[] = [];
  for await (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      if (excludedLogPaths.has(path)) {
        continue;
      }
      let pathStat;
      try {
        pathStat = await stat(path);
      } catch {
        continue;
      }
      if (pathStat.mtimeMs < changedAfterMs) {
        continue;
      }
      const candidate = await analyzeLogDiscoveryCandidate(path, validCwds);
      if (!candidate.hasWorkspaceCwd) {
        continue;
      }
      if (mode === 'pre-caller-terminal-local-command') {
        if (
          candidate.callerUserTurnCount === 0 &&
          candidate.otherWorkspaceCallerUserTurnCount === 0 &&
          candidate.hasPreCallerTerminalLocalCommand
        ) {
          candidates.push({ path, mtimeMs: pathStat.mtimeMs });
        }
        continue;
      }
      if (candidate.callerUserTurnCount === 0) {
        if (candidate.otherWorkspaceCallerUserTurnCount > 0) {
          throw new OpenPError('Claude Code session log caller user turn does not match the requested workspace', EXIT_CODES.protocolViolation);
        }
        continue;
      }
      if (candidate.callerUserTurnCount > 1) {
        throw new OpenPError('Claude Code session log contains multiple caller user turns for one open-p turn', EXIT_CODES.protocolViolation);
      }
      candidates.push({ path, mtimeMs: pathStat.mtimeMs });
      continue;
    }
  }
  return candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

async function collectTopLevelJsonlLogPaths(
  dir: string,
  output: Set<string>,
): Promise<void> {
  let entries;
  try {
    entries = await opendir(dir);
  } catch {
    return;
  }

  for await (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      output.add(path);
    }
  }
}

async function cwdCandidates(cwd: string): Promise<ReadonlySet<string>> {
  const candidates = new Set<string>([cwd]);
  try {
    candidates.add(await realpath(cwd));
  } catch {
    // Keep the caller-provided cwd when the workspace no longer exists.
  }
  return candidates;
}

async function projectLogDirsForCwd(cwd: string): Promise<ReadonlySet<string>> {
  const dirs = new Set<string>();
  for (const candidate of await cwdCandidates(cwd)) {
    dirs.add(resolveClaudeCodeProjectLogDir(candidate));
  }
  return dirs;
}

async function analyzeLogDiscoveryCandidate(
  path: string,
  validCwds: ReadonlySet<string>,
): Promise<{
  hasWorkspaceCwd: boolean;
  callerUserTurnCount: number;
  otherWorkspaceCallerUserTurnCount: number;
  hasPreCallerTerminalLocalCommand: boolean;
}> {
  let hasWorkspaceCwd = false;
  let callerUserTurnCount = 0;
  let otherWorkspaceCallerUserTurnCount = 0;
  let hasPreCallerTerminalLocalCommand = false;
  const localCommandTranscriptPromptIds = new Set<string>();
  const lines = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    const event = parseLineObject(line);
    rememberLocalCommandTranscriptPromptId(localCommandTranscriptPromptIds, event);
    if (typeof event.cwd === 'string' && validCwds.has(event.cwd)) {
      hasWorkspaceCwd = true;
    }
    if (isCallerUserTurn(event, line, localCommandTranscriptPromptIds)) {
      if (typeof event.cwd === 'string' && validCwds.has(event.cwd)) {
        callerUserTurnCount += 1;
      } else {
        otherWorkspaceCallerUserTurnCount += 1;
      }
      continue;
    }
    if (
      callerUserTurnCount === 0 &&
      otherWorkspaceCallerUserTurnCount === 0 &&
      isPreCallerTerminalLocalCommandEvent(event, localCommandTranscriptPromptIds)
    ) {
      hasPreCallerTerminalLocalCommand = true;
    }
  }
  return {
    hasWorkspaceCwd,
    callerUserTurnCount,
    otherWorkspaceCallerUserTurnCount,
    hasPreCallerTerminalLocalCommand,
  };
}

async function assertDiscoveredLogStillUnambiguous(
  options: {
    readonly sessionId: string | null;
    readonly cwd?: string | null;
    readonly discoveryStartedAtMs?: number | null;
    readonly excludedLogPaths?: ReadonlySet<string>;
  },
  selectedLogPath: string,
): Promise<void> {
  if (
    options.sessionId ||
    !options.cwd ||
    options.discoveryStartedAtMs === null ||
    options.discoveryStartedAtMs === undefined
  ) {
    return;
  }
  const discoveredLogPath = await findRecentClaudeCodeSessionLog(
    options.cwd,
    options.discoveryStartedAtMs,
    options.excludedLogPaths,
  );
  if (discoveredLogPath && discoveredLogPath !== selectedLogPath) {
    throw new OpenPError('Claude Code session log discovery changed during backend-generated first-turn session resolution', EXIT_CODES.protocolViolation);
  }
}

async function logFileHasCwd(path: string, validCwds: ReadonlySet<string>): Promise<boolean> {
  const lines = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    const event = parseLineObject(line);
    if (typeof event?.cwd === 'string' && validCwds.has(event.cwd)) {
      lines.close();
      return true;
    }
  }
  return false;
}

function isCallerUserTurn(
  event: Record<string, unknown>,
  rawLine: string,
  localCommandTranscriptPromptIds: ReadonlySet<string>,
): boolean {
  if (event.type !== 'user') {
    return false;
  }
  if (isClaudeCodeTaskNotificationLine(rawLine)) {
    return false;
  }
  if (event.isMeta === true) {
    return false;
  }
  if (event.isCompactSummary === true) {
    return false; // context-compaction continuation message, not a caller prompt (see turn-parser.ts)
  }
  if (userEventHasToolResult(event)) {
    return false;
  }
  if (isLocalCommandTranscriptEvent(event, localCommandTranscriptPromptIds)) {
    return false;
  }
  return true;
}

function collectUserText(event: Record<string, unknown>): string[] {
  const message = event.message;
  if (typeof message === 'string') {
    return [message];
  }
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return [];
  }
  const content = (message as Record<string, unknown>).content;
  if (typeof content === 'string') {
    return [content];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  const texts: string[] = [];
  for (const block of content) {
    if (typeof block === 'string') {
      texts.push(block);
      continue;
    }
    if (!block || typeof block !== 'object' || Array.isArray(block)) {
      continue;
    }
    const item = block as Record<string, unknown>;
    if (item.type === 'text' && typeof item.text === 'string') {
      texts.push(item.text);
    }
  }
  return texts;
}

function userEventHasToolResult(event: Record<string, unknown>): boolean {
  const message = event.message;
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return false;
  }
  const content = (message as Record<string, unknown>).content;
  return Array.isArray(content) && content.some((block) => {
    if (!block || typeof block !== 'object' || Array.isArray(block)) {
      return false;
    }
    return (block as Record<string, unknown>).type === 'tool_result';
  });
}

function isLocalCommandTranscriptEvent(
  event: Record<string, unknown>,
  localCommandTranscriptPromptIds: ReadonlySet<string>,
): boolean {
  const texts = collectUserText(event).map((text) => text.trim()).filter(Boolean);
  if (texts.length !== 1) {
    return false;
  }
  if (texts[0] === '/exit') {
    return true;
  }
  const promptId = stringOrNull(event.promptId);
  return promptId !== null &&
    localCommandTranscriptPromptIds.has(promptId) &&
    isLocalCommandTranscriptText(texts[0]!);
}

function isPreCallerTerminalLocalCommandEvent(
  event: Record<string, unknown>,
  localCommandTranscriptPromptIds: ReadonlySet<string>,
): boolean {
  const texts = collectTranscriptText(event);
  if (texts.length !== 1 || !isTerminalLocalCommandTranscriptText(texts[0]!)) {
    return false;
  }
  if (event.type === 'system' && event.subtype === 'local_command') {
    return true;
  }
  const promptId = stringOrNull(event.promptId);
  return promptId !== null && localCommandTranscriptPromptIds.has(promptId);
}

function collectTranscriptText(event: Record<string, unknown>): string[] {
  const texts = collectUserText(event).map((text) => text.trim()).filter(Boolean);
  const content = event.content;
  if (typeof content === 'string' && content.trim().length > 0) {
    texts.push(content.trim());
  }
  return texts;
}

function isTerminalLocalCommandTranscriptText(text: string): boolean {
  return text.startsWith('<local-command-stdout>') || text.startsWith('<local-command-stderr>');
}

function rememberLocalCommandTranscriptPromptId(
  promptIds: Set<string>,
  event: Record<string, unknown>,
): void {
  if (event.type !== 'user' || event.isMeta !== true) {
    return;
  }
  const promptId = stringOrNull(event.promptId);
  if (promptId === null) {
    return;
  }
  const texts = collectUserText(event).map((text) => text.trim()).filter(Boolean);
  if (texts.length === 1 && texts[0]!.startsWith('<local-command-caveat>')) {
    promptIds.add(promptId);
  }
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export async function readNewText(path: string, offset: number): Promise<{ text: string; nextOffset: number }> {
  const size = await getFileSize(path);
  if (size <= offset) {
    return { text: '', nextOffset: offset };
  }
  if (offset === 0 && size < 1024 * 1024) {
    return { text: await readFile(path, 'utf8'), nextOffset: size };
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stream = createReadStream(path, { start: offset, end: size - 1 });
    stream.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    stream.on('error', reject);
    stream.on('end', () => {
      resolve({ text: Buffer.concat(chunks).toString('utf8'), nextOffset: size });
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sleepWithinDeadline(
  ms: number,
  deadline: number | null,
  turnId: string,
  onTimeout?: () => Promise<void> | void,
): Promise<void> {
  if (deadline === null) {
    await sleep(ms);
    return;
  }
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    await onTimeout?.();
    throw new OpenPError(`timed out waiting for turn ${turnId}`, EXIT_CODES.timeout);
  }
  await sleep(Math.min(ms, remainingMs));
  if (Date.now() >= deadline) {
    await onTimeout?.();
    throw new OpenPError(`timed out waiting for turn ${turnId}`, EXIT_CODES.timeout);
  }
}

async function waitForLogChange(path: string, fallbackMs: number): Promise<void> {
  const dir = dirname(path);
  const target = basename(path);
  let watchPath = path;
  let watchedTarget: string | null = null;
  try {
    const pathStat = await stat(path);
    if (!pathStat.isFile()) {
      watchPath = dir;
      watchedTarget = target;
    }
  } catch {
    watchPath = dir;
    watchedTarget = target;
  }
  return new Promise((resolve) => {
    let settled = false;
    let closeWatcher: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const armTimer = (ms: number): void => {
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(finish, ms);
    };
    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      closeWatcher?.();
      resolve();
    };
    let delayMs = fallbackMs;
    try {
      const watcher = watch(watchPath, (_eventType, filename) => {
        if (!watchedTarget || !filename || filename.toString() === watchedTarget) {
          finish();
        }
      });
      watcher.on('error', () => {
        closeWatcher?.();
        closeWatcher = null;
        armTimer(Math.max(fallbackMs, SESSION_LOG_DISCOVERY_POLL_INTERVAL_MS));
      });
      closeWatcher = () => watcher.close();
    } catch {
      delayMs = Math.max(fallbackMs, SESSION_LOG_DISCOVERY_POLL_INTERVAL_MS);
    }
    armTimer(delayMs);
  });
}

function assistantContentTimestampMs(line: string): number | null {
  const record = parseLineObject(line);
  if (record.type !== 'assistant' || typeof record.timestamp !== 'string') {
    return null;
  }
  const message = record.message;
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return null;
  }
  const content = (message as Record<string, unknown>).content;
  if (!Array.isArray(content) || content.length === 0) {
    return null;
  }
  const timestampMs = Date.parse(record.timestamp);
  return Number.isFinite(timestampMs) ? timestampMs : null;
}

function parseLineObject(line: string): Record<string, unknown> {
  try {
    const value = JSON.parse(line);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // Non-JSON lines are ignored by callers.
  }
  return {};
}

function assertValidSessionId(sessionId: string): void {
  if (!isSafeSessionId(sessionId)) {
    throw new OpenPError(`invalid Claude Code session id for session log path: ${sessionId}`, EXIT_CODES.sessionState);
  }
}

async function backendExited(isBackendAlive: (() => Promise<boolean>) | undefined): Promise<boolean> {
  return isBackendAlive ? !(await isBackendAlive()) : false;
}

function shouldPublishIntermediate(candidate: string | null, lastPublished: string | null): candidate is string {
  if (!candidate) {
    return false;
  }
  if (lastPublished === null) {
    return true;
  }
  if (candidate === lastPublished) {
    return false;
  }
  return !isStablePrefixOfLongerText(candidate, lastPublished);
}

function isStablePrefixOfLongerText(candidate: string, previous: string): boolean {
  const normalizedCandidate = normalizeForPrefixComparison(candidate);
  const normalizedPrevious = normalizeForPrefixComparison(previous);
  return normalizedCandidate.length > 0 &&
    normalizedPrevious.length > normalizedCandidate.length &&
    normalizedPrevious.startsWith(normalizedCandidate);
}

function normalizeForPrefixComparison(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}
