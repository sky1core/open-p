import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { chmod, lstat, mkdir, open, realpath, rmdir, unlink } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
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
import { assertNativeAppendCandidate } from '../../core/native-append-preflight.js';
import { isSafeSessionId } from '../../core/session-id.js';
import { resolveOpenPStateRoot } from '../../core/state-root.js';
import { isCanonicalUuidV4 } from '../../core/uuid.js';
import { resolveOpenCodeBin } from './bin.js';
import { buildOpenCodeHistoryEnv } from './env.js';
import { runOpenCodeExec, type OpenCodeExecResult } from './exec-runner.js';
import {
  assertOpenCodeExportNativeIds,
  assertOpenCodeExportSessionIdentity,
  extractOpenCodeNativeTurns,
  hasPendingOpenCodeToolCall,
  openCodeNativeStateDigest,
} from './native-reader.js';
import { parseOpenCodeNativeId } from './native-id.js';
import { buildLocalhostOnlySandboxCommand } from './sandbox.js';

// The `Imported session: <id>` line OpenCode prints to stdout after `opencode import <file>`.
const IMPORTED_SESSION_RE = /^Imported session:\s*(\S+)\s*$/;

// Base62 alphabet for the random tail of `msg_`/`prt_` ids.
const BASE62 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

// Native OpenCode ids are exactly `msg_`/`prt_` + 12 lowercase-hex chars (an allocation segment)
// + 14 base62 chars. Seeded ids must carry segments larger than every existing message/part id or
// an immediate resumed turn can fail before a model call in observed OpenCode behavior. This native-id continuation rule is independent
// from the separate `info.time.created` export-ordering rule. Only ids matching the full native
// shape count as allocation candidates: a near-native id (12-hex head but a missing/short/non-base62
// tail) is malformed and must not seed the segment counter.
const ID_SEGMENT_HEX_LENGTH = 12;
const ID_SUFFIX_LENGTH = 14;
// Largest value a native 12-hex segment can hold (48 bits); one more hex digit would break the
// native id shape and with it OpenCode's native-id continuation contract.
const MAX_ID_SEGMENT = 0xffffffffffffn;
const OPENCODE_IMPORT_FILENAME = 'import.json';
const SYSTEM_TEMP_ROOT = '/tmp';

interface JsonObject {
  [key: string]: unknown;
}

// Appends the caller's turns to an existing OpenCode session by re-importing the session's own
// export with extra text-only messages. OpenCode `import` upserts on the document-level `info.id`,
// so the session id is preserved and the existing messages are re-sent verbatim. Nothing is written
// to the session store directly: `export` and `import` are the only supported native surfaces.
export async function appendOpenCodeSessionHistory(input: {
  readonly sessionId: string;
  readonly cwd: string;
  readonly turns: readonly SeedWriteTurn[];
  readonly persistPreparedAppend: AppendSessionHistoryInput['persistPreparedAppend'];
  readonly signal?: AbortSignal;
}): Promise<AppendSessionHistoryResult> {
  throwIfAborted(input.signal);
  if (!isSafeSessionId(input.sessionId)) {
    throw new OpenPError('OpenCode history append received an unsafe session id', EXIT_CODES.protocolViolation);
  }
  const bin = resolveOpenCodeBin();
  const historyEnv = await buildOpenCodeHistoryEnv(input.cwd, process.env);
  const stateRoot = resolveOpenPStateRoot(input.cwd, process.env);
  const importTempRoot = await resolveOpenCodeImportTempRoot(stateRoot);
  historyEnv.env.TMPDIR = importTempRoot;

  const exportCommand = buildLocalhostOnlySandboxCommand(bin, ['export', input.sessionId]);
  const exportResult = await runOpenCodeExec({
    bin: exportCommand.bin,
    args: exportCommand.args,
    cwd: input.cwd,
    env: historyEnv.env,
    timeoutMs: 0,
    signal: input.signal,
  });
  assertOpenCodeHistoryOk('export', exportResult, input.signal);

  const before = extractOpenCodeNativeTurns(exportResult.stdout, input.sessionId);
  const built = prepareOpenCodeHistoryAppend(exportResult.stdout, input.turns, Date.now(), input.sessionId);
  const cleanupToken = randomUUID();
  await input.persistPreparedAppend({
    before,
    beforeNativeStateDigest: openCodeNativeStateDigest(exportResult.stdout),
    candidateNativeStateDigest: openCodeNativeStateDigest(built.doc),
    turns: built.written,
    cleanupToken,
  });

  let primaryError: unknown = null;
  let cleanupSettled = false;
  try {
    const temp = await createOpenCodeImportTempFile({
      doc: built.doc,
      sessionId: input.sessionId,
      cleanupToken,
      stateRoot,
    });
    throwIfAborted(input.signal);
    const importCommand = buildLocalhostOnlySandboxCommand(bin, ['import', temp.path]);
    const importResult = await runOpenCodeExec({
      bin: importCommand.bin,
      args: importCommand.args,
      cwd: input.cwd,
      env: historyEnv.env,
      timeoutMs: 0,
      signal: input.signal,
    });
    assertOpenCodeHistoryOk('import', importResult, input.signal);

    const importedId = parseImportedSessionId(importResult.stdout);
    if (importedId !== input.sessionId) {
      throw new OpenPError(
        `OpenCode import reported session ${importedId ?? 'unknown'} but expected ${input.sessionId}`,
        EXIT_CODES.protocolViolation,
      );
    }
    try {
      await cleanupOpenCodePreparedSessionHistoryAppend({
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
          message: 'OpenCode seed import document cleanup failed after native commit',
        },
      };
    }
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (!cleanupSettled) {
      try {
        await cleanupOpenCodePreparedSessionHistoryAppend({
          sessionId: input.sessionId,
          cwd: input.cwd,
          token: cleanupToken,
        });
      } catch (cleanupError) {
        if (primaryError === null) {
          throw cleanupError;
        }
        throw combineOpenCodePrimaryAndCleanupFailure(primaryError, cleanupError);
      }
    }
  }
}

export function prepareOpenCodeHistoryAppend(
  exportJson: string,
  turns: readonly SeedWriteTurn[],
  nowMs: number,
  expectedSessionId: string,
): { readonly doc: string; readonly written: readonly NativeWrittenTurn[] } {
  const before = extractOpenCodeNativeTurns(exportJson, expectedSessionId);
  const built = buildOpenCodeImport(exportJson, turns, nowMs, expectedSessionId);
  const candidate = extractOpenCodeNativeTurns(built.doc, expectedSessionId);
  assertNativeAppendCandidate({
    backend: 'OpenCode',
    before,
    candidate,
    requested: turns,
    written: built.written,
  });
  return built;
}

export async function createOpenCodeImportTempFile(input: {
  readonly doc: string;
  readonly sessionId: string;
  readonly cleanupToken: string;
  readonly stateRoot: string;
}): Promise<{
  readonly path: string;
  readonly cleanup: () => Promise<void>;
}> {
  assertOpenCodeCleanupIdentity(input.sessionId, input.cleanupToken);
  const tempRoot = await resolveOpenCodeImportTempRoot(input.stateRoot);
  const { dir, path } = openCodeImportTempPaths(tempRoot, input.sessionId, input.cleanupToken);
  await mkdir(dir, { mode: 0o700 });
  await chmod(dir, 0o700);
  assertPrivateOpenCodeTempDirectory(await lstat(dir));
  await syncDirectory(tempRoot);
  const file = await open(path, 'wx', 0o600);
  try {
    await file.writeFile(input.doc, 'utf8');
    await file.chmod(0o600);
    await file.sync();
  } finally {
    await file.close();
  }
  await syncDirectory(dir);
  return {
    path,
    cleanup: () => removeOpenCodeImportTempFile(tempRoot, dir, path),
  };
}

// Cleanup re-derives the only allowed locator from the validated session id and UUID token. Core
// calls this after native/provenance settlement, before retiring the pending marker and journal.
export async function cleanupOpenCodePreparedSessionHistoryAppend(
  input: CleanupPreparedSessionHistoryAppendInput,
): Promise<void> {
  throwIfAborted(input.signal);
  assertOpenCodeCleanupIdentity(input.sessionId, input.token);
  const stateRoot = resolveOpenPStateRoot(input.cwd, process.env);
  const tempRoot = await resolveOpenCodeImportTempRoot(stateRoot);
  const { dir, path } = openCodeImportTempPaths(tempRoot, input.sessionId, input.token);
  await removeOpenCodeImportTempFile(tempRoot, dir, path);
}

async function removeOpenCodeImportTempFile(tempRoot: string, dir: string, path: string): Promise<void> {
  let dirInfo;
  try {
    dirInfo = await lstat(dir);
  } catch (error) {
    if (isNotFoundError(error)) {
      try {
        // A previous attempt may have removed the locator before failing its parent fsync.
        // Do not report cleanup settled until the absence is durable in the fixed temp root.
        await syncDirectory(tempRoot);
        return;
      } catch (syncError) {
        throw openCodeCleanupError(syncError);
      }
    }
    throw openCodeCleanupError(error);
  }
  dirInfo = await normalizePrivateOpenCodeTempDirectory(dir, dirInfo);

  try {
    const fileInfo = await lstat(path);
    const uid = currentUid();
    const fileMode = fileInfo.mode & 0o777;
    if (!fileInfo.isFile() || fileInfo.isSymbolicLink() || (fileMode & 0o177) !== 0 ||
      (uid !== null && fileInfo.uid !== uid)) {
      throw new OpenPError('OpenCode seed cleanup file failed validation', EXIT_CODES.protocolViolation);
    }
    await unlink(path);
    await syncDirectory(dir);
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw openCodeCleanupError(error);
    }
    try {
      await syncDirectory(dir);
    } catch (syncError) {
      throw openCodeCleanupError(syncError);
    }
  }
  try {
    await rmdir(dir);
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw openCodeCleanupError(error);
    }
  }
  try {
    // Also sync on the ENOENT retry path after an earlier successful rmdir.
    await syncDirectory(tempRoot);
  } catch (error) {
    throw openCodeCleanupError(error);
  }
}

function openCodeImportTempPaths(
  tempRoot: string,
  sessionId: string,
  cleanupToken: string,
): { readonly dir: string; readonly path: string } {
  const sessionDigest = createHash('sha256').update(sessionId, 'utf8').digest('hex').slice(0, 32);
  const dir = join(tempRoot, `openp-opencode-seed-${sessionDigest}-${cleanupToken}`);
  return { dir, path: join(dir, OPENCODE_IMPORT_FILENAME) };
}

function assertOpenCodeCleanupIdentity(sessionId: string, cleanupToken: string): void {
  if (!isSafeSessionId(sessionId)) {
    throw new OpenPError('OpenCode seed cleanup received an unsafe session id', EXIT_CODES.protocolViolation);
  }
  if (!isCanonicalUuidV4(cleanupToken)) {
    throw new OpenPError('OpenCode seed cleanup token must be a UUIDv4', EXIT_CODES.protocolViolation);
  }
}

function assertPrivateOpenCodeTempDirectory(info: Stats, exactMode = true): void {
  const uid = currentUid();
  const mode = info.mode & 0o777;
  const privateMode = exactMode ? mode === 0o700 : (mode & 0o077) === 0;
  if (!info.isDirectory() || info.isSymbolicLink() || !privateMode ||
    (uid !== null && info.uid !== uid)) {
    throw new OpenPError('OpenCode seed cleanup directory failed validation', EXIT_CODES.protocolViolation);
  }
}

async function normalizePrivateOpenCodeTempDirectory(path: string, info: Stats): Promise<Stats> {
  assertPrivateOpenCodeTempDirectory(info, false);
  if ((info.mode & 0o777) === 0o700) {
    return info;
  }
  try {
    await chmod(path, 0o700);
    const normalized = await lstat(path);
    assertPrivateOpenCodeTempDirectory(normalized);
    return normalized;
  } catch (error) {
    throw openCodeCleanupError(error);
  }
}

function openCodeCleanupError(error: unknown): OpenPError {
  if (error instanceof OpenPError) {
    return error;
  }
  return new OpenPError(
    `OpenCode seed transient artifact cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
    EXIT_CODES.protocolViolation,
  );
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { readonly code?: unknown }).code === 'ENOENT';
}

export function combineOpenCodePrimaryAndCleanupFailure(
  primaryError: unknown,
  cleanupError: unknown,
): Error {
  const message = `${primaryError instanceof Error ? primaryError.message : String(primaryError)}; ` +
    `OpenCode seed import document cleanup also failed: ` +
    `${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`;
  if (isAbortError(primaryError)) {
    return createAbortError(message, primaryError.interruptedReasoningContent);
  }
  if (primaryError instanceof OpenPError) {
    return new OpenPError(message, primaryError.exitCode, {
      reasonCode: primaryError.reasonCode,
      details: {
        ...primaryError.details,
        cleanupFailed: true,
      },
    });
  }
  return new OpenPError(message, EXIT_CODES.backendStartFailed, {
    details: { cleanupFailed: true },
  });
}

export async function resolveOpenCodeImportTempRoot(
  stateRoot: string,
): Promise<string> {
  const systemTempRoot = await canonicalPath(SYSTEM_TEMP_ROOT);
  const uid = currentUid();
  const tempRoot = join(systemTempRoot, `openp-opencode-seed-${uid ?? 'nouid'}`);
  try {
    await mkdir(tempRoot, { mode: 0o700 });
    await chmod(tempRoot, 0o700);
    await syncDirectory(systemTempRoot);
  } catch (error) {
    if (!isAlreadyExistsError(error)) {
      throw error;
    }
  }
  await assertOpenCodeImportTempRoot(tempRoot, stateRoot);
  return tempRoot;
}

async function assertOpenCodeImportTempRoot(tempRoot: string, stateRoot: string): Promise<void> {
  const canonicalStateRoot = await canonicalPath(stateRoot);
  if (isPathInside(tempRoot, canonicalStateRoot)) {
    throw new OpenPError(
      'OpenCode seed import temp root must be outside the open-p state root',
      EXIT_CODES.protocolViolation,
    );
  }
  let info;
  try {
    info = await lstat(tempRoot);
  } catch (error) {
    throw openCodeCleanupError(error);
  }
  try {
    await normalizePrivateOpenCodeTempDirectory(tempRoot, info);
  } catch {
    throw new OpenPError('OpenCode seed temp root failed ownership/private-directory validation', EXIT_CODES.protocolViolation);
  }
}

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

function isPathInside(path: string, parent: string): boolean {
  const child = relative(parent, path);
  return child === '' || (!child.startsWith('..') && !isAbsolute(child));
}

function currentUid(): number | null {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

function isAlreadyExistsError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { readonly code?: unknown }).code === 'EEXIST';
}

// Pure transform (unit-test surface): an `opencode export` JSON string plus the caller's turns ->
// an `opencode import` document JSON string. Existing messages are preserved verbatim and the new
// text-only messages are appended. The document-level `info.id` (the upsert key) is never changed;
// appended message-level `info.id` values are fresh native ids. The clone templates are the last
// user message and last assistant message that carry a `text` part; a missing template or
// unparseable export is a protocol violation.
export function buildOpenCodeImportDoc(
  exportJson: string,
  turns: readonly SeedWriteTurn[],
  nowMs: number = Date.now(),
  expectedSessionId?: string,
): string {
  return buildOpenCodeImport(exportJson, turns, nowMs, expectedSessionId).doc;
}

export function buildOpenCodeImport(
  exportJson: string,
  turns: readonly SeedWriteTurn[],
  nowMs: number = Date.now(),
  expectedSessionId?: string,
): { readonly doc: string; readonly written: readonly NativeWrittenTurn[] } {
  let doc: unknown;
  try {
    doc = JSON.parse(exportJson);
  } catch {
    throw new OpenPError('OpenCode export output is not valid JSON', EXIT_CODES.protocolViolation);
  }
  if (!isJsonObject(doc) || !Array.isArray(doc.messages)) {
    throw new OpenPError('OpenCode export output has no messages array', EXIT_CODES.protocolViolation);
  }
  assertOpenCodeExportNativeIds(doc);
  assertOpenCodeExportSessionIdentity(doc, expectedSessionId);

  const messages = doc.messages;
  const userTemplate = findLastTextMessage(messages, 'user');
  const assistantTemplate = findLastTextMessage(messages, 'assistant');
  if (!userTemplate || !assistantTemplate) {
    throw new OpenPError(
      'OpenCode export has no user/assistant text message to clone',
      EXIT_CODES.protocolViolation,
    );
  }

  // A leading assistant turn parents onto the last existing message; otherwise each assistant
  // parents onto the freshly appended message before it.
  let prevMessageId = requireMessageId(messages[messages.length - 1]);
  const nextSeedId = createSeedIdAllocator(messages);
  const appendedMessageCount = turns.length * 2;
  const existingMaxTime = maxExistingMessageTime(messages);
  let created = nowMs - appendedMessageCount;
  if (appendedMessageCount > 0 && existingMaxTime !== null && created <= existingMaxTime) {
    throw new OpenPError(
      'OpenCode export leaves no non-future timestamp range for seeded messages',
      EXIT_CODES.protocolViolation,
    );
  }
  const appended: JsonObject[] = [];
  const written: NativeWrittenTurn[] = [];
  for (const turn of turns) {
    const userMessage = structuredClone(userTemplate);
    const userMessageId = nextSeedId('msg_');
    userMessage.info.id = userMessageId;
    userMessage.info.time = { created };
    userMessage.parts = [buildTextPart(userTemplate, turn.userText, userMessageId, nextSeedId('prt_'), { start: created })];
    appended.push(userMessage);
    prevMessageId = userMessageId;
    created += 1;

    const assistantMessage = structuredClone(assistantTemplate);
    const assistantMessageId = nextSeedId('msg_');
    const completed = created + 1;
    assistantMessage.info.id = assistantMessageId;
    assistantMessage.info.time = { created, completed };
    assistantMessage.info.parentID = prevMessageId;
    assistantMessage.parts = [
      buildTextPart(assistantTemplate, turn.assistantText, assistantMessageId, nextSeedId('prt_'), {
        start: created,
        end: completed,
      }),
    ];
    appended.push(assistantMessage);
    prevMessageId = assistantMessageId;
    written.push({
      logicalId: turn.logicalId,
      contentDigest: turn.contentDigest,
      nativeIds: {
        userId: userMessageId,
        assistantIds: [assistantMessageId],
        completionId: assistantMessageId,
      },
    });
    created += 1;
  }

  doc.messages = [...messages, ...appended];
  return { doc: JSON.stringify(doc), written };
}

function maxExistingMessageTime(messages: readonly unknown[]): number | null {
  let max: number | null = null;
  for (const message of messages) {
    if (!isJsonObject(message) || !isJsonObject(message.info) || !isJsonObject(message.info.time)) {
      continue;
    }
    for (const key of ['created', 'completed'] as const) {
      const value = message.info.time[key];
      if (typeof value === 'number' && Number.isFinite(value) && (max === null || value > max)) {
        max = value;
      }
    }
  }
  return max;
}

// A message carrying `info` and at least one `{type:"text", text:string}` part.
interface OpenCodeTemplateMessage extends JsonObject {
  info: JsonObject;
  parts: JsonObject[];
}

function findLastTextMessage(messages: unknown[], role: 'user' | 'assistant'): OpenCodeTemplateMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isJsonObject(message) || !isJsonObject(message.info) || message.info.role !== role) {
      continue;
    }
    if (!Array.isArray(message.parts) || !message.parts.some(isPortableTextPart)) {
      continue;
    }
    if (role === 'assistant' && !isSuccessfulAssistantTemplate(message)) {
      continue;
    }
    return message as OpenCodeTemplateMessage;
  }
  return null;
}

function buildTextPart(
  template: OpenCodeTemplateMessage,
  text: string,
  messageId: string,
  partId: string,
  freshTime: JsonObject,
): JsonObject {
  const textPart = template.parts.find(isPortableTextPart)!;
  const part: JsonObject = { ...structuredClone(textPart), id: partId, text, messageID: messageId };
  // Synthetic and ignored text is backend-owned context, not caller/final-answer evidence. A seed
  // append must always create an ordinary portable text part even when a nearby native template
  // carries one of those flags.
  delete part.synthetic;
  delete part.ignored;
  // Assistant text parts natively carry `time: {start, end}` (user text parts carry none). A stale
  // template timestamp must not survive into a seeded part, so when the template has a time key it
  // is regenerated from the seeded message's own info.time; when it has none, none is created.
  if (Object.prototype.hasOwnProperty.call(part, 'time')) {
    part.time = freshTime;
  }
  return part;
}

// Allocates seed ids that continue the export's native id ordering: the max 12-hex time segment
// across every existing message and part id, incremented once per allocated id (BigInt: the
// segment is 48 bits, beyond Number's exact range), plus a fresh 14-char base62 tail. Message and
// part ids share one counter so allocation order (msg, its part, next msg, ...) stays ascending.
function createSeedIdAllocator(messages: unknown[]): (prefix: 'msg_' | 'prt_') => string {
  const maxExisting = maxIdSegment(messages);
  if (maxExisting === null) {
    throw new OpenPError(
      'OpenCode export has no native-format ids to order seeded messages after',
      EXIT_CODES.protocolViolation,
    );
  }
  let segment = maxExisting;
  return (prefix) => {
    segment += 1n;
    if (segment > MAX_ID_SEGMENT) {
      throw new OpenPError(
        'OpenCode seed id segment overflows the native 12-hex range',
        EXIT_CODES.protocolViolation,
      );
    }
    return `${prefix}${segment.toString(16).padStart(ID_SEGMENT_HEX_LENGTH, '0')}${base62Suffix()}`;
  };
}

function maxIdSegment(messages: unknown[]): bigint | null {
  let max: bigint | null = null;
  const consider = (id: unknown, kind: 'msg' | 'prt'): void => {
    const parsed = parseOpenCodeNativeId(id, kind);
    if (!parsed) {
      throw new OpenPError('OpenCode export contains a malformed native id', EXIT_CODES.protocolViolation);
    }
    const segment = parsed.segment;
    if (max === null || segment > max) {
      max = segment;
    }
  };
  for (const message of messages) {
    if (!isJsonObject(message)) {
      continue;
    }
    if (isJsonObject(message.info)) {
      consider(message.info.id, 'msg');
    }
    if (Array.isArray(message.parts)) {
      for (const part of message.parts) {
        if (isJsonObject(part)) {
          consider(part.id, 'prt');
        }
      }
    }
  }
  return max;
}

function base62Suffix(): string {
  let suffix = '';
  for (const byte of randomBytes(ID_SUFFIX_LENGTH)) {
    suffix += BASE62[byte % 62];
  }
  return suffix;
}

function parseImportedSessionId(stdout: string): string | null {
  for (const line of stdout.split('\n')) {
    const match = line.match(IMPORTED_SESSION_RE);
    if (match) {
      return match[1]!;
    }
  }
  return null;
}

// export/import failures preserve bounded stdout/stderr diagnostics as backend-exit; a signal kill
// surfaces as interrupted when the caller aborted, otherwise as a backend exit.
function assertOpenCodeHistoryOk(
  phase: 'export' | 'import',
  result: OpenCodeExecResult,
  signal: AbortSignal | undefined,
): void {
  if (result.signal) {
    if (signal?.aborted) {
      throw createAbortError();
    }
    throw new OpenPError(`OpenCode ${phase} stopped due to signal ${result.signal}`, EXIT_CODES.backendExited);
  }
  if (result.exitCode !== 0) {
    throw createOpenCodeHistoryExitError(phase, result.exitCode, result.stdout, result.stderr);
  }
}

function createOpenCodeHistoryExitError(
  phase: 'export' | 'import',
  exitCode: number | null,
  stdout: string,
  stderr: string,
): OpenPError {
  const diagnostics = [stdout.trim().slice(0, 500), stderr.trim().slice(0, 500)].filter(
    (value, index, values) => value.length > 0 && values.indexOf(value) === index,
  );
  const detail = diagnostics.length > 0 ? `: ${diagnostics.join(' | ').slice(0, 700)}` : '';
  return new OpenPError(
    `OpenCode ${phase} exited with code ${exitCode ?? 'unknown'}${detail}`,
    EXIT_CODES.backendExited,
  );
}

function requireMessageId(message: unknown): string {
  if (isJsonObject(message) && isJsonObject(message.info) && typeof message.info.id === 'string' && message.info.id.length > 0) {
    return message.info.id;
  }
  throw new OpenPError('OpenCode export message is missing an id', EXIT_CODES.protocolViolation);
}

function isPortableTextPart(part: unknown): part is JsonObject {
  return isJsonObject(part) && part.type === 'text' && typeof part.text === 'string' &&
    part.synthetic !== true && part.ignored !== true;
}

function isSuccessfulAssistantTemplate(message: JsonObject): boolean {
  const info = message.info as JsonObject;
  return !Object.prototype.hasOwnProperty.call(info, 'error') &&
    typeof info.finish === 'string' && info.finish.length > 0 &&
    !['tool-calls', 'unknown', 'content-filter', 'error'].includes(info.finish) &&
    isJsonObject(info.time) && typeof info.time.completed === 'number' &&
    Number.isFinite(info.time.completed) && info.time.completed >= 0 &&
    !hasPendingOpenCodeToolCall(message);
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
