import type { PtySession } from '../../runners/types.js';
import {
  isClaudeCodeEmptyInputPromptLine,
  isClaudeCodeMenuSelectionLine,
} from './interactive.js';

export interface ClaudeInputDraftFingerprint {
  readonly line: string;
}

export interface ClaudeInputDraftSurface {
  readonly fingerprint: ClaudeInputDraftFingerprint | null;
}

export async function captureClaudeInputDraftSurface(
  pty: Pick<PtySession, 'captureCursorLine'>,
): Promise<ClaudeInputDraftSurface | null> {
  const line = await pty.captureCursorLine().catch(() => null);
  if (line === null) {
    return null;
  }
  return { fingerprint: fingerprintClaudeInputDraftLine(line) };
}

export async function captureClaudeInputDraftFingerprint(
  pty: Pick<PtySession, 'captureCursorLine'>,
): Promise<ClaudeInputDraftFingerprint | null> {
  return (await captureClaudeInputDraftSurface(pty))?.fingerprint ?? null;
}

export function sameClaudeInputDraftFingerprint(
  left: ClaudeInputDraftFingerprint | null,
  right: ClaudeInputDraftFingerprint | null,
): boolean {
  return left !== null && right !== null && left.line === right.line;
}

export function changedClaudeInputDraftSurface(
  before: ClaudeInputDraftSurface | null,
  after: ClaudeInputDraftSurface | null,
): ClaudeInputDraftFingerprint | null {
  if (before === null || after === null || after.fingerprint === null) {
    return null;
  }
  if (before.fingerprint?.line === after.fingerprint.line) {
    return null;
  }
  return after.fingerprint;
}

export async function waitForChangedClaudeInputDraftSurface(
  pty: Pick<PtySession, 'captureCursorLine'>,
  before: ClaudeInputDraftSurface | null,
  timeoutMs: number,
): Promise<ClaudeInputDraftFingerprint | null> {
  if (before === null) {
    return null;
  }
  const deadline = Date.now() + timeoutMs;
  do {
    const fingerprint = changedClaudeInputDraftSurface(
      before,
      await captureClaudeInputDraftSurface(pty),
    );
    if (fingerprint !== null) {
      return fingerprint;
    }
    await sleep(25);
  } while (Date.now() < deadline);
  return null;
}

function fingerprintClaudeInputDraftLine(line: string): ClaudeInputDraftFingerprint | null {
  if (isClaudeCodeMenuSelectionLine(line) || isClaudeCodeEmptyInputPromptLine(line)) {
    return null;
  }
  const cleanLine = line
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .trim();
  if (!cleanLine) {
    return null;
  }
  return { line: cleanLine };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
