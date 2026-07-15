import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rmdir, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SessionLockStore } from '../src/core/session-lock.js';
import { EXIT_CODES, OpenPError } from '../src/core/errors.js';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_TOKEN = '22222222-2222-4222-8222-222222222222';
const LEGACY_STALE_TOKEN = '33333333-3333-4333-8333-333333333333';

test('acquires one lock per session and releases it', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'openp-lock-'));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-lock-root-'));
  const store = new SessionLockStore(projectRoot, stateRoot);

  const first = await store.acquire(SESSION_ID);
  const mode = (await stat(first.path)).mode & 0o777;
  const raw = JSON.parse(await readFile(first.path, 'utf8'));

  assert.equal(mode, 0o600);
  assert.equal(raw.sessionId, SESSION_ID);
  assert.equal(raw.pid, process.pid);
  assert.equal(raw.processIdentityVersion, 1);
  assert.equal(raw.processStartedAt === null ||
    typeof raw.processStartedAt === 'string' &&
      /^utc:(Sun|Mon|Tue|Wed|Thu|Fri|Sat) [A-Z][a-z]{2} ( [1-9]|[12]\d|3[01]) \d{2}:\d{2}:\d{2} \d{4}$/.test(raw.processStartedAt), true);
  assert.equal(typeof raw.token, 'string');
  assert.equal(first.path.startsWith(projectRoot), false);
  await assert.rejects(
    () => stat(join(projectRoot, '.openp')),
    (error) => typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT',
  );

  await assert.rejects(
    () => store.acquire(SESSION_ID),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionBusy,
  );

  await first.release();
  const gatePath = store.pathForSession(SESSION_ID);
  const gateEntries = await readdir(gatePath);
  assert.deepEqual(gateEntries, ['gate-v2']);
  assert.equal((await lstat(gatePath)).isDirectory(), true);
  assert.equal((await lstat(join(gatePath, 'gate-v2'))).isFile(), true);
  assert.equal((await readFile(join(gatePath, 'gate-v2'), 'utf8')).length > 0, true);

  const second = await store.acquire(SESSION_ID);
  await second.release();
  assert.deepEqual(await readdir(gatePath), ['gate-v2']);
});

test('concurrent active-claim attempts publish exactly one owner inside the permanent gate', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'openp-lock-'));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-lock-root-'));
  const stores = Array.from({ length: 12 }, () => new SessionLockStore(projectRoot, stateRoot));

  const outcomes = await Promise.all(stores.map(async (store) => {
    try {
      return { lock: await store.acquire(SESSION_ID) };
    } catch (error) {
      if (error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionBusy) {
        return { busy: true as const };
      }
      throw error;
    }
  }));

  const winners = outcomes.filter((outcome) => 'lock' in outcome && outcome.lock);
  assert.equal(winners.length, 1);
  const winner = winners[0] as { lock: { path: string; release(): Promise<void> } };
  assert.equal(winner.lock.path.includes(`${SESSION_ID}.lock/active/`), true);
  await winner.lock.release();
});

test('does not release a lock with a different token', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'openp-lock-'));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-lock-root-'));
  const store = new SessionLockStore(projectRoot, stateRoot);
  const lock = await store.acquire(SESSION_ID);

  await writeFile(lock.path, JSON.stringify({
    token: OTHER_TOKEN,
    sessionId: SESSION_ID,
    pid: process.pid,
    createdAt: new Date().toISOString(),
  }));
  await lock.release();

  assert.equal((await readFile(lock.path, 'utf8')).includes(OTHER_TOKEN), true);
});

test('does not auto-remove a legacy file lock owned by a missing process', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'openp-lock-'));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-lock-root-'));
  const store = new SessionLockStore(projectRoot, stateRoot);
  const path = store.pathForSession(SESSION_ID);
  await mkdir(join(stateRoot, 'locks'), { recursive: true });
  await writeFile(path, JSON.stringify({
    token: 'stale-token',
    sessionId: SESSION_ID,
    pid: 99_999_999,
    createdAt: new Date().toISOString(),
  }));

  const bytesBefore = await readFile(path);
  const inodeBefore = (await stat(path)).ino;
  await assert.rejects(
    () => store.acquire(SESSION_ID),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionBusy,
  );
  assert.deepEqual(await readFile(path), bytesBefore);
  assert.equal((await stat(path)).ino, inodeBefore);
});

test('recovers stale and empty legacy directory claims into a permanent gate', async () => {
  for (const legacyShape of ['stale', 'empty'] as const) {
    const projectRoot = await mkdtemp(join(tmpdir(), 'openp-lock-'));
    const stateRoot = await mkdtemp(join(tmpdir(), 'openp-lock-root-'));
    const store = new SessionLockStore(projectRoot, stateRoot);
    const gatePath = store.pathForSession(SESSION_ID);
    await mkdir(join(stateRoot, 'locks'), { recursive: true });
    await mkdir(gatePath, { mode: 0o700 });
    await chmod(gatePath, 0o700);
    if (legacyShape === 'stale') {
      const legacyOwner = join(gatePath, `${LEGACY_STALE_TOKEN}.json`);
      await writeFile(legacyOwner, JSON.stringify({
        token: LEGACY_STALE_TOKEN,
        sessionId: SESSION_ID,
        pid: 99_999_999,
        createdAt: new Date().toISOString(),
      }), { flag: 'wx', mode: 0o600 });
      await chmod(legacyOwner, 0o600);
    }

    const lock = await store.acquire(SESSION_ID);
    assert.equal(lock.path.includes(`${SESSION_ID}.lock/active/`), true);
    assert.equal((await readFile(join(gatePath, 'gate-v2'), 'utf8')).length > 0, true);
    await lock.release();
  }
});

test('rejects an observed non-private empty legacy gate without replacing it', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'openp-lock-'));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-lock-root-'));
  const store = new SessionLockStore(projectRoot, stateRoot);
  const gatePath = store.pathForSession(SESSION_ID);
  await mkdir(join(stateRoot, 'locks'), { recursive: true });
  await mkdir(gatePath, { mode: 0o755 });
  await chmod(gatePath, 0o755);
  const before = await stat(gatePath);

  await assert.rejects(
    () => store.acquire(SESSION_ID),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionState,
  );

  const after = await stat(gatePath);
  assert.equal(after.ino, before.ino);
  assert.equal(after.mode & 0o777, 0o755);
  assert.deepEqual(await readdir(gatePath), []);
});

test('keeps an unversioned live-pid claim busy because its local-time identity is not comparable', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'openp-lock-'));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-lock-root-'));
  const store = new SessionLockStore(projectRoot, stateRoot);
  const liveLock = await store.acquire(SESSION_ID);
  const existing = JSON.parse(await readFile(liveLock.path, 'utf8'));
  await writeFile(liveLock.path, JSON.stringify({
    token: existing.token,
    sessionId: SESSION_ID,
    pid: process.pid,
    createdAt: '2000-01-01T00:00:00.000Z',
    processStartedAt: 'Mon Jan  1 09:00:00 2000',
  }));

  await assert.rejects(
    () => store.acquire(SESSION_ID),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionBusy,
  );
  assert.equal(JSON.parse(await readFile(liveLock.path, 'utf8')).token, existing.token);
});

test('recovers a versioned canonical claim after its pid has been reused', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'openp-lock-'));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-lock-root-'));
  const store = new SessionLockStore(projectRoot, stateRoot);
  const staleLock = await store.acquire(SESSION_ID);
  const existing = JSON.parse(await readFile(staleLock.path, 'utf8'));
  assert.equal(typeof existing.processStartedAt, 'string');
  await writeFile(staleLock.path, JSON.stringify({
    ...existing,
    processIdentityVersion: 1,
    processStartedAt: 'utc:Sat Jan  1 00:00:00 2000',
  }));

  const lock = await store.acquire(SESSION_ID);
  const raw = JSON.parse(await readFile(lock.path, 'utf8'));

  assert.notEqual(raw.token, existing.token);
  await lock.release();
});

test('keeps the same live owner busy when contenders use a different timezone', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'openp-lock-'));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-lock-root-'));
  const store = new SessionLockStore(projectRoot, stateRoot);
  const previousTimezone = process.env.TZ;
  let owner: Awaited<ReturnType<SessionLockStore['acquire']>> | null = null;
  let contenderOutcome:
    | { readonly kind: 'acquired'; readonly lock: Awaited<ReturnType<SessionLockStore['acquire']>> }
    | { readonly kind: 'rejected'; readonly error: unknown }
    | null = null;
  try {
    process.env.TZ = 'UTC';
    owner = await store.acquire(SESSION_ID);
    const ownerToken = JSON.parse(await readFile(owner.path, 'utf8')).token;

    process.env.TZ = 'Asia/Seoul';
    contenderOutcome = await new SessionLockStore(projectRoot, stateRoot).acquire(SESSION_ID).then(
      (lock) => ({ kind: 'acquired', lock }) as const,
      (error: unknown) => ({ kind: 'rejected', error }) as const,
    );
    assert.equal(contenderOutcome.kind, 'rejected');
    if (contenderOutcome.kind === 'rejected') {
      assert.equal(contenderOutcome.error instanceof OpenPError &&
        contenderOutcome.error.exitCode === EXIT_CODES.sessionBusy, true);
    }
    assert.equal(JSON.parse(await readFile(owner.path, 'utf8')).token, ownerToken);
  } finally {
    if (contenderOutcome?.kind === 'acquired') {
      await contenderOutcome.lock.release();
    }
    if (previousTimezone === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = previousTimezone;
    }
    if (owner) {
      await owner.release();
    }
  }
});

test('uses the trusted process-status executable instead of a caller PATH wrapper', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'openp-lock-'));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-lock-root-'));
  const fakeBin = await mkdtemp(join(tmpdir(), 'openp-fake-ps-'));
  const fakePs = join(fakeBin, 'ps');
  await writeFile(fakePs, '#!/bin/sh\nprintf "PATH-WRAPPER\\n"\n', { flag: 'wx', mode: 0o700 });
  await chmod(fakePs, 0o700);
  const previousPath = process.env.PATH;
  let lock: Awaited<ReturnType<SessionLockStore['acquire']>> | null = null;
  try {
    process.env.PATH = `${fakeBin}:${previousPath ?? ''}`;
    lock = await new SessionLockStore(projectRoot, stateRoot).acquire(SESSION_ID);
    const raw = JSON.parse(await readFile(lock.path, 'utf8'));
    assert.equal(raw.processIdentityVersion, 1);
    assert.equal(raw.processStartedAt === null ||
      typeof raw.processStartedAt === 'string' &&
        /^utc:(Sun|Mon|Tue|Wed|Thu|Fri|Sat) [A-Z][a-z]{2} ( [1-9]|[12]\d|3[01]) \d{2}:\d{2}:\d{2} \d{4}$/.test(raw.processStartedAt), true);
    assert.notEqual(raw.processStartedAt, 'utc:PATH-WRAPPER');
  } finally {
    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }
    if (lock) {
      await lock.release();
    }
    await unlink(fakePs);
    await rmdir(fakeBin);
  }
});

test('malformed current lock evidence fails closed without recovering a live owner', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'openp-lock-'));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-lock-root-'));
  const store = new SessionLockStore(projectRoot, stateRoot);
  const owner = await store.acquire(SESSION_ID);
  const original = JSON.parse(await readFile(owner.path, 'utf8'));
  assert.equal(typeof original.processStartedAt, 'string');

  const corruptions: readonly ((claim: Record<string, unknown>) => void)[] = [
    (claim) => { claim.processStartedAt = 'utc:'; },
    (claim) => { claim.processStartedAt = 'utc:Mon Feb 30 00:00:00 2026'; },
    (claim) => { claim.processStartedAt = 'utc:Thu Jan  1 00:00:00 2099'; },
    (claim) => { claim.pid = -process.pid; },
    (claim) => { claim.token = 'not-a-uuid'; },
    (claim) => { claim.createdAt = 'not-an-instant'; },
    (claim) => { claim.createdAt = '2099-01-01T00:00:00.000Z'; },
    (claim) => { claim.sessionId = '../outside'; },
    (claim) => { claim.unexpected = true; },
    (claim) => { delete claim.processStartedAt; },
  ];

  for (const corrupt of corruptions) {
    const candidate = structuredClone(original) as Record<string, unknown>;
    corrupt(candidate);
    await writeFile(owner.path, JSON.stringify(candidate));
    await assert.rejects(
      () => store.acquire(SESSION_ID),
      (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionState,
    );
    assert.deepEqual(JSON.parse(await readFile(owner.path, 'utf8')), candidate);
  }

  await writeFile(owner.path, JSON.stringify(original));
  await owner.release();
});

test('acquires locks for opaque session ids generated by backends', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'openp-lock-'));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-lock-root-'));
  const store = new SessionLockStore(projectRoot, stateRoot);
  const sessionId = 'agent-session_01:opaque';

  const lock = await store.acquire(sessionId);
  const raw = JSON.parse(await readFile(lock.path, 'utf8'));

  assert.equal(raw.sessionId, sessionId);
  await lock.release();
});

test('rejects invalid session ids at the lock path boundary', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'openp-lock-'));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-lock-root-'));
  const store = new SessionLockStore(projectRoot, stateRoot);

  await assert.rejects(
    () => store.acquire('../outside'),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionState,
  );
});

test('concurrent acquires over a stale canonical lock yield at most one owner', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'openp-lock-'));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-lock-root-'));

  for (let iteration = 0; iteration < 25; iteration += 1) {
    const staleLock = await new SessionLockStore(projectRoot, stateRoot).acquire(SESSION_ID);
    const stale = JSON.parse(await readFile(staleLock.path, 'utf8'));
    await writeFile(staleLock.path, JSON.stringify({
      token: stale.token,
      sessionId: SESSION_ID,
      pid: 99_999_999,
      createdAt: new Date().toISOString(),
    }));

    const stores = Array.from({ length: 6 }, () => new SessionLockStore(projectRoot, stateRoot));
    const outcomes = await Promise.all(stores.map(async (store) => {
      try {
        return { lock: await store.acquire(SESSION_ID) };
      } catch (error) {
        if (error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionBusy) {
          return { busy: true as const };
        }
        throw error;
      }
    }));

    const winners = outcomes.filter((outcome) => 'lock' in outcome && outcome.lock);
    assert.equal(winners.length <= 1, true, `iteration ${iteration}: multiple lock owners`);
    if (winners.length === 1) {
      const winner = winners[0] as { lock: { path: string; release(): Promise<void> } };
      const raw = JSON.parse(await readFile(winner.lock.path, 'utf8'));
      assert.notEqual(raw.token, stale.token, `iteration ${iteration}: stale lock left on disk`);
      await winner.lock.release();
    }
  }
});

test('permanent gate blocks legacy file creation and legacy temp-directory rename after release', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'openp-lock-'));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-lock-root-'));
  const store = new SessionLockStore(projectRoot, stateRoot);
  const gatePath = store.pathForSession(SESSION_ID);
  const lock = await store.acquire(SESSION_ID);
  await lock.release();

  await assert.rejects(
    async () => {
      const handle = await open(gatePath, 'wx', 0o600);
      await handle.close();
    },
    (error) => hasErrorCode(error, 'EEXIST') || hasErrorCode(error, 'EISDIR'),
  );

  const legacyTempDir = join(stateRoot, 'locks', '.legacy-lock.tmp');
  const legacyOwnerPath = join(legacyTempDir, 'legacy-token.json');
  await mkdir(legacyTempDir, { mode: 0o700 });
  await writeFile(legacyOwnerPath, '{"token":"legacy-token"}\n');
  await assert.rejects(
    () => rename(legacyTempDir, gatePath),
    (error) => hasErrorCode(error, 'EEXIST') || hasErrorCode(error, 'ENOTEMPTY'),
  );
  await unlink(legacyOwnerPath);
  await rmdir(legacyTempDir);
  assert.deepEqual(await readdir(gatePath), ['gate-v2']);
});

test('legacy pre-read cannot acquire after a new owner fails work and releases', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'openp-lock-'));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-lock-root-'));
  const store = new SessionLockStore(projectRoot, stateRoot);
  const gatePath = store.pathForSession(SESSION_ID);

  // A delayed legacy process observes the old protocol path as absent before the new protocol
  // publishes its crash-durable gate and active owner.
  await assert.rejects(() => lstat(gatePath), (error) => hasErrorCode(error, 'ENOENT'));

  const current = await store.acquire(SESSION_ID);
  const pendingMarker = join(stateRoot, 'pending-seed-append.marker');
  await writeFile(pendingMarker, 'pending\n', { flag: 'wx', mode: 0o600 });
  const nativeCommitTarget = join(stateRoot, 'native-commit-target');
  await mkdir(nativeCommitTarget);
  await assert.rejects(
    () => writeFile(nativeCommitTarget, 'must not commit\n'),
    (error) => hasErrorCode(error, 'EISDIR'),
  );
  await current.release();

  // The legacy process resumes from its stale pre-read and attempts the HEAD temp-dir rename.
  // The permanent non-empty gate must still make that acquisition fail closed.
  const legacyTempDir = join(stateRoot, 'locks', '.legacy-delayed.lock.tmp');
  const legacyOwnerPath = join(legacyTempDir, 'legacy-delayed.json');
  await mkdir(legacyTempDir, { mode: 0o700 });
  await writeFile(legacyOwnerPath, '{"token":"legacy-delayed"}\n');
  await assert.rejects(
    () => rename(legacyTempDir, gatePath),
    (error) => hasErrorCode(error, 'EEXIST') || hasErrorCode(error, 'ENOTEMPTY'),
  );
  assert.deepEqual(await readdir(gatePath), ['gate-v2']);

  await unlink(legacyOwnerPath);
  await rmdir(legacyTempDir);
  await rmdir(nativeCommitTarget);
  await unlink(pendingMarker);
});

test('stale recovery rejects a symlink active claim without touching its external target', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'openp-lock-'));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-lock-root-'));
  const store = new SessionLockStore(projectRoot, stateRoot);
  const gatePath = store.pathForSession(SESSION_ID);
  const lock = await store.acquire(SESSION_ID);
  await lock.release();

  const externalDir = await mkdtemp(join(tmpdir(), 'openp-external-lock-'));
  const externalOwner = join(externalDir, 'external-token.json');
  await writeFile(externalOwner, JSON.stringify({
    token: 'external-token',
    sessionId: SESSION_ID,
    pid: 99_999_999,
    createdAt: new Date().toISOString(),
  }), { flag: 'wx', mode: 0o600 });
  await chmod(externalOwner, 0o600);
  await symlink(externalDir, join(gatePath, 'active'), 'dir');

  await assert.rejects(
    () => store.acquire(SESSION_ID),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionState,
  );
  assert.equal((await readFile(externalOwner, 'utf8')).includes('external-token'), true);

  await unlink(join(gatePath, 'active'));
  await unlink(externalOwner);
  await rmdir(externalDir);
});

test('release rejects symlink and non-private active claims without unlinking external owners', async () => {
  for (const unsafeShape of ['symlink', 'mode'] as const) {
    const projectRoot = await mkdtemp(join(tmpdir(), 'openp-lock-'));
    const stateRoot = await mkdtemp(join(tmpdir(), 'openp-lock-root-'));
    const store = new SessionLockStore(projectRoot, stateRoot);
    const gatePath = store.pathForSession(SESSION_ID);
    const lock = await store.acquire(SESSION_ID);
    const activeDir = join(gatePath, 'active');

    if (unsafeShape === 'symlink') {
      const externalDir = await mkdtemp(join(tmpdir(), 'openp-external-lock-'));
      const externalOwner = join(externalDir, 'external-owner.json');
      await writeFile(externalOwner, 'external owner must remain\n', { flag: 'wx', mode: 0o600 });
      await unlink(lock.path);
      await rmdir(activeDir);
      await symlink(externalDir, activeDir, 'dir');

      await assert.rejects(
        () => lock.release(),
        (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionState,
      );
      assert.equal(await readFile(externalOwner, 'utf8'), 'external owner must remain\n');
      await unlink(activeDir);
      await unlink(externalOwner);
      await rmdir(externalDir);
    } else {
      await chmod(activeDir, 0o755);
      await assert.rejects(
        () => lock.release(),
        (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionState,
      );
      assert.equal((await readFile(lock.path, 'utf8')).length > 0, true);
      await chmod(activeDir, 0o700);
      await lock.release();
    }
  }
});

test('owner symlink is rejected without reading or unlinking its external target', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'openp-lock-'));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-lock-root-'));
  const store = new SessionLockStore(projectRoot, stateRoot);
  const lock = await store.acquire(SESSION_ID);
  const original = JSON.parse(await readFile(lock.path, 'utf8'));
  const externalOwner = join(await mkdtemp(join(tmpdir(), 'openp-external-owner-')), 'owner.json');
  await writeFile(externalOwner, JSON.stringify(original), { flag: 'wx', mode: 0o600 });
  await unlink(lock.path);
  await symlink(externalOwner, lock.path, 'file');

  await assert.rejects(
    () => lock.release(),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionState,
  );
  assert.equal(JSON.parse(await readFile(externalOwner, 'utf8')).token, original.token);

  await unlink(lock.path);
  await unlink(externalOwner);
  await rmdir(join(externalOwner, '..'));
});

test('stale recovery does not remove a lock replaced by a live owner', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'openp-lock-'));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-lock-root-'));
  const store = new SessionLockStore(projectRoot, stateRoot);
  const path = store.pathForSession(SESSION_ID);
  await mkdir(join(stateRoot, 'locks'), { recursive: true });
  // A live-pid lock must stay untouched even though it was not created by this store.
  await writeFile(path, JSON.stringify({
    token: 'live-owner-token',
    sessionId: SESSION_ID,
    pid: process.pid,
    createdAt: new Date().toISOString(),
  }));

  await assert.rejects(
    () => store.acquire(SESSION_ID),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionBusy,
  );
  assert.equal((await readFile(path, 'utf8')).includes('live-owner-token'), true);
});

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
