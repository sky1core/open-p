import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export function resolveOpenPStateRoot(projectRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  const workspaceKey = workspaceStateKey(projectRoot);
  const xdgStateHome = normalizeEnvPath(env.XDG_STATE_HOME);
  const base = xdgStateHome || join(homedir(), '.local', 'state');
  return join(base, 'open-p', 'workspaces', workspaceKey);
}

export function createSeedOperationDomainDigest(projectRoot: string, stateRoot: string): string {
  return createHash('sha256')
    .update('openp.seed.operation-domain.v1')
    .update('\0')
    .update(resolveWorkspacePath(projectRoot))
    .update('\0')
    .update(resolve(stateRoot).normalize('NFC'))
    .digest('hex');
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
