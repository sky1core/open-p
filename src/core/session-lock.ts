import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readdir, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EXIT_CODES, OpenPError } from './errors.js';
import { isSafeSessionId } from './session-id.js';
import { resolveOpenPStateRoot } from './state-root.js';

export interface SessionLock {
  readonly sessionId: string;
  /** Path to this owner's token file inside the canonical lock directory. */
  readonly path: string;
  release(): Promise<void>;
}

interface LockFile {
  readonly token: string;
  readonly sessionId: string;
  readonly pid: number;
  readonly createdAt: string;
  readonly processStartedAt?: string | null;
}

export class SessionLockStore {
  private readonly stateRoot: string;

  constructor(projectRoot: string, stateRoot: string = resolveOpenPStateRoot(projectRoot)) {
    this.stateRoot = stateRoot;
  }

  /** Canonical lock directory. Older open-p versions may have left a file at this path. */
  pathForSession(sessionId: string): string {
    assertValidSessionId(sessionId);
    return join(this.stateRoot, 'locks', `${sessionId}.lock`);
  }

  async acquire(sessionId: string): Promise<SessionLock> {
    const lockDir = this.pathForSession(sessionId);
    await mkdir(join(this.stateRoot, 'locks'), { recursive: true, mode: 0o700 });

    const lockFile: LockFile = {
      token: randomUUID(),
      sessionId,
      pid: process.pid,
      createdAt: new Date().toISOString(),
      processStartedAt: await readProcessStartIdentity(process.pid),
    };

    let ownerPath = await tryCreateLockDirectory(lockDir, lockFile);
    if (!ownerPath) {
      const recovered = await recoverStaleSessionLock(lockDir);
      if (!recovered) {
        throw new OpenPError(`session ${sessionId} is busy`, EXIT_CODES.sessionBusy);
      }
      ownerPath = await tryCreateLockDirectory(lockDir, lockFile);
      if (!ownerPath || !(await verifySessionLockOwnership(ownerPath, lockFile.token))) {
        throw new OpenPError(`session ${sessionId} is busy`, EXIT_CODES.sessionBusy);
      }
    }

    return {
      sessionId,
      path: ownerPath,
      release: async () => {
        await releaseSessionLock(lockDir, ownerPath!, lockFile.token);
      },
    };
  }
}

async function tryCreateLockDirectory(lockDir: string, lockFile: LockFile): Promise<string | null> {
  const parentDir = join(lockDir, '..');
  const tempDir = join(parentDir, `.${lockFile.sessionId}.${lockFile.token}.lock.tmp`);
  const ownerName = ownerFileName(lockFile.token);
  const tempOwnerPath = join(tempDir, ownerName);
  try {
    await mkdir(tempDir, { mode: 0o700 });
    await writeFile(tempOwnerPath, `${JSON.stringify(lockFile, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await chmod(tempOwnerPath, 0o600).catch(() => undefined);
    await rename(tempDir, lockDir);
    return join(lockDir, ownerName);
  } catch (error) {
    await unlink(tempOwnerPath).catch(() => undefined);
    await rmdir(tempDir).catch(() => undefined);
    if (
      isErrorCode(error, 'EEXIST') ||
      isErrorCode(error, 'ENOTEMPTY') ||
      isErrorCode(error, 'ENOTDIR') ||
      isErrorCode(error, 'EISDIR')
    ) {
      return null;
    }
    throw new OpenPError(`failed to acquire session lock: ${lockDir}`, EXIT_CODES.sessionState);
  }
}

async function recoverStaleSessionLock(lockPath: string): Promise<boolean> {
  let stats;
  try {
    stats = await lstat(lockPath);
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) {
      return true;
    }
    throw new OpenPError(`failed to read session lock: ${lockPath}`, EXIT_CODES.sessionState);
  }

  if (stats.isFile()) {
    return recoverLegacyFileLock(lockPath);
  }
  if (!stats.isDirectory()) {
    throw new OpenPError(`invalid session lock: ${lockPath}`, EXIT_CODES.sessionState);
  }
  return recoverDirectoryLock(lockPath);
}

async function recoverLegacyFileLock(lockPath: string): Promise<boolean> {
  let existing: LockFile;
  try {
    existing = await readLockFile(lockPath);
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) {
      return true;
    }
    throw error;
  }
  if (!(await isStaleLock(existing))) {
    return false;
  }
  try {
    // New lock owners use a directory. A delayed legacy recoverer therefore cannot unlink a
    // replacement owner after another process has completed the file-to-directory transition.
    await unlink(lockPath);
    return true;
  } catch (error) {
    if (isErrorCode(error, 'ENOENT') || isErrorCode(error, 'EISDIR') || isErrorCode(error, 'EPERM')) {
      return false;
    }
    throw new OpenPError(`failed to recover stale session lock: ${lockPath}`, EXIT_CODES.sessionState);
  }
}

async function recoverDirectoryLock(lockDir: string): Promise<boolean> {
  let ownerNames: string[];
  try {
    ownerNames = (await readdir(lockDir)).filter((name) => name.endsWith('.json'));
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) {
      return true;
    }
    throw new OpenPError(`failed to read session lock: ${lockDir}`, EXIT_CODES.sessionState);
  }

  if (ownerNames.length === 0) {
    return removeEmptyLockDirectory(lockDir);
  }
  if (ownerNames.length !== 1) {
    throw new OpenPError(`invalid session lock: ${lockDir}`, EXIT_CODES.sessionState);
  }

  const ownerName = ownerNames[0]!;
  const ownerPath = join(lockDir, ownerName);
  let existing: LockFile;
  try {
    existing = await readLockFile(ownerPath);
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) {
      return true;
    }
    throw error;
  }
  if (ownerName !== ownerFileName(existing.token)) {
    throw new OpenPError(`invalid session lock: ${lockDir}`, EXIT_CODES.sessionState);
  }
  if (!(await isStaleLock(existing))) {
    return false;
  }

  try {
    // The token is part of the filename. If another recoverer has already replaced the lock
    // directory, this unlink cannot remove the new owner's differently named token file.
    await unlink(ownerPath);
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) {
      return false;
    }
    throw new OpenPError(`failed to recover stale session lock: ${lockDir}`, EXIT_CODES.sessionState);
  }
  return removeEmptyLockDirectory(lockDir);
}

async function removeEmptyLockDirectory(lockDir: string): Promise<boolean> {
  try {
    await rmdir(lockDir);
    return true;
  } catch (error) {
    if (isErrorCode(error, 'ENOENT') || isErrorCode(error, 'ENOTEMPTY') || isErrorCode(error, 'EEXIST')) {
      return false;
    }
    throw new OpenPError(`failed to recover stale session lock: ${lockDir}`, EXIT_CODES.sessionState);
  }
}

async function verifySessionLockOwnership(ownerPath: string, token: string): Promise<boolean> {
  try {
    const current = await readLockFile(ownerPath);
    return current.token === token;
  } catch {
    return false;
  }
}

async function releaseSessionLock(lockDir: string, ownerPath: string, token: string): Promise<void> {
  let existing: LockFile;
  try {
    existing = await readLockFile(ownerPath);
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) {
      try {
        await lstat(lockDir);
      } catch (statError) {
        if (isErrorCode(statError, 'ENOENT')) {
          return;
        }
      }
      throw new OpenPError(`failed to read session lock: ${lockDir}`, EXIT_CODES.sessionState);
    }
    throw error;
  }
  if (existing.token !== token) {
    return;
  }

  try {
    await unlink(ownerPath);
  } catch (error) {
    if (!isErrorCode(error, 'ENOENT')) {
      throw new OpenPError(`failed to release session lock: ${lockDir}`, EXIT_CODES.sessionState);
    }
  }
  try {
    await rmdir(lockDir);
  } catch (error) {
    if (isErrorCode(error, 'ENOENT') || isErrorCode(error, 'ENOTEMPTY') || isErrorCode(error, 'EEXIST')) {
      return;
    }
    throw new OpenPError(`failed to release session lock: ${lockDir}`, EXIT_CODES.sessionState);
  }
}

async function readLockFile(path: string): Promise<LockFile> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) {
      throw error;
    }
    throw new OpenPError(`failed to read session lock: ${path}`, EXIT_CODES.sessionState);
  }
  if (!isLockFile(value)) {
    throw new OpenPError(`invalid session lock: ${path}`, EXIT_CODES.sessionState);
  }
  return value;
}

async function isStaleLock(lock: LockFile): Promise<boolean> {
  if (!isProcessAlive(lock.pid)) {
    return true;
  }
  const currentProcessStartedAt = await readProcessStartIdentity(lock.pid);
  return isReusedProcessIdentity(lock, currentProcessStartedAt);
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
    typeof candidate.createdAt === 'string' &&
    (candidate.processStartedAt === undefined ||
      candidate.processStartedAt === null ||
      typeof candidate.processStartedAt === 'string')
  );
}

function isReusedProcessIdentity(lock: LockFile, currentProcessStartedAt: string | null): boolean {
  if (currentProcessStartedAt === null) {
    return false;
  }
  if (typeof lock.processStartedAt === 'string' && lock.processStartedAt.length > 0) {
    return lock.processStartedAt !== currentProcessStartedAt;
  }
  const lockCreatedAtMs = Date.parse(lock.createdAt);
  const processStartedAtMs = Date.parse(currentProcessStartedAt);
  return Number.isFinite(lockCreatedAtMs) &&
    Number.isFinite(processStartedAtMs) &&
    processStartedAtMs > lockCreatedAtMs;
}

function readProcessStartIdentity(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 1000 }, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      const value = stdout.trim();
      resolve(value || null);
    });
  });
}

function ownerFileName(token: string): string {
  return `${token}.json`;
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isErrorCode(error, 'ESRCH')) {
      return false;
    }
    return true;
  }
}

function assertValidSessionId(sessionId: string): void {
  if (!isSafeSessionId(sessionId)) {
    throw new OpenPError(`invalid session id for lock path: ${sessionId}`, EXIT_CODES.sessionState);
  }
}
