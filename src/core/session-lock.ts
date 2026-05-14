import { randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { EXIT_CODES, OpenPError } from './errors.js';
import { resolveOpenPStateRoot } from './state-root.js';

export interface SessionLock {
  readonly sessionId: string;
  readonly path: string;
  release(): Promise<void>;
}

interface LockFile {
  readonly token: string;
  readonly sessionId: string;
  readonly pid: number;
  readonly createdAt: string;
}

export class SessionLockStore {
  private readonly stateRoot: string;

  constructor(projectRoot: string, stateRoot: string = resolveOpenPStateRoot(projectRoot)) {
    this.stateRoot = stateRoot;
  }

  pathForSession(sessionId: string): string {
    assertValidSessionId(sessionId);
    return join(this.stateRoot, 'locks', `${sessionId}.lock`);
  }

  async acquire(sessionId: string): Promise<SessionLock> {
    const path = this.pathForSession(sessionId);
    await mkdir(join(this.stateRoot, 'locks'), { recursive: true, mode: 0o700 });

    const lockFile: LockFile = {
      token: randomUUID(),
      sessionId,
      pid: process.pid,
      createdAt: new Date().toISOString(),
    };

    const acquired = await tryWriteSessionLock(path, lockFile);
    if (!acquired) {
      const recovered = await recoverStaleSessionLock(path);
      if (!recovered || !(await tryWriteSessionLock(path, lockFile))) {
        throw new OpenPError(`session ${sessionId} is busy`, EXIT_CODES.sessionBusy);
      }
    }

    return {
      sessionId,
      path,
      release: async () => {
        await releaseSessionLock(path, lockFile.token);
      },
    };
  }
}

async function tryWriteSessionLock(path: string, lockFile: LockFile): Promise<boolean> {
  try {
    await writeFile(path, `${JSON.stringify(lockFile, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await chmod(path, 0o600).catch(() => undefined);
    return true;
  } catch (error) {
    if (isErrorCode(error, 'EEXIST')) {
      return false;
    }
    throw new OpenPError(`failed to acquire session lock: ${path}`, EXIT_CODES.sessionState);
  }
}

async function recoverStaleSessionLock(path: string): Promise<boolean> {
  let existing: unknown;
  try {
    existing = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) {
      return true;
    }
    throw new OpenPError(`failed to read session lock: ${path}`, EXIT_CODES.sessionState);
  }

  if (!isLockFile(existing)) {
    throw new OpenPError(`invalid session lock: ${path}`, EXIT_CODES.sessionState);
  }
  if (isProcessAlive(existing.pid)) {
    return false;
  }

  try {
    await unlink(path);
    return true;
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) {
      return true;
    }
    throw new OpenPError(`failed to recover stale session lock: ${path}`, EXIT_CODES.sessionState);
  }
}

async function releaseSessionLock(path: string, token: string): Promise<void> {
  let existing: unknown;
  try {
    existing = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) {
      return;
    }
    throw new OpenPError(`failed to read session lock: ${path}`, EXIT_CODES.sessionState);
  }

  if (!isLockFile(existing) || existing.token !== token) {
    return;
  }

  try {
    await unlink(path);
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) {
      return;
    }
    throw new OpenPError(`failed to release session lock: ${path}`, EXIT_CODES.sessionState);
  }
}

function isLockFile(value: unknown): value is LockFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.token === 'string' &&
    typeof candidate.sessionId === 'string' &&
    typeof candidate.pid === 'number' &&
    typeof candidate.createdAt === 'string'
  );
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    // Signal 0 checks process existence without sending a terminating signal.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isErrorCode(error, 'ESRCH')) {
      return false;
    }
    if (isErrorCode(error, 'EPERM')) {
      return true;
    }
    return true;
  }
}

function assertValidSessionId(sessionId: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId)) {
    throw new OpenPError(`invalid session id for lock path: ${sessionId}`, EXIT_CODES.sessionState);
  }
}
