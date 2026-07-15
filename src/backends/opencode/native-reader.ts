import type { NativeSessionReadResult, NativeSessionTurn } from '../../core/backend.js';
import { createAbortError } from '../../core/abort.js';
import { EXIT_CODES, OpenPError } from '../../core/errors.js';
import { resolveOpenCodeBin } from './bin.js';
import { buildOpenCodeHistoryEnv } from './env.js';
import { runOpenCodeExec, type OpenCodeExecResult } from './exec-runner.js';
import { buildLocalhostOnlySandboxCommand } from './sandbox.js';

interface JsonObject {
  readonly [key: string]: unknown;
}

export async function readOpenCodeNativeSession(input: {
  readonly backend: string;
  readonly sessionId: string;
  readonly cwd: string;
  readonly signal?: AbortSignal;
}): Promise<NativeSessionReadResult> {
  const bin = resolveOpenCodeBin();
  const historyEnv = await buildOpenCodeHistoryEnv(input.cwd, process.env);
  const command = buildLocalhostOnlySandboxCommand(bin, ['export', input.sessionId]);
  const result = await runOpenCodeExec({
    bin: command.bin,
    args: command.args,
    cwd: input.cwd,
    env: historyEnv.env,
    timeoutMs: 0,
    signal: input.signal,
  });
  assertOpenCodeExportOk(result, input.signal);
  return {
    backend: input.backend,
    sessionId: input.sessionId,
    turns: extractOpenCodeNativeTurns(result.stdout),
  };
}

export function extractOpenCodeNativeTurns(exportJson: string): readonly NativeSessionTurn[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(exportJson);
  } catch {
    throw new OpenPError('OpenCode export output is not valid JSON', EXIT_CODES.protocolViolation);
  }
  if (!isObject(parsed) || !Array.isArray(parsed.messages)) {
    throw new OpenPError('OpenCode export output has no messages array', EXIT_CODES.protocolViolation);
  }
  const turns: NativeSessionTurn[] = [];
  let pendingUser: { id: string; text: string } | null = null;
  for (const [messageIndex, message] of parsed.messages.entries()) {
    if (!isObject(message) || !isObject(message.info) || !Array.isArray(message.parts)) {
      throw new OpenPError('OpenCode export contains unsupported message shape', EXIT_CODES.protocolViolation);
    }
    rejectUnsupportedOpenCodeSource(message);
    const role = message.info.role;
    if (role === 'user') {
      if (pendingUser) {
        throw new OpenPError(
          'OpenCode export contains consecutive pending user messages',
          EXIT_CODES.protocolViolation,
        );
      }
      pendingUser = { id: messageId(message), text: textFromMessage(message) };
      continue;
    }
    if (pendingUser && role !== 'assistant') {
      throw new OpenPError(
        'OpenCode export contains a non-adjacent user/assistant turn',
        EXIT_CODES.protocolViolation,
      );
    }
    if (role === 'assistant' && pendingUser) {
      if (!isObject(message.info.time) || typeof message.info.time.completed !== 'number') {
        if (messageIndex !== parsed.messages.length - 1) {
          throw new OpenPError(
            'OpenCode export contains a non-trailing assistant without completion evidence',
            EXIT_CODES.protocolViolation,
          );
        }
        pendingUser = null;
        continue;
      }
      const assistantText = textFromMessage(message);
      if (pendingUser.text.length > 0 && assistantText.length > 0) {
        const assistantId = messageId(message);
        turns.push({
          userText: pendingUser.text,
          assistantText,
          nativeIds: {
            userId: pendingUser.id,
            assistantIds: [assistantId],
            completionId: assistantId,
          },
        });
      }
      pendingUser = null;
    }
  }
  return turns;
}

function rejectUnsupportedOpenCodeSource(message: JsonObject): void {
  if (isObject(message.info) && isObject(message.info.revert)) {
    throw new OpenPError('OpenCode pending revert sessions are not supported for seed source conversion', EXIT_CODES.protocolViolation);
  }
  for (const part of message.parts as unknown[]) {
    if (!isObject(part)) continue;
    if (part.type === 'compaction' || part.summary === true || isObject(part.metadata) && part.metadata.compaction_continue === true) {
      throw new OpenPError('OpenCode compacted sessions are not supported for seed source conversion', EXIT_CODES.protocolViolation);
    }
  }
}

function textFromMessage(message: JsonObject): string {
  return (message.parts as unknown[])
    .filter((part): part is JsonObject => isObject(part) && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('');
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
