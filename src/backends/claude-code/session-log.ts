import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { opendir, stat, readFile, realpath } from 'node:fs/promises';
import { createReadStream, watch } from 'node:fs';
import { createInterface } from 'node:readline';
import { EXIT_CODES, OpenPError } from '../../core/errors.js';
import { extractClaudeCodeIntermediateContent, parseClaudeCodeJsonlTurn } from './turn-parser.js';
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
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function resolveClaudeCodeSessionLogPath(sessionId: string, cwd: string): string {
  assertValidSessionId(sessionId);
  return join(homedir(), '.claude', 'projects', encodeClaudeCodeProjectPath(cwd), `${sessionId}.jsonl`);
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
  const root = join(homedir(), '.claude', 'projects');
  try {
    const rootStat = await stat(root);
    if (!rootStat.isDirectory()) return null;
  } catch {
    return null;
  }
  return findJsonlByBasename(root, `${sessionId}.jsonl`, cwd ? await cwdCandidates(cwd) : null);
}

export async function waitForClaudeCodeTurnResult(options: {
  readonly sessionId: string;
  readonly turnId: string;
  readonly timeoutMs: number;
  readonly initialOffset: number;
  readonly knownLogPath: string | null;
  readonly expectedLogPath?: string | null;
  readonly cwd?: string | null;
  readonly paceIntermediateEvents?: boolean;
  readonly structuredOutputRequested?: boolean;
  readonly structuredOutputJsonSchema?: unknown;
  readonly isBackendAlive?: () => Promise<boolean>;
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
  let nextFallbackDiscoveryAtMs = options.knownLogPath ? Date.now() + SESSION_LOG_DISCOVERY_POLL_INTERVAL_MS : Date.now();
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
    if (intermediateContent.assistantSnapshot && options.onIntermediateAssistantSnapshot) {
      const snapshotKey = JSON.stringify(intermediateContent.assistantSnapshot);
      if (snapshotKey !== lastPublishedSnapshot) {
        lastPublishedSnapshot = snapshotKey;
        options.onIntermediateAssistantSnapshot(intermediateContent.assistantSnapshot, 'jsonl');
      }
      return;
    }
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
  };

  while (deadline === null || Date.now() < deadline) {
    if (!logPath) {
      logPath = await findClaudeCodeSessionLog(options.sessionId, options.cwd);
      if (!logPath) {
        if (options.expectedLogPath) {
          logPath = options.expectedLogPath;
          offset = 0;
        } else {
          if (await backendExited(options.isBackendAlive)) {
            throw new OpenPError(`backend exited while waiting for session log for turn ${options.turnId}`, EXIT_CODES.backendExited);
          }
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
      const discoveredLogPath = await findClaudeCodeSessionLog(options.sessionId, options.cwd);
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
      const combined = remainder + chunk.text;
      const parts = combined.split('\n');
      remainder = parts.pop() ?? '';
      for (const line of parts) {
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
            await sleepWithinDeadline(targetDelayMs - elapsedMs, deadline, options.turnId);
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
        return result;
      }
    }
    if (await backendExited(options.isBackendAlive)) {
      throw new OpenPError(`backend exited during active turn ${options.turnId}`, EXIT_CODES.backendExited);
    }
    await waitForLogChange(logPath, ACTIVE_TURN_LOG_POLL_INTERVAL_MS);
  }

  if (!logPath || !observedLogFile) {
    throw new OpenPError(`Claude Code session log not found for session ${options.sessionId}. The interactive CLI may be waiting for workspace trust or startup input. Open the workspace once with Claude Code and trust it before running openp unattended.`, EXIT_CODES.sessionLogNotFound);
  }
  throw new OpenPError(`timed out waiting for turn ${options.turnId}`, EXIT_CODES.timeout);
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
    if (entry.isDirectory()) {
      const found = await findJsonlByBasename(path, basename, validCwds);
      if (found) return found;
    }
  }
  return null;
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

async function sleepWithinDeadline(ms: number, deadline: number | null, turnId: string): Promise<void> {
  if (deadline === null) {
    await sleep(ms);
    return;
  }
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    throw new OpenPError(`timed out waiting for turn ${turnId}`, EXIT_CODES.timeout);
  }
  await sleep(Math.min(ms, remainingMs));
  if (Date.now() >= deadline) {
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
  if (!SESSION_ID_PATTERN.test(sessionId)) {
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
