import { open, stat, truncate } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import { throwIfAborted } from './abort.js';
import { EXIT_CODES, OpenPError } from './errors.js';

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
  const file = await inspectFileEnd(path);
  const payload = encodeJsonlAppendPayload(file.endsWithNewline, lines);
  throwIfAborted(signal);
  const handle = await open(path, 'a');
  try {
    throwIfAborted(signal);
  } catch (error) {
    // Preserve the primary abort classification just as commitAppendTransaction preserves a
    // primary write failure when close also fails.
    await handle.close().catch(() => undefined);
    throw error;
  }
  await commitAppendTransaction({
    write: async () => {
      await handle.writeFile(payload);
      await handle.sync();
    },
    close: () => handle.close(),
    rollback: async () => {
      await truncate(path, file.size);
      const rollbackHandle = await open(path, 'r+');
      try {
        await rollbackHandle.sync();
      } finally {
        await rollbackHandle.close();
      }
    },
  });
}

export function encodeJsonlAppendPayload(
  existingEndsWithNewline: boolean,
  lines: readonly string[],
): Buffer {
  if (lines.length === 0) {
    return Buffer.alloc(0);
  }
  const leading = existingEndsWithNewline ? '' : '\n';
  return Buffer.from(`${leading}${lines.join('\n')}\n`, 'utf8');
}

export async function commitAppendTransaction(input: {
  readonly write: () => Promise<void>;
  readonly close: () => Promise<void>;
  readonly rollback: () => Promise<void>;
}): Promise<void> {
  let failure: unknown = null;
  try {
    await input.write();
  } catch (error) {
    failure = error;
  }
  try {
    await input.close();
  } catch (error) {
    if (failure === null) {
      failure = error;
    }
  }
  if (failure === null) {
    return;
  }
  try {
    await input.rollback();
  } catch {
    throw new OpenPError('JSONL append failed and its partial write could not be rolled back', EXIT_CODES.protocolViolation);
  }
  throw failure;
}

// An empty file needs no separator. A non-empty file needs a leading newline only when its last
// byte is not already a line feed. ENOENT propagates to the caller unclassified.
async function inspectFileEnd(path: string): Promise<{ readonly size: number; readonly endsWithNewline: boolean }> {
  const stats = await stat(path);
  if (stats.size === 0) {
    return { size: 0, endsWithNewline: true };
  }
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(1);
    await handle.read(buffer, 0, 1, stats.size - 1);
    return { size: stats.size, endsWithNewline: buffer[0] === 0x0a };
  } finally {
    await handle.close();
  }
}
