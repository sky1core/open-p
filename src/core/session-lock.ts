import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, readdir, rename, rmdir, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { EXIT_CODES, OpenPError } from './errors.js';
import { ensureDurableDirectory, syncDirectory } from './fs-durability.js';
import { isSafeSessionId } from './session-id.js';
import { resolveOpenPStateRoot } from './state-root.js';

const GATE_SENTINEL_NAME = 'gate-v2';
const GATE_SENTINEL_CONTENT = 'open-p permanent session lock gate v2\n';
const ACTIVE_DIR_NAME = 'active';
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const PROCESS_START_RE = /^utc:(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ( [1-9]|[12]\d|3[01]) ([01]\d|2[0-3]):([0-5]\d):([0-5]\d) (\d{4})$/;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

export interface SessionLock {
  readonly sessionId: string;
  /** Path to this owner's token file inside the permanent gate's active claim. */
  readonly path: string;
  release(): Promise<void>;
}

interface LockFile {
  readonly token: string;
  readonly sessionId: string;
  readonly pid: number;
  readonly createdAt: string;
  readonly processIdentityVersion?: 1;
  readonly processStartedAt?: string | null;
}

export class SessionLockStore {
  private readonly stateRoot: string;

  constructor(projectRoot: string, stateRoot: string = resolveOpenPStateRoot(projectRoot)) {
    this.stateRoot = stateRoot;
  }

  /** Permanent canonical gate. It remains non-empty after the active claim is released. */
  pathForSession(sessionId: string): string {
    assertValidSessionId(sessionId);
    return join(this.stateRoot, 'locks', `${sessionId}.lock`);
  }

  async acquire(sessionId: string): Promise<SessionLock> {
    const gateDir = this.pathForSession(sessionId);
    const locksDir = dirname(gateDir);
    await ensureDurableDirectory(locksDir);

    const lockFile: LockFile = {
      token: randomUUID(),
      sessionId,
      pid: process.pid,
      createdAt: new Date().toISOString(),
      processIdentityVersion: 1,
      processStartedAt: await readProcessStartIdentity(process.pid),
    };

    // Inspect before the first publication. On macOS, rename(non-empty-directory,
    // existing-empty-directory) can replace the existing directory, so publishing first would
    // silently bypass the ownership and mode checks for an observed legacy gate.
    let canonicalKind = await inspectCanonicalLock(gateDir);
    let ownerPath: string | null = null;
    if (canonicalKind === 'missing') {
      // First publication is one atomic directory rename. The temporary gate already contains both
      // the sentinel and the non-empty active claim, and every entry is synced before it becomes
      // canonical. A delayed old-version file create or temp-directory rename can no longer acquire
      // the canonical path after this point because the sentinel is never removed.
      ownerPath = await tryInitializePermanentGate(gateDir, lockFile);
      if (!ownerPath) {
        canonicalKind = await inspectCanonicalLock(gateDir);
      }
    }

    if (!ownerPath && canonicalKind === 'legacy-directory') {
      const recoveredLegacy = await recoverLegacyDirectoryClaim(gateDir, sessionId);
      if (!recoveredLegacy) {
        throw new OpenPError(`session ${sessionId} is busy`, EXIT_CODES.sessionBusy);
      }
      ownerPath = await tryInitializePermanentGate(gateDir, lockFile);
      if (!ownerPath) {
        canonicalKind = await inspectCanonicalLock(gateDir);
      }
    }

    if (!ownerPath) {
      if (canonicalKind !== 'permanent') {
        throw new OpenPError(`session ${sessionId} is busy`, EXIT_CODES.sessionBusy);
      }
      // Inspect/recover before publication so an existing symlink or non-private active path is
      // rejected rather than replaced by rename. Publication remains an atomic competition.
      const recovered = await recoverStaleActiveClaim(gateDir, sessionId);
      if (!recovered) {
        throw new OpenPError(`session ${sessionId} is busy`, EXIT_CODES.sessionBusy);
      }
      ownerPath = await tryPublishActiveClaim(gateDir, lockFile);
    }
    if (!ownerPath || !(await verifySessionLockOwnership(ownerPath, lockFile.token, sessionId))) {
      throw new OpenPError(`session ${sessionId} is busy`, EXIT_CODES.sessionBusy);
    }

    return {
      sessionId,
      path: ownerPath,
      release: async () => {
        await releaseSessionLock(gateDir, ownerPath!, lockFile.token, sessionId);
      },
    };
  }
}

async function tryInitializePermanentGate(gateDir: string, lockFile: LockFile): Promise<string | null> {
  const locksDir = dirname(gateDir);
  const tempGateDir = join(locksDir, `.${lockFile.sessionId}.${lockFile.token}.gate.tmp`);
  const tempActiveDir = join(tempGateDir, ACTIVE_DIR_NAME);
  const ownerName = ownerFileName(lockFile.token);
  const tempOwnerPath = join(tempActiveDir, ownerName);
  const tempSentinelPath = join(tempGateDir, GATE_SENTINEL_NAME);
  let published = false;
  try {
    await mkdir(tempGateDir, { mode: 0o700 });
    await chmod(tempGateDir, 0o700);
    await writeDurableFile(tempSentinelPath, GATE_SENTINEL_CONTENT);
    await mkdir(tempActiveDir, { mode: 0o700 });
    await chmod(tempActiveDir, 0o700);
    await writeDurableFile(tempOwnerPath, serializeLockFile(lockFile));

    // Both files are durable before the containing directories. Only then may the complete,
    // non-empty gate become canonical. Syncing locksDir persists the canonical rename itself.
    await syncDirectory(tempActiveDir);
    await syncDirectory(tempGateDir);
    await rename(tempGateDir, gateDir);
    published = true;
    await syncDirectory(locksDir);
    return join(gateDir, ACTIVE_DIR_NAME, ownerName);
  } catch (error) {
    if (published) {
      await cleanupPublishedActiveClaim(
        join(gateDir, ACTIVE_DIR_NAME),
        join(gateDir, ACTIVE_DIR_NAME, ownerName),
        gateDir,
      ).catch(() => undefined);
    } else {
      await cleanupInitialGateCandidate(tempGateDir, tempActiveDir, tempOwnerPath, tempSentinelPath);
    }
    if (isLockClaimCollision(error)) {
      return null;
    }
    throw new OpenPError(`failed to acquire session lock: ${gateDir}`, EXIT_CODES.sessionState);
  }
}

async function tryPublishActiveClaim(gateDir: string, lockFile: LockFile): Promise<string | null> {
  const locksDir = dirname(gateDir);
  const tempActiveDir = join(locksDir, `.${lockFile.sessionId}.${lockFile.token}.active.tmp`);
  const activeDir = join(gateDir, ACTIVE_DIR_NAME);
  const ownerName = ownerFileName(lockFile.token);
  const tempOwnerPath = join(tempActiveDir, ownerName);
  let published = false;
  try {
    await mkdir(tempActiveDir, { mode: 0o700 });
    await chmod(tempActiveDir, 0o700);
    await writeDurableFile(tempOwnerPath, serializeLockFile(lockFile));
    await syncDirectory(tempActiveDir);
    await rename(tempActiveDir, activeDir);
    published = true;
    await syncDirectory(gateDir);
    return join(activeDir, ownerName);
  } catch (error) {
    if (published) {
      await cleanupPublishedActiveClaim(activeDir, join(activeDir, ownerName), gateDir).catch(() => undefined);
    } else {
      await cleanupActiveClaimCandidate(tempActiveDir, tempOwnerPath);
    }
    if (isLockClaimCollision(error)) {
      return null;
    }
    throw new OpenPError(`failed to acquire session lock: ${gateDir}`, EXIT_CODES.sessionState);
  }
}

type CanonicalLockKind = 'missing' | 'legacy-file' | 'legacy-directory' | 'permanent';

async function inspectCanonicalLock(gateDir: string): Promise<CanonicalLockKind> {
  let gateStats;
  try {
    gateStats = await lstat(gateDir);
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) {
      return 'missing';
    }
    throw new OpenPError(`failed to read session lock: ${gateDir}`, EXIT_CODES.sessionState);
  }
  if (gateStats.isFile()) {
    // A legacy file owner is never removed or converted automatically. That would reopen the
    // compare-and-delete race with a delayed legacy process, so mixed versions fail closed.
    return 'legacy-file';
  }
  if (!gateStats.isDirectory()) {
    throw new OpenPError(`invalid session lock: ${gateDir}`, EXIT_CODES.sessionState);
  }

  const sentinelPath = join(gateDir, GATE_SENTINEL_NAME);
  let sentinelStats;
  try {
    sentinelStats = await lstat(sentinelPath);
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) {
      // HEAD's directory protocol can be recovered safely by comparing the token filename before
      // unlinking. It is migrated only after the legacy claim is proven stale or empty.
      return 'legacy-directory';
    }
    throw new OpenPError(`failed to read session lock: ${gateDir}`, EXIT_CODES.sessionState);
  }
  if (!sentinelStats.isFile()) {
    throw new OpenPError(`invalid session lock gate: ${gateDir}`, EXIT_CODES.sessionState);
  }
  if ((gateStats.mode & 0o777) !== 0o700 || (sentinelStats.mode & 0o777) !== 0o600 ||
    !ownedByCurrentUser(gateStats.uid) || !ownedByCurrentUser(sentinelStats.uid)) {
    throw new OpenPError(`invalid session lock gate: ${gateDir}`, EXIT_CODES.sessionState);
  }
  try {
    if (await readFile(sentinelPath, 'utf8') !== GATE_SENTINEL_CONTENT) {
      throw new OpenPError(`invalid session lock gate: ${gateDir}`, EXIT_CODES.sessionState);
    }
    const entries = await readdir(gateDir);
    if (entries.some((entry) => entry !== GATE_SENTINEL_NAME && entry !== ACTIVE_DIR_NAME)) {
      throw new OpenPError(`invalid session lock gate: ${gateDir}`, EXIT_CODES.sessionState);
    }
  } catch (error) {
    if (error instanceof OpenPError) {
      throw error;
    }
    throw new OpenPError(`failed to read session lock: ${gateDir}`, EXIT_CODES.sessionState);
  }
  return 'permanent';
}

async function isPermanentGate(gateDir: string): Promise<boolean> {
  return (await inspectCanonicalLock(gateDir)) === 'permanent';
}

async function recoverLegacyDirectoryClaim(gateDir: string, sessionId: string): Promise<boolean> {
  return recoverClaimDirectory(gateDir, dirname(gateDir), sessionId);
}

async function recoverStaleActiveClaim(gateDir: string, sessionId: string): Promise<boolean> {
  if (!(await isPermanentGate(gateDir))) {
    return false;
  }
  return recoverClaimDirectory(join(gateDir, ACTIVE_DIR_NAME), gateDir, sessionId);
}

async function recoverClaimDirectory(claimDir: string, parentDir: string, sessionId: string): Promise<boolean> {
  if (!(await isPrivateDirectory(claimDir))) {
    return true;
  }
  let ownerNames: string[];
  try {
    ownerNames = await readdir(claimDir);
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) {
      return true;
    }
    throw new OpenPError(`failed to read session lock: ${claimDir}`, EXIT_CODES.sessionState);
  }

  if (ownerNames.length === 0) {
    return removeEmptyClaimDirectory(claimDir, parentDir);
  }
  if (ownerNames.length !== 1 || !ownerNames[0]!.endsWith('.json')) {
    throw new OpenPError(`invalid session lock: ${claimDir}`, EXIT_CODES.sessionState);
  }

  const ownerName = ownerNames[0]!;
  const ownerPath = join(claimDir, ownerName);
  let existing: LockFile;
  try {
    existing = await readLockFile(ownerPath);
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) {
      return removeEmptyClaimDirectory(claimDir, parentDir);
    }
    throw error;
  }
  if (ownerName !== ownerFileName(existing.token) || existing.sessionId !== sessionId) {
    throw new OpenPError(`invalid session lock: ${claimDir}`, EXIT_CODES.sessionState);
  }
  if (!(await isStaleLock(existing))) {
    return false;
  }

  try {
    // The token is part of the filename. If a concurrent recoverer has already removed this stale
    // claim and another process has published a new active directory, this path is absent rather
    // than pointing at the new owner's differently named file.
    await unlink(ownerPath);
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) {
      return false;
    }
    throw new OpenPError(`failed to recover stale session lock: ${claimDir}`, EXIT_CODES.sessionState);
  }
  await syncDirectoryIfPresent(claimDir);
  return removeEmptyClaimDirectory(claimDir, parentDir);
}

async function removeEmptyClaimDirectory(claimDir: string, parentDir: string): Promise<boolean> {
  try {
    await rmdir(claimDir);
    await syncDirectory(parentDir);
    return true;
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) {
      try {
        // This is also the retry after rmdir succeeded but the parent fsync failed. The permanent
        // gate must not consider the active claim released until that absence is durable.
        await syncDirectory(parentDir);
        return true;
      } catch {
        throw new OpenPError(`failed to recover stale session lock: ${claimDir}`, EXIT_CODES.sessionState);
      }
    }
    if (isErrorCode(error, 'ENOTEMPTY') || isErrorCode(error, 'EEXIST')) {
      return false;
    }
    throw new OpenPError(`failed to recover stale session lock: ${claimDir}`, EXIT_CODES.sessionState);
  }
}

async function verifySessionLockOwnership(ownerPath: string, token: string, sessionId: string): Promise<boolean> {
  try {
    const current = await readLockFile(ownerPath);
    return current.token === token && current.sessionId === sessionId;
  } catch {
    return false;
  }
}

async function releaseSessionLock(
  gateDir: string,
  ownerPath: string,
  token: string,
  sessionId: string,
): Promise<void> {
  if (!(await isPermanentGate(gateDir))) {
    throw new OpenPError(`failed to read session lock: ${gateDir}`, EXIT_CODES.sessionState);
  }
  const activeDir = join(gateDir, ACTIVE_DIR_NAME);
  if (!(await isPrivateDirectory(activeDir))) {
    throw new OpenPError(`failed to read session lock: ${activeDir}`, EXIT_CODES.sessionState);
  }
  let existing: LockFile;
  try {
    existing = await readLockFile(ownerPath);
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) {
      await removeEmptyClaimDirectory(activeDir, gateDir);
      return;
    }
    throw error;
  }
  if (existing.token !== token || existing.sessionId !== sessionId) {
    return;
  }

  try {
    await unlink(ownerPath);
  } catch (error) {
    if (!isErrorCode(error, 'ENOENT')) {
      throw new OpenPError(`failed to release session lock: ${gateDir}`, EXIT_CODES.sessionState);
    }
  }
  await syncDirectoryIfPresent(activeDir);
  await removeEmptyClaimDirectory(activeDir, gateDir);
}

async function writeDurableFile(path: string, content: string): Promise<void> {
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.chmod(0o600);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function cleanupInitialGateCandidate(
  tempGateDir: string,
  tempActiveDir: string,
  tempOwnerPath: string,
  tempSentinelPath: string,
): Promise<void> {
  await unlink(tempOwnerPath).catch(() => undefined);
  await rmdir(tempActiveDir).catch(() => undefined);
  await unlink(tempSentinelPath).catch(() => undefined);
  await rmdir(tempGateDir).catch(() => undefined);
}

async function cleanupActiveClaimCandidate(tempActiveDir: string, tempOwnerPath: string): Promise<void> {
  await unlink(tempOwnerPath).catch(() => undefined);
  await rmdir(tempActiveDir).catch(() => undefined);
}

async function cleanupPublishedActiveClaim(
  activeDir: string,
  ownerPath: string,
  gateDir: string,
): Promise<void> {
  await unlink(ownerPath).catch(() => undefined);
  await syncDirectoryIfPresent(activeDir).catch(() => undefined);
  await rmdir(activeDir).catch(() => undefined);
  await syncDirectory(gateDir).catch(() => undefined);
}

async function syncDirectoryIfPresent(path: string): Promise<void> {
  try {
    await syncDirectory(path);
  } catch (error) {
    if (!isErrorCode(error, 'ENOENT')) {
      throw error;
    }
  }
}

async function isPrivateDirectory(path: string): Promise<boolean> {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) {
      return false;
    }
    throw new OpenPError(`failed to read session lock: ${path}`, EXIT_CODES.sessionState);
  }
  if (!stats.isDirectory() || (stats.mode & 0o777) !== 0o700 || !ownedByCurrentUser(stats.uid)) {
    throw new OpenPError(`invalid session lock: ${path}`, EXIT_CODES.sessionState);
  }
  return true;
}

function serializeLockFile(lockFile: LockFile): string {
  return `${JSON.stringify(lockFile, null, 2)}\n`;
}

function isLockClaimCollision(error: unknown): boolean {
  return (
    isErrorCode(error, 'EEXIST') ||
    isErrorCode(error, 'ENOTEMPTY') ||
    isErrorCode(error, 'ENOTDIR') ||
    isErrorCode(error, 'EISDIR')
  );
}

async function readLockFile(path: string): Promise<LockFile> {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) {
      throw error;
    }
    throw new OpenPError(`failed to read session lock: ${path}`, EXIT_CODES.sessionState);
  }
  if (!stats.isFile() || (stats.mode & 0o777) !== 0o600 || !ownedByCurrentUser(stats.uid)) {
    throw new OpenPError(`invalid session lock: ${path}`, EXIT_CODES.sessionState);
  }
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
  const versioned = candidate.processIdentityVersion === 1;
  const allowedKeys = versioned
    ? ['token', 'sessionId', 'pid', 'createdAt', 'processIdentityVersion', 'processStartedAt']
    : ['token', 'sessionId', 'pid', 'createdAt', 'processStartedAt'];
  if (!hasExactKeys(candidate, allowedKeys, versioned
    ? ['token', 'sessionId', 'pid', 'createdAt', 'processIdentityVersion', 'processStartedAt']
    : ['token', 'sessionId', 'pid', 'createdAt'])) {
    return false;
  }
  if (typeof candidate.token !== 'string' || !UUID_V4_RE.test(candidate.token) ||
    typeof candidate.sessionId !== 'string' || !isSafeSessionId(candidate.sessionId) ||
    !Number.isSafeInteger(candidate.pid) || (candidate.pid as number) <= 0 ||
    typeof candidate.createdAt !== 'string') {
    return false;
  }
  const createdAtMs = canonicalIsoInstantMs(candidate.createdAt);
  if (createdAtMs === null || createdAtMs > Date.now()) {
    return false;
  }
  if (versioned) {
    if (candidate.processStartedAt === null) {
      return true;
    }
    const processStartedAtMs = canonicalProcessStartInstantMs(candidate.processStartedAt);
    return processStartedAtMs !== null && processStartedAtMs <= createdAtMs;
  }
  return candidate.processStartedAt === undefined ||
    candidate.processStartedAt === null ||
    typeof candidate.processStartedAt === 'string' &&
      candidate.processStartedAt.length > 0 &&
      Buffer.byteLength(candidate.processStartedAt, 'utf8') <= 256;
}

function hasExactKeys(
  candidate: Record<string, unknown>,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[],
): boolean {
  const keys = Object.keys(candidate);
  return keys.every((key) => allowedKeys.includes(key)) &&
    requiredKeys.every((key) => Object.prototype.hasOwnProperty.call(candidate, key));
}

function canonicalIsoInstantMs(value: string): number | null {
  if (!ISO_INSTANT_RE.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value ? time : null;
}

function canonicalProcessStartInstantMs(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = value.match(PROCESS_START_RE);
  if (!match) return null;
  const weekday = match[1]!;
  const month = MONTHS.indexOf(match[2] as typeof MONTHS[number]);
  const day = Number(match[3]!.trim());
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const year = Number(match[7]);
  if (month < 0 || year < 1970 || year > 9999) return null;
  const instant = new Date(Date.UTC(year, month, day, hour, minute, second));
  return instant.getUTCFullYear() === year &&
    instant.getUTCMonth() === month &&
    instant.getUTCDate() === day &&
    instant.getUTCHours() === hour &&
    instant.getUTCMinutes() === minute &&
    instant.getUTCSeconds() === second &&
    WEEKDAYS[instant.getUTCDay()] === weekday
    ? instant.getTime()
    : null;
}

function isReusedProcessIdentity(lock: LockFile, currentProcessStartedAt: string | null): boolean {
  // Pre-version identities were rendered in the observing process's timezone/locale. Comparing
  // those strings can classify the same live process as a reused PID, so mixed-version claims stay
  // fail-closed busy until their PID exits. Only the canonical v1 form can prove PID reuse.
  if (lock.processIdentityVersion !== 1 || currentProcessStartedAt === null) {
    return false;
  }
  if (typeof lock.processStartedAt === 'string' && lock.processStartedAt.length > 0) {
    return lock.processStartedAt !== currentProcessStartedAt;
  }
  return false;
}

function readProcessStartIdentity(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    // The executable is absolute as well as its locale/timezone being fixed. PATH is caller-owned
    // and a different `ps` implementation or wrapper must not turn one live PID into a mismatch.
    // Platforms without /bin/ps safely return null; a live claim with no comparable identity stays
    // busy rather than being recovered by guesswork.
    execFile('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 1000,
      env: { ...process.env, TZ: 'UTC', LANG: 'C', LC_ALL: 'C' },
    }, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      const value = stdout.trim();
      const identity = value ? `utc:${value}` : null;
      resolve(identity !== null && canonicalProcessStartInstantMs(identity) !== null ? identity : null);
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

function ownedByCurrentUser(uid: number): boolean {
  return typeof process.getuid !== 'function' || uid === process.getuid();
}

function assertValidSessionId(sessionId: string): void {
  if (!isSafeSessionId(sessionId)) {
    throw new OpenPError(`invalid session id for lock path: ${sessionId}`, EXIT_CODES.sessionState);
  }
}
