import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { EXIT_CODES, OpenPError } from './errors.js';
import { resolveOpenPStateRoot } from './state-root.js';
import { getOpenPVersionInfo } from './version.js';

export interface DebugLogEntry {
  readonly event: string;
  readonly [key: string]: unknown;
}

export function resolveDefaultDebugLogPath(projectRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveOpenPStateRoot(projectRoot, env), 'logs', 'debug.jsonl');
}

export async function appendDebugLog(path: string | null, entry: DebugLogEntry): Promise<void> {
  if (path === null) {
    return;
  }

  const versionInfo = getOpenPVersionInfo();
  const line = `${JSON.stringify({
    timestamp: new Date().toISOString(),
    openpVersion: versionInfo.version,
    ...(versionInfo.gitCommit ? { openpGitCommit: versionInfo.gitCommit } : {}),
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
