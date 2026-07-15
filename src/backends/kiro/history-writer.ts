import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, rename, rmdir, stat, truncate, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createAbortError, isAbortError, throwIfAborted } from '../../core/abort.js';
import type {
  AppendSessionHistoryInput,
  AppendSessionHistoryResult,
  CleanupPreparedSessionHistoryAppendInput,
  NativeWrittenTurn,
  SeedWriteTurn,
} from '../../core/backend.js';
import { EXIT_CODES, OpenPError } from '../../core/errors.js';
import { syncDirectory } from '../../core/fs-durability.js';
import { appendJsonlLines, encodeJsonlAppendPayload } from '../../core/jsonl-append.js';
import { assertNativeAppendCandidate } from '../../core/native-append-preflight.js';
import { decodeNativeStateUtf8 } from '../../core/native-state-digest.js';
import { isCanonicalUuidV4 } from '../../core/uuid.js';
import {
  assertKiroNativeSessionAppendable,
  extractKiroNativeTurns,
  kiroNativeStateDigest,
} from './native-reader.js';
import { resolveKiroSessionLogPath } from './session-log.js';

interface JsonObject {
  [key: string]: unknown;
}

const KIRO_SEED_TEMP_FILENAME = 'companion.tmp';

// Resolves the canonical Kiro CLI session log, then appends the caller's paired turns as native
// `Prompt` and `AssistantMessage` records cloned from the log's own last such records (runtime
// golden). The `.json` companion is updated with completion metadata for each appended pair so the
// seeded pairs can later be read as completed native turns.
export async function appendKiroSessionHistory(input: {
  readonly sessionId: string;
  readonly cwd: string; // signature parity only; Kiro resolves its log by session id, not cwd
  readonly turns: readonly SeedWriteTurn[];
  readonly persistPreparedAppend: AppendSessionHistoryInput['persistPreparedAppend'];
  readonly signal?: AbortSignal;
}): Promise<AppendSessionHistoryResult> {
  throwIfAborted(input.signal);
  const logPath = resolveKiroSessionLogPath(input.sessionId);
  if (!logPath) {
    throw new OpenPError(`kiro session log not found for ${input.sessionId}`, EXIT_CODES.sessionLogNotFound);
  }
  let logBytes: Buffer;
  try {
    logBytes = await readFile(logPath);
  } catch (error) {
    if (isNotFoundError(error)) {
      throw new OpenPError(`kiro session log not found for ${input.sessionId}`, EXIT_CODES.sessionLogNotFound);
    }
    throw error;
  }
  const logText = decodeNativeStateUtf8(logBytes, 'Kiro native session log');
  let companionBytes: Buffer;
  const companionPath = logPath.replace(/\.jsonl$/, '.json');
  try {
    companionBytes = await readFile(companionPath);
  } catch {
    throw new OpenPError(`kiro companion metadata not found for ${input.sessionId}`, EXIT_CODES.protocolViolation);
  }
  const companionText = decodeNativeStateUtf8(companionBytes, 'Kiro companion metadata');
  assertKiroNativeSessionAppendable(logText, companionText, input.sessionId);
  const before = extractKiroNativeTurns(logText, companionText, input.sessionId);
  const built = buildKiroHistoryEntries(logText, input.turns);
  const companion = buildKiroCompanionWithAppendedTurns(companionText, input.turns, built.written);
  const payload = encodeJsonlAppendPayload(
    logBytes.length === 0 || logBytes[logBytes.length - 1] === 0x0a,
    built.lines,
  );
  const candidateLogText = `${logText}${payload.toString('utf8')}`;
  const candidateLogBytes = Buffer.concat([logBytes, payload]);
  const candidateCompanionBytes = Buffer.from(companion, 'utf8');
  const candidate = extractKiroNativeTurns(
    candidateLogText,
    companion,
    input.sessionId,
  );
  assertNativeAppendCandidate({
    backend: 'Kiro',
    before,
    candidate,
    requested: input.turns,
    written: built.written,
  });
  const cleanupToken = randomUUID();
  await input.persistPreparedAppend({
    before,
    beforeNativeStateDigest: kiroNativeStateDigest(logBytes, companionBytes),
    candidateNativeStateDigest: kiroNativeStateDigest(candidateLogBytes, candidateCompanionBytes),
    turns: built.written,
    cleanupToken,
  });
  let primaryError: unknown = null;
  let cleanupSettled = false;
  try {
    await commitKiroHistoryAppend({
      logPath,
      companionPath,
      lines: built.lines,
      companion,
      cleanupToken,
      signal: input.signal,
    });
    try {
      await cleanupKiroPreparedSessionHistoryAppend({
        sessionId: input.sessionId,
        cwd: input.cwd,
        token: cleanupToken,
      });
      cleanupSettled = true;
      return { sessionId: input.sessionId, turns: built.written };
    } catch {
      cleanupSettled = true;
      return {
        sessionId: input.sessionId,
        turns: built.written,
        postWriteCleanupFailure: {
          message: 'Kiro seed transient artifact cleanup failed after native commit',
        },
      };
    }
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (!cleanupSettled) {
      try {
        await cleanupKiroPreparedSessionHistoryAppend({
          sessionId: input.sessionId,
          cwd: input.cwd,
          token: cleanupToken,
        });
      } catch (cleanupError) {
        if (primaryError === null) {
          throw cleanupError;
        }
        throw combineKiroPrimaryAndCleanupFailure(primaryError, cleanupError);
      }
    }
  }
}

// Kiro stores one logical history in two files. If the prepared companion has not been published
// and preparation fails after JSONL append, restore the JSONL to its exact prior byte length. Once
// rename publishes the companion, both artifacts remain for exact pending-journal reconciliation.
export async function commitKiroHistoryAppend(input: {
  readonly logPath: string;
  readonly companionPath: string;
  readonly lines: readonly string[];
  readonly companion: string;
  readonly cleanupToken: string;
  readonly signal?: AbortSignal;
}): Promise<void> {
  throwIfAborted(input.signal);
  assertCleanupToken(input.cleanupToken, 'Kiro');
  const originalSize = (await stat(input.logPath)).size;
  const companionMode = (await stat(input.companionPath)).mode & 0o777;
  const tempDir = join(dirname(input.companionPath), `.openp-seed-${input.cleanupToken}`);
  const tmpPath = join(tempDir, KIRO_SEED_TEMP_FILENAME);
  let jsonlAppendAttempted = false;
  let companionPublished = false;
  try {
    await mkdir(tempDir, { mode: 0o700 });
    await chmod(tempDir, 0o700);
    assertPrivateSeedDirectory(await lstat(tempDir), 'Kiro');
    await syncDirectory(dirname(tempDir));
    const temp = await open(tmpPath, 'wx', 0o600);
    try {
      await temp.writeFile(input.companion, 'utf8');
      await temp.chmod(companionMode);
      await temp.sync();
    } finally {
      await temp.close();
    }
    await syncDirectory(tempDir);
    jsonlAppendAttempted = true;
    await appendJsonlLines(input.logPath, input.lines, input.signal);
    await rename(tmpPath, input.companionPath);
    companionPublished = true;
    await syncDirectory(tempDir);
    await syncDirectory(dirname(input.companionPath));
  } catch (error) {
    let rollbackFailed = false;
    if (jsonlAppendAttempted && !companionPublished) {
      try {
        await truncate(input.logPath, originalSize);
        const log = await open(input.logPath, 'r+');
        try {
          await log.sync();
        } finally {
          await log.close();
        }
      } catch {
        rollbackFailed = true;
      }
    }
    if (rollbackFailed) {
      throw new OpenPError(
        'kiro companion publish failed and the JSONL append could not be rolled back',
        EXIT_CODES.protocolViolation,
      );
    }
    throw error;
  }
}

// The pending-append journal stores only `token`; the path is always re-derived from the validated
// Kiro session id. Cleanup intentionally removes one fixed file and then one empty private
// directory. It never follows a path supplied by a journal and never recursively deletes.
export async function cleanupKiroPreparedSessionHistoryAppend(
  input: CleanupPreparedSessionHistoryAppendInput,
): Promise<void> {
  throwIfAborted(input.signal);
  assertCleanupToken(input.token, 'Kiro');
  const logPath = resolveKiroSessionLogPath(input.sessionId);
  if (!logPath) {
    throw new OpenPError('Kiro seed cleanup received an unsafe session id', EXIT_CODES.protocolViolation);
  }
  const sessionRoot = dirname(logPath);
  const companionPath = logPath.replace(/\.jsonl$/, '.json');
  const tempDir = join(sessionRoot, `.openp-seed-${input.token}`);
  const tmpPath = join(tempDir, KIRO_SEED_TEMP_FILENAME);
  await removeControlledSeedTempDirectory('Kiro', sessionRoot, tempDir, tmpPath, companionPath);
}

async function removeControlledSeedTempDirectory(
  backend: string,
  parentDir: string,
  tempDir: string,
  tmpPath: string,
  companionPath: string,
): Promise<void> {
  let dirInfo;
  try {
    dirInfo = await lstat(tempDir);
  } catch (error) {
    if (isNotFoundError(error)) {
      try {
        // A prior attempt may already have removed the locator and then failed before this
        // directory entry became durable. Absence is settled only after the parent is synced.
        await syncDirectory(parentDir);
        return;
      } catch (syncError) {
        throw cleanupError(backend, syncError);
      }
    }
    throw cleanupError(backend, error);
  }
  assertPrivateSeedDirectory(dirInfo, backend, false);
  if ((dirInfo.mode & 0o777) !== 0o700) {
    try {
      await chmod(tempDir, 0o700);
      dirInfo = await lstat(tempDir);
      assertPrivateSeedDirectory(dirInfo, backend);
    } catch (error) {
      throw cleanupError(backend, error);
    }
  }

  try {
    const fileInfo = await lstat(tmpPath);
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    const fileMode = fileInfo.mode & 0o777;
    const companionMode = (await stat(companionPath)).mode & 0o777;
    const privatePreChmodMode = (fileMode & 0o177) === 0;
    if (!fileInfo.isFile() || fileInfo.isSymbolicLink() ||
      (fileMode !== companionMode && !privatePreChmodMode) ||
      (uid !== null && fileInfo.uid !== uid)) {
      throw new OpenPError(`${backend} seed cleanup file failed validation`, EXIT_CODES.protocolViolation);
    }
    await unlink(tmpPath);
    await syncDirectory(tempDir);
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw cleanupError(backend, error);
    }
    try {
      // The file may have been removed by an earlier failed cleanup attempt. Sync the token
      // directory before removing it so that file absence is durable too.
      await syncDirectory(tempDir);
    } catch (syncError) {
      throw cleanupError(backend, syncError);
    }
  }

  try {
    await rmdir(tempDir);
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw cleanupError(backend, error);
    }
  }
  try {
    // This must run even when rmdir reports ENOENT: that path is the retry after a previous
    // rmdir succeeded but the parent-directory fsync failed.
    await syncDirectory(parentDir);
  } catch (error) {
    throw cleanupError(backend, error);
  }
}

function assertCleanupToken(token: string, backend: string): void {
  if (!isCanonicalUuidV4(token)) {
    throw new OpenPError(`${backend} seed cleanup token must be a UUIDv4`, EXIT_CODES.protocolViolation);
  }
}

function assertPrivateSeedDirectory(info: Stats, backend: string, exactMode = true): void {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const mode = info.mode & 0o777;
  const privateMode = exactMode ? mode === 0o700 : (mode & 0o077) === 0;
  if (!info.isDirectory() || info.isSymbolicLink() || !privateMode ||
    (uid !== null && info.uid !== uid)) {
    throw new OpenPError(`${backend} seed cleanup directory failed validation`, EXIT_CODES.protocolViolation);
  }
}

function cleanupError(backend: string, error: unknown): OpenPError {
  if (error instanceof OpenPError) {
    return error;
  }
  return new OpenPError(
    `${backend} seed transient artifact cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
    EXIT_CODES.protocolViolation,
  );
}

function combineKiroPrimaryAndCleanupFailure(primaryError: unknown, cleanupFailure: unknown): Error {
  const message = `${primaryError instanceof Error ? primaryError.message : String(primaryError)}; ` +
    `Kiro seed transient artifact cleanup also failed: ` +
    `${cleanupFailure instanceof Error ? cleanupFailure.message : String(cleanupFailure)}`;
  if (isAbortError(primaryError)) {
    return createAbortError(message, primaryError.interruptedReasoningContent);
  }
  if (primaryError instanceof OpenPError) {
    return new OpenPError(message, primaryError.exitCode, {
      reasonCode: primaryError.reasonCode,
      details: { ...primaryError.details, cleanupFailed: true },
    });
  }
  return new OpenPError(message, EXIT_CODES.backendStartFailed, {
    details: { cleanupFailed: true },
  });
}

// Pure transform (unit-test surface): existing log text -> JSON lines to append. The last single
// `text` Prompt and the last single `text` AssistantMessage are the clone templates; a missing
// template is a protocol violation. Unparseable lines are skipped, never rewritten. Only Prompt
// records carry `data.meta.timestamp`; AssistantMessage records have no meta and none is created.
export function buildKiroHistoryEntries(
  logText: string,
  turns: readonly SeedWriteTurn[],
  nowSec: number = Math.floor(Date.now() / 1000),
): { readonly lines: readonly string[]; readonly written: readonly NativeWrittenTurn[] } {
  let promptTemplate: string | null = null;
  let assistantTemplate: string | null = null;
  let latestPromptTimestampSec = Number.NEGATIVE_INFINITY;

  for (const rawLine of logText.split('\n')) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isJsonObject(entry)) {
      continue;
    }
    if (isKiroPromptTemplate(entry)) {
      promptTemplate = line;
      const data = entry.data as JsonObject;
      const meta = isJsonObject(data.meta) ? data.meta : null;
      if (typeof meta?.timestamp === 'number' && Number.isFinite(meta.timestamp)) {
        latestPromptTimestampSec = Math.max(latestPromptTimestampSec, meta.timestamp);
      }
    }
    if (isKiroAssistantTemplate(entry)) {
      assistantTemplate = line;
    }
  }

  if (!promptTemplate || !assistantTemplate) {
    throw new OpenPError(
      'kiro session log has no Prompt/AssistantMessage record to clone',
      EXIT_CODES.protocolViolation,
    );
  }

  const lines: string[] = [];
  const written: NativeWrittenTurn[] = [];
  const firstTimestampSec = Math.max(Math.floor(nowSec), latestPromptTimestampSec);
  turns.forEach((turn, index) => {
    const prompt = buildKiroPromptEntry(promptTemplate!, turn.userText, firstTimestampSec + index);
    const assistant = buildKiroAssistantEntry(assistantTemplate!, turn.assistantText);
    lines.push(JSON.stringify(prompt));
    lines.push(JSON.stringify(assistant));
    const userId = (prompt.data as JsonObject).message_id as string;
    const assistantId = (assistant.data as JsonObject).message_id as string;
    written.push({
      logicalId: turn.logicalId,
      contentDigest: turn.contentDigest,
      nativeIds: {
        userId,
        assistantIds: [assistantId],
        completionId: assistantId,
      },
    });
  });
  return { lines, written };
}

export function buildKiroCompanionWithAppendedTurns(
  companionText: string,
  turns: readonly SeedWriteTurn[],
  written: readonly NativeWrittenTurn[],
): string {
  let companion: unknown;
  try {
    companion = JSON.parse(companionText);
  } catch {
    throw new OpenPError('kiro companion metadata is not valid JSON', EXIT_CODES.protocolViolation);
  }
  if (!isJsonObject(companion) || !isJsonObject(companion.session_state) ||
    companion.session_state.version !== 'v1' ||
    !isJsonObject(companion.session_state.conversation_metadata) ||
    !Array.isArray(companion.session_state.conversation_metadata.user_turn_metadatas)) {
    throw new OpenPError('kiro companion metadata has no user_turn_metadatas', EXIT_CODES.protocolViolation);
  }
  if (turns.length !== written.length) {
    throw new OpenPError('kiro companion metadata turn count mismatch', EXIT_CODES.protocolViolation);
  }
  const metadatas = companion.session_state.conversation_metadata.user_turn_metadatas;
  const template = metadatas.length > 0 && isJsonObject(metadatas[metadatas.length - 1])
    ? metadatas[metadatas.length - 1] as JsonObject
    : null;
  if (!template) {
    throw new OpenPError('kiro companion metadata has no template turn', EXIT_CODES.protocolViolation);
  }
  const now = new Date();
  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index]!;
    const native = written[index]!.nativeIds;
    const metadata = structuredClone(template) as JsonObject;
    metadata.message_ids = [native.userId, ...native.assistantIds];
    metadata.end_reason = 'UserTurnEnd';
    metadata.end_timestamp = new Date(now.getTime() + index * 1000).toISOString();
    metadata.user_prompt_length = turn.userText.length;
    metadata.result = {
      Ok: {
        id: native.completionId,
        role: 'assistant',
        content: [{ kind: 'text', data: turn.assistantText }],
        meta: { timestamp: Math.floor((now.getTime() + index * 1000) / 1000) },
      },
    };
    if (isJsonObject(metadata.loop_id)) {
      metadata.loop_id = { ...metadata.loop_id, rand: randomUint32() };
    }
    metadatas.push(metadata);
  }
  return `${JSON.stringify(companion, null, 2)}\n`;
}

function isKiroPromptTemplate(entry: JsonObject): boolean {
  if (entry.version !== 'v1' || entry.kind !== 'Prompt') {
    return false;
  }
  const data = entry.data;
  return isJsonObject(data) && isSingleTextContent(data.content);
}

function isKiroAssistantTemplate(entry: JsonObject): boolean {
  if (entry.version !== 'v1' || entry.kind !== 'AssistantMessage') {
    return false;
  }
  const data = entry.data;
  return isJsonObject(data) && isSingleTextContent(data.content);
}

function isSingleTextContent(content: unknown): boolean {
  if (!Array.isArray(content) || content.length !== 1) {
    return false;
  }
  const block = content[0];
  return isJsonObject(block) && block.kind === 'text' && typeof block.data === 'string';
}

// Cloning re-parses the stored template line each turn so entries never share references. Only the
// fields below are replaced; every other field keeps its template value.
function buildKiroPromptEntry(templateLine: string, text: string, timestampSec: number): JsonObject {
  const entry = JSON.parse(templateLine) as JsonObject;
  const data = entry.data as JsonObject;
  data.message_id = randomUUID();
  (data.content as JsonObject[])[0]!.data = text;
  const meta = isJsonObject(data.meta) ? data.meta : {};
  meta.timestamp = timestampSec;
  data.meta = meta;
  return entry;
}

function buildKiroAssistantEntry(templateLine: string, text: string): JsonObject {
  const entry = JSON.parse(templateLine) as JsonObject;
  const data = entry.data as JsonObject;
  data.message_id = randomUUID();
  (data.content as JsonObject[])[0]!.data = text;
  delete data.meta;
  return entry;
}

function randomUint32(): number {
  return Math.floor(Math.random() * 0x100000000);
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { readonly code?: unknown }).code === 'ENOENT';
}
