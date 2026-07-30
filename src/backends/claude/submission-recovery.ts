import type { PtySession } from '../../runners/types.js';
import {
  captureClaudeCodeCursorSurface,
  isClaudeCodeEmptyInputPromptLine,
  isClaudeCodeMenuSelectionLine,
} from './interactive.js';

const CLAUDE_INPUT_NAVIGATION_SETTLE_MS = 750;
const CLAUDE_INPUT_DRAFT_SETTLE_MS = 300;

export interface ClaudeInputDraftFingerprint {
  readonly line: string;
  readonly cursorRow: number | null;
  readonly cursorColumn: number | null;
}

export interface ClaudeInputDraftSurface {
  readonly fingerprint: ClaudeInputDraftFingerprint | null;
  readonly kind: 'draft' | 'empty' | 'menu' | 'ambiguous';
}

export async function captureClaudeInputDraftSurface(
  pty: Pick<PtySession, 'captureCursorLine' | 'captureCursorSurface'>,
): Promise<ClaudeInputDraftSurface | null> {
  const cursorSurface = await captureClaudeCodeCursorSurface(pty);
  if (cursorSurface === null) {
    return null;
  }
  const { line, cursorColumn } = cursorSurface;
  const opaqueFingerprint = fingerprintClaudeInputDraftLine(line);
  if (isClaudeCodeMenuSelectionLine(line)) {
    return { fingerprint: null, kind: 'menu' };
  }
  if (isClaudeCodeEmptyInputPromptLine(line)) {
    return { fingerprint: null, kind: 'empty' };
  }
  if (
    cursorColumn === 2 &&
    /^❯\s/u.test(line.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').trimStart())
  ) {
    return { fingerprint: null, kind: 'ambiguous' };
  }
  const fingerprint = opaqueFingerprint === null
    ? null
    : { ...opaqueFingerprint, cursorRow: cursorSurface.cursorRow, cursorColumn };
  return {
    fingerprint,
    kind: fingerprint === null ? 'ambiguous' : 'draft',
  };
}

export async function captureClaudeInputDraftFingerprint(
  pty: Pick<PtySession, 'captureCursorLine' | 'captureCursorSurface'>,
): Promise<ClaudeInputDraftFingerprint | null> {
  return (await captureClaudeInputDraftSurface(pty))?.fingerprint ?? null;
}

export function sameClaudeInputDraftFingerprint(
  left: ClaudeInputDraftFingerprint | null,
  right: ClaudeInputDraftFingerprint | null,
): boolean {
  return left !== null &&
    right !== null &&
    left.line === right.line &&
    left.cursorRow === right.cursorRow &&
    left.cursorColumn === right.cursorColumn;
}

export function changedClaudeInputDraftSurface(
  before: ClaudeInputDraftSurface | null,
  after: ClaudeInputDraftSurface | null,
): ClaudeInputDraftFingerprint | null {
  const afterFingerprint = after?.fingerprint ?? null;
  if (before === null || afterFingerprint === null) {
    return null;
  }
  if (
    before.fingerprint?.line === afterFingerprint.line &&
    before.fingerprint.cursorRow === afterFingerprint.cursorRow &&
    before.fingerprint.cursorColumn === afterFingerprint.cursorColumn
  ) {
    return null;
  }
  return afterFingerprint;
}

export async function waitForChangedClaudeInputDraftSurface(
  pty: Pick<
    PtySession,
    'captureCursorLine' | 'captureCursorSurface' | 'moveCursorToStart' | 'moveCursorToEnd'
  >,
  before: ClaudeInputDraftSurface | null,
  timeoutMs: number,
  assertCanInteract: () => void = () => undefined,
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
      const settledFingerprint = await settleClaudeInputDraftFingerprint(
        pty,
        fingerprint,
        assertCanInteract,
        deadline,
      );
      if (settledFingerprint === null) {
        await sleep(25);
        continue;
      }
      const confirmedFingerprint = await confirmClaudeInputDraftFingerprint(
        pty,
        settledFingerprint,
        assertCanInteract,
      );
      if (confirmedFingerprint !== null) {
        return confirmedFingerprint;
      }
    }
    await sleep(25);
  } while (Date.now() < deadline);
  return null;
}

async function settleClaudeInputDraftFingerprint(
  pty: Pick<PtySession, 'captureCursorLine' | 'captureCursorSurface'>,
  candidate: ClaudeInputDraftFingerprint,
  assertCanInteract: () => void,
  deadline: number,
): Promise<ClaudeInputDraftFingerprint | null> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    return null;
  }
  await sleep(Math.min(CLAUDE_INPUT_DRAFT_SETTLE_MS, remainingMs));
  assertCanInteract();
  const surface = await captureClaudeCodeCursorSurface(pty);
  const settledFingerprint = surface === null || isClaudeCodeMenuSelectionLine(surface.line)
    ? null
    : fingerprintClaudeCodeCursorSurface(surface);
  return sameClaudeInputDraftFingerprint(candidate, settledFingerprint)
    ? candidate
    : null;
}

async function confirmClaudeInputDraftFingerprint(
  pty: Pick<
    PtySession,
    'captureCursorLine' | 'captureCursorSurface' | 'moveCursorToStart' | 'moveCursorToEnd'
  >,
  candidate: ClaudeInputDraftFingerprint,
  assertCanInteract: () => void,
): Promise<ClaudeInputDraftFingerprint | null> {
  if (
    !pty.captureCursorSurface ||
    !pty.moveCursorToStart ||
    !pty.moveCursorToEnd
  ) {
    return candidate;
  }

  assertCanInteract();
  try {
    await pty.moveCursorToStart();
  } catch {
    return null;
  }
  const startDeadline = Date.now() + CLAUDE_INPUT_NAVIGATION_SETTLE_MS;
  const startFingerprint = await waitForClaudeInputDraftFingerprint(
    pty,
    (fingerprint) => !sameClaudeInputDraftFingerprint(candidate, fingerprint),
    assertCanInteract,
    startDeadline,
  );
  if (startFingerprint === null) {
    return null;
  }

  assertCanInteract();
  try {
    await pty.moveCursorToEnd();
  } catch {
    return null;
  }
  return waitForRestoredClaudeInputDraftFingerprint(
    pty,
    candidate,
    startFingerprint,
    assertCanInteract,
    Date.now() + CLAUDE_INPUT_NAVIGATION_SETTLE_MS,
  );
}

async function waitForRestoredClaudeInputDraftFingerprint(
  pty: Pick<PtySession, 'captureCursorLine' | 'captureCursorSurface'>,
  candidate: ClaudeInputDraftFingerprint,
  startFingerprint: ClaudeInputDraftFingerprint,
  assertCanInteract: () => void,
  deadline: number,
): Promise<ClaudeInputDraftFingerprint | null> {
  for (;;) {
    assertCanInteract();
    const surface = await captureClaudeCodeCursorSurface(pty);
    const fingerprint = surface === null || isClaudeCodeMenuSelectionLine(surface.line)
      ? null
      : fingerprintClaudeCodeCursorSurface(surface);
    if (sameClaudeInputDraftFingerprint(candidate, fingerprint)) {
      return candidate;
    }
    if (
      fingerprint !== null &&
      !sameClaudeInputDraftFingerprint(startFingerprint, fingerprint)
    ) {
      // End moved the caret, but the draft changed while the first candidate was being proved.
      // Let the outer loop take the new stable candidate instead of waiting out the rest of the
      // caller budget.
      return null;
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return null;
    }
    await sleep(Math.min(25, remainingMs));
  }
}

async function waitForClaudeInputDraftFingerprint(
  pty: Pick<PtySession, 'captureCursorLine' | 'captureCursorSurface'>,
  accept: (fingerprint: ClaudeInputDraftFingerprint) => boolean,
  assertCanInteract: () => void,
  deadline: number,
): Promise<ClaudeInputDraftFingerprint | null> {
  for (;;) {
    assertCanInteract();
    const surface = await captureClaudeCodeCursorSurface(pty);
    const fingerprint = surface === null || isClaudeCodeMenuSelectionLine(surface.line)
      ? null
      : fingerprintClaudeCodeCursorSurface(surface);
    if (fingerprint !== null && accept(fingerprint)) {
      return fingerprint;
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return null;
    }
    await sleep(Math.min(25, remainingMs));
  }
}

export class ClaudePromptSubmissionTransportError extends Error {
  constructor(
    readonly cause: unknown,
    readonly submissionAttempted: boolean,
  ) {
    super('Claude prompt submission transport failed after write was attempted', { cause });
    this.name = 'ClaudePromptSubmissionTransportError';
  }
}

export function isClaudePromptSubmissionTransportError(
  error: unknown,
): error is ClaudePromptSubmissionTransportError {
  return error instanceof ClaudePromptSubmissionTransportError;
}

function fingerprintClaudeInputDraftLine(
  line: string,
): Pick<ClaudeInputDraftFingerprint, 'line'> | null {
  const cleanLine = line
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .trim();
  if (!cleanLine) {
    return null;
  }
  return { line: cleanLine };
}

function fingerprintClaudeCodeCursorSurface(
  surface: {
    readonly line: string;
    readonly cursorRow: number | null;
    readonly cursorColumn: number | null;
  },
): ClaudeInputDraftFingerprint | null {
  const lineFingerprint = fingerprintClaudeInputDraftLine(surface.line);
  return lineFingerprint === null
    ? null
    : {
        ...lineFingerprint,
        cursorRow: surface.cursorRow,
        cursorColumn: surface.cursorColumn,
      };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
