import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, chmod, mkdir, mkdtemp, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { EXIT_CODES, OpenPError } from '../src/core/errors.js';
import {
  SeedOperationReceiptStore,
  SeedOperationLockStore,
  createPreparedSeedOperationReceipt,
  formatSeedOperationStatus,
  nextSeedOperationPhase,
  type SeedOperationReceipt,
  type SeedOperationReceiptV2,
  type SeedOperationTargetEvidence,
} from '../src/core/seed-operation-receipt.js';

const OPERATION_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_OPERATION_ID = '22222222-2222-4222-8222-222222222222';
const DOCUMENT_DIGEST = 'd'.repeat(64);
const SOURCE_TURN_DIGEST = 'a'.repeat(64);
const BOOTSTRAP_DIGEST = 'b'.repeat(64);
const NATIVE_STATE_DIGEST = 'c'.repeat(64);
const PROVENANCE_DIGEST = 'e'.repeat(64);
const OPERATION_DOMAIN_DIGEST = 'f'.repeat(64);
const TARGET_STORAGE_DIGEST = '1'.repeat(64);

function prepared(operationId = OPERATION_ID): SeedOperationReceiptV2 {
  return createPreparedSeedOperationReceipt({
    operationId,
    binding: {
      schemaVersion: 1,
      operationDomainDigest: OPERATION_DOMAIN_DIGEST,
      source: { kind: 'external-ir' },
      target: { storageIdentityDigest: TARGET_STORAGE_DIGEST },
    },
    request: {
      targetBackend: 'target',
      source: { kind: 'external-ir', documentDigest: DOCUMENT_DIGEST },
      model: 'bootstrap-model',
      reasoningEffort: 'high',
      timeoutMs: 1234,
      cwd: '/workspace',
    },
    source: {
      output: { kind: 'external-ir', documentDigest: DOCUMENT_DIGEST },
      turnCount: 1,
      turnDigest: SOURCE_TURN_DIGEST,
    },
  });
}

function targetEvidence(): SeedOperationTargetEvidence {
  return {
    backend: 'target',
    sessionId: 'target-session',
    bootstrap: [{
      contentDigest: BOOTSTRAP_DIGEST,
      nativeIds: {
        userId: 'bootstrap:user',
        assistantIds: ['bootstrap:assistant'],
        completionId: 'bootstrap:complete',
      },
    }],
    nativeStateDigest: NATIVE_STATE_DIGEST,
    provenanceDigest: PROVENANCE_DIGEST,
  };
}

function succeeded(receipt: SeedOperationReceiptV2): SeedOperationReceiptV2 {
  return nextSeedOperationPhase(receipt, 'succeeded', {
    result: {
      source: receipt.source.output,
      target: { backend: 'target', sessionId: 'target-session' },
      appendedTurns: 1,
      mode: 'create',
      status: 'created',
    },
  });
}

async function context(): Promise<{ readonly cwd: string; readonly stateRoot: string; readonly store: SeedOperationReceiptStore }> {
  const cwd = await mkdtemp(join(tmpdir(), 'openp-seed-op-cwd-'));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-seed-op-state-'));
  return { cwd, stateRoot, store: new SeedOperationReceiptStore(cwd, stateRoot) };
}

test('seed operation receipt is private, strict, status-formatted, and transcript-free', async () => {
  const ctx = await context();
  const store = ctx.store;
  const first = prepared();
  await store.create(first);
  const creating = nextSeedOperationPhase(first, 'creating');
  await store.update(first, creating);
  const targetCreated = nextSeedOperationPhase(creating, 'target-created', { target: targetEvidence() });
  await store.update(creating, targetCreated);
  const final = succeeded(targetCreated);
  await store.update(targetCreated, final);

  assert.deepEqual(await store.load(OPERATION_ID), final);
  const path = store.pathForOperation(OPERATION_ID);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(dirname(path))).mode & 0o777, 0o700);
  const raw = await readFile(path, 'utf8');
  for (const forbidden of ['userText', 'assistantText']) {
    assert.equal(raw.includes(forbidden), false, `receipt leaked ${forbidden}`);
  }

  const line = formatSeedOperationStatus(final);
  const parsed = JSON.parse(line);
  assert.deepEqual(Object.keys(parsed), ['seedOperation']);
  assert.equal(parsed.seedOperation.operationId, OPERATION_ID);
  assert.equal(parsed.seedOperation.phase, 'succeeded');
  assert.equal(parsed.seedOperation.schemaVersion, 2);
  assert.equal(parsed.seedOperation.identityEvidence, 'recorded');
  assert.equal(parsed.seedOperation.binding, undefined);
  assert.equal(line.includes(OPERATION_DOMAIN_DIGEST), false);
  assert.equal(line.includes(TARGET_STORAGE_DIGEST), false);
  assert.equal(parsed.seedOperation.seed.status, 'created');
});

test('seed operation receipt first publication is no-replace and corruption is retained', async () => {
  const ctx = await context();
  const store = ctx.store;
  const first = prepared();
  await store.create(first);
  const before = await readFile(store.pathForOperation(OPERATION_ID), 'utf8');

  await assert.rejects(
    () => store.create(first),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionState,
  );
  assert.equal(await readFile(store.pathForOperation(OPERATION_ID), 'utf8'), before);

  await writeFile(store.pathForOperation(OPERATION_ID), '{broken', { mode: 0o600 });
  await assert.rejects(
    () => store.load(OPERATION_ID),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionState,
  );
  await access(store.pathForOperation(OPERATION_ID));
});

test('seed operation receipt rejects unknown keys, invalid UTF-8, loose permissions, and symlinks', async () => {
  const corruptions: readonly {
    readonly name: string;
    readonly mutate: (path: string, value: SeedOperationReceipt) => Promise<void>;
  }[] = [
    {
      name: 'unknown key',
      mutate: async (path, value) => {
        await writeFile(path, JSON.stringify({ ...value, unexpected: true }), { mode: 0o600 });
      },
    },
    {
      name: 'invalid UTF-8',
      mutate: async (path) => {
        await writeFile(path, Buffer.from([0x7b, 0x80, 0x7d]), { mode: 0o600 });
      },
    },
    {
      name: 'loose permissions',
      mutate: async (path) => {
        await chmod(path, 0o644);
      },
    },
    {
      name: 'empty optional request value',
      mutate: async (path, value) => {
        await writeFile(path, JSON.stringify({
          ...value,
          request: { ...value.request, model: '' },
        }), { mode: 0o600 });
      },
    },
    {
      name: 'unknown binding key',
      mutate: async (path, value) => {
        assert.equal(value.schemaVersion, 2);
        if (value.schemaVersion !== 2) throw new Error('expected v2 receipt');
        await writeFile(path, JSON.stringify({
          ...value,
          binding: { ...value.binding, unexpected: true },
        }), { mode: 0o600 });
      },
    },
    {
      name: 'invalid operation domain digest',
      mutate: async (path, value) => {
        assert.equal(value.schemaVersion, 2);
        if (value.schemaVersion !== 2) throw new Error('expected v2 receipt');
        await writeFile(path, JSON.stringify({
          ...value,
          binding: { ...value.binding, operationDomainDigest: 'not-a-digest' },
        }), { mode: 0o600 });
      },
    },
    {
      name: 'binding source kind mismatch',
      mutate: async (path, value) => {
        assert.equal(value.schemaVersion, 2);
        if (value.schemaVersion !== 2) throw new Error('expected v2 receipt');
        await writeFile(path, JSON.stringify({
          ...value,
          binding: {
            ...value.binding,
            source: { kind: 'native', storageIdentityDigest: '2'.repeat(64) },
          },
        }), { mode: 0o600 });
      },
    },
  ];

  for (const current of corruptions) {
    const ctx = await context();
    const store = ctx.store;
    const receipt = prepared();
    await store.create(receipt);
    const path = store.pathForOperation(OPERATION_ID);
    await current.mutate(path, receipt);
    await assert.rejects(
      () => store.load(OPERATION_ID),
      (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionState,
      current.name,
    );
    await access(path);
  }

  const ctx = await context();
  const symlinkStore = ctx.store;
  const symlinkPath = symlinkStore.pathForOperation(OTHER_OPERATION_ID);
  await mkdir(dirname(symlinkPath), { recursive: true, mode: 0o700 });
  await symlink('/tmp/openp-seed-operation-target', symlinkPath);
  await assert.rejects(
    () => symlinkStore.load(OTHER_OPERATION_ID),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionState,
  );

  const directoryCtx = await context();
  const directoryPath = dirname(directoryCtx.store.pathForOperation(OPERATION_ID));
  const symlinkTarget = await mkdtemp(join(tmpdir(), 'openp-seed-op-symlink-target-'));
  await writeFile(join(symlinkTarget, `${OPERATION_ID}.json`), `${JSON.stringify(prepared())}\n`, { mode: 0o600 });
  await symlink(symlinkTarget, directoryPath, 'dir');
  await assert.rejects(
    () => directoryCtx.store.load(OPERATION_ID),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionState,
  );

  const looseDirectoryCtx = await context();
  await looseDirectoryCtx.store.create(prepared());
  const looseDirectoryPath = dirname(looseDirectoryCtx.store.pathForOperation(OPERATION_ID));
  await chmod(looseDirectoryPath, 0o777);
  await assert.rejects(
    () => looseDirectoryCtx.store.load(OPERATION_ID),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionState,
  );
  assert.equal((await stat(looseDirectoryPath)).mode & 0o777, 0o777, 'invalid evidence must not be repaired');

  const oversizedCtx = await context();
  const oversizedPath = oversizedCtx.store.pathForOperation(OPERATION_ID);
  await mkdir(dirname(oversizedPath), { mode: 0o700 });
  await writeFile(oversizedPath, Buffer.alloc(64 * 1024 + 1, 0x20), { mode: 0o600 });
  await assert.rejects(
    () => oversizedCtx.store.load(OPERATION_ID),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionState,
  );

  const oversizedCreateCtx = await context();
  await assert.rejects(
    () => oversizedCreateCtx.store.create({
      ...prepared(),
      request: { ...prepared().request, model: 'm'.repeat(64 * 1024) },
    }),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionState,
  );
  await assert.rejects(() => access(oversizedCreateCtx.store.pathForOperation(OPERATION_ID)));
});

test('seed operation receipt enforces phase invariants and legal transitions', async () => {
  const ctx = await context();
  const store = ctx.store;
  const first = prepared();
  await store.create(first);
  const illegalSucceeded = nextSeedOperationPhase(first, 'succeeded', {
    target: targetEvidence(),
    result: {
      source: first.source.output,
      target: { backend: 'target', sessionId: 'target-session' },
      appendedTurns: 1,
      mode: 'create',
      status: 'created',
    },
  });
  await assert.rejects(
    () => store.update(first, illegalSucceeded),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionState,
  );

  const creating = nextSeedOperationPhase(first, 'creating');
  await assert.rejects(
    () => store.update(first, {
      ...creating,
      binding: {
        ...creating.binding,
        target: { storageIdentityDigest: '2'.repeat(64) },
      },
    }),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionState,
  );
  await assert.rejects(
    () => store.update(first, {
      ...creating,
      request: { ...creating.request, model: 'changed-model' },
    }),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionState,
  );
  await store.update(first, creating);
  const indeterminate = nextSeedOperationPhase(creating, 'indeterminate', {
    indeterminateReason: 'creating-owner-ended-before-target-id',
  });
  await store.update(creating, indeterminate);
  await assert.rejects(
    () => store.update(indeterminate, nextSeedOperationPhase(indeterminate, 'creating')),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionState,
  );

  const raw = {
    ...prepared(OTHER_OPERATION_ID),
    phase: 'target-created',
  };
  const badPath = store.pathForOperation(OTHER_OPERATION_ID);
  await writeFile(badPath, `${JSON.stringify(raw)}\n`, { mode: 0o600 });
  await assert.rejects(
    () => store.load(OTHER_OPERATION_ID),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionState,
  );
});

test('seed operation receipt rejects cross-field and immutable target corruption', async () => {
  const ctx = await context();
  const store = ctx.store;
  const first = prepared();
  await store.create(first);
  const creating = nextSeedOperationPhase(first, 'creating');
  await store.update(first, creating);
  const targetCreated = nextSeedOperationPhase(creating, 'target-created', { target: targetEvidence() });
  await store.update(creating, targetCreated);

  const changedTargetReceipt = {
    ...targetCreated,
    target: { ...targetCreated.target!, sessionId: 'different-target' },
  };
  const changedTarget = nextSeedOperationPhase(changedTargetReceipt, 'succeeded', {
    result: {
      source: targetCreated.source.output,
      target: { backend: 'target', sessionId: 'different-target' },
      appendedTurns: 1,
      mode: 'create',
      status: 'created',
    },
  });
  await assert.rejects(
    () => store.update(targetCreated, changedTarget),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionState,
  );

  const invalidCountPath = store.pathForOperation(OTHER_OPERATION_ID);
  const otherTargetCreated = nextSeedOperationPhase(
    nextSeedOperationPhase(prepared(OTHER_OPERATION_ID), 'creating'),
    'target-created',
    { target: targetEvidence() },
  );
  const invalidCount = {
    ...succeeded(otherTargetCreated),
    result: { ...succeeded(otherTargetCreated).result!, appendedTurns: 2 },
  };
  await writeFile(invalidCountPath, `${JSON.stringify(invalidCount)}\n`, { mode: 0o600 });
  await assert.rejects(
    () => store.load(OTHER_OPERATION_ID),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionState,
  );
});

test('seed operation receipt creation is private under a restrictive umask', async () => {
  const ctx = await context();
  const previousUmask = process.umask(0o777);
  try {
    const first = prepared();
    await ctx.store.create(first);
    const creating = nextSeedOperationPhase(first, 'creating');
    await ctx.store.update(first, creating);
  } finally {
    process.umask(previousUmask);
  }
  const path = ctx.store.pathForOperation(OPERATION_ID);
  assert.equal((await stat(dirname(path))).mode & 0o777, 0o700);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await ctx.store.load(OPERATION_ID))?.phase, 'creating');
});

test('seed operation lock rejects a symlinked namespace without changing its target', async () => {
  const ctx = await context();
  const target = await mkdtemp(join(tmpdir(), 'openp-seed-op-lock-target-'));
  const targetMode = (await stat(target)).mode & 0o777;
  await symlink(target, join(ctx.stateRoot, 'seed-operation-locks'), 'dir');
  const lockStore = new SeedOperationLockStore(ctx.cwd, ctx.stateRoot);

  await assert.rejects(
    () => lockStore.acquire(OPERATION_ID),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionState,
  );
  assert.equal((await stat(target)).mode & 0o777, targetMode);
  assert.deepEqual(await readdir(target), []);
});

test('seed operation receipt loads remain valid across concurrent phase renames', async () => {
  const ctx = await context();
  const operations = Array.from({ length: 8 }, () => randomUUID());
  await Promise.all(operations.map(async (operationId) => {
    const first = {
      ...prepared(operationId),
      request: { ...prepared(operationId).request, model: 'm'.repeat(48 * 1024) },
    };
    await ctx.store.create(first);
    const creating = nextSeedOperationPhase(first, 'creating');
    const targetCreated = nextSeedOperationPhase(creating, 'target-created', { target: targetEvidence() });
    const final = succeeded(targetCreated);
    const observedLoads = Promise.all(Array.from({ length: 12 }, async () => {
      const observed = await ctx.store.load(operationId);
      assert.ok(observed);
      assert.equal(observed.operationId, operationId);
      return observed.phase;
    }));
    const transitions = (async () => {
      await ctx.store.update(first, creating);
      await ctx.store.update(creating, targetCreated);
      await ctx.store.update(targetCreated, final);
    })();
    await Promise.all([observedLoads, transitions]);
    assert.equal((await ctx.store.load(operationId))?.phase, 'succeeded');
  }));
});
