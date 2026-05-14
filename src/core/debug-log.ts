import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { EXIT_CODES, OpenPError } from './errors.js';

export interface DebugLogEntry {
  readonly event: string;
  readonly [key: string]: unknown;
}

export async function appendDebugLog(path: string | null, entry: DebugLogEntry): Promise<void> {
  if (path === null) {
    return;
  }

  const line = `${JSON.stringify({
    timestamp: new Date().toISOString(),
    ...entry,
  })}\n`;

  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, line, { flag: 'a', mode: 0o600 });
    await chmod(path, 0o600).catch(() => undefined);
  } catch {
    throw new OpenPError(`failed to write debug log: ${path}`, EXIT_CODES.sessionState);
  }
}
