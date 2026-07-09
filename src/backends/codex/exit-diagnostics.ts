import { readFile } from 'node:fs/promises';

import { EXIT_CODES, OpenPError } from '../../core/errors.js';
import { parseCodexOutput } from './jsonl-parser.js';
import {
  readCodexSessionLogResultSinceBaseline,
  type CodexSessionLogBaseline,
} from './session-log.js';

export interface CodexNonZeroExitErrorOptions {
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly stdout: string;
  readonly outputLastMessagePath: string;
  readonly sessionId: string | null;
  readonly sessionLogBaseline: CodexSessionLogBaseline | null;
}

export async function createCodexNonZeroExitError(options: CodexNonZeroExitErrorOptions): Promise<OpenPError> {
  const stderrSnippet = options.stderr.trim().slice(0, 500);
  const stdoutDiagnostic = extractCodexStdoutExitDiagnostic(options.stdout);
  const details = formatExitDetails([stdoutDiagnostic, stderrSnippet]);
  const fallbackMessage = `Codex CLI exited with code ${options.exitCode}${details}`;

  const sessionId = await resolveDiagnosticSessionId(options);
  if (!sessionId) {
    return new OpenPError(fallbackMessage, EXIT_CODES.backendExited);
  }

  try {
    const sessionLog = await readCodexSessionLogResultSinceBaseline(sessionId, options.sessionLogBaseline);
    if (sessionLog?.hasCompletionEvidence && !sessionLog.content?.trim()) {
      if (stdoutDiagnostic) {
        return new OpenPError(fallbackMessage, EXIT_CODES.backendExited);
      }
      return new OpenPError(
        `Codex CLI completed without a final answer (exit code ${options.exitCode}${details})`,
        EXIT_CODES.backendExited,
      );
    }
  } catch {
    // Preserve the original non-zero exit when diagnostic log inspection fails.
  }

  return new OpenPError(fallbackMessage, EXIT_CODES.backendExited);
}

function formatExitDetails(messages: readonly (string | null | undefined)[]): string {
  const unique: string[] = [];
  for (const message of messages) {
    const normalized = message?.trim();
    if (!normalized || unique.includes(normalized)) continue;
    unique.push(normalized);
  }
  if (unique.length === 0) return '';
  return `: ${unique.join(' | ').slice(0, 700)}`;
}

function extractCodexStdoutExitDiagnostic(stdout: string): string | null {
  const messages: string[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!event || typeof event !== 'object') continue;
    const record = event as Record<string, unknown>;
    if (record.type === 'error' && typeof record.message === 'string') {
      appendUniqueMessage(messages, normalizeCodexDiagnosticMessage(record.message));
      continue;
    }
    if (record.type === 'turn.failed') {
      const error = asObject(record.error);
      if (typeof error?.message === 'string') {
        appendUniqueMessage(messages, normalizeCodexDiagnosticMessage(error.message));
      }
      continue;
    }
    const item = asObject(record.item);
    if (item?.type === 'error' && typeof item.message === 'string') {
      appendUniqueMessage(messages, normalizeCodexDiagnosticMessage(item.message));
    }
  }
  return messages.length > 0 ? messages.slice(0, 3).join(' | ') : null;
}

function normalizeCodexDiagnosticMessage(message: string): string {
  const trimmed = message.trim();
  if (!trimmed) return trimmed;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const record = asObject(parsed);
    const error = asObject(record?.error);
    if (typeof error?.message === 'string' && error.message.trim()) {
      const status = typeof record?.status === 'number' ? `status ${record.status}: ` : '';
      return `${status}${error.message.trim()}`;
    }
  } catch {
    // Non-JSON diagnostic text is already the provider-facing message.
  }
  return trimmed;
}

function appendUniqueMessage(messages: string[], message: string): void {
  const normalized = message.trim();
  if (!normalized || messages.includes(normalized)) return;
  messages.push(normalized);
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

async function resolveDiagnosticSessionId(options: CodexNonZeroExitErrorOptions): Promise<string | null> {
  if (options.sessionId) {
    return options.sessionId;
  }

  let lastMessageContent: string | null = null;
  try {
    lastMessageContent = await readFile(options.outputLastMessagePath, 'utf8');
  } catch {
    // file may not exist
  }

  try {
    return parseCodexOutput(options.stdout, lastMessageContent).sessionId;
  } catch {
    return null;
  }
}
