import { EXIT_CODES, OpenPError } from '../../core/errors.js';
import type { PtySession } from '../../runners/types.js';

export async function waitForClaudeCodeInputReady(pty: PtySession, timeoutMs: number): Promise<void> {
  const deadline = timeoutMs === 0 ? null : Date.now() + timeoutMs;
  let trustConfirmed = false;
  let lastScreenText = '';
  while (deadline === null || Date.now() < deadline) {
    if (!(await pty.isAlive())) {
      throw new OpenPError(`Claude Code exited before it was ready for input${formatReadinessScreen(lastScreenText)}`, EXIT_CODES.backendStartFailed);
    }
    const text = await pty.captureText().catch(() => '');
    lastScreenText = text;
    if (/Quick safety check|trust this folder/i.test(text)) {
      if (!trustConfirmed) {
        trustConfirmed = true;
        await pty.submit();
        await sleep(500);
        continue;
      }
      throw new OpenPError(`Claude Code is still waiting for workspace trust after confirmation.${formatReadinessScreen(lastScreenText)}`, EXIT_CODES.backendStartFailed);
    }
    if (isClaudeCodeInputPromptVisible(text)) {
      await sleep(300);
      return;
    }
    await sleep(250);
  }
  throw new OpenPError(`timed out waiting for Claude Code to become ready for input${formatReadinessScreen(lastScreenText)}`, EXIT_CODES.backendStartFailed);
}

export function readinessTimeoutMs(timeoutMs: number): number {
  return timeoutMs === 0 ? 15_000 : Math.min(timeoutMs, 15_000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isClaudeCodeInputPromptVisible(screenText: string): boolean {
  const recentLines = screenText
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(-8);
  return recentLines.some((line) => /^❯(?:\s|$)/u.test(line));
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
