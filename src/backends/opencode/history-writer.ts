import { randomBytes } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createAbortError, throwIfAborted } from '../../core/abort.js';
import type { SessionHistoryTurn } from '../../core/backend.js';
import { EXIT_CODES, OpenPError } from '../../core/errors.js';
import { resolveOpenCodeBin } from './bin.js';
import { buildOpenCodeHistoryEnv } from './env.js';
import { runOpenCodeExec, type OpenCodeExecResult } from './exec-runner.js';
import { buildLocalhostOnlySandboxCommand } from './sandbox.js';

// The `Imported session: <id>` line OpenCode prints to stdout after `opencode import <file>`.
const IMPORTED_SESSION_RE = /^Imported session:\s*(\S+)\s*$/;

// Base62 alphabet for the random tail of `msg_`/`prt_` ids.
const BASE62 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

// Native OpenCode ids are exactly `msg_`/`prt_` + 12 lowercase-hex chars (a time segment that
// ascends with creation time) + 14 base62 chars. OpenCode sorts messages by id, so seeded ids must
// carry segments larger than every existing message/part id or the session's message order breaks
// on resume (live-verified in the 20260714-201500-opencode-id-ordering reference). Only ids
// matching the full native shape count as ordering candidates: a near-native id (12-hex head but a
// missing/short/non-base62 tail) is malformed and must not seed the segment counter.
const NATIVE_ID_RE = /^(?:msg|prt)_([0-9a-f]{12})[0-9A-Za-z]{14}$/;
const ID_SEGMENT_HEX_LENGTH = 12;
const ID_SUFFIX_LENGTH = 14;
// Largest value a native 12-hex segment can hold (48 bits); one more hex digit would break the
// native id shape and with it opencode's id-based message ordering.
const MAX_ID_SEGMENT = 0xffffffffffffn;

interface JsonObject {
  [key: string]: unknown;
}

// Appends the caller's turns to an existing OpenCode session by re-importing the session's own
// export with extra text-only messages. OpenCode `import` upserts on the document's `info.id`, so
// the session id is preserved and the existing messages are re-sent verbatim. Nothing is written
// to the session store directly: `export` and `import` are the only supported native surfaces.
export async function appendOpenCodeSessionHistory(input: {
  readonly sessionId: string;
  readonly cwd: string;
  readonly turns: readonly SessionHistoryTurn[];
  readonly signal?: AbortSignal;
}): Promise<void> {
  throwIfAborted(input.signal);
  const bin = resolveOpenCodeBin();
  const historyEnv = await buildOpenCodeHistoryEnv(input.cwd, process.env);

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

  const importDoc = buildOpenCodeImportDoc(exportResult.stdout, input.turns);

  const tmpFile = join(historyEnv.cacheDir, `seed-import-${randomBytes(12).toString('hex')}.json`);
  await writeFile(tmpFile, importDoc, { mode: 0o600 });
  try {
    throwIfAborted(input.signal);
    const importCommand = buildLocalhostOnlySandboxCommand(bin, ['import', tmpFile]);
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
  } finally {
    await rm(tmpFile, { force: true }).catch(() => undefined);
  }
}

// Pure transform (unit-test surface): an `opencode export` JSON string plus the caller's turns ->
// an `opencode import` document JSON string. Existing messages are preserved verbatim and the new
// text-only messages are appended. `info.id` (the upsert key) is never changed. The clone templates
// are the last user message and last assistant message that carry a `text` part; a missing template
// or unparseable export is a protocol violation.
export function buildOpenCodeImportDoc(
  exportJson: string,
  turns: readonly SessionHistoryTurn[],
  nowMs: number = Date.now(),
): string {
  let doc: unknown;
  try {
    doc = JSON.parse(exportJson);
  } catch {
    throw new OpenPError('OpenCode export output is not valid JSON', EXIT_CODES.protocolViolation);
  }
  if (!isJsonObject(doc) || !Array.isArray(doc.messages)) {
    throw new OpenPError('OpenCode export output has no messages array', EXIT_CODES.protocolViolation);
  }

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
  let created = nowMs;
  const appended: JsonObject[] = [];
  for (const turn of turns) {
    const template = turn.role === 'user' ? userTemplate : assistantTemplate;
    const message = structuredClone(template);
    const messageId = nextSeedId('msg_');
    message.info.id = messageId;
    // Part-level time (when the template carries one) must agree with the message's info.time.
    let partTime: JsonObject;
    if (turn.role === 'user') {
      message.info.time = { created };
      partTime = { start: created };
    } else {
      const completed = created + 1000;
      message.info.time = { created, completed };
      message.info.parentID = prevMessageId;
      partTime = { start: created, end: completed };
    }
    message.parts = [buildTextPart(template, turn.text, messageId, nextSeedId('prt_'), partTime)];
    appended.push(message);
    prevMessageId = messageId;
    created += 3000;
  }

  doc.messages = [...messages, ...appended];
  return JSON.stringify(doc);
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
    if (!Array.isArray(message.parts) || !message.parts.some(isTextPart)) {
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
  const textPart = template.parts.find(isTextPart)!;
  const part: JsonObject = { ...structuredClone(textPart), id: partId, text, messageID: messageId };
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
  const consider = (id: unknown): void => {
    if (typeof id !== 'string') {
      return;
    }
    const match = id.match(NATIVE_ID_RE);
    if (!match) {
      return;
    }
    const segment = BigInt(`0x${match[1]!}`);
    if (max === null || segment > max) {
      max = segment;
    }
  };
  for (const message of messages) {
    if (!isJsonObject(message)) {
      continue;
    }
    if (isJsonObject(message.info)) {
      consider(message.info.id);
    }
    if (Array.isArray(message.parts)) {
      for (const part of message.parts) {
        if (isJsonObject(part)) {
          consider(part.id);
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

function isTextPart(part: unknown): part is JsonObject {
  return isJsonObject(part) && part.type === 'text' && typeof part.text === 'string';
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
