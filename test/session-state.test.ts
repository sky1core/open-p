import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SessionStateStore } from '../src/core/session-state.js';
import { EXIT_CODES, OpenPError } from '../src/core/errors.js';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';

test('writes session state outside the project tree with restrictive permissions', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'openp-state-'));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-state-root-'));
  const store = new SessionStateStore(projectRoot, stateRoot);

  const state = await store.save({
    backend: 'claude-code',
    provider: 'tmux',
    backendSessionId: SESSION_ID,
    cwd: projectRoot,
    lastProviderSessionId: 'openp-pty-1',
    sessionLogPath: '/tmp/claude-session.jsonl',
    lastTurnId: 'turn-1',
  });

  const path = join(stateRoot, 'sessions', `${SESSION_ID}.json`);
  const raw = JSON.parse(await readFile(path, 'utf8'));
  const mode = (await stat(path)).mode & 0o777;

  assert.equal(mode, 0o600);
  assert.deepEqual(raw, state);
  assert.deepEqual(await store.load(SESSION_ID), state);
  assert.equal(path.startsWith(projectRoot), false);
  await assert.rejects(
    () => stat(join(projectRoot, '.openp')),
    (error) => typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT',
  );
  assert.equal(Number.isNaN(Date.parse(state.createdAt)), false);
  assert.equal(Number.isNaN(Date.parse(state.updatedAt)), false);
});

test('preserves createdAt and updates last turn on repeated saves', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'openp-state-'));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-state-root-'));
  const store = new SessionStateStore(projectRoot, stateRoot);

  const first = await store.save({
    backend: 'claude-code',
    provider: 'tmux',
    backendSessionId: SESSION_ID,
    cwd: projectRoot,
    lastProviderSessionId: 'openp-pty-1',
    sessionLogPath: null,
    lastTurnId: null,
  });
  const second = await store.save({
    backend: 'claude-code',
    provider: 'tmux',
    backendSessionId: SESSION_ID,
    cwd: projectRoot,
    lastProviderSessionId: 'openp-pty-2',
    sessionLogPath: '/tmp/claude-session.jsonl',
    lastTurnId: 'turn-2',
  });

  assert.equal(second.createdAt, first.createdAt);
  assert.notEqual(second.updatedAt, '');
  assert.equal(second.lastProviderSessionId, 'openp-pty-2');
  assert.equal(second.sessionLogPath, '/tmp/claude-session.jsonl');
  assert.equal(second.lastTurnId, 'turn-2');
});

test('requires existing compatible state for resume', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'openp-state-'));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-state-root-'));
  const store = new SessionStateStore(projectRoot, stateRoot);

  await assert.rejects(
    () => store.requireCompatible({
      backend: 'claude-code',
      provider: 'tmux',
      backendSessionId: SESSION_ID,
      cwd: projectRoot,
    }),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionState,
  );
});

test('fails closed when existing state belongs to another workspace', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'openp-state-'));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-state-root-'));
  const store = new SessionStateStore(projectRoot, stateRoot);
  await store.save({
    backend: 'claude-code',
    provider: 'tmux',
    backendSessionId: SESSION_ID,
    cwd: projectRoot,
    lastProviderSessionId: null,
    sessionLogPath: null,
    lastTurnId: null,
  });

  await assert.rejects(
    () => store.requireCompatible({
      backend: 'claude-code',
      provider: 'tmux',
      backendSessionId: SESSION_ID,
      cwd: '/different/workspace',
    }),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionState,
  );
});

test('fails closed on malformed state files', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'openp-state-'));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-state-root-'));
  const store = new SessionStateStore(projectRoot, stateRoot);
  const path = join(stateRoot, 'sessions', `${SESSION_ID}.json`);
  await mkdir(join(stateRoot, 'sessions'), { recursive: true });
  await writeFile(path, '{"schemaVersion":2}');

  await assert.rejects(
    () => store.load(SESSION_ID),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionState,
  );
});

test('saves and loads session state with non-claude-code backend', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'openp-state-'));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-state-root-'));
  const store = new SessionStateStore(projectRoot, stateRoot);

  const state = await store.save({
    backend: 'codex',
    provider: 'screen',
    backendSessionId: SESSION_ID,
    cwd: projectRoot,
    lastProviderSessionId: null,
    sessionLogPath: null,
    lastTurnId: null,
  });

  assert.equal(state.backend, 'codex');
  assert.equal(state.provider, 'screen');
  const loaded = await store.load(SESSION_ID);
  assert.equal(loaded?.backend, 'codex');
  assert.equal(loaded?.provider, 'screen');
});

test('rejects session state with empty backend or provider', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'openp-state-'));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-state-root-'));
  const store = new SessionStateStore(projectRoot, stateRoot);
  const path = join(stateRoot, 'sessions', `${SESSION_ID}.json`);
  await mkdir(join(stateRoot, 'sessions'), { recursive: true });

  await writeFile(path, JSON.stringify({
    schemaVersion: 1,
    backend: '',
    provider: 'tmux',
    backendSessionId: SESSION_ID,
    cwd: projectRoot,
    lastProviderSessionId: null,
    sessionLogPath: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastTurnId: null,
  }));
  await assert.rejects(
    () => store.load(SESSION_ID),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionState,
  );
});

test('rejects unsafe session ids at the state path boundary', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'openp-state-'));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-state-root-'));
  const store = new SessionStateStore(projectRoot, stateRoot);

  await assert.rejects(
    () => store.load('../outside'),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionState,
  );
});
