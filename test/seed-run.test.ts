import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type {
  AppendSessionHistoryInput,
  AppendSessionHistoryResult,
  Backend,
  BackendProvider,
  BackendWorkerBridge,
  NativeSessionReadResult,
  NativeSessionTurn,
  NativeTurnIds,
  NativeWrittenTurn,
  ReadNativeSessionInput,
} from '../src/core/backend.js';
import type { BackendRunOptions, TurnRequest, TurnResult } from '../src/core/types.js';
import { createAbortError, isAbortError } from '../src/core/abort.js';
import { CODEX_DESCRIPTOR } from '../src/backends/codex/descriptor.js';
import { EXIT_CODES, OpenPError } from '../src/core/errors.js';
import { SessionLockStore } from '../src/core/session-lock.js';
import { SessionStateStore } from '../src/core/session-state.js';
import { resolveOpenPStateRoot } from '../src/core/state-root.js';
import { runSeed, settleProviderPending } from '../src/core/seed.js';
import { SeedAppendJournalStore } from '../src/core/seed-append-journal.js';
import { SeedProvenanceStore, createInitialProvenanceState, nativeSourceRefs, withAppendedProvenanceEntries } from '../src/core/seed-provenance.js';
import { contentDigest, logicalTurnsFromNative } from '../src/core/seed-ir.js';
import { digestNativeState } from '../src/core/native-state-digest.js';
import {
  SeedOperationLockStore,
  SeedOperationReceiptStore,
  formatSeedOperationStatus,
} from '../src/core/seed-operation-receipt.js';

function nativeIds(prefix: string): NativeTurnIds {
  return {
    userId: `${prefix}:user`,
    assistantIds: [`${prefix}:assistant`],
    completionId: `${prefix}:complete`,
  };
}

function nativeTurn(prefix: string, userText = `user ${prefix}`, assistantText = `assistant ${prefix}`): NativeSessionTurn {
  return { userText, assistantText, nativeIds: nativeIds(prefix) };
}

function fakeNativeStateDigest(turns: readonly NativeSessionTurn[]): string {
  return digestNativeState('fake-seed-provider-v1', [Buffer.from(JSON.stringify(turns), 'utf8')]);
}

function result(turnId: string, sessionId: string): TurnResult {
  return {
    turnId,
    text: 'OK',
    reasoningContent: null,
    structuredOutput: undefined,
    requestId: null,
    sessionId,
    assistantEvents: [],
    warnings: [],
    diagnostics: {
      durationMs: 1,
      stopReason: null,
      toolsUsed: [],
      usage: { inputTokens: null, cacheReadInputTokens: null, outputTokens: null },
      rawEventCount: 0,
    },
  };
}

interface RunTurnCall {
  readonly request: TurnRequest;
  readonly options: BackendRunOptions;
}

class FakeBackend implements Backend {
  constructor(
    private readonly backendId: string,
    private readonly sessionId: string,
    private readonly reads: Map<string, NativeSessionReadResult>,
    private readonly runCalls: RunTurnCall[],
    private readonly beforeRun: (() => Promise<void>) | undefined,
    private readonly afterRun: (() => Promise<void>) | undefined,
  ) {}

  async runTurn(request: TurnRequest, options: BackendRunOptions): Promise<TurnResult> {
    await this.beforeRun?.();
    this.runCalls.push({ request, options });
    this.reads.set(this.sessionId, {
      backend: this.backendId,
      sessionId: this.sessionId,
      turns: [nativeTurn('bootstrap', 'Reply with only: OK', 'OK')],
    });
    await this.afterRun?.();
    return result(request.turnId, this.sessionId);
  }
}

class FakeProvider implements BackendProvider {
  readonly descriptor;
  readonly appended: NativeWrittenTurn[] = [];
  readonly runCalls: RunTurnCall[] = [];
  readonly readCalls: string[] = [];
  readonly readInputs: ReadNativeSessionInput[] = [];
  preparedCount = 0;
  commitCount = 0;
  cleanupCount = 0;
  readonly cleanupPreparedSessionHistoryAppend?: NonNullable<BackendProvider['cleanupPreparedSessionHistoryAppend']>;

  constructor(
    readonly id: string,
    private readonly reads: Map<string, NativeSessionReadResult>,
    private readonly createSessionId = 'created-session',
    private readonly corruptWrittenTurn = false,
    private readonly hooks: {
      readonly afterRun?: () => Promise<void>;
      readonly beforeRun?: () => Promise<void>;
      readonly failAppend?: OpenPError;
      readonly afterAppend?: () => Promise<void>;
      readonly beforeNativeMutation?: () => Promise<void>;
      readonly postWriteCleanupFailure?: AppendSessionHistoryResult['postWriteCleanupFailure'];
      readonly writtenNativeIds?: (index: number) => NativeTurnIds;
      readonly resultSessionId?: string;
      readonly settlementReadFailure?: Error;
      readonly transformNativeRead?: (
        read: NativeSessionReadResult,
        input: ReadNativeSessionInput,
      ) => NativeSessionReadResult;
      readonly hasCleanupCapability?: boolean;
      readonly beforeCleanup?: () => Promise<void>;
      readonly preparedCleanupToken?: string | null;
    } = {},
  ) {
    this.descriptor = { ...CODEX_DESCRIPTOR, id, label: id };
    if (hooks.postWriteCleanupFailure || hooks.hasCleanupCapability) {
      this.cleanupPreparedSessionHistoryAppend = async () => {
        await hooks.beforeCleanup?.();
        this.cleanupCount += 1;
      };
    }
  }

  createBackend(): Backend {
    return new FakeBackend(this.id, this.createSessionId, this.reads, this.runCalls, this.hooks.beforeRun, this.hooks.afterRun);
  }

  createWorkerBridge(): BackendWorkerBridge {
    throw new Error('not used');
  }

  async resolveSessionLogPath(): Promise<string | null> {
    return null;
  }

  async readNativeSession(input: ReadNativeSessionInput): Promise<NativeSessionReadResult> {
    this.readCalls.push(input.sessionId);
    this.readInputs.push(input);
    if (input.mode === 'settlement' && this.hooks.settlementReadFailure) {
      throw this.hooks.settlementReadFailure;
    }
    const read = this.reads.get(input.sessionId);
    assert.ok(read, `missing fake native read for ${input.sessionId}`);
    const completeRead = { ...read, nativeStateDigest: fakeNativeStateDigest(read.turns) };
    return this.hooks.transformNativeRead?.(completeRead, input) ?? completeRead;
  }

  async appendSessionHistory(input: AppendSessionHistoryInput): Promise<AppendSessionHistoryResult> {
    if (this.hooks.failAppend) {
      throw this.hooks.failAppend;
    }
    const read = this.reads.get(input.sessionId);
    assert.ok(read, `missing fake target read for ${input.sessionId}`);
    const written = input.turns.map((turn, index): NativeWrittenTurn => ({
      logicalId: this.corruptWrittenTurn ? `corrupt:${turn.logicalId}` : turn.logicalId,
      contentDigest: turn.contentDigest,
      nativeIds: this.hooks.writtenNativeIds?.(index) ?? nativeIds(`written-${this.appended.length + index}`),
    }));
    const candidateTurns = [
      ...read.turns,
      ...input.turns.map((turn, index) => ({
        userText: turn.userText,
        assistantText: turn.assistantText,
        nativeIds: written[index]!.nativeIds,
      })),
    ];
    const cleanupToken = this.hooks.preparedCleanupToken === null
      ? undefined
      : this.hooks.preparedCleanupToken ??
        (this.cleanupPreparedSessionHistoryAppend ? randomUUID() : undefined);
    await input.persistPreparedAppend({
      before: read.turns,
      beforeNativeStateDigest: fakeNativeStateDigest(read.turns),
      candidateNativeStateDigest: fakeNativeStateDigest(candidateTurns),
      turns: written,
      ...(cleanupToken ? { cleanupToken } : {}),
    });
    this.preparedCount += 1;
    await this.hooks.beforeNativeMutation?.();
    this.commitCount += 1;
    this.reads.set(input.sessionId, {
      ...read,
      turns: candidateTurns,
    });
    this.appended.push(...written);
    await this.hooks.afterAppend?.();
    return {
      sessionId: this.hooks.resultSessionId ?? input.sessionId,
      turns: written,
      ...(this.hooks.postWriteCleanupFailure
        ? { postWriteCleanupFailure: this.hooks.postWriteCleanupFailure }
        : {}),
    };
  }
}

test('core rejects cleanup capability/token mismatches before seed-native mutation', async () => {
  for (const currentCase of [
    { name: 'token without capability', hooks: { preparedCleanupToken: randomUUID() } },
    { name: 'capability without token', hooks: { hasCleanupCapability: true, preparedCleanupToken: null } },
    { name: 'non-UUID token', hooks: { hasCleanupCapability: true, preparedCleanupToken: '../../artifact' } },
  ] as const) {
    await withStateRoot(async (projectRoot, stateRoot) => {
      const reads = new Map<string, NativeSessionReadResult>();
      const provider = new FakeProvider('target', reads, 'created-session', false, currentCase.hooks);
      const irPath = join(projectRoot, 'ir.json');
      await writeFile(irPath, JSON.stringify({
        schemaVersion: 1,
        turns: [{ id: currentCase.name, user: { text: 'seed user' }, assistant: { text: 'seed assistant' } }],
      }));

      await assert.rejects(
        () => runSeed({
          options: {
            backend: 'target',
            source: { kind: 'external-ir', path: irPath },
            resume: false,
            backendSessionId: null,
            model: null,
            reasoningEffort: null,
            timeoutMs: 0,
          },
          provider,
          sourceProvider: null,
          createBackend: () => provider.createBackend(),
          cwd: projectRoot,
          debugLog: null,
          signal: new AbortController().signal,
          forceSignal: new AbortController().signal,
          killSignal: new AbortController().signal,
        }),
        (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.protocolViolation,
        currentCase.name,
      );

      assert.equal(provider.preparedCount, 0, currentCase.name);
      assert.equal(provider.commitCount, 0, currentCase.name);
      assert.equal(await new SeedAppendJournalStore(projectRoot, stateRoot).load('target', 'created-session'), null);
      assert.equal(await new SessionStateStore(projectRoot, stateRoot).loadPendingSeedAppendMarker('created-session'), null);
      assert.equal((await new SessionStateStore(projectRoot, stateRoot).load('created-session'))?.schemaVersion, 1);
    });
  }
});

test('create mode rejects a native source with no portable turns before target creation', async () => {
  await withStateRoot(async (projectRoot) => {
    const reads = new Map<string, NativeSessionReadResult>([[
      'source-session',
      { backend: 'source', sessionId: 'source-session', turns: [] },
    ]]);
    const targetProvider = new FakeProvider('target', reads);
    const sourceProvider = new FakeProvider('source', reads);
    let createCalls = 0;

    await assert.rejects(
      () => runSeed({
        options: {
          backend: 'target',
          source: { kind: 'native', backend: 'source', sessionId: 'source-session' },
          resume: false,
          backendSessionId: null,
          model: null,
          reasoningEffort: null,
          timeoutMs: 0,
        },
        provider: targetProvider,
        sourceProvider,
        createBackend: () => {
          createCalls += 1;
          return targetProvider.createBackend();
        },
        cwd: projectRoot,
        debugLog: null,
        signal: new AbortController().signal,
        forceSignal: new AbortController().signal,
        killSignal: new AbortController().signal,
      }),
      (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.protocolViolation,
    );

    assert.equal(createCalls, 0);
    assert.equal(targetProvider.runCalls.length, 0);
    assert.equal(reads.has('created-session'), false);
  });
});

test('a committed native suffix with missing provenance is settled on the next seed access without duplication', async () => {
  await withStateRoot(async (projectRoot, stateRoot) => {
    const sourceRead: NativeSessionReadResult = {
      backend: 'source',
      sessionId: 'source-session',
      turns: [nativeTurn('source-1')],
    };
    const reads = new Map<string, NativeSessionReadResult>([['source-session', sourceRead]]);
    let crashOnce = true;
    const firstTarget = new FakeProvider('target', reads, 'created-session', false, {
      afterAppend: async () => {
        if (crashOnce) {
          crashOnce = false;
          throw new OpenPError('simulated crash after native commit', EXIT_CODES.sessionState);
        }
      },
    });
    const sourceProvider = new FakeProvider('source', reads);

    await assert.rejects(() => runSeed({
      options: {
        backend: 'target',
        source: { kind: 'native', backend: 'source', sessionId: 'source-session' },
        resume: false,
        backendSessionId: null,
        model: null,
        reasoningEffort: null,
        timeoutMs: 0,
      },
      provider: firstTarget,
      sourceProvider,
      createBackend: () => firstTarget.createBackend(),
      cwd: projectRoot,
      debugLog: null,
      signal: new AbortController().signal,
      forceSignal: new AbortController().signal,
      killSignal: new AbortController().signal,
    }));

    assert.equal(firstTarget.commitCount, 1);
    assert.equal(reads.get('created-session')?.turns.length, 2);
    const provenanceAfterCrash = await new SeedProvenanceStore(projectRoot, stateRoot)
      .load('target', 'created-session');
    assert.equal(provenanceAfterCrash?.entries.length, 0);
    const journalStore = new SeedAppendJournalStore(projectRoot, stateRoot);
    const pending = await journalStore.load('target', 'created-session');
    assert.equal(pending?.planned.length, 1);

    const resumedTarget = new FakeProvider('target', reads);
    const resumed = await runSeed({
      options: {
        backend: 'target',
        source: { kind: 'native', backend: 'source', sessionId: 'source-session' },
        resume: true,
        backendSessionId: 'created-session',
        model: null,
        reasoningEffort: null,
        timeoutMs: 0,
      },
      provider: resumedTarget,
      sourceProvider,
      createBackend: () => resumedTarget.createBackend(),
      cwd: projectRoot,
      debugLog: null,
      signal: new AbortController().signal,
      forceSignal: new AbortController().signal,
      killSignal: new AbortController().signal,
    });

    assert.equal(resumed.status, 'noop');
    assert.equal(resumed.appendedTurns, 0);
    assert.equal(resumedTarget.commitCount, 0);
    assert.equal(reads.get('created-session')?.turns.length, 2);
    assert.equal((await new SeedProvenanceStore(projectRoot, stateRoot)
      .load('target', 'created-session'))?.entries.length, 1);
    assert.equal(await journalStore.load('target', 'created-session'), null);
  });
});

test('a pending committed session settles before it is read as the native source for a new target', async () => {
  await withStateRoot(async (projectRoot, stateRoot) => {
    const originRead: NativeSessionReadResult = {
      backend: 'origin',
      sessionId: 'origin-session',
      turns: [nativeTurn('origin-1')],
    };
    const originTurns = logicalTurnsFromNative(originRead);
    const reads = new Map<string, NativeSessionReadResult>([['origin-session', originRead]]);
    const originProvider = new FakeProvider('origin', reads);
    const pendingSourceProvider = new FakeProvider('source', reads, 'pending-source', false, {
      afterAppend: async () => {
        throw new OpenPError('simulated crash after source native commit', EXIT_CODES.sessionState);
      },
    });

    await assert.rejects(() => runSeed({
      options: {
        backend: 'source',
        source: { kind: 'native', backend: 'origin', sessionId: 'origin-session' },
        resume: false,
        backendSessionId: null,
        model: null,
        reasoningEffort: null,
        timeoutMs: 0,
      },
      provider: pendingSourceProvider,
      sourceProvider: originProvider,
      createBackend: () => pendingSourceProvider.createBackend(),
      cwd: projectRoot,
      debugLog: null,
      signal: new AbortController().signal,
      forceSignal: new AbortController().signal,
      killSignal: new AbortController().signal,
    }));

    const journalStore = new SeedAppendJournalStore(projectRoot, stateRoot);
    const provenanceStore = new SeedProvenanceStore(projectRoot, stateRoot);
    const stateStore = new SessionStateStore(projectRoot, stateRoot);
    assert.equal((await journalStore.load('source', 'pending-source'))?.planned.length, 1);
    assert.equal((await provenanceStore.load('source', 'pending-source'))?.entries.length, 0);
    assert.equal((await stateStore.loadPendingSeedAppendMarker('pending-source'))?.schemaVersion, 2);

    const sourceProvider = new FakeProvider('source', reads, 'unused-source-create');
    const targetProvider = new FakeProvider('target', reads, 'new-target');
    const seeded = await runSeed({
      options: {
        backend: 'target',
        source: { kind: 'native', backend: 'source', sessionId: 'pending-source' },
        resume: false,
        backendSessionId: null,
        model: null,
        reasoningEffort: null,
        timeoutMs: 0,
      },
      provider: targetProvider,
      sourceProvider,
      createBackend: () => targetProvider.createBackend(),
      cwd: projectRoot,
      debugLog: null,
      signal: new AbortController().signal,
      forceSignal: new AbortController().signal,
      killSignal: new AbortController().signal,
    });

    assert.equal(seeded.status, 'created');
    assert.equal(seeded.appendedTurns, 1);
    assert.deepEqual(targetProvider.appended.map((turn) => turn.logicalId), [originTurns[0]!.logicalId]);
    assert.equal(reads.get('new-target')?.turns.length, 2);
    assert.equal((await provenanceStore.load('source', 'pending-source'))?.entries.length, 1);
    assert.equal(await journalStore.load('source', 'pending-source'), null);
    assert.equal(await stateStore.loadPendingSeedAppendMarker('pending-source'), null);
  });
});

test('same native source and target settles a pending committed suffix before returning no-op', async () => {
  await withStateRoot(async (projectRoot, stateRoot) => {
    const sourceRead: NativeSessionReadResult = {
      backend: 'source',
      sessionId: 'source-session',
      turns: [nativeTurn('source-1')],
    };
    const reads = new Map<string, NativeSessionReadResult>([['source-session', sourceRead]]);
    const sourceProvider = new FakeProvider('source', reads);
    const crashingTarget = new FakeProvider('target', reads, 'same-session', false, {
      afterAppend: async () => {
        throw new OpenPError('simulated crash after same-session native commit', EXIT_CODES.sessionState);
      },
    });

    await assert.rejects(() => runSeed({
      options: {
        backend: 'target',
        source: { kind: 'native', backend: 'source', sessionId: 'source-session' },
        resume: false,
        backendSessionId: null,
        model: null,
        reasoningEffort: null,
        timeoutMs: 0,
      },
      provider: crashingTarget,
      sourceProvider,
      createBackend: () => crashingTarget.createBackend(),
      cwd: projectRoot,
      debugLog: null,
      signal: new AbortController().signal,
      forceSignal: new AbortController().signal,
      killSignal: new AbortController().signal,
    }));

    const resumedProvider = new FakeProvider('target', reads);
    const seed = await runSeed({
      options: {
        backend: 'target',
        source: { kind: 'native', backend: 'target', sessionId: 'same-session' },
        resume: true,
        backendSessionId: 'same-session',
        model: null,
        reasoningEffort: null,
        timeoutMs: 0,
      },
      provider: resumedProvider,
      sourceProvider: resumedProvider,
      createBackend: () => resumedProvider.createBackend(),
      cwd: projectRoot,
      debugLog: null,
      signal: new AbortController().signal,
      forceSignal: new AbortController().signal,
      killSignal: new AbortController().signal,
    });

    assert.equal(seed.status, 'noop');
    assert.equal(seed.appendedTurns, 0);
    assert.equal(resumedProvider.commitCount, 0);
    assert.equal(reads.get('same-session')?.turns.length, 2);
    assert.equal((await new SeedProvenanceStore(projectRoot, stateRoot)
      .load('target', 'same-session'))?.entries.length, 1);
    assert.equal(await new SeedAppendJournalStore(projectRoot, stateRoot)
      .load('target', 'same-session'), null);
    assert.equal(await new SessionStateStore(projectRoot, stateRoot)
      .loadPendingSeedAppendMarker('same-session'), null);
  });
});

test('pending journal persistence failure leaves the bootstrapped native session untouched', async () => {
  await withStateRoot(async (projectRoot, stateRoot) => {
    const sourceRead: NativeSessionReadResult = {
      backend: 'source',
      sessionId: 'source-session',
      turns: [nativeTurn('source-1')],
    };
    const reads = new Map<string, NativeSessionReadResult>([['source-session', sourceRead]]);
    const provider = new FakeProvider('target', reads, 'created-session', false, {
      afterRun: async () => {
        await mkdir(stateRoot, { recursive: true });
        await writeFile(join(stateRoot, 'seed-pending'), 'not a directory');
      },
    });
    const sourceProvider = new FakeProvider('source', reads);

    await assert.rejects(
      () => runSeed({
        options: {
          backend: 'target',
          source: { kind: 'native', backend: 'source', sessionId: 'source-session' },
          resume: false,
          backendSessionId: null,
          model: null,
          reasoningEffort: null,
          timeoutMs: 0,
        },
        provider,
        sourceProvider,
        createBackend: () => provider.createBackend(),
        cwd: projectRoot,
        debugLog: null,
        signal: new AbortController().signal,
        forceSignal: new AbortController().signal,
        killSignal: new AbortController().signal,
      }),
      (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionState,
    );

    assert.equal(provider.preparedCount, 0);
    assert.equal(provider.commitCount, 0);
    assert.deepEqual(reads.get('created-session')?.turns.map((turn) => turn.nativeIds.userId), [
      nativeIds('bootstrap').userId,
    ]);
    assert.equal((await new SeedProvenanceStore(projectRoot, stateRoot)
      .load('target', 'created-session'))?.entries.length, 0);
  });
});

test('seed append publishes pending session marker and journal before native mutation', async () => {
  await withStateRoot(async (projectRoot, stateRoot) => {
    const sourceRead: NativeSessionReadResult = {
      backend: 'source',
      sessionId: 'source-session',
      turns: [nativeTurn('source-1')],
    };
    const reads = new Map<string, NativeSessionReadResult>([['source-session', sourceRead]]);
    const provider = new FakeProvider('target', reads, 'created-session', false, {
      beforeNativeMutation: async () => {
        const stateStore = new SessionStateStore(projectRoot, stateRoot);
        await assert.rejects(
          () => stateStore.load('created-session'),
          (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionState,
        );
        const marker = await stateStore.loadPendingSeedAppendMarker('created-session');
        assert.equal(marker?.seedAppendJournal.planned.length, 1);
        assert.equal(
          (await new SeedAppendJournalStore(projectRoot, stateRoot).load('target', 'created-session'))?.operationId,
          marker?.operationId,
        );
        assert.deepEqual(reads.get('created-session')?.turns.map((turn) => turn.nativeIds.userId), [
          nativeIds('bootstrap').userId,
        ]);
      },
    });
    const sourceProvider = new FakeProvider('source', reads);

    const seed = await runSeed({
      options: {
        backend: 'target',
        source: { kind: 'native', backend: 'source', sessionId: 'source-session' },
        resume: false,
        backendSessionId: null,
        model: null,
        reasoningEffort: null,
        timeoutMs: 0,
      },
      provider,
      sourceProvider,
      createBackend: () => provider.createBackend(),
      cwd: projectRoot,
      debugLog: null,
      signal: new AbortController().signal,
      forceSignal: new AbortController().signal,
      killSignal: new AbortController().signal,
    });

    assert.equal(seed.status, 'created');
    assert.equal(await new SessionStateStore(projectRoot, stateRoot).loadPendingSeedAppendMarker('created-session'), null);
  });
});

test('a journaled append stopped before native mutation is retired before one explicit retry', async () => {
  await withStateRoot(async (projectRoot, stateRoot) => {
    const sourceRead: NativeSessionReadResult = {
      backend: 'source',
      sessionId: 'source-session',
      turns: [nativeTurn('source-1')],
    };
    const reads = new Map<string, NativeSessionReadResult>([['source-session', sourceRead]]);
    const interruptedTarget = new FakeProvider('target', reads, 'created-session', false, {
      beforeNativeMutation: async () => {
        throw new OpenPError('simulated stop before native mutation', EXIT_CODES.sessionState);
      },
    });
    const sourceProvider = new FakeProvider('source', reads);

    await assert.rejects(() => runSeed({
      options: {
        backend: 'target',
        source: { kind: 'native', backend: 'source', sessionId: 'source-session' },
        resume: false,
        backendSessionId: null,
        model: null,
        reasoningEffort: null,
        timeoutMs: 0,
      },
      provider: interruptedTarget,
      sourceProvider,
      createBackend: () => interruptedTarget.createBackend(),
      cwd: projectRoot,
      debugLog: null,
      signal: new AbortController().signal,
      forceSignal: new AbortController().signal,
      killSignal: new AbortController().signal,
    }));

    const journalStore = new SeedAppendJournalStore(projectRoot, stateRoot);
    assert.equal(interruptedTarget.preparedCount, 1);
    assert.equal(interruptedTarget.commitCount, 0);
    assert.equal(reads.get('created-session')?.turns.length, 1);
    assert.equal((await journalStore.load('target', 'created-session'))?.planned.length, 1);

    const retryTarget = new FakeProvider('target', reads);
    const retried = await runSeed({
      options: {
        backend: 'target',
        source: { kind: 'native', backend: 'source', sessionId: 'source-session' },
        resume: true,
        backendSessionId: 'created-session',
        model: null,
        reasoningEffort: null,
        timeoutMs: 0,
      },
      provider: retryTarget,
      sourceProvider,
      createBackend: () => retryTarget.createBackend(),
      cwd: projectRoot,
      debugLog: null,
      signal: new AbortController().signal,
      forceSignal: new AbortController().signal,
      killSignal: new AbortController().signal,
    });

    assert.equal(retried.status, 'updated');
    assert.equal(retried.appendedTurns, 1);
    assert.equal(retryTarget.commitCount, 1);
    assert.equal(reads.get('created-session')?.turns.length, 2);
    assert.equal((await new SeedProvenanceStore(projectRoot, stateRoot)
      .load('target', 'created-session'))?.entries.length, 1);
    assert.equal(await journalStore.load('target', 'created-session'), null);
  });
});

test('post-write Reader divergence fails closed and remains blocked on the next access', async () => {
  await withStateRoot(async (projectRoot, stateRoot) => {
    const sourceRead: NativeSessionReadResult = {
      backend: 'source',
      sessionId: 'source-session',
      turns: [nativeTurn('source-1')],
    };
    const reads = new Map<string, NativeSessionReadResult>([['source-session', sourceRead]]);
    const divergentTarget = new FakeProvider('target', reads, 'created-session', false, {
      afterAppend: async () => {
        const committed = reads.get('created-session');
        assert.ok(committed);
        reads.set('created-session', {
          ...committed,
          turns: [...committed.turns, nativeTurn('foreign-extra')],
        });
      },
    });
    const sourceProvider = new FakeProvider('source', reads);

    await assert.rejects(
      () => runSeed({
        options: {
          backend: 'target',
          source: { kind: 'native', backend: 'source', sessionId: 'source-session' },
          resume: false,
          backendSessionId: null,
          model: null,
          reasoningEffort: null,
          timeoutMs: 0,
        },
        provider: divergentTarget,
        sourceProvider,
        createBackend: () => divergentTarget.createBackend(),
        cwd: projectRoot,
        debugLog: null,
        signal: new AbortController().signal,
        forceSignal: new AbortController().signal,
        killSignal: new AbortController().signal,
      }),
      (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.protocolViolation,
    );

    const journalStore = new SeedAppendJournalStore(projectRoot, stateRoot);
    assert.equal(divergentTarget.commitCount, 1);
    assert.equal(reads.get('created-session')?.turns.length, 3);
    assert.equal((await new SeedProvenanceStore(projectRoot, stateRoot)
      .load('target', 'created-session'))?.entries.length, 0);
    assert.equal((await journalStore.load('target', 'created-session'))?.planned.length, 1);

    const blockedTarget = new FakeProvider('target', reads);
    await assert.rejects(
      () => runSeed({
        options: {
          backend: 'target',
          source: { kind: 'native', backend: 'source', sessionId: 'source-session' },
          resume: true,
          backendSessionId: 'created-session',
          model: null,
          reasoningEffort: null,
          timeoutMs: 0,
        },
        provider: blockedTarget,
        sourceProvider,
        createBackend: () => blockedTarget.createBackend(),
        cwd: projectRoot,
        debugLog: null,
        signal: new AbortController().signal,
        forceSignal: new AbortController().signal,
        killSignal: new AbortController().signal,
      }),
      (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.protocolViolation,
    );
    assert.equal(blockedTarget.preparedCount, 0);
    assert.equal(blockedTarget.commitCount, 0);
    assert.equal((await journalStore.load('target', 'created-session'))?.planned.length, 1);
  });
});

async function withStateRoot<T>(fn: (projectRoot: string, stateRoot: string) => Promise<T>): Promise<T> {
  const previous = process.env.XDG_STATE_HOME;
  const projectRoot = await mkdtemp(join(tmpdir(), 'openp-seed-run-cwd-'));
  const xdgStateHome = await mkdtemp(join(tmpdir(), 'openp-seed-run-state-'));
  const stateRoot = resolveOpenPStateRoot(projectRoot, { XDG_STATE_HOME: xdgStateHome });
  process.env.XDG_STATE_HOME = xdgStateHome;
  try {
    return await fn(projectRoot, stateRoot);
  } finally {
    if (previous === undefined) {
      delete process.env.XDG_STATE_HOME;
    } else {
      process.env.XDG_STATE_HOME = previous;
    }
  }
}

test('create mode bootstraps target, appends external IR, and stores provenance without transcript text', async () => {
  await withStateRoot(async (projectRoot, stateRoot) => {
    const reads = new Map<string, NativeSessionReadResult>();
    const store = new SeedProvenanceStore(projectRoot, stateRoot);
    const provider = new FakeProvider('target', reads);
    const irPath = join(projectRoot, 'ir.json');
    await writeFile(irPath, JSON.stringify({
      schemaVersion: 1,
      turns: [{
        id: 'sensitive caller transcript in external id',
        user: { text: 'codename REDMOON' },
        assistant: { text: 'noted' },
      }],
    }));

    const seed = await runSeed({
      options: {
        backend: 'target',
        source: { kind: 'external-ir', path: irPath },
        resume: false,
        backendSessionId: null,
        model: 'bootstrap-model',
        reasoningEffort: 'bootstrap-effort',
        timeoutMs: 123,
      },
      provider,
      sourceProvider: null,
      createBackend: () => provider.createBackend(),
      cwd: projectRoot,
      debugLog: '/tmp/openp-seed-debug.jsonl',
      signal: new AbortController().signal,
      forceSignal: new AbortController().signal,
      killSignal: new AbortController().signal,
    });

    assert.equal(seed.status, 'created');
    assert.equal(seed.appendedTurns, 1);
    assert.equal(provider.appended.length, 1);
    assert.equal(provider.runCalls.length, 1);
    assert.equal(provider.runCalls[0]!.request.prompt, 'Reply with only: OK');
    assert.equal(provider.runCalls[0]!.request.jsonSchema, null);
    assert.equal(provider.runCalls[0]!.options.resume, false);
    assert.equal(provider.runCalls[0]!.options.model, 'bootstrap-model');
    assert.equal(provider.runCalls[0]!.options.reasoningEffort, 'bootstrap-effort');
    assert.equal(provider.runCalls[0]!.options.timeoutMs, 123);
    assert.equal(provider.runCalls[0]!.options.permissionMode, null);
    assert.equal(provider.runCalls[0]!.options.tools, null);
    assert.equal(provider.runCalls[0]!.options.jsonSchema, null);
    assert.deepEqual(provider.runCalls[0]!.options.backendArgs, []);
    assert.equal(provider.runCalls[0]!.options.debugLog, '/tmp/openp-seed-debug.jsonl');
    const provenance = await store.load('target', 'created-session');
    assert.equal(provenance?.bootstrap.length, 1);
    assert.equal(provenance?.entries.length, 1);
    assert.equal(provenance?.entries[0]!.source.kind, 'external-ir');
    const stored = await readFile(store.pathForSession('target', 'created-session'), 'utf8');
    assert.equal(stored.includes('codename REDMOON'), false);
    assert.equal(stored.includes('sensitive caller transcript in external id'), false);
  });
});

test('post-commit cleanup failure is surfaced only after provenance is durable', async () => {
  await withStateRoot(async (projectRoot, stateRoot) => {
    const reads = new Map<string, NativeSessionReadResult>();
    const provider = new FakeProvider('target', reads, 'created-session', false, {
      postWriteCleanupFailure: { message: 'transient transcript cleanup blocked' },
    });
    const irPath = join(projectRoot, 'ir.json');
    await writeFile(irPath, JSON.stringify({
      schemaVersion: 1,
      turns: [{ id: 'one', user: { text: 'remember one' }, assistant: { text: 'noted one' } }],
    }));

    await assert.rejects(
      () => runSeed({
        options: {
          backend: 'target',
          source: { kind: 'external-ir', path: irPath },
          resume: false,
          backendSessionId: null,
          model: null,
          reasoningEffort: null,
          timeoutMs: 0,
        },
        provider,
        sourceProvider: null,
        createBackend: () => provider.createBackend(),
        cwd: projectRoot,
        debugLog: null,
        signal: new AbortController().signal,
        forceSignal: new AbortController().signal,
        killSignal: new AbortController().signal,
      }),
      (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionState &&
        error.message.includes('native append and provenance were saved') &&
        error.message.includes('session created-session was created') &&
        error.details?.provenanceSaved === true &&
        error.details?.journalRetired === false,
    );

    const stored = await new SeedProvenanceStore(projectRoot, stateRoot).load('target', 'created-session');
    assert.equal(stored?.entries.length, 1);
    assert.equal(provider.cleanupCount, 0, 'the writer-reported cleanup failure is retried on the next access');
    assert.notEqual(
      await new SeedAppendJournalStore(projectRoot, stateRoot).load('target', 'created-session'),
      null,
    );
    assert.notEqual(
      await new SessionStateStore(projectRoot, stateRoot).loadPendingSeedAppendMarker('created-session'),
      null,
    );

    await settleProviderPending(provider, 'created-session', projectRoot);

    assert.equal(provider.cleanupCount, 1);
    assert.equal(
      await new SeedAppendJournalStore(projectRoot, stateRoot).load('target', 'created-session'),
      null,
    );
    assert.equal(
      await new SessionStateStore(projectRoot, stateRoot).loadPendingSeedAppendMarker('created-session'),
      null,
    );
    assert.equal((await new SessionStateStore(projectRoot, stateRoot).load('created-session'))?.schemaVersion, 1);
  });
});

test('cleanup plus unverified post-write state reports unknown commit and retains settlement evidence', async () => {
  await withStateRoot(async (projectRoot, stateRoot) => {
    const reads = new Map<string, NativeSessionReadResult>();
    const provider = new FakeProvider('target', reads, 'created-session', false, {
      afterAppend: async () => {
        const current = reads.get('created-session');
        assert.ok(current);
        reads.set('created-session', {
          ...current,
          turns: [...current.turns, nativeTurn('foreign')],
        });
      },
      postWriteCleanupFailure: { message: 'transient transcript cleanup blocked' },
    });
    const irPath = join(projectRoot, 'ir.json');
    await writeFile(irPath, JSON.stringify({
      schemaVersion: 1,
      turns: [{ id: 'one', user: { text: 'remember one' }, assistant: { text: 'noted one' } }],
    }));

    await assert.rejects(
      () => runSeed({
        options: {
          backend: 'target',
          source: { kind: 'external-ir', path: irPath },
          resume: false,
          backendSessionId: null,
          model: null,
          reasoningEffort: null,
          timeoutMs: 0,
        },
        provider,
        sourceProvider: null,
        createBackend: () => provider.createBackend(),
        cwd: projectRoot,
        debugLog: null,
        signal: new AbortController().signal,
        forceSignal: new AbortController().signal,
        killSignal: new AbortController().signal,
      }),
      (error) => error instanceof OpenPError &&
        error.exitCode === EXIT_CODES.protocolViolation &&
        error.details?.nativeAppendCommitted === 'unknown' &&
        error.details?.provenanceSaved === false &&
        error.details?.journalRetired === false &&
        error.details?.cleanupFailed === true,
    );

    const provenance = await new SeedProvenanceStore(projectRoot, stateRoot)
      .load('target', 'created-session');
    assert.equal(provenance?.entries.length, 0);
    assert.equal(
      (await new SeedAppendJournalStore(projectRoot, stateRoot)
        .load('target', 'created-session'))?.planned.length,
      1,
    );
  });
});

test('cleanup failure does not replace a post-write settlement AbortError', async () => {
  await withStateRoot(async (projectRoot, stateRoot) => {
    const reads = new Map<string, NativeSessionReadResult>();
    const provider = new FakeProvider('target', reads, 'created-session', false, {
      settlementReadFailure: createAbortError('post-write settlement aborted'),
      postWriteCleanupFailure: { message: 'transient transcript cleanup blocked' },
    });
    const irPath = join(projectRoot, 'ir.json');
    await writeFile(irPath, JSON.stringify({
      schemaVersion: 1,
      turns: [{ id: 'one', user: { text: 'remember one' }, assistant: { text: 'noted one' } }],
    }));

    await assert.rejects(
      () => runSeed({
        options: {
          backend: 'target',
          source: { kind: 'external-ir', path: irPath },
          resume: false,
          backendSessionId: null,
          model: null,
          reasoningEffort: null,
          timeoutMs: 0,
        },
        provider,
        sourceProvider: null,
        createBackend: () => provider.createBackend(),
        cwd: projectRoot,
        debugLog: null,
        signal: new AbortController().signal,
        forceSignal: new AbortController().signal,
        killSignal: new AbortController().signal,
      }),
      (error) => isAbortError(error) &&
        error.message.includes('post-write settlement aborted') &&
        error.message.includes('cleanup also failed'),
    );

    assert.equal(
      (await new SeedAppendJournalStore(projectRoot, stateRoot)
        .load('target', 'created-session'))?.planned.length,
      1,
    );
    assert.equal(
      (await new SeedProvenanceStore(projectRoot, stateRoot)
        .load('target', 'created-session'))?.entries.length,
      0,
    );
  });
});

test('append mode writes only a strict logical suffix and extends provenance', async () => {
  await withStateRoot(async (projectRoot, stateRoot) => {
    const sourceRead: NativeSessionReadResult = {
      backend: 'source',
      sessionId: 'source-session',
      turns: [nativeTurn('source-1'), nativeTurn('source-2')],
    };
    const sourceTurns = logicalTurnsFromNative(sourceRead);
    const targetRead: NativeSessionReadResult = {
      backend: 'target',
      sessionId: 'target-session',
      turns: [nativeTurn('target-1', sourceRead.turns[0]!.userText, sourceRead.turns[0]!.assistantText)],
    };
    const reads = new Map<string, NativeSessionReadResult>([
      ['source-session', sourceRead],
      ['target-session', targetRead],
    ]);
    const provenanceStore = new SeedProvenanceStore(projectRoot, stateRoot);
    const targetProvider = new FakeProvider('target', reads);
    const sourceProvider = new FakeProvider('source', reads);
    await new SessionStateStore(projectRoot, stateRoot).save({
      backend: 'target',
      backendSessionId: 'target-session',
      cwd: projectRoot,
      lastProviderSessionId: null,
      sessionLogPath: null,
      lastTurnId: 'previous',
    });
    const provenance = withAppendedProvenanceEntries(createInitialProvenanceState({
      backend: 'target',
      sessionId: 'target-session',
      bootstrap: [],
    }), {
      targetBackend: 'target',
      targetSessionId: 'target-session',
      sourceRefs: nativeSourceRefs('source', 'source-session', sourceTurns.slice(0, 1)),
      written: [{
        logicalId: sourceTurns[0]!.logicalId,
        contentDigest: sourceTurns[0]!.contentDigest,
        nativeIds: nativeIds('target-1'),
      }],
    });
    await provenanceStore.save(provenance);

    const seed = await runSeed({
      options: {
        backend: 'target',
        source: { kind: 'native', backend: 'source', sessionId: 'source-session' },
        resume: true,
        backendSessionId: 'target-session',
        model: null,
        reasoningEffort: null,
        timeoutMs: 0,
      },
      provider: targetProvider,
      sourceProvider,
      createBackend: () => targetProvider.createBackend(),
      cwd: projectRoot,
      debugLog: null,
      signal: new AbortController().signal,
      forceSignal: new AbortController().signal,
      killSignal: new AbortController().signal,
    });

    assert.equal(seed.status, 'updated');
    assert.equal(seed.appendedTurns, 1);
    assert.deepEqual(targetProvider.appended.map((turn) => turn.logicalId), [sourceTurns[1]!.logicalId]);
    const updated = await new SeedProvenanceStore(projectRoot, stateRoot).load('target', 'target-session');
    assert.deepEqual(updated?.entries.map((entry) => entry.logicalId), sourceTurns.map((turn) => turn.logicalId));
  });
});

test('native source read and provenance load are blocked by the source session lock before target creation', async () => {
  await withStateRoot(async (projectRoot, stateRoot) => {
    const sourceRead: NativeSessionReadResult = {
      backend: 'source',
      sessionId: 'source-session',
      turns: [nativeTurn('source-1')],
    };
    const reads = new Map<string, NativeSessionReadResult>([['source-session', sourceRead]]);
    const targetProvider = new FakeProvider('target', reads);
    const sourceProvider = new FakeProvider('source', reads);
    const sourceLock = await new SessionLockStore(projectRoot, stateRoot).acquire('source-session');
    try {
      await assert.rejects(
        () => runSeed({
          options: {
            backend: 'target',
            source: { kind: 'native', backend: 'source', sessionId: 'source-session' },
            resume: false,
            backendSessionId: null,
            model: null,
            reasoningEffort: null,
            timeoutMs: 0,
          },
          provider: targetProvider,
          sourceProvider,
          createBackend: () => targetProvider.createBackend(),
          cwd: projectRoot,
          debugLog: null,
          signal: new AbortController().signal,
          forceSignal: new AbortController().signal,
          killSignal: new AbortController().signal,
        }),
        (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionBusy,
      );
    } finally {
      await sourceLock.release();
    }

    assert.deepEqual(sourceProvider.readCalls, []);
    assert.deepEqual(targetProvider.runCalls, []);
    assert.deepEqual(targetProvider.appended, []);
    assert.equal(await new SeedProvenanceStore(projectRoot, stateRoot).load('target', 'created-session'), null);
  });
});

test('same native source and target ordinary no-op verifies native state without writing', async () => {
  await withStateRoot(async (projectRoot, stateRoot) => {
    const reads = new Map<string, NativeSessionReadResult>([[
      'same-session',
      { backend: 'target', sessionId: 'same-session', turns: [nativeTurn('same')] },
    ]]);
    const provider = new FakeProvider('target', reads);
    await new SessionStateStore(projectRoot, stateRoot).save({
      backend: 'target',
      backendSessionId: 'same-session',
      cwd: projectRoot,
      lastProviderSessionId: null,
      sessionLogPath: null,
      lastTurnId: 'previous',
    });

    const seed = await runSeed({
      options: {
        backend: 'target',
        source: { kind: 'native', backend: 'target', sessionId: 'same-session' },
        resume: true,
        backendSessionId: 'same-session',
        model: null,
        reasoningEffort: null,
        timeoutMs: 0,
      },
      provider,
      sourceProvider: provider,
      createBackend: () => provider.createBackend(),
      cwd: projectRoot,
      debugLog: null,
      signal: new AbortController().signal,
      forceSignal: new AbortController().signal,
      killSignal: new AbortController().signal,
    });

    assert.equal(seed.status, 'noop');
    assert.equal(seed.appendedTurns, 0);
    assert.equal(provider.appended.length, 0);
    assert.equal(provider.readCalls.includes('same-session'), true);
  });
});

test('same native source and target rejects zero portable turns', async () => {
  await withStateRoot(async (projectRoot, stateRoot) => {
    const reads = new Map<string, NativeSessionReadResult>([[
      'same-session',
      { backend: 'target', sessionId: 'same-session', turns: [] },
    ]]);
    const provider = new FakeProvider('target', reads);
    await new SessionStateStore(projectRoot, stateRoot).save({
      backend: 'target',
      backendSessionId: 'same-session',
      cwd: projectRoot,
      lastProviderSessionId: null,
      sessionLogPath: null,
      lastTurnId: 'previous',
    });

    await assert.rejects(
      () => runSeed({
        options: {
          backend: 'target',
          source: { kind: 'native', backend: 'target', sessionId: 'same-session' },
          resume: true,
          backendSessionId: 'same-session',
          model: null,
          reasoningEffort: null,
          timeoutMs: 0,
        },
        provider,
        sourceProvider: provider,
        createBackend: () => provider.createBackend(),
        cwd: projectRoot,
        debugLog: null,
        signal: new AbortController().signal,
        forceSignal: new AbortController().signal,
        killSignal: new AbortController().signal,
      }),
      (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.protocolViolation,
    );

    assert.equal(provider.appended.length, 0);
    assert.equal(provider.runCalls.length, 0);
  });
});

test('core rejects a writer that changes logical turn identity', async () => {
  await withStateRoot(async (projectRoot) => {
    const reads = new Map<string, NativeSessionReadResult>();
    const provider = new FakeProvider('target', reads, 'created-session', true);
    const irPath = join(projectRoot, 'ir.json');
    await writeFile(irPath, JSON.stringify({
      schemaVersion: 1,
      turns: [{ id: 'one', user: { text: 'hello' }, assistant: { text: 'world' } }],
    }));

    await assert.rejects(
      () => runSeed({
        options: {
          backend: 'target',
          source: { kind: 'external-ir', path: irPath },
          resume: false,
          backendSessionId: null,
          model: null,
          reasoningEffort: null,
          timeoutMs: 0,
        },
        provider,
        sourceProvider: null,
        createBackend: () => provider.createBackend(),
        cwd: projectRoot,
        debugLog: null,
        signal: new AbortController().signal,
        forceSignal: new AbortController().signal,
        killSignal: new AbortController().signal,
      }),
      (error) => error instanceof Error && 'exitCode' in error && error.exitCode === 40 &&
        error.message.includes('--resume') === false,
    );
  });
});

test('core rejects a writer that reports a different target session id and keeps the journal', async () => {
  await withStateRoot(async (projectRoot, stateRoot) => {
    const reads = new Map<string, NativeSessionReadResult>();
    const provider = new FakeProvider('target', reads, 'created-session', false, {
      resultSessionId: 'different-session',
    });
    const irPath = join(projectRoot, 'ir.json');
    await writeFile(irPath, JSON.stringify({
      schemaVersion: 1,
      turns: [{ id: 'one', user: { text: 'hello' }, assistant: { text: 'world' } }],
    }));

    await assert.rejects(
      () => runSeed({
        options: {
          backend: 'target',
          source: { kind: 'external-ir', path: irPath },
          resume: false,
          backendSessionId: null,
          model: null,
          reasoningEffort: null,
          timeoutMs: 0,
        },
        provider,
        sourceProvider: null,
        createBackend: () => provider.createBackend(),
        cwd: projectRoot,
        debugLog: null,
        signal: new AbortController().signal,
        forceSignal: new AbortController().signal,
        killSignal: new AbortController().signal,
      }),
      (error) => error instanceof OpenPError &&
        error.exitCode === EXIT_CODES.protocolViolation &&
        error.message.includes('different or empty target session id'),
    );

    assert.equal(
      (await new SeedAppendJournalStore(projectRoot, stateRoot)
        .load('target', 'created-session'))?.planned.length,
      1,
    );
  });
});

test('core rejects completion ids that alias the user id from readers and writers', async () => {
  await withStateRoot(async (projectRoot) => {
    const invalidIds = {
      userId: 'aliased-user-completion',
      assistantIds: ['distinct-assistant'],
      completionId: 'aliased-user-completion',
    };
    const reads = new Map<string, NativeSessionReadResult>([[
      'source-session',
      {
        backend: 'source',
        sessionId: 'source-session',
        turns: [{ userText: 'source user', assistantText: 'source assistant', nativeIds: invalidIds }],
      },
    ]]);
    const targetProvider = new FakeProvider('target', reads);
    const sourceProvider = new FakeProvider('source', reads);

    await assert.rejects(
      () => runSeed({
        options: {
          backend: 'target',
          source: { kind: 'native', backend: 'source', sessionId: 'source-session' },
          resume: false,
          backendSessionId: null,
          model: null,
          reasoningEffort: null,
          timeoutMs: 0,
        },
        provider: targetProvider,
        sourceProvider,
        createBackend: () => targetProvider.createBackend(),
        cwd: projectRoot,
        debugLog: null,
        signal: new AbortController().signal,
        forceSignal: new AbortController().signal,
        killSignal: new AbortController().signal,
      }),
      (error) => error instanceof OpenPError &&
        error.exitCode === EXIT_CODES.protocolViolation &&
        error.message.includes('native session reader returned invalid native turn ids'),
    );
  });

  await withStateRoot(async (projectRoot) => {
    const reads = new Map<string, NativeSessionReadResult>();
    const provider = new FakeProvider('target', reads, 'created-session', false, {
      writtenNativeIds: () => ({
        userId: 'aliased-user-completion',
        assistantIds: ['distinct-assistant'],
        completionId: 'aliased-user-completion',
      }),
    });
    const irPath = join(projectRoot, 'ir.json');
    await writeFile(irPath, JSON.stringify({
      schemaVersion: 1,
      turns: [{ id: 'one', user: { text: 'hello' }, assistant: { text: 'world' } }],
    }));

    await assert.rejects(
      () => runSeed({
        options: {
          backend: 'target',
          source: { kind: 'external-ir', path: irPath },
          resume: false,
          backendSessionId: null,
          model: null,
          reasoningEffort: null,
          timeoutMs: 0,
        },
        provider,
        sourceProvider: null,
        createBackend: () => provider.createBackend(),
        cwd: projectRoot,
        debugLog: null,
        signal: new AbortController().signal,
        forceSignal: new AbortController().signal,
        killSignal: new AbortController().signal,
      }),
      (error) => error instanceof OpenPError &&
        error.exitCode === EXIT_CODES.protocolViolation &&
        error.message.includes('seed writer returned invalid native turn ids'),
    );
  });
});

test('core rejects writer native ids reused across a batch or from the bootstrap turn', async () => {
  for (const collision of ['batch', 'bootstrap'] as const) {
    await withStateRoot(async (projectRoot, stateRoot) => {
      const reads = new Map<string, NativeSessionReadResult>();
      const provider = new FakeProvider('target', reads, 'created-session', false, {
        writtenNativeIds: collision === 'batch'
          ? () => nativeIds('duplicate-written')
          : () => nativeIds('bootstrap'),
      });
      const irPath = join(projectRoot, 'ir.json');
      await writeFile(irPath, JSON.stringify({
        schemaVersion: 1,
        turns: collision === 'batch'
          ? [
            { id: 'one', user: { text: 'u1' }, assistant: { text: 'a1' } },
            { id: 'two', user: { text: 'u2' }, assistant: { text: 'a2' } },
          ]
          : [{ id: 'one', user: { text: 'u1' }, assistant: { text: 'a1' } }],
      }));

      await assert.rejects(
        () => runSeed({
          options: {
            backend: 'target',
            source: { kind: 'external-ir', path: irPath },
            resume: false,
            backendSessionId: null,
            model: null,
            reasoningEffort: null,
            timeoutMs: 0,
          },
          provider,
          sourceProvider: null,
          createBackend: () => provider.createBackend(),
          cwd: projectRoot,
          debugLog: null,
          signal: new AbortController().signal,
          forceSignal: new AbortController().signal,
          killSignal: new AbortController().signal,
        }),
        (error) => error instanceof OpenPError &&
          error.exitCode === EXIT_CODES.protocolViolation &&
          error.message.includes('seed writer reused a native id across logical turns'),
      );

      const provenance = await new SeedProvenanceStore(projectRoot, stateRoot).load('target', 'created-session');
      assert.equal(provenance?.entries.length, 0);
    });
  }
});

test('core rejects a native reader result from a different backend namespace', async () => {
  await withStateRoot(async (projectRoot) => {
    const reads = new Map<string, NativeSessionReadResult>([[
      'source-session',
      { backend: 'wrong-source', sessionId: 'source-session', turns: [nativeTurn('source-1')] },
    ]]);
    const targetProvider = new FakeProvider('target', reads);
    const sourceProvider = new FakeProvider('source', reads);

    await assert.rejects(
      () => runSeed({
        options: {
          backend: 'target',
          source: { kind: 'native', backend: 'source', sessionId: 'source-session' },
          resume: false,
          backendSessionId: null,
          model: null,
          reasoningEffort: null,
          timeoutMs: 0,
        },
        provider: targetProvider,
        sourceProvider,
        createBackend: () => targetProvider.createBackend(),
        cwd: projectRoot,
        debugLog: null,
        signal: new AbortController().signal,
        forceSignal: new AbortController().signal,
        killSignal: new AbortController().signal,
      }),
      (error) => error instanceof Error && 'exitCode' in error && error.exitCode === 40,
    );
  });
});

test('core rejects wrong session identity, absent state proof, and empty Reader turns', async () => {
  const cases: readonly {
    readonly name: string;
    readonly transform: (read: NativeSessionReadResult) => NativeSessionReadResult;
  }[] = [
    { name: 'wrong session id', transform: (read) => ({ ...read, sessionId: 'other-session' }) },
    { name: 'missing native state digest', transform: (read) => ({
      backend: read.backend,
      sessionId: read.sessionId,
      turns: read.turns,
    }) },
    { name: 'invalid native state digest', transform: (read) => ({ ...read, nativeStateDigest: 'not-a-digest' }) },
    { name: 'empty user text', transform: (read) => ({
      ...read,
      turns: [{ ...read.turns[0]!, userText: '' }],
    }) },
    { name: 'empty assistant text', transform: (read) => ({
      ...read,
      turns: [{ ...read.turns[0]!, assistantText: '' }],
    }) },
  ];

  for (const currentCase of cases) {
    await withStateRoot(async (projectRoot) => {
      const sourceRead: NativeSessionReadResult = {
        backend: 'source',
        sessionId: 'source-session',
        turns: [nativeTurn('source-1')],
      };
      const reads = new Map<string, NativeSessionReadResult>([['source-session', sourceRead]]);
      const targetProvider = new FakeProvider('target', reads);
      const sourceProvider = new FakeProvider('source', reads, 'unused', false, {
        transformNativeRead: currentCase.transform,
      });
      let createCalls = 0;

      await assert.rejects(
        () => runSeed({
          options: {
            backend: 'target',
            source: { kind: 'native', backend: 'source', sessionId: 'source-session' },
            resume: false,
            backendSessionId: null,
            model: null,
            reasoningEffort: null,
            timeoutMs: 0,
          },
          provider: targetProvider,
          sourceProvider,
          createBackend: () => {
            createCalls += 1;
            return targetProvider.createBackend();
          },
          cwd: projectRoot,
          debugLog: null,
          signal: new AbortController().signal,
          forceSignal: new AbortController().signal,
          killSignal: new AbortController().signal,
        }),
        (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.protocolViolation,
        currentCase.name,
      );
      assert.equal(createCalls, 0, currentCase.name);
    });
  }
});

test('core rejects overlapping native ids across distinct logical turns', async () => {
  await withStateRoot(async (projectRoot) => {
    const overlappingRead: NativeSessionReadResult = {
      backend: 'source',
      sessionId: 'source-session',
      turns: [
        nativeTurn('source-1'),
        {
          userText: 'second user',
          assistantText: 'second assistant',
          nativeIds: {
            userId: 'source-2:user',
            assistantIds: ['source-1:assistant'],
            completionId: 'source-2:complete',
          },
        },
      ],
    };
    const reads = new Map<string, NativeSessionReadResult>([['source-session', overlappingRead]]);
    const targetProvider = new FakeProvider('target', reads);
    const sourceProvider = new FakeProvider('source', reads);

    await assert.rejects(
      () => runSeed({
        options: {
          backend: 'target',
          source: { kind: 'native', backend: 'source', sessionId: 'source-session' },
          resume: false,
          backendSessionId: null,
          model: null,
          reasoningEffort: null,
          timeoutMs: 0,
        },
        provider: targetProvider,
        sourceProvider,
        createBackend: () => targetProvider.createBackend(),
        cwd: projectRoot,
        debugLog: null,
        signal: new AbortController().signal,
        forceSignal: new AbortController().signal,
        killSignal: new AbortController().signal,
      }),
      (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.protocolViolation,
    );
  });
});

test('core allows a same-turn assistant/completion native id overlap', async () => {
  await withStateRoot(async (projectRoot) => {
    const sourceRead: NativeSessionReadResult = {
      backend: 'source',
      sessionId: 'source-session',
      turns: [
        {
          userText: 'source user',
          assistantText: 'source assistant',
          nativeIds: {
            userId: 'source:user',
            assistantIds: ['source:assistant'],
            completionId: 'source:assistant',
          },
        },
      ],
    };
    const reads = new Map<string, NativeSessionReadResult>([['source-session', sourceRead]]);
    const targetProvider = new FakeProvider('target', reads);
    const sourceProvider = new FakeProvider('source', reads);

    const seed = await runSeed({
      options: {
        backend: 'target',
        source: { kind: 'native', backend: 'source', sessionId: 'source-session' },
        resume: false,
        backendSessionId: null,
        model: null,
        reasoningEffort: null,
        timeoutMs: 0,
      },
      provider: targetProvider,
      sourceProvider,
      createBackend: () => targetProvider.createBackend(),
      cwd: projectRoot,
      debugLog: null,
      signal: new AbortController().signal,
      forceSignal: new AbortController().signal,
      killSignal: new AbortController().signal,
    });

    assert.equal(seed.appendedTurns, 1);
  });
});

test('create mode reports an ambiguous writer failure without suggesting automatic resume', async () => {
  await withStateRoot(async (projectRoot) => {
    const sourceRead: NativeSessionReadResult = {
      backend: 'source',
      sessionId: 'source-session',
      turns: [nativeTurn('source-1')],
    };
    const reads = new Map<string, NativeSessionReadResult>([['source-session', sourceRead]]);
    const provider = new FakeProvider('target', reads, 'created-session', false, {
      failAppend: new OpenPError('writer failed', EXIT_CODES.protocolViolation, {
        details: { phase: 'native-write' },
      }),
    });
    const sourceProvider = new FakeProvider('source', reads);

    await assert.rejects(
      () => runSeed({
        options: {
          backend: 'target',
          source: { kind: 'native', backend: 'source', sessionId: 'source-session' },
          resume: false,
          backendSessionId: null,
          model: null,
          reasoningEffort: null,
          timeoutMs: 0,
        },
        provider,
        sourceProvider,
        createBackend: () => provider.createBackend(),
        cwd: projectRoot,
        debugLog: null,
        signal: new AbortController().signal,
        forceSignal: new AbortController().signal,
        killSignal: new AbortController().signal,
      }),
      (error) => error instanceof OpenPError &&
        error.exitCode === EXIT_CODES.protocolViolation &&
        error.message.includes('session created-session was created') &&
        error.message.includes('native append state may be ambiguous') &&
        error.message.includes('--resume') === false &&
        error.details?.phase === 'native-write',
    );
  });
});

test('create mode never suggests resume after native mutation with an invalid writer mapping', async () => {
  await withStateRoot(async (projectRoot) => {
    const sourceRead: NativeSessionReadResult = {
      backend: 'source',
      sessionId: 'source-session',
      turns: [nativeTurn('source-1')],
    };
    const reads = new Map<string, NativeSessionReadResult>([['source-session', sourceRead]]);
    const provider = new FakeProvider('target', reads, 'created-session', true);
    const sourceProvider = new FakeProvider('source', reads);

    await assert.rejects(
      () => runSeed({
        options: {
          backend: 'target',
          source: { kind: 'native', backend: 'source', sessionId: 'source-session' },
          resume: false,
          backendSessionId: null,
          model: null,
          reasoningEffort: null,
          timeoutMs: 0,
        },
        provider,
        sourceProvider,
        createBackend: () => provider.createBackend(),
        cwd: projectRoot,
        debugLog: null,
        signal: new AbortController().signal,
        forceSignal: new AbortController().signal,
        killSignal: new AbortController().signal,
      }),
      (error) => error instanceof OpenPError &&
        error.exitCode === EXIT_CODES.protocolViolation &&
        error.message.includes('session created-session was created') &&
        error.message.includes('--resume') === false,
    );
  });
});

test('create mode initial provenance failure does not suggest a safe --resume retry', async () => {
  await withStateRoot(async (projectRoot, stateRoot) => {
    const sourceRead: NativeSessionReadResult = {
      backend: 'source',
      sessionId: 'source-session',
      turns: [nativeTurn('source-1')],
    };
    const reads = new Map<string, NativeSessionReadResult>([['source-session', sourceRead]]);
    const provider = new FakeProvider('target', reads, 'created-session', false, {
      afterRun: async () => {
        await mkdir(stateRoot, { recursive: true });
        await writeFile(join(stateRoot, 'seed-provenance'), 'not a directory');
      },
    });
    const sourceProvider = new FakeProvider('source', reads);

    await assert.rejects(
      () => runSeed({
        options: {
          backend: 'target',
          source: { kind: 'native', backend: 'source', sessionId: 'source-session' },
          resume: false,
          backendSessionId: null,
          model: null,
          reasoningEffort: null,
          timeoutMs: 0,
        },
        provider,
        sourceProvider,
        createBackend: () => provider.createBackend(),
        cwd: projectRoot,
        debugLog: null,
        signal: new AbortController().signal,
        forceSignal: new AbortController().signal,
        killSignal: new AbortController().signal,
      }),
      (error) => error instanceof Error &&
        error.message.includes('session created-session was created') &&
        error.message.includes('--resume') === false,
    );
  });
});

test('create mode final provenance failure is exactly settled on the next access without replay', async () => {
  await withStateRoot(async (projectRoot, stateRoot) => {
    const sourceRead: NativeSessionReadResult = {
      backend: 'source',
      sessionId: 'source-session',
      turns: [nativeTurn('source-1')],
    };
    const reads = new Map<string, NativeSessionReadResult>([['source-session', sourceRead]]);
    const provenanceStore = new SeedProvenanceStore(projectRoot, stateRoot);
    let initialProvenanceText: string | null = null;
    const provider = new FakeProvider('target', reads, 'created-session', false, {
      afterAppend: async () => {
        initialProvenanceText = await readFile(
          provenanceStore.pathForSession('target', 'created-session'),
          'utf8',
        );
        await rm(join(stateRoot, 'seed-provenance'), { recursive: true, force: true });
        await writeFile(join(stateRoot, 'seed-provenance'), 'not a directory');
      },
    });
    const sourceProvider = new FakeProvider('source', reads);

    await assert.rejects(
      () => runSeed({
        options: {
          backend: 'target',
          source: { kind: 'native', backend: 'source', sessionId: 'source-session' },
          resume: false,
          backendSessionId: null,
          model: null,
          reasoningEffort: null,
          timeoutMs: 0,
        },
        provider,
        sourceProvider,
        createBackend: () => provider.createBackend(),
        cwd: projectRoot,
        debugLog: null,
        signal: new AbortController().signal,
        forceSignal: new AbortController().signal,
        killSignal: new AbortController().signal,
      }),
      (error) => error instanceof OpenPError &&
        error.message.includes('--resume') === false &&
        error.message.includes('settlement evidence was retained') &&
        error.details?.nativeAppendCommitted === true &&
        error.details?.provenanceSaved === false &&
        error.details?.journalRetired === false,
    );

    assert.equal(provider.commitCount, 1);
    assert.equal(reads.get('created-session')?.turns.length, 2);
    const journalStore = new SeedAppendJournalStore(projectRoot, stateRoot);
    assert.equal((await journalStore.load('target', 'created-session'))?.planned.length, 1);
    assert.ok(initialProvenanceText);

    await rm(join(stateRoot, 'seed-provenance'), { recursive: true, force: true });
    await provenanceStore.save(JSON.parse(initialProvenanceText));

    const resumedProvider = new FakeProvider('target', reads);
    const resumed = await runSeed({
      options: {
        backend: 'target',
        source: { kind: 'native', backend: 'source', sessionId: 'source-session' },
        resume: true,
        backendSessionId: 'created-session',
        model: null,
        reasoningEffort: null,
        timeoutMs: 0,
      },
      provider: resumedProvider,
      sourceProvider,
      createBackend: () => resumedProvider.createBackend(),
      cwd: projectRoot,
      debugLog: null,
      signal: new AbortController().signal,
      forceSignal: new AbortController().signal,
      killSignal: new AbortController().signal,
    });

    assert.equal(resumed.status, 'noop');
    assert.equal(resumed.appendedTurns, 0);
    assert.equal(resumedProvider.commitCount, 0);
    assert.equal(reads.get('created-session')?.turns.length, 2);
    assert.equal((await provenanceStore.load('target', 'created-session'))?.entries.length, 1);
    assert.equal(await journalStore.load('target', 'created-session'), null);
  });
});

test('operation create records creating before bootstrap and target-created before native mutation', async () => {
  await withStateRoot(async (projectRoot, stateRoot) => {
    const sensitiveExternalId = 'raw external id REDMOON';
    const sensitiveUser = 'codename REDMOON user text';
    const sensitiveAssistant = 'codename REDMOON assistant text';
    const operationId = randomUUID();
    const reads = new Map<string, NativeSessionReadResult>();
    const receiptStore = new SeedOperationReceiptStore(projectRoot, stateRoot);
    let sawCreatingBeforeBootstrap = false;
    let sawTargetCreatedBeforeMutation = false;
    const provider = new FakeProvider('target', reads, 'created-session', false, {
      beforeRun: async () => {
        const receipt = await receiptStore.load(operationId);
        assert.equal(receipt?.phase, 'creating');
        assert.equal(receipt.source.turnCount, 1);
        assert.equal(receipt.target, undefined);
        assert.equal(reads.has('created-session'), false);
        sawCreatingBeforeBootstrap = true;
      },
      beforeNativeMutation: async () => {
        const receipt = await receiptStore.load(operationId);
        const pending = await new SeedAppendJournalStore(projectRoot, stateRoot).load('target', 'created-session');
        assert.equal(receipt?.phase, 'target-created');
        assert.equal(receipt.target?.sessionId, 'created-session');
        assert.equal(receipt.target?.bootstrap[0]?.contentDigest, contentDigest('Reply with only: OK', 'OK'));
        assert.equal(receipt.target?.nativeStateDigest, fakeNativeStateDigest([nativeTurn('bootstrap', 'Reply with only: OK', 'OK')]));
        assert.notEqual(pending?.operationId, operationId, 'caller operation id must not be reused as append journal operationId');
        sawTargetCreatedBeforeMutation = true;
      },
    });
    const irPath = join(projectRoot, 'secret-input-ir-path.json');
    await writeFile(irPath, JSON.stringify({
      schemaVersion: 1,
      turns: [{
        id: sensitiveExternalId,
        user: { text: sensitiveUser },
        assistant: { text: sensitiveAssistant },
      }],
    }));

    const seed = await runSeed({
      options: {
        backend: 'target',
        source: { kind: 'external-ir', path: irPath },
        resume: false,
        backendSessionId: null,
        model: 'bootstrap-model',
        reasoningEffort: 'high',
        timeoutMs: 5000,
        operationId,
      },
      provider,
      sourceProvider: null,
      createBackend: () => provider.createBackend(),
      cwd: projectRoot,
      debugLog: null,
      signal: new AbortController().signal,
      forceSignal: new AbortController().signal,
      killSignal: new AbortController().signal,
    });

    assert.equal(sawCreatingBeforeBootstrap, true);
    assert.equal(sawTargetCreatedBeforeMutation, true);
    assert.equal(seed.status, 'created');
    const receipt = await receiptStore.load(operationId);
    assert.equal(receipt?.phase, 'succeeded');
    assert.deepEqual(receipt?.result, seed);
    assert.equal(provider.readInputs.some((input) => input.sessionId === 'created-session' && input.mode === 'settlement'), true);
    const persisted = await readFile(receiptStore.pathForOperation(operationId), 'utf8');
    const status = formatSeedOperationStatus(receipt!);
    for (const forbidden of [sensitiveExternalId, sensitiveUser, sensitiveAssistant, irPath]) {
      assert.equal(persisted.includes(forbidden), false, `receipt leaked ${forbidden}`);
      assert.equal(status.includes(forbidden), false, `status leaked ${forbidden}`);
    }
  });
});

test('succeeded operation replay returns the durable result without source read or bootstrap', async () => {
  await withStateRoot(async (projectRoot) => {
    const operationId = randomUUID();
    const sourceRead: NativeSessionReadResult = {
      backend: 'source',
      sessionId: 'source-session',
      turns: [nativeTurn('source-1')],
    };
    const reads = new Map<string, NativeSessionReadResult>([['source-session', sourceRead]]);
    const firstTarget = new FakeProvider('target', reads, 'created-session');
    const firstSource = new FakeProvider('source', reads);
    const first = await runSeed({
      options: {
        backend: 'target',
        source: { kind: 'native', backend: 'source', sessionId: 'source-session' },
        resume: false,
        backendSessionId: null,
        model: null,
        reasoningEffort: null,
        timeoutMs: 0,
        operationId,
      },
      provider: firstTarget,
      sourceProvider: firstSource,
      createBackend: () => firstTarget.createBackend(),
      cwd: projectRoot,
      debugLog: null,
      signal: new AbortController().signal,
      forceSignal: new AbortController().signal,
      killSignal: new AbortController().signal,
    });

    const replaySource = new FakeProvider('source', new Map());
    const replayTarget = new FakeProvider('target', reads, 'unused-created-session');
    const replayed = await runSeed({
      options: {
        backend: 'target',
        source: { kind: 'native', backend: 'source', sessionId: 'source-session' },
        resume: false,
        backendSessionId: null,
        model: null,
        reasoningEffort: null,
        timeoutMs: 0,
        operationId,
      },
      provider: replayTarget,
      sourceProvider: replaySource,
      createBackend: () => replayTarget.createBackend(),
      cwd: projectRoot,
      debugLog: null,
      signal: new AbortController().signal,
      forceSignal: new AbortController().signal,
      killSignal: new AbortController().signal,
    });

    assert.deepEqual(replayed, first);
    assert.deepEqual(replaySource.readCalls, []);
    assert.deepEqual(replayTarget.runCalls, []);
    assert.equal(replayTarget.commitCount, 0);
  });
});

test('target-created operation replay ignores a later source suffix and appends only the recorded prefix', async () => {
  await withStateRoot(async (projectRoot, stateRoot) => {
    const operationId = randomUUID();
    const sourceRead: NativeSessionReadResult = {
      backend: 'source',
      sessionId: 'source-session',
      turns: [nativeTurn('source-1')],
    };
    const reads = new Map<string, NativeSessionReadResult>([['source-session', sourceRead]]);
    const failingTarget = new FakeProvider('target', reads, 'created-session', false, {
      failAppend: new OpenPError('stop after target-created receipt', EXIT_CODES.sessionState),
    });
    const sourceProvider = new FakeProvider('source', reads);

    await assert.rejects(() => runSeed({
      options: {
        backend: 'target',
        source: { kind: 'native', backend: 'source', sessionId: 'source-session' },
        resume: false,
        backendSessionId: null,
        model: null,
        reasoningEffort: null,
        timeoutMs: 0,
        operationId,
      },
      provider: failingTarget,
      sourceProvider,
      createBackend: () => failingTarget.createBackend(),
      cwd: projectRoot,
      debugLog: null,
      signal: new AbortController().signal,
      forceSignal: new AbortController().signal,
      killSignal: new AbortController().signal,
    }));
    assert.equal((await new SeedOperationReceiptStore(projectRoot, stateRoot).load(operationId))?.phase, 'target-created');
    reads.set('source-session', {
      ...sourceRead,
      turns: [...sourceRead.turns, nativeTurn('source-2')],
    });

    const replayTarget = new FakeProvider('target', reads, 'unused-created-session');
    const replayed = await runSeed({
      options: {
        backend: 'target',
        source: { kind: 'native', backend: 'source', sessionId: 'source-session' },
        resume: false,
        backendSessionId: null,
        model: null,
        reasoningEffort: null,
        timeoutMs: 0,
        operationId,
      },
      provider: replayTarget,
      sourceProvider: new FakeProvider('source', reads),
      createBackend: () => replayTarget.createBackend(),
      cwd: projectRoot,
      debugLog: null,
      signal: new AbortController().signal,
      forceSignal: new AbortController().signal,
      killSignal: new AbortController().signal,
    });

    assert.equal(replayed.status, 'created');
    assert.equal(replayed.appendedTurns, 1);
    assert.equal(replayed.target.sessionId, 'created-session');
    assert.equal(replayTarget.commitCount, 1);
    assert.deepEqual(replayTarget.appended.map((turn) => turn.logicalId), [logicalTurnsFromNative(sourceRead)[0]!.logicalId]);
    assert.equal(reads.get('created-session')?.turns.length, 2);
    assert.deepEqual(replayTarget.runCalls, []);
  });
});

test('operation replay fails closed when the recorded source prefix drifts', async () => {
  await withStateRoot(async (projectRoot) => {
    const operationId = randomUUID();
    const sourceRead: NativeSessionReadResult = {
      backend: 'source',
      sessionId: 'source-session',
      turns: [nativeTurn('source-1')],
    };
    const reads = new Map<string, NativeSessionReadResult>([['source-session', sourceRead]]);
    const failingTarget = new FakeProvider('target', reads, 'created-session', false, {
      failAppend: new OpenPError('stop after target-created receipt', EXIT_CODES.sessionState),
    });
    const sourceProvider = new FakeProvider('source', reads);
    await assert.rejects(() => runSeed({
      options: {
        backend: 'target',
        source: { kind: 'native', backend: 'source', sessionId: 'source-session' },
        resume: false,
        backendSessionId: null,
        model: null,
        reasoningEffort: null,
        timeoutMs: 0,
        operationId,
      },
      provider: failingTarget,
      sourceProvider,
      createBackend: () => failingTarget.createBackend(),
      cwd: projectRoot,
      debugLog: null,
      signal: new AbortController().signal,
      forceSignal: new AbortController().signal,
      killSignal: new AbortController().signal,
    }));
    reads.set('source-session', {
      ...sourceRead,
      turns: [nativeTurn('source-1', 'changed user', 'changed assistant')],
    });
    const replayTarget = new FakeProvider('target', reads, 'unused-created-session');

    await assert.rejects(
      () => runSeed({
        options: {
          backend: 'target',
          source: { kind: 'native', backend: 'source', sessionId: 'source-session' },
          resume: false,
          backendSessionId: null,
          model: null,
          reasoningEffort: null,
          timeoutMs: 0,
          operationId,
        },
        provider: replayTarget,
        sourceProvider: new FakeProvider('source', reads),
        createBackend: () => replayTarget.createBackend(),
        cwd: projectRoot,
        debugLog: null,
        signal: new AbortController().signal,
        forceSignal: new AbortController().signal,
        killSignal: new AbortController().signal,
      }),
      (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionState &&
        error.details?.conflict === true,
    );
    assert.deepEqual(replayTarget.runCalls, []);
    assert.equal(replayTarget.commitCount, 0);
  });
});

test('target-created operation replay rejects bootstrap native-state drift before append', async () => {
  await withStateRoot(async (projectRoot) => {
    const operationId = randomUUID();
    const reads = new Map<string, NativeSessionReadResult>();
    const failingTarget = new FakeProvider('target', reads, 'created-session', false, {
      failAppend: new OpenPError('stop after target-created receipt', EXIT_CODES.sessionState),
    });
    const irPath = join(projectRoot, 'ir.json');
    await writeFile(irPath, JSON.stringify({
      schemaVersion: 1,
      turns: [{ id: 'one', user: { text: 'remember one' }, assistant: { text: 'noted one' } }],
    }));
    const options = {
      backend: 'target',
      source: { kind: 'external-ir' as const, path: irPath },
      resume: false,
      backendSessionId: null,
      model: null,
      reasoningEffort: null,
      timeoutMs: 0,
      operationId,
    };

    await assert.rejects(() => runSeed({
      options,
      provider: failingTarget,
      sourceProvider: null,
      createBackend: () => failingTarget.createBackend(),
      cwd: projectRoot,
      debugLog: null,
      signal: new AbortController().signal,
      forceSignal: new AbortController().signal,
      killSignal: new AbortController().signal,
    }));

    const replayTarget = new FakeProvider('target', reads, 'unused-created-session', false, {
      transformNativeRead: (read, input) => input.sessionId === 'created-session'
        ? { ...read, nativeStateDigest: 'f'.repeat(64) }
        : read,
    });
    await assert.rejects(
      () => runSeed({
        options,
        provider: replayTarget,
        sourceProvider: null,
        createBackend: () => replayTarget.createBackend(),
        cwd: projectRoot,
        debugLog: null,
        signal: new AbortController().signal,
        forceSignal: new AbortController().signal,
        killSignal: new AbortController().signal,
      }),
      (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.protocolViolation &&
        /bootstrap native state differs/.test(error.message),
    );
    assert.deepEqual(replayTarget.runCalls, []);
    assert.equal(replayTarget.commitCount, 0);
  });
});

test('creating operation replay becomes indeterminate without a second bootstrap', async () => {
  await withStateRoot(async (projectRoot, stateRoot) => {
    const operationId = randomUUID();
    const reads = new Map<string, NativeSessionReadResult>();
    const provider = new FakeProvider('target', reads, 'created-session', false, {
      beforeRun: async () => {
        throw new OpenPError('simulated crash before bootstrap', EXIT_CODES.sessionState);
      },
    });
    const irPath = join(projectRoot, 'ir.json');
    await writeFile(irPath, JSON.stringify({
      schemaVersion: 1,
      turns: [{ id: 'one', user: { text: 'remember one' }, assistant: { text: 'noted one' } }],
    }));

    await assert.rejects(() => runSeed({
      options: {
        backend: 'target',
        source: { kind: 'external-ir', path: irPath },
        resume: false,
        backendSessionId: null,
        model: null,
        reasoningEffort: null,
        timeoutMs: 0,
        operationId,
      },
      provider,
      sourceProvider: null,
      createBackend: () => provider.createBackend(),
      cwd: projectRoot,
      debugLog: null,
      signal: new AbortController().signal,
      forceSignal: new AbortController().signal,
      killSignal: new AbortController().signal,
    }));
    assert.equal((await new SeedOperationReceiptStore(projectRoot, stateRoot).load(operationId))?.phase, 'creating');
    await writeFile(irPath, '{invalidated source');

    const replayTarget = new FakeProvider('target', reads, 'should-not-bootstrap');
    let createCalls = 0;
    await assert.rejects(
      () => runSeed({
        options: {
          backend: 'target',
          source: { kind: 'external-ir', path: irPath },
          resume: false,
          backendSessionId: null,
          model: null,
          reasoningEffort: null,
          timeoutMs: 0,
          operationId,
        },
        provider: replayTarget,
        sourceProvider: null,
        createBackend: () => {
          createCalls += 1;
          return replayTarget.createBackend();
        },
        cwd: projectRoot,
        debugLog: null,
        signal: new AbortController().signal,
        forceSignal: new AbortController().signal,
        killSignal: new AbortController().signal,
      }),
      (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionState,
    );

    assert.equal(createCalls, 0);
    assert.deepEqual(replayTarget.runCalls, []);
    assert.equal((await new SeedOperationReceiptStore(projectRoot, stateRoot).load(operationId))?.phase, 'indeterminate');
    assert.equal(reads.has('should-not-bootstrap'), false);
  });
});

test('operation and target locks remain held through pre-terminal settlement', async () => {
  await withStateRoot(async (projectRoot, stateRoot) => {
    const operationId = randomUUID();
    const reads = new Map<string, NativeSessionReadResult>();
    let enteredCleanup!: () => void;
    let releaseCleanup!: () => void;
    const cleanupEntered = new Promise<void>((resolve) => {
      enteredCleanup = resolve;
    });
    const cleanupRelease = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    let shouldBlock = true;
    const provider = new FakeProvider('target', reads, 'created-session', false, {
      hasCleanupCapability: true,
      beforeCleanup: async () => {
        if (!shouldBlock) return;
        shouldBlock = false;
        enteredCleanup();
        await cleanupRelease;
      },
    });
    const irPath = join(projectRoot, 'ir.json');
    await writeFile(irPath, JSON.stringify({
      schemaVersion: 1,
      turns: [{ id: 'one', user: { text: 'remember one' }, assistant: { text: 'noted one' } }],
    }));
    const run = () => runSeed({
      options: {
        backend: 'target',
        source: { kind: 'external-ir' as const, path: irPath },
        resume: false,
        backendSessionId: null,
        model: null,
        reasoningEffort: null,
        timeoutMs: 0,
        operationId,
      },
      provider,
      sourceProvider: null,
      createBackend: () => provider.createBackend(),
      cwd: projectRoot,
      debugLog: null,
      signal: new AbortController().signal,
      forceSignal: new AbortController().signal,
      killSignal: new AbortController().signal,
    });

    const firstPromise = run();
    await cleanupEntered;
    try {
      await assert.rejects(
        run,
        (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionBusy,
      );
      await assert.rejects(
        () => new SessionLockStore(projectRoot, stateRoot).acquire('created-session'),
        (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionBusy,
      );
      await assert.rejects(
        () => new SeedOperationLockStore(projectRoot, stateRoot).acquire(operationId),
        (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionBusy,
      );
      assert.equal(provider.runCalls.length, 1);
      assert.equal(provider.commitCount, 1);
      assert.equal((await new SeedOperationReceiptStore(projectRoot, stateRoot).load(operationId))?.phase, 'target-created');
      assert.notEqual(await new SeedAppendJournalStore(projectRoot, stateRoot).load('target', 'created-session'), null);
    } finally {
      releaseCleanup();
    }
    const first = await firstPromise;
    const replayed = await run();
    assert.deepEqual(replayed, first);
    assert.equal(first.target.sessionId, 'created-session');
    assert.equal(provider.runCalls.length, 1);
    assert.equal(provider.commitCount, 1);
    assert.equal(provider.cleanupCount, 1);
    assert.equal((await new SeedOperationReceiptStore(projectRoot, stateRoot).load(operationId))?.phase, 'succeeded');
  });
});

test('target-created operation replay settles a pending committed suffix and returns original create result', async () => {
  await withStateRoot(async (projectRoot, stateRoot) => {
    const operationId = randomUUID();
    const sourceRead: NativeSessionReadResult = {
      backend: 'source',
      sessionId: 'source-session',
      turns: [nativeTurn('source-1')],
    };
    const reads = new Map<string, NativeSessionReadResult>([['source-session', sourceRead]]);
    const firstTarget = new FakeProvider('target', reads, 'created-session', false, {
      afterAppend: async () => {
        throw new OpenPError('simulated crash after native commit', EXIT_CODES.sessionState);
      },
    });
    const sourceProvider = new FakeProvider('source', reads);
    await assert.rejects(() => runSeed({
      options: {
        backend: 'target',
        source: { kind: 'native', backend: 'source', sessionId: 'source-session' },
        resume: false,
        backendSessionId: null,
        model: null,
        reasoningEffort: null,
        timeoutMs: 0,
        operationId,
      },
      provider: firstTarget,
      sourceProvider,
      createBackend: () => firstTarget.createBackend(),
      cwd: projectRoot,
      debugLog: null,
      signal: new AbortController().signal,
      forceSignal: new AbortController().signal,
      killSignal: new AbortController().signal,
    }));
    assert.equal(firstTarget.commitCount, 1);
    assert.equal((await new SeedOperationReceiptStore(projectRoot, stateRoot).load(operationId))?.phase, 'target-created');
    assert.notEqual(await new SeedAppendJournalStore(projectRoot, stateRoot).load('target', 'created-session'), null);

    const replayTarget = new FakeProvider('target', reads, 'unused-created-session');
    const replayed = await runSeed({
      options: {
        backend: 'target',
        source: { kind: 'native', backend: 'source', sessionId: 'source-session' },
        resume: false,
        backendSessionId: null,
        model: null,
        reasoningEffort: null,
        timeoutMs: 0,
        operationId,
      },
      provider: replayTarget,
      sourceProvider: new FakeProvider('source', reads),
      createBackend: () => replayTarget.createBackend(),
      cwd: projectRoot,
      debugLog: null,
      signal: new AbortController().signal,
      forceSignal: new AbortController().signal,
      killSignal: new AbortController().signal,
    });

    assert.equal(replayed.status, 'created');
    assert.equal(replayed.appendedTurns, 1);
    assert.equal(replayed.target.sessionId, 'created-session');
    assert.deepEqual(replayTarget.runCalls, []);
    assert.equal(replayTarget.commitCount, 0);
    assert.equal(reads.get('created-session')?.turns.length, 2);
    assert.equal(await new SeedAppendJournalStore(projectRoot, stateRoot).load('target', 'created-session'), null);
    assert.equal((await new SeedOperationReceiptStore(projectRoot, stateRoot).load(operationId))?.phase, 'succeeded');
  });
});

test('target-created replay recovers a completed operation after later ordinary target turns', async () => {
  await withStateRoot(async (projectRoot, stateRoot) => {
    const operationId = randomUUID();
    const reads = new Map<string, NativeSessionReadResult>();
    const firstTarget = new FakeProvider('target', reads, 'created-session', false, {
      afterAppend: async () => {
        throw new OpenPError('simulated crash after native commit', EXIT_CODES.sessionState);
      },
    });
    const irPath = join(projectRoot, 'ir.json');
    await writeFile(irPath, JSON.stringify({
      schemaVersion: 1,
      turns: [{ id: 'one', user: { text: 'remember one' }, assistant: { text: 'noted one' } }],
    }));
    const options = {
      backend: 'target',
      source: { kind: 'external-ir' as const, path: irPath },
      resume: false,
      backendSessionId: null,
      model: null,
      reasoningEffort: null,
      timeoutMs: 0,
      operationId,
    };

    await assert.rejects(() => runSeed({
      options,
      provider: firstTarget,
      sourceProvider: null,
      createBackend: () => firstTarget.createBackend(),
      cwd: projectRoot,
      debugLog: null,
      signal: new AbortController().signal,
      forceSignal: new AbortController().signal,
      killSignal: new AbortController().signal,
    }));
    assert.equal((await new SeedOperationReceiptStore(projectRoot, stateRoot).load(operationId))?.phase, 'target-created');

    await settleProviderPending(firstTarget, 'created-session', projectRoot, new AbortController().signal);
    assert.equal(await new SeedAppendJournalStore(projectRoot, stateRoot).load('target', 'created-session'), null);
    const settled = reads.get('created-session');
    assert.ok(settled);
    reads.set('created-session', {
      ...settled,
      turns: [...settled.turns, nativeTurn('later-ordinary')],
    });

    const replayTarget = new FakeProvider('target', reads, 'must-not-bootstrap');
    const replayed = await runSeed({
      options,
      provider: replayTarget,
      sourceProvider: null,
      createBackend: () => replayTarget.createBackend(),
      cwd: projectRoot,
      debugLog: null,
      signal: new AbortController().signal,
      forceSignal: new AbortController().signal,
      killSignal: new AbortController().signal,
    });

    assert.equal(replayed.status, 'created');
    assert.equal(replayed.target.sessionId, 'created-session');
    assert.equal(replayed.appendedTurns, 1);
    assert.deepEqual(replayTarget.runCalls, []);
    assert.equal(replayTarget.commitCount, 0);
    assert.equal(reads.get('created-session')?.turns.length, 3);
    assert.equal((await new SeedOperationReceiptStore(projectRoot, stateRoot).load(operationId))?.phase, 'succeeded');
  });
});
