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
  const details = stderrSnippet ? `: ${stderrSnippet}` : '';
  const fallbackMessage = `Codex CLI exited with code ${options.exitCode}${details}`;

  const sessionId = await resolveDiagnosticSessionId(options);
  if (!sessionId) {
    return new OpenPError(fallbackMessage, EXIT_CODES.backendExited);
  }

  try {
    const sessionLog = await readCodexSessionLogResultSinceBaseline(sessionId, options.sessionLogBaseline);
    if (sessionLog?.hasCompletionEvidence && !sessionLog.content?.trim()) {
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
