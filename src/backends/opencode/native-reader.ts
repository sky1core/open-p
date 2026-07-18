import type { NativeSessionReadResult, NativeSessionTurn } from '../../core/backend.js';
import { createAbortError } from '../../core/abort.js';
import { EXIT_CODES, OpenPError } from '../../core/errors.js';
import { digestNativeState } from '../../core/native-state-digest.js';
import { resolveOpenCodeBin } from './bin.js';
import { buildOpenCodeHistoryEnv } from './env.js';
import { runOpenCodeExec, type OpenCodeExecResult } from './exec-runner.js';
import { parseOpenCodeNativeId } from './native-id.js';
import { buildLocalhostOnlySandboxCommand } from './sandbox.js';

interface JsonObject {
  readonly [key: string]: unknown;
}

interface OpenCodeAssistantEvidence {
  readonly id: string;
  readonly text: string;
  readonly completed: number | null;
  readonly finish: unknown;
  readonly interrupted: boolean;
  readonly hasPendingNativeToolCall: boolean;
}

interface PendingOpenCodeTurn {
  readonly id: string;
  readonly text: string;
  readonly assistants: OpenCodeAssistantEvidence[];
}

const UNSUPPORTED_SUCCESS_FINISHES = new Set(['unknown', 'content-filter', 'error']);
const SUPPORTED_OPENCODE_EXPORT_VERSIONS = new Set(['1.17.11']);

export async function readOpenCodeNativeSession(input: {
  readonly backend: string;
  readonly sessionId: string;
  readonly cwd: string;
  readonly mode?: 'logical' | 'settlement';
  readonly signal?: AbortSignal;
}): Promise<NativeSessionReadResult> {
  const bin = resolveOpenCodeBin();
  const historyEnv = await buildOpenCodeHistoryEnv(input.cwd, process.env);
  const command = buildLocalhostOnlySandboxCommand(bin, ['export', input.sessionId]);
  let result = await runOpenCodeExec({
    bin: command.bin,
    args: command.args,
    cwd: input.cwd,
    env: historyEnv.env,
    timeoutMs: 0,
    signal: input.signal,
  });
  assertOpenCodeExportOk(result, input.signal);
  if (input.mode === 'settlement') {
    const confirmed = await runOpenCodeExec({
      bin: command.bin,
      args: command.args,
      cwd: input.cwd,
      env: historyEnv.env,
      timeoutMs: 0,
      signal: input.signal,
    });
    assertOpenCodeExportOk(confirmed, input.signal);
    assertStableOpenCodeNativeExports(result.stdout, confirmed.stdout, input.sessionId);
    result = confirmed;
  }
  return {
    backend: input.backend,
    sessionId: input.sessionId,
    turns: extractOpenCodeNativeTurns(result.stdout, input.sessionId),
    nativeStateDigest: openCodeNativeStateDigest(result.stdout),
  };
}

export function openCodeNativeStateDigest(exportJson: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(exportJson);
  } catch {
    throw new OpenPError('OpenCode export output is not valid JSON', EXIT_CODES.protocolViolation);
  }
  if (!isObject(parsed) || !Array.isArray(parsed.messages)) {
    throw new OpenPError('OpenCode export output has no messages array', EXIT_CODES.protocolViolation);
  }
  return digestNativeState('opencode-export-messages-v1', [
    Buffer.from(canonicalJson(parsed.messages), 'utf8'),
  ]);
}

export function assertStableOpenCodeNativeExports(
  firstExportJson: string,
  confirmedExportJson: string,
  expectedSessionId: string,
): void {
  // Both observations must independently be valid source snapshots. Comparing only `messages`
  // would miss a transient top-level revert/compacting marker because those volatile export fields
  // are intentionally outside the complete-message-state digest.
  extractOpenCodeNativeTurns(firstExportJson, expectedSessionId);
  extractOpenCodeNativeTurns(confirmedExportJson, expectedSessionId);
  if (openCodeNativeStateDigest(confirmedExportJson) !== openCodeNativeStateDigest(firstExportJson)) {
    throw new OpenPError('OpenCode native session changed during settlement verification', EXIT_CODES.protocolViolation);
  }
}

// OpenCode's supported history surface is JSON export/import rather than a native file. Object key
// order is a serialization detail of that surface, while array order and every JSON value are native
// session state. Canonicalizing object keys lets the prepared import and a fresh export prove the same
// semantic messages without ignoring any native field.
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function extractOpenCodeNativeTurns(exportJson: string, expectedSessionId?: string): readonly NativeSessionTurn[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(exportJson);
  } catch {
    throw new OpenPError('OpenCode export output is not valid JSON', EXIT_CODES.protocolViolation);
  }
  if (!isObject(parsed) || !Array.isArray(parsed.messages)) {
    throw new OpenPError('OpenCode export output has no messages array', EXIT_CODES.protocolViolation);
  }
  rejectUnsupportedOpenCodeDocument(parsed);
  assertOpenCodeExportNativeIds(parsed);
  assertOpenCodeExportSessionIdentity(parsed, expectedSessionId);
  const turns: NativeSessionTurn[] = [];
  let pending: PendingOpenCodeTurn | null = null;

  const finalizePending = (atEof: boolean): void => {
    const current = pending;
    pending = null;
    if (!current) return;
    // OpenCode persists internal shell/subtask continuation users as text parts marked synthetic.
    // They are native context, not caller prompts, and therefore do not form portable IR turns.
    if (current.text.length === 0) return;
    if (current.assistants.length === 0) {
      if (atEof) return;
      throw new OpenPError(
        'OpenCode export contains consecutive pending user messages',
        EXIT_CODES.protocolViolation,
      );
    }
    const lastAssistantIndex = current.assistants.length - 1;
    const interruptedIndex = current.assistants.findIndex((assistant) => assistant.interrupted);
    if (interruptedIndex >= 0 && interruptedIndex !== lastAssistantIndex) {
      throw new OpenPError(
        'OpenCode export contains assistant subturns after an interrupted assistant',
        EXIT_CODES.protocolViolation,
      );
    }
    for (const [index, assistant] of current.assistants.entries()) {
      if (assistant.interrupted) continue;
      if (assistant.completed === null) {
        if (atEof && index === current.assistants.length - 1) return;
        throw new OpenPError(
          'OpenCode export contains a non-trailing assistant without completion evidence',
          EXIT_CODES.protocolViolation,
        );
      }
      if (typeof assistant.finish !== 'string' || assistant.finish.length === 0) {
        throw new OpenPError(
          'OpenCode export contains a completed assistant without a finish reason',
          EXIT_CODES.protocolViolation,
        );
      }
      if (index < lastAssistantIndex && assistant.finish !== 'tool-calls' &&
        !assistant.hasPendingNativeToolCall) {
        throw new OpenPError(
          'OpenCode export contains an assistant sibling without continuation evidence',
          EXIT_CODES.protocolViolation,
        );
      }
    }
    const completion = current.assistants.at(-1)!;
    // An explicit terminal provider/abort error proves this logical turn is not portable. It is
    // excluded rather than flattening partial text into a successful answer.
    if (completion.interrupted) return;
    if (completion.finish === 'tool-calls' || completion.hasPendingNativeToolCall) {
      if (atEof) return;
      throw new OpenPError(
        'OpenCode export contains a non-trailing unfinished tool-call turn',
        EXIT_CODES.protocolViolation,
      );
    }
    if (UNSUPPORTED_SUCCESS_FINISHES.has(completion.finish as string)) {
      throw new OpenPError(
        'OpenCode export contains an unsupported terminal finish reason',
        EXIT_CODES.protocolViolation,
      );
    }
    if (completion.text.length === 0) {
      return;
    }
    turns.push({
      userText: current.text,
      assistantText: completion.text,
      nativeIds: {
        userId: current.id,
        assistantIds: current.assistants.map((assistant) => assistant.id),
        completionId: completion.id,
      },
    });
  };

  for (let messageIndex = 0; messageIndex < parsed.messages.length; messageIndex += 1) {
    const message = parsed.messages[messageIndex];
    if (!isObject(message) || !isObject(message.info) || !Array.isArray(message.parts)) {
      throw new OpenPError('OpenCode export contains unsupported message shape', EXIT_CODES.protocolViolation);
    }
    if (isCompletedOpenCodeCompactionPair(parsed.messages, messageIndex)) {
      messageIndex += 1;
      continue;
    }
    rejectUnsupportedOpenCodeSource(message);
    const role = message.info.role;
    if (role === 'user') {
      finalizePending(false);
      pending = { id: messageId(message), text: portableTextFromMessage(message), assistants: [] };
      continue;
    }
    if (role !== 'assistant') {
      throw new OpenPError(
        'OpenCode export contains an unsupported native message role',
        EXIT_CODES.protocolViolation,
      );
    }
    if (!pending) {
      throw new OpenPError(
        'OpenCode export contains an assistant without an owning user message',
        EXIT_CODES.protocolViolation,
      );
    }
    if (message.info.parentID !== pending.id) {
      throw new OpenPError(
        'OpenCode export assistant parentID does not match its owning user message',
        EXIT_CODES.protocolViolation,
      );
    }
    const completed = isObject(message.info.time) &&
      typeof message.info.time.completed === 'number' &&
      Number.isFinite(message.info.time.completed) &&
      message.info.time.completed >= 0
      ? message.info.time.completed
      : null;
    pending.assistants.push({
      id: messageId(message),
      text: portableTextFromMessage(message),
      completed,
      finish: message.info.finish,
      interrupted: Object.prototype.hasOwnProperty.call(message.info, 'error'),
      hasPendingNativeToolCall: hasPendingOpenCodeToolCall(message),
    });
  }
  finalizePending(true);
  return turns;
}

export function isCompletedOpenCodeCompactionPair(messages: readonly unknown[], userIndex: number): boolean {
  const userMessage = messages[userIndex];
  const assistantMessage = messages[userIndex + 1];
  if (!isObject(userMessage) || !isObject(userMessage.info) || !Array.isArray(userMessage.parts) ||
    !isObject(assistantMessage) || !isObject(assistantMessage.info) || !Array.isArray(assistantMessage.parts)) {
    return false;
  }
  if (userMessage.info.role !== 'user' || userMessage.parts.length !== 1) {
    return false;
  }
  // Observed pair users carry an object-valued info.summary; boolean true on the user member is an
  // unobserved shape and must fall through to the fail-closed rejection (only the assistant member
  // legitimately carries info.summary === true).
  if (userMessage.info.summary === true) {
    return false;
  }
  if (hasOpenCodeCompactionPairFailClosedMarker(userMessage) ||
    hasOpenCodeCompactionPairFailClosedMarker(assistantMessage)) {
    return false;
  }
  const [part] = userMessage.parts;
  if (!isObject(part) || part.type !== 'compaction') {
    return false;
  }
  if (assistantMessage.info.role !== 'assistant' || assistantMessage.info.summary !== true ||
    assistantMessage.info.parentID !== messageId(userMessage) ||
    Object.prototype.hasOwnProperty.call(assistantMessage.info, 'error')) {
    return false;
  }
  // The pair's only compaction part is the user member's single one; a compaction part on the
  // summary assistant is an unobserved shape and must fall through to the fail-closed rejection.
  if (assistantMessage.parts.some((assistantPart) => isObject(assistantPart) && assistantPart.type === 'compaction')) {
    return false;
  }
  return isObject(assistantMessage.info.time) &&
    typeof assistantMessage.info.time.completed === 'number' &&
    Number.isFinite(assistantMessage.info.time.completed) &&
    assistantMessage.info.time.completed >= 0;
}

function hasOpenCodeCompactionPairFailClosedMarker(message: JsonObject): boolean {
  if (isObject(message.info) && Object.prototype.hasOwnProperty.call(message.info, 'revert')) {
    return true;
  }
  return (message.parts as unknown[]).some((part) => isObject(part) &&
    (part.summary === true || isObject(part.metadata) && part.metadata.compaction_continue === true));
}

export function assertOpenCodeExportNativeIds(exportDoc: unknown): void {
  if (!isObject(exportDoc) || !Array.isArray(exportDoc.messages)) {
    throw new OpenPError('OpenCode export output has no messages array', EXIT_CODES.protocolViolation);
  }
  const seen = new Set<string>();
  for (const message of exportDoc.messages) {
    if (!isObject(message) || !isObject(message.info) || !Array.isArray(message.parts) ||
      !parseOpenCodeNativeId(message.info.id, 'msg')) {
      throw new OpenPError('OpenCode export contains an invalid native message id', EXIT_CODES.protocolViolation);
    }
    const messageId = message.info.id as string;
    if (seen.has(messageId)) {
      throw new OpenPError('OpenCode export contains a duplicate native id', EXIT_CODES.protocolViolation);
    }
    seen.add(messageId);
    for (const part of message.parts) {
      if (!isObject(part) || !parseOpenCodeNativeId(part.id, 'prt')) {
        throw new OpenPError('OpenCode export contains an invalid native part id', EXIT_CODES.protocolViolation);
      }
      const partId = part.id as string;
      if (seen.has(partId)) {
        throw new OpenPError('OpenCode export contains a duplicate native id', EXIT_CODES.protocolViolation);
      }
      seen.add(partId);
    }
  }
}

export function assertOpenCodeExportSessionIdentity(exportDoc: unknown, expectedSessionId: string | undefined): void {
  if (expectedSessionId === undefined) {
    return;
  }
  if (!isObject(exportDoc)) {
    throw new OpenPError('OpenCode export has no native session identity', EXIT_CODES.protocolViolation);
  }
  const info = isObject(exportDoc.info) ? exportDoc.info : null;
  if (info?.id !== expectedSessionId) {
    throw new OpenPError('OpenCode export info.id does not match the requested session id', EXIT_CODES.protocolViolation);
  }
  if (!Array.isArray(exportDoc.messages)) {
    throw new OpenPError('OpenCode export output has no messages array', EXIT_CODES.protocolViolation);
  }
  for (const message of exportDoc.messages) {
    if (!isObject(message) || !isObject(message.info) || typeof message.info.id !== 'string' ||
      message.info.id.length === 0 || message.info.sessionID !== expectedSessionId || !Array.isArray(message.parts)) {
      throw new OpenPError('OpenCode export message belongs to a different native session', EXIT_CODES.protocolViolation);
    }
    for (const part of message.parts) {
      if (!isObject(part) || part.sessionID !== expectedSessionId || part.messageID !== message.info.id) {
        throw new OpenPError('OpenCode export part has invalid native ownership', EXIT_CODES.protocolViolation);
      }
    }
  }
}

function rejectUnsupportedOpenCodeDocument(doc: JsonObject): void {
  if (!isObject(doc.info) || typeof doc.info.version !== 'string' ||
    !SUPPORTED_OPENCODE_EXPORT_VERSIONS.has(doc.info.version)) {
    throw new OpenPError('OpenCode export version is unsupported', EXIT_CODES.protocolViolation);
  }
  if (Object.prototype.hasOwnProperty.call(doc.info, 'revert')) {
    throw new OpenPError('OpenCode pending revert sessions are not supported for seed source conversion', EXIT_CODES.protocolViolation);
  }
  if (isObject(doc.info.time) && Object.prototype.hasOwnProperty.call(doc.info.time, 'compacting')) {
    throw new OpenPError('OpenCode sessions with pending compaction are not supported for seed source conversion', EXIT_CODES.protocolViolation);
  }
}

function rejectUnsupportedOpenCodeSource(message: JsonObject): void {
  if (isObject(message.info)) {
    if (Object.prototype.hasOwnProperty.call(message.info, 'revert')) {
      throw new OpenPError('OpenCode pending revert sessions are not supported for seed source conversion', EXIT_CODES.protocolViolation);
    }
    if (message.info.summary === true) {
      throw new OpenPError('OpenCode compacted sessions are not supported for seed source conversion', EXIT_CODES.protocolViolation);
    }
  }
  for (const part of message.parts as unknown[]) {
    if (!isObject(part)) continue;
    if (part.type === 'compaction' || part.summary === true || isObject(part.metadata) && part.metadata.compaction_continue === true) {
      throw new OpenPError('OpenCode compacted sessions are not supported for seed source conversion', EXIT_CODES.protocolViolation);
    }
  }
}

function portableTextFromMessage(message: JsonObject): string {
  return (message.parts as unknown[])
    .filter((part): part is JsonObject => isObject(part) && part.type === 'text' &&
      typeof part.text === 'string' && part.synthetic !== true && part.ignored !== true)
    .map((part) => part.text as string)
    .join('');
}

export function hasPendingOpenCodeToolCall(message: JsonObject): boolean {
  return (message.parts as unknown[]).some((part) => {
    if (!isObject(part) || part.type !== 'tool') return false;
    const providerExecuted = isObject(part.metadata) && part.metadata.providerExecuted === true;
    const orphanedInterrupted = isObject(part.state) && part.state.status === 'error' &&
      isObject(part.state.metadata) && part.state.metadata.interrupted === true;
    return !providerExecuted && !orphanedInterrupted;
  });
}

function messageId(message: JsonObject): string {
  if (isObject(message.info) && typeof message.info.id === 'string' && message.info.id.length > 0) {
    return message.info.id;
  }
  throw new OpenPError('OpenCode export message is missing an id', EXIT_CODES.protocolViolation);
}

export function assertOpenCodeExportOk(result: OpenCodeExecResult, signal?: AbortSignal): void {
  if (result.signal) {
    if (signal?.aborted) {
      throw createAbortError();
    }
    throw new OpenPError(`OpenCode export stopped due to signal ${result.signal}`, EXIT_CODES.backendExited);
  }
  if (result.exitCode !== 0) {
    const detail = [result.stdout.trim().slice(0, 500), result.stderr.trim().slice(0, 500)]
      .filter((value, index, values) => value.length > 0 && values.indexOf(value) === index)
      .join(' | ');
    throw new OpenPError(
      `OpenCode export exited with code ${result.exitCode ?? 'unknown'}${detail ? `: ${detail}` : ''}`,
      EXIT_CODES.backendExited,
    );
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
