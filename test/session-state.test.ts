import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { NativeSessionReadResult, NativeTurnIds, NativeWrittenTurn } from '../src/core/backend.js';
import { SessionStateStore } from '../src/core/session-state.js';
import { EXIT_CODES, OpenPError } from '../src/core/errors.js';
import { createSeedAppendJournal } from '../src/core/seed-append-journal.js';
import { digestNativeState } from '../src/core/native-state-digest.js';
import { contentDigest } from '../src/core/seed-ir.js';
import { createInitialProvenanceState, externalSourceRefs } from '../src/core/seed-provenance.js';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';

test('writes session state outside the project tree with restrictive permissions', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'openp-state-'));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-state-root-'));
  const store = new SessionStateStore(projectRoot, stateRoot);

  const state = await store.save({
    backend: 'claude',
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
    backend: 'claude',
    backendSessionId: SESSION_ID,
    cwd: projectRoot,
    lastProviderSessionId: 'openp-pty-1',
    sessionLogPath: null,
    lastTurnId: null,
  });
  const second = await store.save({
    backend: 'claude',
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
      backend: 'claude',
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
    backend: 'claude',
    backendSessionId: SESSION_ID,
    cwd: projectRoot,
    lastProviderSessionId: null,
    sessionLogPath: null,
    lastTurnId: null,
  });

  await assert.rejects(
    () => store.requireCompatible({
      backend: 'claude',
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

test('fails closed on invalid UTF-8 state evidence', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'openp-state-'));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-state-root-'));
  const store = new SessionStateStore(projectRoot, stateRoot);
  await store.save({
    backend: 'claude',
    backendSessionId: SESSION_ID,
    cwd: projectRoot,
    lastProviderSessionId: null,
    sessionLogPath: null,
    lastTurnId: 'turn-valid-utf8',
  });
  const path = store.pathForSession(SESSION_ID);
  const bytes = await readFile(path);
  const valueOffset = bytes.indexOf(Buffer.from('turn-valid-utf8'));
  assert.notEqual(valueOffset, -1);
  bytes[valueOffset] = 0x80;
  await writeFile(path, bytes);

  await assert.rejects(
    () => store.load(SESSION_ID),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionState,
  );
});

test('fails closed on unknown state fields, invalid dates, and mismatched embedded session ids', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'openp-state-'));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-state-root-'));
  const store = new SessionStateStore(projectRoot, stateRoot);
  const state = await store.save({
    backend: 'claude',
    backendSessionId: SESSION_ID,
    cwd: projectRoot,
    lastProviderSessionId: null,
    sessionLogPath: null,
    lastTurnId: null,
  });
  const path = join(stateRoot, 'sessions', `${SESSION_ID}.json`);
  const corruptions: readonly ((value: any) => void)[] = [
    (value) => { value.unknown = true; },
    (value) => { value.updatedAt = 'not-a-date'; },
    (value) => { value.updatedAt = '1'; },
    (value) => { value.backendSessionId = 'different-session'; },
  ];

  for (const corrupt of corruptions) {
    const value = structuredClone(state) as any;
    corrupt(value);
    await writeFile(path, JSON.stringify(value));
    await assert.rejects(
      () => store.load(SESSION_ID),
      (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionState,
    );
  }
});

test('saves and loads session state with non-claude backend', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'openp-state-'));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-state-root-'));
  const store = new SessionStateStore(projectRoot, stateRoot);

  const state = await store.save({
    backend: 'codex',
    backendSessionId: SESSION_ID,
    cwd: projectRoot,
    lastProviderSessionId: null,
    sessionLogPath: null,
    lastTurnId: null,
  });

  assert.equal(state.backend, 'codex');
  const loaded = await store.load(SESSION_ID);
  assert.equal(loaded?.backend, 'codex');
});

test('rejects resume across configured backend instances by backend id mismatch', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'openp-state-'));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-state-root-'));
  const store = new SessionStateStore(projectRoot, stateRoot);

  await store.save({
    backend: 'claude-alt',
    backendSessionId: SESSION_ID,
    cwd: projectRoot,
    lastProviderSessionId: null,
    sessionLogPath: null,
    lastTurnId: 'turn-1',
  });

  await assert.rejects(
    () => store.requireCompatible({
      backend: 'claude-main',
      backendSessionId: SESSION_ID,
      cwd: projectRoot,
    }),
    (error) => error instanceof OpenPError &&
      error.exitCode === EXIT_CODES.sessionState &&
      /belongs to backend claude-alt/.test(error.message),
  );
});

test('pending seed session marker is strict, private, and rejected by ordinary v1 state loading', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'openp-state-'));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-state-root-'));
  const store = new SessionStateStore(projectRoot, stateRoot);
  const restoreState = await store.save({
    backend: 'claude',
    backendSessionId: SESSION_ID,
    cwd: projectRoot,
    lastProviderSessionId: 'openp-pty-1',
    sessionLogPath: '/tmp/claude-session.jsonl',
    lastTurnId: 'turn-before-seed',
  });
  const journal = sessionStateTestJournal(projectRoot);

  const marker = await store.publishPendingSeedAppendMarker({
    restoreState,
    seedAppendJournal: journal,
  });
  const path = store.pathForSession(SESSION_ID);
  const rawText = await readFile(path, 'utf8');
  const raw = JSON.parse(rawText);

  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(join(stateRoot, 'sessions'))).mode & 0o777, 0o700);
  assert.deepEqual(Object.keys(raw).sort(), [
    'backend',
    'backendSessionId',
    'createdAt',
    'cwd',
    'kind',
    'operationId',
    'restoreState',
    'schemaVersion',
    'seedAppendJournal',
  ].sort());
  assert.equal(raw.schemaVersion, 2);
  assert.equal(raw.operationId, raw.seedAppendJournal.operationId);
  assert.equal(raw.createdAt, raw.seedAppendJournal.createdAt);
  assert.deepEqual(marker.restoreState, restoreState);
  for (const forbidden of ['codename REDMOON', 'noted-secret', 'raw-external-id', 'userText', 'assistantText']) {
    assert.equal(rawText.includes(forbidden), false, `marker leaked ${forbidden}`);
  }

  await assert.rejects(
    () => store.load(SESSION_ID),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionState,
  );
  await assert.rejects(
    () => store.requireCompatible({ backend: 'claude', backendSessionId: SESSION_ID, cwd: projectRoot }),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionState,
  );
  assert.deepEqual(
    await store.requireCompatibleForPendingSeedSettlement({
      backend: 'claude',
      backendSessionId: SESSION_ID,
      cwd: projectRoot,
    }),
    restoreState,
  );

  const corruptions: readonly ((value: any) => void)[] = [
    (value) => { value.extra = true; },
    (value) => { value.operationId = 'not-a-uuid'; },
    (value) => { value.createdAt = '1'; },
    (value) => { value.restoreState.extra = true; },
    (value) => { value.seedAppendJournal.operationId = '00000000-0000-4000-8000-000000000000'; },
  ];
  for (const corrupt of corruptions) {
    const value = structuredClone(raw);
    corrupt(value);
    await writeFile(path, JSON.stringify(value), { mode: 0o600 });
    await assert.rejects(
      () => store.requireCompatibleForPendingSeedSettlement({
        backend: 'claude',
        backendSessionId: SESSION_ID,
        cwd: projectRoot,
      }),
      (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionState,
    );
  }
});

test('pending seed marker publication refuses a stale restore-state snapshot', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'openp-state-'));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-state-root-'));
  const store = new SessionStateStore(projectRoot, stateRoot);
  const stale = await store.save({
    backend: 'claude',
    backendSessionId: SESSION_ID,
    cwd: projectRoot,
    lastProviderSessionId: null,
    sessionLogPath: null,
    lastTurnId: 'turn-before-update',
  });
  const current = await store.save({
    backend: 'claude',
    backendSessionId: SESSION_ID,
    cwd: projectRoot,
    lastProviderSessionId: null,
    sessionLogPath: null,
    lastTurnId: 'turn-after-update',
  });

  await assert.rejects(
    () => store.publishPendingSeedAppendMarker({
      restoreState: stale,
      seedAppendJournal: sessionStateTestJournal(projectRoot),
    }),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionState,
  );
  assert.deepEqual(await store.load(SESSION_ID), current);
});

function sessionStateIds(prefix: string): NativeTurnIds {
  return {
    userId: `${prefix}:user`,
    assistantIds: [`${prefix}:assistant`],
    completionId: `${prefix}:complete`,
  };
}

function sessionStateDigest(turns: readonly unknown[]): string {
  return digestNativeState('session-state-pending-seed-test-v1', [Buffer.from(JSON.stringify(turns), 'utf8')]);
}

function sessionStateTestJournal(projectRoot: string) {
  const beforeTurns = [{
    userText: 'Reply with only: OK',
    assistantText: 'OK',
    nativeIds: sessionStateIds('base'),
  }];
  const before: NativeSessionReadResult = {
    backend: 'claude',
    sessionId: SESSION_ID,
    turns: beforeTurns,
    nativeStateDigest: sessionStateDigest(beforeTurns),
  };
  const written: readonly NativeWrittenTurn[] = [{
    logicalId: `ir:${'1'.repeat(64)}`,
    contentDigest: contentDigest('codename REDMOON', 'noted-secret'),
    nativeIds: sessionStateIds('seeded'),
  }];
  const fullTurns = [
    ...beforeTurns,
    { userText: 'codename REDMOON', assistantText: 'noted-secret', nativeIds: sessionStateIds('seeded') },
  ];
  const provenance = createInitialProvenanceState({
    backend: 'claude',
    sessionId: SESSION_ID,
    bootstrap: [sessionStateIds('base')],
  });
  return createSeedAppendJournal({
    backend: 'claude',
    sessionId: SESSION_ID,
    before,
    provenance,
    sourceRefs: externalSourceRefs('d'.repeat(64), ['raw-external-id']),
    written,
    candidateNativeStateDigest: sessionStateDigest(fullTurns),
  });
}

test('saves and loads opaque session ids generated by backends', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'openp-state-'));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-state-root-'));
  const store = new SessionStateStore(projectRoot, stateRoot);
  const sessionId = 'agent-session_01:opaque';

  await store.save({
    backend: 'codex',
    backendSessionId: sessionId,
    cwd: projectRoot,
    lastProviderSessionId: null,
    sessionLogPath: null,
    lastTurnId: 'turn-1',
  });

  const loaded = await store.load(sessionId);
  assert.equal(loaded?.backendSessionId, sessionId);
});

test('rejects session state with empty backend', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'openp-state-'));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-state-root-'));
  const store = new SessionStateStore(projectRoot, stateRoot);
  const path = join(stateRoot, 'sessions', `${SESSION_ID}.json`);
  await mkdir(join(stateRoot, 'sessions'), { recursive: true });

  await writeFile(path, JSON.stringify({
    schemaVersion: 1,
    backend: '',
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

test('rejects invalid session ids at the state path boundary', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'openp-state-'));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-state-root-'));
  const store = new SessionStateStore(projectRoot, stateRoot);

  await assert.rejects(
    () => store.load('../outside'),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionState,
  );
});
