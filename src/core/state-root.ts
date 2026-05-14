import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export function resolveOpenPStateRoot(projectRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = normalizeEnvPath(env.OPENP_STATE_DIR);
  const workspaceKey = workspaceStateKey(projectRoot);

  if (override) {
    return join(override, 'workspaces', workspaceKey);
  }

  const xdgStateHome = normalizeEnvPath(env.XDG_STATE_HOME);
  const base = xdgStateHome || join(homedir(), '.local', 'state');
  return join(base, 'open-p', 'workspaces', workspaceKey);
}

function normalizeEnvPath(value: string | undefined): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) {
    return null;
  }
  if (trimmed === '~') {
    return homedir();
  }
  if (trimmed.startsWith('~/')) {
    return join(homedir(), trimmed.slice(2));
  }
  return isAbsolute(trimmed) ? trimmed : resolve(trimmed);
}

function workspaceStateKey(projectRoot: string): string {
  const normalizedRoot = resolveWorkspacePath(projectRoot);
  return createHash('sha256').update(normalizedRoot).digest('hex').slice(0, 32);
}

function resolveWorkspacePath(projectRoot: string): string {
  try {
    return realpathSync.native(projectRoot);
  } catch {
    return resolve(projectRoot);
  }
}
