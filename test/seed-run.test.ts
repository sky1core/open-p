import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
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
} from '../src/core/backend.js';
import type { BackendRunOptions, TurnRequest, TurnResult } from '../src/core/types.js';
import { CODEX_DESCRIPTOR } from '../src/backends/codex/descriptor.js';
import { SessionStateStore } from '../src/core/session-state.js';
import { resolveOpenPStateRoot } from '../src/core/state-root.js';
import { runSeed } from '../src/core/seed.js';
import { SeedProvenanceStore, createInitialProvenanceState, nativeSourceRefs, withAppendedProvenanceEntries } from '../src/core/seed-provenance.js';
import { logicalTurnsFromNative } from '../src/core/seed-ir.js';

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

class FakeBackend implements Backend {
  constructor(
    private readonly sessionId: string,
    private readonly reads: Map<string, NativeSessionReadResult>,
  ) {}

  async runTurn(request: TurnRequest, _options: BackendRunOptions): Promise<TurnResult> {
    this.reads.set(this.sessionId, {
      backend: 'target',
      sessionId: this.sessionId,
      turns: [nativeTurn('bootstrap', 'Reply with only: OK', 'OK')],
    });
    return result(request.turnId, this.sessionId);
  }
}

class FakeProvider implements BackendProvider {
  readonly descriptor;
  readonly appended: NativeWrittenTurn[] = [];

  constructor(
    readonly id: string,
    private readonly reads: Map<string, NativeSessionReadResult>,
    private readonly createSessionId = 'created-session',
    private readonly corruptWrittenTurn = false,
  ) {
    this.descriptor = { ...CODEX_DESCRIPTOR, id, label: id };
  }

  createBackend(): Backend {
    return new FakeBackend(this.createSessionId, this.reads);
  }

  createWorkerBridge(): BackendWorkerBridge {
    throw new Error('not used');
  }

  async resolveSessionLogPath(): Promise<string | null> {
    return null;
  }

  async readNativeSession(input: { readonly sessionId: string }): Promise<NativeSessionReadResult> {
    const read = this.reads.get(input.sessionId);
    assert.ok(read, `missing fake native read for ${input.sessionId}`);
    return read;
  }

  async appendSessionHistory(input: AppendSessionHistoryInput): Promise<AppendSessionHistoryResult> {
    const read = this.reads.get(input.sessionId);
    assert.ok(read, `missing fake target read for ${input.sessionId}`);
    const written = input.turns.map((turn, index): NativeWrittenTurn => ({
      logicalId: this.corruptWrittenTurn ? `corrupt:${turn.logicalId}` : turn.logicalId,
      contentDigest: turn.contentDigest,
      nativeIds: nativeIds(`written-${this.appended.length + index}`),
    }));
    this.reads.set(input.sessionId, {
      ...read,
      turns: [
        ...read.turns,
        ...input.turns.map((turn, index) => ({
          userText: turn.userText,
          assistantText: turn.assistantText,
          nativeIds: written[index]!.nativeIds,
        })),
      ],
    });
    this.appended.push(...written);
    return { turns: written };
  }
}

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
    });

    assert.equal(seed.status, 'created');
    assert.equal(seed.appendedTurns, 1);
    assert.equal(provider.appended.length, 1);
    const store = new SeedProvenanceStore(projectRoot, stateRoot);
    const provenance = await store.load('target', 'created-session');
    assert.equal(provenance?.bootstrap.length, 1);
    assert.equal(provenance?.entries.length, 1);
    assert.equal(provenance?.entries[0]!.source.kind, 'external-ir');
    const stored = await readFile(store.pathForSession('target', 'created-session'), 'utf8');
    assert.equal(stored.includes('codename REDMOON'), false);
    assert.equal(stored.includes('sensitive caller transcript in external id'), false);
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
    await new SeedProvenanceStore(projectRoot, stateRoot).save(provenance);

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

test('same native source and target no-op does not read or write native artifacts', async () => {
  await withStateRoot(async (projectRoot, stateRoot) => {
    const reads = new Map<string, NativeSessionReadResult>();
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
      (error) => error instanceof Error && 'exitCode' in error && error.exitCode === 40,
    );
  });
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
