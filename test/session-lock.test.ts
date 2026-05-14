import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SessionLockStore } from '../src/core/session-lock.js';
import { EXIT_CODES, OpenPError } from '../src/core/errors.js';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';

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
  const second = await store.acquire(SESSION_ID);
  await second.release();
});

test('does not release a lock with a different token', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'openp-lock-'));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-lock-root-'));
  const store = new SessionLockStore(projectRoot, stateRoot);
  const lock = await store.acquire(SESSION_ID);

  await writeFile(lock.path, JSON.stringify({
    token: 'other-token',
    sessionId: SESSION_ID,
    pid: process.pid,
    createdAt: new Date().toISOString(),
  }));
  await lock.release();

  assert.equal((await readFile(lock.path, 'utf8')).includes('other-token'), true);
});

test('recovers a stale lock owned by a missing process', async () => {
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

  const lock = await store.acquire(SESSION_ID);
  const raw = JSON.parse(await readFile(path, 'utf8'));

  assert.notEqual(raw.token, 'stale-token');
  assert.equal(raw.sessionId, SESSION_ID);
  await lock.release();
});

test('rejects unsafe session ids at the lock path boundary', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'openp-lock-'));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-lock-root-'));
  const store = new SessionLockStore(projectRoot, stateRoot);

  await assert.rejects(
    () => store.acquire('../outside'),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionState,
  );
});
