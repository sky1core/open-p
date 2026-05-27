import type { PtySession } from '../../runners/types.js';
import { extractClaudeCodeScreenAssistantText } from './screen-parser.js';

export function startClaudeCodeScreenIntermediateMonitor(options: {
  readonly pty: PtySession;
  readonly onIntermediateText?: (text: string) => void;
  readonly intervalMs?: number;
}): () => Promise<void> {
  if (!options.onIntermediateText) {
    return async () => {};
  }

  const intervalMs = options.intervalMs ?? 250;
  let stopped = false;
  let lastText: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let activeTick: Promise<void> | null = null;

  const schedule = (): void => {
    if (stopped) {
      return;
    }
    timer = setTimeout(() => {
      activeTick = tick().finally(() => {
        activeTick = null;
        schedule();
      });
    }, intervalMs);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  };

  const tick = async (): Promise<void> => {
    if (stopped) {
      return;
    }
    try {
      if (!(await options.pty.isAlive())) {
        stopped = true;
        return;
      }
      const text = extractClaudeCodeScreenAssistantText(await options.pty.captureText());
      if (stopped) {
        return;
      }
      if (isPublishableIntermediateText(text, lastText)) {
        lastText = text;
        options.onIntermediateText?.(text);
      }
    } catch {
      // Screen capture is best-effort only; JSONL remains the result authority.
    }
  };

  schedule();

  return async () => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    await activeTick;
  };
}

export function isPublishableIntermediateText(text: string | null, previousText: string | null): text is string {
  if (!text || !text.trim()) {
    return false;
  }
  if (text === previousText) {
    return false;
  }
  return true;
}
