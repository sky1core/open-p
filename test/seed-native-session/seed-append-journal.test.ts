import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, chmod, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import type { NativeSessionReadResult, NativeTurnIds, NativeWrittenTurn } from '../../src/core/backend.js';
import { EXIT_CODES, OpenPError } from '../../src/core/errors.js';
import {
  SeedAppendJournalStore,
  createSeedAppendJournal,
  settlePendingSeedAppend,
} from '../../src/core/seed-append-journal.js';
import {
  SeedProvenanceStore,
  createInitialProvenanceState,
  externalSourceRefs,
  withAppendedProvenanceEntries,
  type SeedProvenanceState,
} from '../../src/core/seed-provenance.js';
import { contentDigest } from '../../src/core/seed-ir.js';
import { digestNativeState } from '../../src/core/native-state-digest.js';
import {
  SessionStateStore,
  type PendingSeedAppendSessionState,
  type SessionStateCompatibility,
} from '../../src/core/session-state.js';

const BACKEND = 'target';
const SESSION_ID = 'target-session';
const SECRET_USER = 'codename FIXTURESECRET';
const SECRET_ASSISTANT = 'noted-secret';
const RAW_EXTERNAL_ID = 'caller-secret-id';

function ids(prefix: string): NativeTurnIds {
  return {
    userId: `${prefix}:user`,
    assistantIds: [`${prefix}:assistant`],
    completionId: `${prefix}:complete`,
  };
}

function baseRead(): NativeSessionReadResult {
  const turns = [{
    userText: 'Reply with only: OK',
    assistantText: 'OK',
    nativeIds: ids('bootstrap'),
  }];
  return {
    backend: BACKEND,
    sessionId: SESSION_ID,
    turns,
    nativeStateDigest: testNativeStateDigest(turns),
  };
}

function written(): readonly NativeWrittenTurn[] {
  return [{
    logicalId: `ir:${'1'.repeat(64)}`,
    contentDigest: contentDigest(SECRET_USER, SECRET_ASSISTANT),
    nativeIds: ids('written'),
  }];
}

function fullRead(): NativeSessionReadResult {
  const turns = [
    ...baseRead().turns,
    { userText: SECRET_USER, assistantText: SECRET_ASSISTANT, nativeIds: ids('written') },
  ];
  return {
    ...baseRead(),
    turns,
    nativeStateDigest: testNativeStateDigest(turns),
  };
}

function testNativeStateDigest(turns: readonly unknown[]): string {
  return digestNativeState('seed-journal-test-v1', [Buffer.from(JSON.stringify(turns), 'utf8')]);
}

async function context(): Promise<{
  readonly cwd: string;
  readonly stateRoot: string;
  readonly journalStore: SeedAppendJournalStore;
  readonly provenanceStore: SeedProvenanceStore;
  readonly sessionStateStore: SessionStateStore;
  readonly provenance: ReturnType<typeof createInitialProvenanceState>;
}> {
  const cwd = await mkdtemp(join(tmpdir(), 'openp-seed-journal-cwd-'));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-seed-journal-state-'));
  const journalStore = new SeedAppendJournalStore(cwd, stateRoot);
  const provenanceStore = new SeedProvenanceStore(cwd, stateRoot);
  const sessionStateStore = new SessionStateStore(cwd, stateRoot);
  const provenance = createInitialProvenanceState({
    backend: BACKEND,
    sessionId: SESSION_ID,
    bootstrap: [ids('bootstrap')],
  });
  await provenanceStore.save(provenance);
  return { cwd, stateRoot, journalStore, provenanceStore, sessionStateStore, provenance };
}

function journal(
  provenance: ReturnType<typeof createInitialProvenanceState>,
  cleanupToken: string | null = null,
) {
  return createSeedAppendJournal({
    backend: BACKEND,
    sessionId: SESSION_ID,
    before: baseRead(),
    provenance,
    sourceRefs: externalSourceRefs('d'.repeat(64), [RAW_EXTERNAL_ID]),
    written: written(),
    candidateNativeStateDigest: fullRead().nativeStateDigest!,
    cleanupToken,
  });
}

async function publishMarker(ctx: Awaited<ReturnType<typeof context>>, pending = journal(ctx.provenance)) {
  const restoreState = await ctx.sessionStateStore.save({
    backend: BACKEND,
    backendSessionId: SESSION_ID,
    cwd: ctx.cwd,
    lastProviderSessionId: null,
    sessionLogPath: null,
    lastTurnId: 'turn-before-seed',
  });
  return ctx.sessionStateStore.publishPendingSeedAppendMarker({
    restoreState,
    seedAppendJournal: pending,
  });
}

test('pending seed journal is private, atomic, and transcript-free', async () => {
  const ctx = await context();
  const cleanupToken = randomUUID();
  const pending = journal(ctx.provenance, cleanupToken);
  await ctx.journalStore.create(pending);

  assert.deepEqual(await ctx.journalStore.load(BACKEND, SESSION_ID), pending);
  const path = ctx.journalStore.pathForSession(BACKEND, SESSION_ID);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(dirname(path))).mode & 0o777, 0o700);
  const raw = await readFile(path, 'utf8');
  for (const forbidden of [SECRET_USER, SECRET_ASSISTANT, RAW_EXTERNAL_ID, 'userText', 'assistantText']) {
    assert.equal(raw.includes(forbidden), false, `journal leaked ${forbidden}`);
  }
  assert.equal(raw.includes(cleanupToken), true);
  assert.equal(raw.includes('externalIdDigest'), true);
  assert.deepEqual((await readdir(dirname(path))).filter((name) => name.endsWith('.tmp')), []);

  await assert.rejects(
    () => ctx.journalStore.create(pending),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionState,
  );
});

test('pending seed journal corruption fails as state error and is retained', async () => {
  const ctx = await context();
  const path = ctx.journalStore.pathForSession(BACKEND, SESSION_ID);
  await ctx.journalStore.create(journal(ctx.provenance));
  await writeFile(path, '{broken', { mode: 0o600 });

  await assert.rejects(
    () => ctx.journalStore.load(BACKEND, SESSION_ID),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionState,
  );
  await access(path);
});

test('pending seed journal requires canonical timestamps, UUID operations, and logical ids', async () => {
  const corruptions: readonly ((value: any) => void)[] = [
    (value) => { value.createdAt = '1'; },
    (value) => { value.operationId = 'not-a-uuid'; },
    (value) => { value.cleanupToken = '../../transcript.json'; },
    (value) => { value.planned[0].logicalId = 'garbage'; },
  ];
  for (const corrupt of corruptions) {
    const ctx = await context();
    const path = ctx.journalStore.pathForSession(BACKEND, SESSION_ID);
    await ctx.journalStore.create(journal(ctx.provenance));
    const value = JSON.parse(await readFile(path, 'utf8'));
    corrupt(value);
    await writeFile(path, JSON.stringify(value), { mode: 0o600 });

    await assert.rejects(
      () => ctx.journalStore.load(BACKEND, SESSION_ID),
      (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionState,
    );
    await access(path);
  }
});

test('pending settlement requires the backend cleanup capability before Reader access', async () => {
  const ctx = await context();
  const pending = journal(ctx.provenance, randomUUID());
  await ctx.journalStore.create(pending);
  let readCalls = 0;

  await assert.rejects(
    () => settlePendingSeedAppend({
      backend: BACKEND,
      sessionId: SESSION_ID,
      cwd: ctx.cwd,
      readNativeSession: async () => {
        readCalls += 1;
        return fullRead();
      },
      journalStore: ctx.journalStore,
      provenanceStore: ctx.provenanceStore,
    }),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.protocolViolation,
  );
  assert.equal(readCalls, 0);
  await access(ctx.journalStore.pathForSession(BACKEND, SESSION_ID));
});

test('pending settlement cleans the opaque backend locator before retiring exact evidence', async () => {
  for (const expected of ['not-committed', 'committed', 'already-settled'] as const) {
    const ctx = await context();
    const cleanupToken = randomUUID();
    const pending = journal(ctx.provenance, cleanupToken);
    const marker = await publishMarker(ctx, pending);
    await ctx.journalStore.create(pending);
    if (expected === 'already-settled') {
      await ctx.provenanceStore.save(withAppendedProvenanceEntries(ctx.provenance, {
        targetBackend: BACKEND,
        targetSessionId: SESSION_ID,
        sourceRefs: pending.planned.map((turn) => turn.source),
        written: written(),
      }));
    }
    let cleanupCalls = 0;

    const status = await settlePendingSeedAppend({
      backend: BACKEND,
      sessionId: SESSION_ID,
      cwd: ctx.cwd,
      readNativeSession: async () => expected === 'not-committed' ? baseRead() : fullRead(),
      cleanupPreparedAppend: async (input) => {
        cleanupCalls += 1;
        assert.equal(input.sessionId, SESSION_ID);
        assert.equal(input.cwd, ctx.cwd);
        assert.equal(input.token, cleanupToken);
        assert.notEqual(await ctx.sessionStateStore.loadPendingSeedAppendMarker(SESSION_ID), null);
        await access(ctx.journalStore.pathForSession(BACKEND, SESSION_ID));
      },
      journalStore: ctx.journalStore,
      provenanceStore: ctx.provenanceStore,
      sessionStateStore: ctx.sessionStateStore,
    });

    assert.equal(status, expected);
    assert.equal(cleanupCalls, 1);
    assert.equal(await ctx.journalStore.load(BACKEND, SESSION_ID), null);
    assert.deepEqual(await ctx.sessionStateStore.load(SESSION_ID), marker.restoreState);
  }
});

test('cleanup failure after provenance settlement retains marker and journal for exact retry', async () => {
  const ctx = await context();
  const cleanupToken = randomUUID();
  const pending = journal(ctx.provenance, cleanupToken);
  await publishMarker(ctx, pending);
  await ctx.journalStore.create(pending);
  let cleanupCalls = 0;

  await assert.rejects(
    () => settlePendingSeedAppend({
      backend: BACKEND,
      sessionId: SESSION_ID,
      cwd: ctx.cwd,
      readNativeSession: async () => fullRead(),
      cleanupPreparedAppend: async () => {
        cleanupCalls += 1;
        throw new Error('simulated cleanup failure');
      },
      journalStore: ctx.journalStore,
      provenanceStore: ctx.provenanceStore,
      sessionStateStore: ctx.sessionStateStore,
    }),
    (error) => error instanceof OpenPError &&
      error.exitCode === EXIT_CODES.sessionState && error.details?.cleanupFailed === true,
  );
  assert.equal(cleanupCalls, 1);
  assert.equal((await ctx.provenanceStore.load(BACKEND, SESSION_ID))?.entries.length, 1);
  assert.notEqual(await ctx.journalStore.load(BACKEND, SESSION_ID), null);
  assert.notEqual(await ctx.sessionStateStore.loadPendingSeedAppendMarker(SESSION_ID), null);

  const retried = await settlePendingSeedAppend({
    backend: BACKEND,
    sessionId: SESSION_ID,
    cwd: ctx.cwd,
    readNativeSession: async () => fullRead(),
    cleanupPreparedAppend: async (input) => {
      cleanupCalls += 1;
      assert.equal(input.token, cleanupToken);
    },
    journalStore: ctx.journalStore,
    provenanceStore: ctx.provenanceStore,
    sessionStateStore: ctx.sessionStateStore,
  });

  assert.equal(retried, 'already-settled');
  assert.equal(cleanupCalls, 2);
  assert.equal(await ctx.journalStore.load(BACKEND, SESSION_ID), null);
  assert.equal(await ctx.sessionStateStore.loadPendingSeedAppendMarker(SESSION_ID), null);
});

test('already-final provenance is re-saved durably before cleanup and pending evidence retirement', async () => {
  const ctx = await context();
  const cleanupToken = randomUUID();
  const pending = journal(ctx.provenance, cleanupToken);
  const finalProvenance = withAppendedProvenanceEntries(ctx.provenance, {
    targetBackend: BACKEND,
    targetSessionId: SESSION_ID,
    sourceRefs: pending.planned.map((turn) => turn.source),
    written: written(),
  });
  await ctx.provenanceStore.save(finalProvenance);
  await publishMarker(ctx, pending);
  await ctx.journalStore.create(pending);

  class RetryProvenanceStore extends SeedProvenanceStore {
    saveCalls = 0;
    rejectSave = true;

    override async save(state: SeedProvenanceState): Promise<void> {
      this.saveCalls += 1;
      if (this.rejectSave) {
        throw new OpenPError('simulated provenance directory fsync failure', EXIT_CODES.sessionState);
      }
      await super.save(state);
    }
  }

  const retryStore = new RetryProvenanceStore(ctx.cwd, ctx.stateRoot);
  let cleanupCalls = 0;
  await assert.rejects(
    () => settlePendingSeedAppend({
      backend: BACKEND,
      sessionId: SESSION_ID,
      cwd: ctx.cwd,
      readNativeSession: async () => fullRead(),
      cleanupPreparedAppend: async () => {
        cleanupCalls += 1;
      },
      journalStore: ctx.journalStore,
      provenanceStore: retryStore,
      sessionStateStore: ctx.sessionStateStore,
    }),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionState,
  );
  assert.equal(retryStore.saveCalls, 1);
  assert.equal(cleanupCalls, 0, 'cleanup cannot run before final provenance durability is re-established');
  assert.notEqual(await ctx.journalStore.load(BACKEND, SESSION_ID), null);
  assert.notEqual(await ctx.sessionStateStore.loadPendingSeedAppendMarker(SESSION_ID), null);

  retryStore.rejectSave = false;
  const status = await settlePendingSeedAppend({
    backend: BACKEND,
    sessionId: SESSION_ID,
    cwd: ctx.cwd,
    readNativeSession: async () => fullRead(),
    cleanupPreparedAppend: async () => {
      cleanupCalls += 1;
    },
    journalStore: ctx.journalStore,
    provenanceStore: retryStore,
    sessionStateStore: ctx.sessionStateStore,
  });

  assert.equal(status, 'already-settled');
  assert.equal(retryStore.saveCalls, 2);
  assert.equal(cleanupCalls, 1);
  assert.equal(await ctx.journalStore.load(BACKEND, SESSION_ID), null);
  assert.equal(await ctx.sessionStateStore.loadPendingSeedAppendMarker(SESSION_ID), null);
});

test('pending seed journal rejects invalid UTF-8 state evidence', async () => {
  const ctx = await context();
  const pending = journal(ctx.provenance);
  const path = ctx.journalStore.pathForSession(BACKEND, SESSION_ID);
  await ctx.journalStore.create(pending);
  const bytes = await readFile(path);
  const valueOffset = bytes.indexOf(Buffer.from(pending.operationId));
  assert.notEqual(valueOffset, -1);
  bytes[valueOffset] = 0x80;
  await writeFile(path, bytes, { mode: 0o600 });

  await assert.rejects(
    () => ctx.journalStore.load(BACKEND, SESSION_ID),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionState,
  );
  await access(path);
});

test('seed provenance rejects invalid UTF-8 state evidence', async () => {
  const ctx = await context();
  const path = ctx.provenanceStore.pathForSession(BACKEND, SESSION_ID);
  const bytes = await readFile(path);
  const valueOffset = bytes.indexOf(Buffer.from('bootstrap:user'));
  assert.notEqual(valueOffset, -1);
  bytes[valueOffset] = 0x80;
  await writeFile(path, bytes, { mode: 0o600 });

  await assert.rejects(
    () => ctx.provenanceStore.load(BACKEND, SESSION_ID),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionState,
  );
  await access(path);
});

test('seed provenance requires canonical timestamps and logical ids', async () => {
  const corruptions: readonly ((value: any) => void)[] = [
    (value) => { value.createdAt = '1'; },
    (value) => { value.entries[0].logicalId = 'garbage'; },
  ];
  for (const corrupt of corruptions) {
    const ctx = await context();
    const stored = withAppendedProvenanceEntries(ctx.provenance, {
      targetBackend: BACKEND,
      targetSessionId: SESSION_ID,
      sourceRefs: externalSourceRefs('d'.repeat(64), [RAW_EXTERNAL_ID]),
      written: written(),
    });
    await ctx.provenanceStore.save(stored);
    const path = ctx.provenanceStore.pathForSession(BACKEND, SESSION_ID);
    const value = JSON.parse(await readFile(path, 'utf8'));
    corrupt(value);
    await writeFile(path, JSON.stringify(value), { mode: 0o600 });

    await assert.rejects(
      () => ctx.provenanceStore.load(BACKEND, SESSION_ID),
      (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionState,
    );
    await access(path);
  }
});

test('seed state stores accept the maximum safe session id without overlong temp basenames', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'openp-seed-max-id-cwd-'));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-seed-max-id-state-'));
  const sessionId = 's'.repeat(200);
  const provenanceStore = new SeedProvenanceStore(cwd, stateRoot);
  const provenance = createInitialProvenanceState({
    backend: BACKEND,
    sessionId,
    bootstrap: [ids('bootstrap')],
  });
  await provenanceStore.save(provenance);
  assert.equal((await provenanceStore.load(BACKEND, sessionId))?.sessionId, sessionId);

  const before = { ...baseRead(), sessionId };
  const candidate = { ...fullRead(), sessionId };
  const pending = createSeedAppendJournal({
    backend: BACKEND,
    sessionId,
    before,
    provenance,
    sourceRefs: externalSourceRefs('d'.repeat(64), [RAW_EXTERNAL_ID]),
    written: written(),
    candidateNativeStateDigest: candidate.nativeStateDigest!,
  });
  const journalStore = new SeedAppendJournalStore(cwd, stateRoot);
  await journalStore.create(pending);
  assert.equal((await journalStore.load(BACKEND, sessionId))?.sessionId, sessionId);
});

test('pending seed journal rejects an unsafe native source session before Reader access', async () => {
  const ctx = await context();
  const path = ctx.journalStore.pathForSession(BACKEND, SESSION_ID);
  await ctx.journalStore.create(journal(ctx.provenance));
  const value = JSON.parse(await readFile(path, 'utf8'));
  value.planned[0].source = {
    kind: 'native',
    backend: 'source',
    sessionId: '../unsafe',
    nativeIds: ids('source'),
  };
  await writeFile(path, JSON.stringify(value), { mode: 0o600 });
  let readCalls = 0;

  await assert.rejects(
    () => settlePendingSeedAppend({
      backend: BACKEND,
      sessionId: SESSION_ID,
      cwd: ctx.cwd,
      readNativeSession: async () => {
        readCalls += 1;
        return fullRead();
      },
      journalStore: ctx.journalStore,
      provenanceStore: ctx.provenanceStore,
    }),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionState,
  );
  assert.equal(readCalls, 0);
  await access(path);
});

test('pending settlement distinguishes exact before, exact full commit, and already-settled state', async () => {
  for (const expected of ['not-committed', 'committed', 'already-settled'] as const) {
    const ctx = await context();
    const pending = journal(ctx.provenance);
    if (expected === 'already-settled') {
      await ctx.provenanceStore.save(withAppendedProvenanceEntries(ctx.provenance, {
        targetBackend: BACKEND,
        targetSessionId: SESSION_ID,
        sourceRefs: pending.planned.map((turn) => turn.source),
        written: written(),
      }));
    }
    await ctx.journalStore.create(pending);

    const status = await settlePendingSeedAppend({
      backend: BACKEND,
      sessionId: SESSION_ID,
      cwd: ctx.cwd,
      readNativeSession: async (input) => {
        assert.equal(input.mode, 'settlement');
        return expected === 'not-committed' ? baseRead() : fullRead();
      },
      journalStore: ctx.journalStore,
      provenanceStore: ctx.provenanceStore,
    });

    assert.equal(status, expected);
    assert.equal(await ctx.journalStore.load(BACKEND, SESSION_ID), null);
    const stored = await ctx.provenanceStore.load(BACKEND, SESSION_ID);
    assert.equal(stored?.entries.length, expected === 'not-committed' ? 0 : 1);
    if (stored?.entries[0]) {
      assert.deepEqual(stored.entries[0].target.nativeIds, ids('written'));
    }
  }
});

test('pending marker-only settlement recovers exact base, exact full, and final provenance states', async () => {
  for (const expected of ['not-committed', 'committed', 'already-settled'] as const) {
    const ctx = await context();
    const pending = journal(ctx.provenance);
    if (expected === 'already-settled') {
      await ctx.provenanceStore.save(withAppendedProvenanceEntries(ctx.provenance, {
        targetBackend: BACKEND,
        targetSessionId: SESSION_ID,
        sourceRefs: pending.planned.map((turn) => turn.source),
        written: written(),
      }));
    }
    const marker = await publishMarker(ctx, pending);

    const status = await settlePendingSeedAppend({
      backend: BACKEND,
      sessionId: SESSION_ID,
      cwd: ctx.cwd,
      readNativeSession: async () => expected === 'not-committed' ? baseRead() : fullRead(),
      journalStore: ctx.journalStore,
      provenanceStore: ctx.provenanceStore,
      sessionStateStore: ctx.sessionStateStore,
    });

    assert.equal(status, expected);
    assert.equal(await ctx.journalStore.load(BACKEND, SESSION_ID), null);
    assert.equal(await ctx.sessionStateStore.loadPendingSeedAppendMarker(SESSION_ID), null);
    assert.deepEqual(await ctx.sessionStateStore.load(SESSION_ID), marker.restoreState);
    assert.equal((await ctx.provenanceStore.load(BACKEND, SESSION_ID))?.entries.length, expected === 'not-committed' ? 0 : 1);
  }
});

test('pending marker and journal mismatch fails closed before Reader access', async () => {
  const ctx = await context();
  const markerJournal = journal(ctx.provenance);
  await publishMarker(ctx, markerJournal);
  const fileJournal = journal(ctx.provenance);
  assert.notEqual(fileJournal.operationId, markerJournal.operationId);
  await ctx.journalStore.create(fileJournal);
  let readCalls = 0;

  await assert.rejects(
    () => settlePendingSeedAppend({
      backend: BACKEND,
      sessionId: SESSION_ID,
      cwd: ctx.cwd,
      readNativeSession: async () => {
        readCalls += 1;
        return fullRead();
      },
      journalStore: ctx.journalStore,
      provenanceStore: ctx.provenanceStore,
      sessionStateStore: ctx.sessionStateStore,
    }),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionState,
  );
  assert.equal(readCalls, 0);
  await access(ctx.journalStore.pathForSession(BACKEND, SESSION_ID));
  await assert.rejects(
    () => ctx.sessionStateStore.load(SESSION_ID),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionState,
  );
});

test('pending marker-only settlement retains v2 state on native divergence', async () => {
  const ctx = await context();
  await publishMarker(ctx);
  const divergent = {
    ...fullRead(),
    turns: [...fullRead().turns, {
      userText: 'foreign user',
      assistantText: 'foreign assistant',
      nativeIds: ids('foreign'),
    }],
  };

  await assert.rejects(
    () => settlePendingSeedAppend({
      backend: BACKEND,
      sessionId: SESSION_ID,
      cwd: ctx.cwd,
      readNativeSession: async () => divergent,
      journalStore: ctx.journalStore,
      provenanceStore: ctx.provenanceStore,
      sessionStateStore: ctx.sessionStateStore,
    }),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.protocolViolation,
  );
  assert.notEqual(await ctx.sessionStateStore.loadPendingSeedAppendMarker(SESSION_ID), null);
  await assert.rejects(
    () => ctx.sessionStateStore.load(SESSION_ID),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionState,
  );
});

test('pending marker stays v2 when journal removal fails', async () => {
  const ctx = await context();
  const pending = journal(ctx.provenance);
  await publishMarker(ctx, pending);
  await ctx.journalStore.create(pending);
  class FailingRemoveJournalStore extends SeedAppendJournalStore {
    override async remove(): Promise<void> {
      throw new OpenPError('simulated journal removal failure', EXIT_CODES.sessionState);
    }
  }

  await assert.rejects(
    () => settlePendingSeedAppend({
      backend: BACKEND,
      sessionId: SESSION_ID,
      cwd: ctx.cwd,
      readNativeSession: async () => baseRead(),
      journalStore: new FailingRemoveJournalStore(ctx.cwd, ctx.stateRoot),
      provenanceStore: ctx.provenanceStore,
      sessionStateStore: ctx.sessionStateStore,
    }),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionState,
  );
  assert.notEqual(await ctx.sessionStateStore.loadPendingSeedAppendMarker(SESSION_ID), null);
  await access(ctx.journalStore.pathForSession(BACKEND, SESSION_ID));
});

test('pending marker-only recovery retries v1 restore after journal was removed', async () => {
  const ctx = await context();
  const pending = journal(ctx.provenance);
  const marker = await publishMarker(ctx, pending);
  await ctx.journalStore.create(pending);
  class FailingRestoreSessionStateStore extends SessionStateStore {
    private failed = false;
    override async restorePendingSeedAppendMarker(input: PendingSeedAppendSessionState): Promise<void> {
      if (!this.failed) {
        this.failed = true;
        throw new OpenPError('simulated v1 restore failure', EXIT_CODES.sessionState);
      }
      await super.restorePendingSeedAppendMarker(input);
    }
  }

  await assert.rejects(
    () => settlePendingSeedAppend({
      backend: BACKEND,
      sessionId: SESSION_ID,
      cwd: ctx.cwd,
      readNativeSession: async () => baseRead(),
      journalStore: ctx.journalStore,
      provenanceStore: ctx.provenanceStore,
      sessionStateStore: new FailingRestoreSessionStateStore(ctx.cwd, ctx.stateRoot),
    }),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionState,
  );
  assert.equal(await ctx.journalStore.load(BACKEND, SESSION_ID), null);
  assert.notEqual(await ctx.sessionStateStore.loadPendingSeedAppendMarker(SESSION_ID), null);

  const retried = await settlePendingSeedAppend({
    backend: BACKEND,
    sessionId: SESSION_ID,
    cwd: ctx.cwd,
    readNativeSession: async () => baseRead(),
    journalStore: ctx.journalStore,
    provenanceStore: ctx.provenanceStore,
    sessionStateStore: ctx.sessionStateStore,
  });

  assert.equal(retried, 'not-committed');
  assert.deepEqual(await ctx.sessionStateStore.load(SESSION_ID), marker.restoreState);
});

test('pending-none retry confirms a visible v1 restore durably before allowing another turn', async () => {
  const ctx = await context();
  const pending = journal(ctx.provenance);

  class PostRestoreFailureStateStore extends SessionStateStore {
    rejectConfirmation = true;
    confirmationCalls = 0;

    override async restorePendingSeedAppendMarker(marker: PendingSeedAppendSessionState): Promise<void> {
      await super.restorePendingSeedAppendMarker(marker);
      throw new OpenPError('simulated sessions directory fsync failure after visible v1 rename', EXIT_CODES.sessionState);
    }

    override async confirmCompatibleV1DurabilityIfPresent(expected: SessionStateCompatibility): Promise<void> {
      this.confirmationCalls += 1;
      if (this.rejectConfirmation) {
        throw new OpenPError('simulated v1 durability confirmation failure', EXIT_CODES.sessionState);
      }
      await super.confirmCompatibleV1DurabilityIfPresent(expected);
    }
  }

  const sessionStateStore = new PostRestoreFailureStateStore(ctx.cwd, ctx.stateRoot);
  const restoreState = await sessionStateStore.save({
    backend: BACKEND,
    backendSessionId: SESSION_ID,
    cwd: ctx.cwd,
    lastProviderSessionId: null,
    sessionLogPath: null,
    lastTurnId: 'turn-before-seed',
  });
  await sessionStateStore.publishPendingSeedAppendMarker({
    restoreState,
    seedAppendJournal: pending,
  });
  await ctx.journalStore.create(pending);

  await assert.rejects(
    () => settlePendingSeedAppend({
      backend: BACKEND,
      sessionId: SESSION_ID,
      cwd: ctx.cwd,
      readNativeSession: async () => fullRead(),
      journalStore: ctx.journalStore,
      provenanceStore: ctx.provenanceStore,
      sessionStateStore,
    }),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionState,
  );
  assert.deepEqual(await sessionStateStore.load(SESSION_ID), restoreState);
  assert.equal(await ctx.journalStore.load(BACKEND, SESSION_ID), null);

  await assert.rejects(
    () => settlePendingSeedAppend({
      backend: BACKEND,
      sessionId: SESSION_ID,
      cwd: ctx.cwd,
      readNativeSession: async () => {
        throw new Error('Reader must not run when no pending evidence exists');
      },
      journalStore: ctx.journalStore,
      provenanceStore: ctx.provenanceStore,
      sessionStateStore,
    }),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionState,
  );
  assert.equal(sessionStateStore.confirmationCalls, 1);

  sessionStateStore.rejectConfirmation = false;
  const status = await settlePendingSeedAppend({
    backend: BACKEND,
    sessionId: SESSION_ID,
    cwd: ctx.cwd,
    readNativeSession: async () => {
      throw new Error('Reader must not run when no pending evidence exists');
    },
    journalStore: ctx.journalStore,
    provenanceStore: ctx.provenanceStore,
    sessionStateStore,
  });
  assert.equal(status, 'none');
  assert.equal(sessionStateStore.confirmationCalls, 2);
});

test('pending-none retry confirms journal absence after a journal-only retirement fsync failure', async () => {
  const ctx = await context();
  const pending = journal(ctx.provenance);
  await ctx.sessionStateStore.save({
    backend: BACKEND,
    backendSessionId: SESSION_ID,
    cwd: ctx.cwd,
    lastProviderSessionId: null,
    sessionLogPath: null,
    lastTurnId: 'turn-before-seed',
  });
  await ctx.journalStore.create(pending);

  class RetryJournalStore extends SeedAppendJournalStore {
    mode: 'post-remove-failure' | 'confirmation-failure' | 'normal' = 'post-remove-failure';
    removeCalls = 0;

    override async remove(backend: string, sessionId: string): Promise<void> {
      this.removeCalls += 1;
      if (this.mode === 'confirmation-failure') {
        throw new OpenPError('simulated journal absence fsync failure', EXIT_CODES.sessionState);
      }
      await super.remove(backend, sessionId);
      if (this.mode === 'post-remove-failure') {
        throw new OpenPError('simulated seed-pending directory fsync failure after unlink', EXIT_CODES.sessionState);
      }
    }
  }

  const retryStore = new RetryJournalStore(ctx.cwd, ctx.stateRoot);
  await assert.rejects(
    () => settlePendingSeedAppend({
      backend: BACKEND,
      sessionId: SESSION_ID,
      cwd: ctx.cwd,
      readNativeSession: async () => baseRead(),
      journalStore: retryStore,
      provenanceStore: ctx.provenanceStore,
      sessionStateStore: ctx.sessionStateStore,
    }),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionState,
  );
  assert.equal(retryStore.removeCalls, 1);
  assert.equal(await ctx.journalStore.load(BACKEND, SESSION_ID), null);

  retryStore.mode = 'confirmation-failure';
  await assert.rejects(
    () => settlePendingSeedAppend({
      backend: BACKEND,
      sessionId: SESSION_ID,
      cwd: ctx.cwd,
      readNativeSession: async () => {
        throw new Error('Reader must not run when no pending evidence exists');
      },
      journalStore: retryStore,
      provenanceStore: ctx.provenanceStore,
      sessionStateStore: ctx.sessionStateStore,
    }),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionState,
  );
  assert.equal(retryStore.removeCalls, 2);

  retryStore.mode = 'normal';
  const status = await settlePendingSeedAppend({
    backend: BACKEND,
    sessionId: SESSION_ID,
    cwd: ctx.cwd,
    readNativeSession: async () => {
      throw new Error('Reader must not run when no pending evidence exists');
    },
    journalStore: retryStore,
    provenanceStore: ctx.provenanceStore,
    sessionStateStore: ctx.sessionStateStore,
  });
  assert.equal(status, 'none');
  assert.equal(retryStore.removeCalls, 3);
});

test('pending settlement rejects partial, changed, extra, and conflicting state without repair', async () => {
  const cases: readonly {
    readonly name: string;
    readonly read: NativeSessionReadResult;
    readonly conflictProvenance?: boolean;
  }[] = [
    {
      name: 'content changed',
      read: {
        ...fullRead(),
        turns: [baseRead().turns[0]!, { ...fullRead().turns[1]!, assistantText: 'changed' }],
      },
    },
    {
      name: 'native id changed',
      read: {
        ...fullRead(),
        turns: [baseRead().turns[0]!, {
          ...fullRead().turns[1]!,
          nativeIds: { ...ids('written'), completionId: 'changed:completion' },
        }],
      },
    },
    {
      name: 'foreign extra suffix',
      read: {
        ...fullRead(),
        turns: [...fullRead().turns, {
          userText: 'foreign user',
          assistantText: 'foreign assistant',
          nativeIds: ids('foreign'),
        }],
      },
    },
    { name: 'conflicting provenance', read: fullRead(), conflictProvenance: true },
  ];

  for (const currentCase of cases) {
    const ctx = await context();
    const pending = journal(ctx.provenance);
    await ctx.journalStore.create(pending);
    if (currentCase.conflictProvenance) {
      await ctx.provenanceStore.save(withAppendedProvenanceEntries(ctx.provenance, {
        targetBackend: BACKEND,
        targetSessionId: SESSION_ID,
        sourceRefs: externalSourceRefs('e'.repeat(64), ['other-id']),
        written: [{
          logicalId: `ir:${'2'.repeat(64)}`,
          contentDigest: contentDigest('other user', 'other assistant'),
          nativeIds: ids('other'),
        }],
      }));
    }

    await assert.rejects(
      () => settlePendingSeedAppend({
        backend: BACKEND,
        sessionId: SESSION_ID,
        cwd: ctx.cwd,
        readNativeSession: async () => currentCase.read,
        journalStore: ctx.journalStore,
        provenanceStore: ctx.provenanceStore,
      }),
      (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.protocolViolation,
      currentCase.name,
    );
    await access(ctx.journalStore.pathForSession(BACKEND, SESSION_ID));
  }
});

test('pending settlement rejects hidden native tail evidence even when completed logical turns equal the base', async () => {
  const ctx = await context();
  await ctx.journalStore.create(journal(ctx.provenance));
  const readWithHiddenTail = {
    ...baseRead(),
    nativeStateDigest: 'f'.repeat(64),
  } as NativeSessionReadResult;

  await assert.rejects(
    () => settlePendingSeedAppend({
      backend: BACKEND,
      sessionId: SESSION_ID,
      cwd: ctx.cwd,
      readNativeSession: async () => readWithHiddenTail,
      journalStore: ctx.journalStore,
      provenanceStore: ctx.provenanceStore,
    }),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.protocolViolation,
  );
  await access(ctx.journalStore.pathForSession(BACKEND, SESSION_ID));
});

test('pending settlement does not hide a corrupt journal behind native reads', async () => {
  const ctx = await context();
  const path = ctx.journalStore.pathForSession(BACKEND, SESSION_ID);
  await ctx.journalStore.create(journal(ctx.provenance));
  await chmod(path, 0o600);
  await writeFile(path, JSON.stringify({ schemaVersion: 999 }), { mode: 0o600 });
  let readCalls = 0;

  await assert.rejects(
    () => settlePendingSeedAppend({
      backend: BACKEND,
      sessionId: SESSION_ID,
      cwd: ctx.cwd,
      readNativeSession: async () => {
        readCalls += 1;
        return fullRead();
      },
      journalStore: ctx.journalStore,
      provenanceStore: ctx.provenanceStore,
    }),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionState,
  );
  assert.equal(readCalls, 0);
  await access(path);
});

test('pending settlement rejects provenance count tampering before Reader access', async () => {
  const ctx = await context();
  const path = ctx.journalStore.pathForSession(BACKEND, SESSION_ID);
  await ctx.journalStore.create(journal(ctx.provenance));
  const value = JSON.parse(await readFile(path, 'utf8'));
  value.base.provenanceEntryCount += 1;
  await writeFile(path, JSON.stringify(value), { mode: 0o600 });
  let readCalls = 0;

  await assert.rejects(
    () => settlePendingSeedAppend({
      backend: BACKEND,
      sessionId: SESSION_ID,
      cwd: ctx.cwd,
      readNativeSession: async () => {
        readCalls += 1;
        return fullRead();
      },
      journalStore: ctx.journalStore,
      provenanceStore: ctx.provenanceStore,
    }),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionState,
  );
  assert.equal(readCalls, 0);
  await access(path);
});

test('pending settlement retains its journal when provenance has unknown or malformed fields', async () => {
  const corruptions: readonly ((value: any) => void)[] = [
    (value) => { value.unknown = true; },
    (value) => { value.createdAt = 'not-a-date'; },
    (value) => { value.bootstrap[0].assistantIds = []; },
  ];

  for (const corrupt of corruptions) {
    const ctx = await context();
    await ctx.journalStore.create(journal(ctx.provenance));
    const provenancePath = ctx.provenanceStore.pathForSession(BACKEND, SESSION_ID);
    const value = JSON.parse(await readFile(provenancePath, 'utf8'));
    corrupt(value);
    await writeFile(provenancePath, JSON.stringify(value), { mode: 0o600 });
    let readCalls = 0;

    await assert.rejects(
      () => settlePendingSeedAppend({
        backend: BACKEND,
        sessionId: SESSION_ID,
        cwd: ctx.cwd,
        readNativeSession: async () => {
          readCalls += 1;
          return fullRead();
        },
        journalStore: ctx.journalStore,
        provenanceStore: ctx.provenanceStore,
      }),
      (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionState,
    );
    assert.equal(readCalls, 0);
    await access(ctx.journalStore.pathForSession(BACKEND, SESSION_ID));
  }
});
