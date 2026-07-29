import { EXIT_CODES, OpenPError } from '../../core/errors.js';
import type { PtySession } from '../../runners/types.js';

const CLAUDE_CODE_NAVIGATION_SETTLE_MS = 750;

export class ClaudeCodeSelectionPromptError extends OpenPError {}

export function isClaudeCodeSelectionPromptError(
  error: unknown,
): error is ClaudeCodeSelectionPromptError {
  return error instanceof ClaudeCodeSelectionPromptError;
}

export async function waitForClaudeCodeInputReady(
  pty: PtySession,
  timeoutMs: number,
  options: { readonly confirmTrustPrompt?: boolean } = {},
): Promise<void> {
  const deadline = timeoutMs === 0 ? null : Date.now() + timeoutMs;
  const confirmTrustPrompt = options.confirmTrustPrompt ?? true;
  let trustConfirmed = false;
  let consecutiveMenuSelectionFrames = 0;
  let lastScreenText = '';
  while (deadline === null || Date.now() < deadline) {
    if (!(await pty.isAlive())) {
      throw new OpenPError(`Claude Code exited before it was ready for input${formatReadinessScreen(lastScreenText)}`, EXIT_CODES.backendStartFailed);
    }
    const cursorLine = await pty.captureCursorLine().catch(() => '');
    // A ready input line settles readiness on its own, so the screen is never read while the
    // backend is simply waiting for the next prompt. Everything below only runs when the backend
    // is showing something else.
    if (isClaudeCodeInputPromptLine(cursorLine)) {
      await sleep(300);
      const settledCursorLine = await pty.captureCursorLine().catch(() => '');
      if (isClaudeCodeInputPromptLine(settledCursorLine)) {
        return;
      }
      lastScreenText = settledCursorLine;
      continue;
    }
    const text = await pty.captureText().catch(() => '');
    lastScreenText = text;
    // The workspace trust prompt renders as a numbered selection menu, so this has to be answered
    // before the menu is read as one openp cannot answer. It is offered only when starting a
    // session fresh, which is also what makes reading the whole screen safe here: a fresh session
    // has no transcript of its own to paint, so the only writer of this text is Claude Code.
    if (
      confirmTrustPrompt &&
      isClaudeCodeMenuSelectionLine(cursorLine) &&
      /Quick safety check|trust this folder/i.test(text)
    ) {
      if (!trustConfirmed) {
        trustConfirmed = true;
        try {
          await pty.submit();
        } catch {
          throw new ClaudeCodeSelectionPromptError(
            `Claude Code workspace trust confirmation failed after submit was attempted.${formatReadinessScreen(lastScreenText)}`,
            EXIT_CODES.backendStartFailed,
          );
        }
        await sleep(500);
        continue;
      }
      throw new ClaudeCodeSelectionPromptError(
        `Claude Code is still waiting for workspace trust after confirmation.${formatReadinessScreen(lastScreenText)}`,
        EXIT_CODES.backendStartFailed,
      );
    }
    if (isClaudeCodeMenuSelectionLine(cursorLine)) {
      consecutiveMenuSelectionFrames += 1;
      if (consecutiveMenuSelectionFrames >= 2) {
        throw new ClaudeCodeSelectionPromptError(
          `Claude Code is showing an interactive selection prompt that open-p cannot answer ` +
            `(e.g., a first-run trusted-tool approval). Complete it manually by running ` +
            `Claude Code once with the same configuration directory.${formatReadinessScreen(lastScreenText)}`,
          EXIT_CODES.backendStartFailed,
        );
      }
    } else {
      consecutiveMenuSelectionFrames = 0;
    }
    await sleep(250);
  }
  throw new OpenPError(`timed out waiting for Claude Code to become ready for input${formatReadinessScreen(lastScreenText)}`, EXIT_CODES.backendStartFailed);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function isClaudeCodeInputReady(pty: Pick<PtySession, 'captureCursorLine'>): Promise<boolean> {
  return isClaudeCodeInputPromptLine(await pty.captureCursorLine().catch(() => ''));
}

export async function isClaudeCodeEmptyInputReady(
  pty: Pick<PtySession, 'captureCursorLine' | 'captureCursorSurface' | 'moveCursorToEnd'>,
): Promise<boolean> {
  if (!await probeClaudeCodeEmptyInputComposer(pty)) {
    return false;
  }
  await sleep(CLAUDE_CODE_NAVIGATION_SETTLE_MS);
  return probeClaudeCodeEmptyInputComposer(pty);
}

export interface ClaudeCodeCursorSurface {
  readonly line: string;
  readonly cursorRow: number | null;
  readonly cursorColumn: number | null;
}

export async function captureClaudeCodeCursorSurface(
  pty: Pick<PtySession, 'captureCursorLine' | 'captureCursorSurface'>,
): Promise<ClaudeCodeCursorSurface | null> {
  if (!pty.captureCursorSurface) {
    const line = await pty.captureCursorLine().catch(() => null);
    return line === null ? null : { line, cursorRow: null, cursorColumn: null };
  }
  const surface = await pty.captureCursorSurface().catch(() => null);
  return surface === null
    ? null
    : {
        line: surface.line,
        cursorRow: surface.cursorRow,
        cursorColumn: surface.cursorColumn,
      };
}

// Reads the screen only when the visible input line is a selection prompt, and returns null
// otherwise. A selection prompt is a question only a human can answer, so a backend showing one is
// not working on anything; the screen comes back with it because the choices name what stopped the
// turn (a usage limit and a first-run approval read the same to open-p, and only the screen tells
// them apart). This stays inside the input-readiness surface: the decision reads the cursor line
// alone, and the screen is carried for the caller to read, never to infer readiness from.
export async function readClaudeCodeSelectionPromptScreen(
  pty: Pick<PtySession, 'captureCursorLine' | 'captureText'>,
): Promise<string | null> {
  if (!isClaudeCodeMenuSelectionLine(await pty.captureCursorLine().catch(() => ''))) {
    return null;
  }
  const screenText = await pty.captureText().catch(() => null);
  if (screenText === null || screenText.trim().length === 0) {
    return '\nLast Claude Code screen: unavailable';
  }
  return formatReadinessScreen(screenText);
}

// A paste whose first character is `!` toggles the Claude Code composer's shell mode instead of
// entering literal prompt text (even under bracketed paste), so the input runs as a shell command
// without a caller user turn. Prepending one space suppresses the toggle; Claude Code preserves
// the leading space untrimmed in the session-log caller user record.
// Evidence: a live probe of bang-leading prompt delivery against Claude Code.
export function escapeClaudeComposerShellModeToggle(prompt: string): string {
  return prompt.startsWith('!') ? ` ${prompt}` : prompt;
}

export function isClaudeCodeInputPromptLine(line: string): boolean {
  const cleanLine = cleanClaudeCodeInputLine(line);
  return /^❯(?:\s|$)/u.test(cleanLine) && !isClaudeCodeMenuSelectionLine(line);
}

export function isClaudeCodeEmptyInputPromptLine(
  line: string,
): boolean {
  return /^❯\s*$/u.test(cleanClaudeCodeInputLine(line));
}

export function isClaudeCodeMenuSelectionLine(line: string): boolean {
  // Numbered drafts are ambiguous with startup menus, so recovery/readiness must fail closed.
  return /^❯\s*\d+\.\s/u.test(cleanClaudeCodeInputLine(line));
}

function cleanClaudeCodeInputLine(line: string): string {
  return line
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .trimStart();
}

function formatReadinessScreen(screenText: string): string {
  const text = screenText
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(-12)
    .join('\n')
    .trim();
  if (!text) {
    return '';
  }
  const truncated = text.length > 2_000 ? `${text.slice(0, 2_000)}\n...[truncated]` : text;
  return `\nLast Claude Code screen:\n${truncated}`;
}

async function probeClaudeCodeEmptyInputComposer(
  pty: Pick<PtySession, 'captureCursorLine' | 'captureCursorSurface' | 'moveCursorToEnd'>,
): Promise<boolean> {
  const surface = await captureClaudeCodeCursorSurface(pty);
  if (surface === null || isClaudeCodeMenuSelectionLine(surface.line)) {
    return false;
  }
  if (isClaudeCodeEmptyInputPromptLine(surface.line)) {
    return true;
  }
  if (
    surface.cursorColumn !== 2 ||
    !isClaudeCodeInputPromptLine(surface.line) ||
    !pty.moveCursorToEnd
  ) {
    return false;
  }
  try {
    await pty.moveCursorToEnd();
  } catch {
    return false;
  }
  // tmux confirms that the key was queued, not that Claude Code has repainted the composer.
  // Reading immediately can therefore mistake a real draft parked at Home (column 2) for an
  // unchanged empty suggestion.
  await sleep(CLAUDE_CODE_NAVIGATION_SETTLE_MS);
  const afterEnd = await captureClaudeCodeCursorSurface(pty);
  return afterEnd !== null &&
    afterEnd.cursorColumn === 2 &&
    isClaudeCodeInputPromptLine(afterEnd.line) &&
    !isClaudeCodeMenuSelectionLine(afterEnd.line);
}
