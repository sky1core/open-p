import { open, stat } from 'node:fs/promises';
import { throwIfAborted } from './abort.js';

// Append-only JSONL writer. Knows file mechanics only; it holds no session-log schema knowledge.
// Existing bytes are never rewritten: the pre-existing content is read solely to decide whether a
// separating newline is required, and every new line is emitted in a single append write. The
// abort signal is re-checked after that read, immediately before the write, so an interrupt
// received at any point before the append never lands a post-abort write.
export async function appendJsonlLines(
  path: string,
  lines: readonly string[],
  signal?: AbortSignal,
): Promise<void> {
  if (lines.length === 0) {
    return;
  }
  const leading = (await fileEndsWithNewline(path)) ? '' : '\n';
  const payload = `${leading}${lines.join('\n')}\n`;
  throwIfAborted(signal);
  const handle = await open(path, 'a');
  try {
    await handle.writeFile(payload, 'utf8');
  } finally {
    await handle.close();
  }
}

// An empty file needs no separator. A non-empty file needs a leading newline only when its last
// byte is not already a line feed. ENOENT propagates to the caller (mapped to sessionLogNotFound).
async function fileEndsWithNewline(path: string): Promise<boolean> {
  const stats = await stat(path);
  if (stats.size === 0) {
    return true;
  }
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(1);
    await handle.read(buffer, 0, 1, stats.size - 1);
    return buffer[0] === 0x0a;
  } finally {
    await handle.close();
  }
}
