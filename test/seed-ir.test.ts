import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { NativeSessionReadResult, NativeTurnIds, NativeWrittenTurn } from '../src/core/backend.js';
import { OpenPError } from '../src/core/errors.js';
import {
  contentDigest,
  logicalTurnsFromNative,
  parseExternalSeedIrJson,
} from '../src/core/seed-ir.js';
import {
  createInitialProvenanceState,
  nativeSourceRefs,
  normalizeNativeReadWithProvenance,
  planSeedAppend,
  withAppendedProvenanceEntries,
  type SeedProvenanceState,
} from '../src/core/seed-provenance.js';
import { loadExternalSeedIrFile } from '../src/core/seed-ir.js';

function rejects(fn: () => unknown, exitCode = 2): void {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof OpenPError, `expected OpenPError, got ${String(error)}`);
    assert.equal(error.exitCode, exitCode);
    return;
  }
  throw new Error('expected function to reject');
}

function ids(prefix: string): NativeTurnIds {
  return {
    userId: `${prefix}:u`,
    assistantIds: [`${prefix}:a`],
    completionId: `${prefix}:done`,
  };
}

function read(backend: string, sessionId: string, turns: readonly {
  readonly prefix: string;
  readonly userText?: string;
  readonly assistantText?: string;
}[]): NativeSessionReadResult {
  return {
    backend,
    sessionId,
    turns: turns.map((turn) => ({
      userText: turn.userText ?? 'same user',
      assistantText: turn.assistantText ?? 'same assistant',
      nativeIds: ids(turn.prefix),
    })),
  };
}

function written(logicalId: string, digest: string, prefix: string): NativeWrittenTurn {
  return {
    logicalId,
    contentDigest: digest,
    nativeIds: ids(prefix),
  };
}

test('external IR parses strict completed user/assistant pairs and namespaces ids by document digest', () => {
  const text = JSON.stringify({
    schemaVersion: 1,
    turns: [
      { id: 'one', user: { text: 'hi' }, assistant: { text: 'yo' } },
      { id: 'two', user: { text: 'hi' }, assistant: { text: 'yo' } },
    ],
  });
  const parsed = parseExternalSeedIrJson(text, '/tmp/ir.json');
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.turns.length, 2);
  assert.match(parsed.documentDigest, /^[0-9a-f]{64}$/);
  assert.match(parsed.turns[0]!.logicalId, /^ir:[0-9a-f]{64}$/);
  assert.notEqual(parsed.turns[0]!.logicalId, 'one');
  assert.notEqual(parsed.turns[0]!.logicalId, parsed.turns[1]!.logicalId);
  assert.equal(parsed.turns[0]!.contentDigest, parsed.turns[1]!.contentDigest);

  const changedDocument = parseExternalSeedIrJson(text.replace('"two"', '"two-renamed"'), '/tmp/ir.json');
  assert.notEqual(changedDocument.documentDigest, parsed.documentDigest);
  assert.notEqual(changedDocument.turns[0]!.logicalId, parsed.turns[0]!.logicalId);
});

test('external IR rejects unknown keys, empty text, duplicate ids, and non-pair shapes', () => {
  const malformed = [
    'not json',
    '[1,2,3]',
    '{"schemaVersion":1,"turns":[]}',
    '{"schemaVersion":2,"turns":[{"id":"x","user":{"text":"u"},"assistant":{"text":"a"}}]}',
    '{"schemaVersion":1,"turns":[{"id":"x","user":{"text":"u"},"assistant":{"text":"a"}}],"extra":1}',
    '{"schemaVersion":1,"turns":[{"id":"x","user":{"text":"u"},"assistant":{"text":"a"},"extra":1}]}',
    '{"schemaVersion":1,"turns":[{"id":"","user":{"text":"u"},"assistant":{"text":"a"}}]}',
    '{"schemaVersion":1,"turns":[{"id":1,"user":{"text":"u"},"assistant":{"text":"a"}}]}',
    '{"schemaVersion":1,"turns":[{"id":"x","user":null,"assistant":{"text":"a"}}]}',
    '{"schemaVersion":1,"turns":[{"id":"x","user":{"text":"u","extra":true},"assistant":{"text":"a"}}]}',
    '{"schemaVersion":1,"turns":[{"id":"x","user":{"text":1},"assistant":{"text":"a"}}]}',
    '{"schemaVersion":1,"turns":[{"id":"x","user":{"text":"u"},"assistant":[]}]}',
    '{"schemaVersion":1,"turns":[{"id":"x","user":{"text":"u"},"assistant":{"text":"a","extra":true}}]}',
    '{"schemaVersion":1,"turns":[{"id":"x","user":{"text":"u"},"assistant":{"text":""}}]}',
    '{"schemaVersion":1,"turns":[{"id":"x","user":{"text":"u"},"assistant":{"text":1}}]}',
    '{"schemaVersion":1,"turns":[{"id":"x","user":{"text":"u"},"assistant":{"text":"a"}},{"id":"x","user":{"text":"u2"},"assistant":{"text":"a2"}}]}',
    '{"schemaVersion":1,"turns":[{"id":"x","role":"user","text":"u"}]}',
  ];
  for (const text of malformed) {
    rejects(() => parseExternalSeedIrJson(text, '/tmp/ir.json'));
  }
});

test('loadExternalSeedIrFile reads and validates a strict IR file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openp-seed-ir-'));
  const path = join(dir, 'ir.json');
  await writeFile(path, '{"schemaVersion":1,"turns":[{"id":"one","user":{"text":"remember"},"assistant":{"text":"noted"}}]}');
  const parsed = await loadExternalSeedIrFile(path);
  assert.equal(parsed.turns[0]!.userText, 'remember');
  await assert.rejects(
    () => loadExternalSeedIrFile(join(dir, 'missing.json')),
    (error) => error instanceof OpenPError && error.exitCode === 2,
  );
});

test('loadExternalSeedIrFile rejects malformed UTF-8 instead of merging distinct raw documents', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openp-seed-ir-invalid-utf8-'));
  const prefix = Buffer.from('{"schemaVersion":1,"turns":[{"id":"one","user":{"text":"', 'utf8');
  const suffix = Buffer.from('"},"assistant":{"text":"noted"}}]}', 'utf8');

  for (const byte of [0x80, 0x81]) {
    const path = join(dir, `ir-${byte.toString(16)}.json`);
    await writeFile(path, Buffer.concat([prefix, Buffer.from([byte]), suffix]));
    await assert.rejects(
      () => loadExternalSeedIrFile(path),
      (error) => error instanceof OpenPError && error.exitCode === 2,
    );
  }
});

test('native logical ids use native structure so repeated identical text stays distinct', () => {
  const turns = logicalTurnsFromNative(read('claude', 'session-a', [{ prefix: 'one' }, { prefix: 'two' }]));
  assert.equal(turns[0]!.contentDigest, turns[1]!.contentDigest);
  assert.notEqual(turns[0]!.logicalId, turns[1]!.logicalId);
});

test('provenance excludes bootstrap and restores original logical ids across A to B to C to A', () => {
  const aRead = read('claude', 'A', [{ prefix: 'a1' }, { prefix: 'a2' }]);
  const aTurns = logicalTurnsFromNative(aRead);
  const bState = withAppendedProvenanceEntries(createInitialProvenanceState({
    backend: 'codex',
    sessionId: 'B',
    bootstrap: [ids('b0')],
  }), {
    targetBackend: 'codex',
    targetSessionId: 'B',
    bootstrap: [ids('b0')],
    sourceRefs: nativeSourceRefs('claude', 'A', aTurns),
    written: aTurns.map((turn, index) => written(turn.logicalId, turn.contentDigest, `b${index + 1}`)),
  });

  const bRead = read('codex', 'B', [{ prefix: 'b0' }, { prefix: 'b1' }, { prefix: 'b2' }]);
  const bTurns = normalizeNativeReadWithProvenance(bRead, bState);
  assert.deepEqual(bTurns.map((turn) => turn.logicalId), aTurns.map((turn) => turn.logicalId));

  const cState = withAppendedProvenanceEntries(createInitialProvenanceState({
    backend: 'kiro',
    sessionId: 'C',
    bootstrap: [],
  }), {
    targetBackend: 'kiro',
    targetSessionId: 'C',
    sourceRefs: nativeSourceRefs('codex', 'B', bTurns),
    written: bTurns.map((turn, index) => written(turn.logicalId, turn.contentDigest, `c${index + 1}`)),
  });
  const cTurns = normalizeNativeReadWithProvenance(read('kiro', 'C', [{ prefix: 'c1' }, { prefix: 'c2' }]), cState);
  assert.deepEqual(cTurns.map((turn) => turn.logicalId), aTurns.map((turn) => turn.logicalId));
  assert.equal(planSeedAppend(cTurns, logicalTurnsFromNative(aRead)).status, 'noop');
});

test('provenance rejects stale content and partial native id matches', () => {
  const source = logicalTurnsFromNative(read('claude', 'A', [{ prefix: 'a1', userText: 'u', assistantText: 'a' }]));
  const state = withAppendedProvenanceEntries(createInitialProvenanceState({
    backend: 'codex',
    sessionId: 'B',
    bootstrap: [],
  }), {
    targetBackend: 'codex',
    targetSessionId: 'B',
    sourceRefs: nativeSourceRefs('claude', 'A', source),
    written: [written(source[0]!.logicalId, source[0]!.contentDigest, 'b1')],
  });

  rejects(
    () => normalizeNativeReadWithProvenance(read('codex', 'B', [{ prefix: 'b1', userText: 'u', assistantText: 'changed' }]), state),
    40,
  );
  rejects(
    () => normalizeNativeReadWithProvenance({
      backend: 'codex',
      sessionId: 'B',
      turns: [{
        userText: 'u',
        assistantText: 'a',
        nativeIds: { userId: 'b1:u', assistantIds: ['other:a'], completionId: 'other:done' },
      }],
    }, state),
    40,
  );
  assert.equal(contentDigest('u', 'a'), source[0]!.contentDigest);
});

test('provenance rejects a target mapping missing after native rollback', () => {
  const source = logicalTurnsFromNative(read('claude', 'A', [
    { prefix: 'a1', userText: 'u1', assistantText: 'a1' },
    { prefix: 'a2', userText: 'u2', assistantText: 'a2' },
  ]));
  const state = withAppendedProvenanceEntries(createInitialProvenanceState({
    backend: 'codex',
    sessionId: 'B',
    bootstrap: [],
  }), {
    targetBackend: 'codex',
    targetSessionId: 'B',
    sourceRefs: nativeSourceRefs('claude', 'A', source),
    written: source.map((turn, index) => written(turn.logicalId, turn.contentDigest, `b${index + 1}`)),
  });

  rejects(
    () => normalizeNativeReadWithProvenance(read('codex', 'B', [
      { prefix: 'b1', userText: 'u1', assistantText: 'a1' },
    ]), state),
    40,
  );
});

test('provenance enforces one-to-one ordered logical and target mappings', () => {
  const sourceRead = read('claude', 'A', [
    { prefix: 'a1', userText: 'u1', assistantText: 'a1' },
    { prefix: 'a2', userText: 'u2', assistantText: 'a2' },
  ]);
  const source = logicalTurnsFromNative(sourceRead);
  const state = withAppendedProvenanceEntries(createInitialProvenanceState({
    backend: 'codex',
    sessionId: 'B',
    bootstrap: [],
  }), {
    targetBackend: 'codex',
    targetSessionId: 'B',
    sourceRefs: nativeSourceRefs('claude', 'A', source),
    written: source.map((turn, index) => written(turn.logicalId, turn.contentDigest, `b${index + 1}`)),
  });
  const targetRead = read('codex', 'B', [
    { prefix: 'b1', userText: 'u1', assistantText: 'a1' },
    { prefix: 'b2', userText: 'u2', assistantText: 'a2' },
  ]);

  const duplicateLogicalId: SeedProvenanceState = {
    ...state,
    entries: [state.entries[0]!, { ...state.entries[1]!, logicalId: state.entries[0]!.logicalId }],
  };
  rejects(() => normalizeNativeReadWithProvenance(targetRead, duplicateLogicalId), 40);

  const duplicateTarget: SeedProvenanceState = {
    ...state,
    entries: [state.entries[0]!, {
      ...state.entries[1]!,
      target: { ...state.entries[1]!.target, nativeIds: state.entries[0]!.target.nativeIds },
    }],
  };
  rejects(() => normalizeNativeReadWithProvenance(targetRead, duplicateTarget), 40);

  const forgedSameSessionSource: SeedProvenanceState = {
    ...state,
    entries: [{
      ...state.entries[0]!,
      source: { kind: 'native', backend: 'codex', sessionId: 'B', nativeIds: ids('b2') },
    }, state.entries[1]!],
  };
  rejects(() => normalizeNativeReadWithProvenance(targetRead, forgedSameSessionSource), 40);

  const reversedTargetRead = read('codex', 'B', [
    { prefix: 'b2', userText: 'u2', assistantText: 'a2' },
    { prefix: 'b1', userText: 'u1', assistantText: 'a1' },
  ]);
  rejects(() => normalizeNativeReadWithProvenance(reversedTargetRead, state), 40);

  const bootstrapOverlap: SeedProvenanceState = { ...state, bootstrap: [ids('b1')] };
  rejects(() => normalizeNativeReadWithProvenance(targetRead, bootstrapOverlap), 40);
});

test('provenance requires every recorded bootstrap mapping to remain present', () => {
  const state = createInitialProvenanceState({
    backend: 'codex',
    sessionId: 'B',
    bootstrap: [ids('bootstrap')],
  });
  rejects(() => normalizeNativeReadWithProvenance(read('codex', 'B', []), state), 40);
});

test('provenance requires bootstrap mappings to precede every seeded target mapping', () => {
  const source = logicalTurnsFromNative(read('claude', 'A', [{
    prefix: 'a1',
    userText: 'source user',
    assistantText: 'source answer',
  }]));
  const state = withAppendedProvenanceEntries(createInitialProvenanceState({
    backend: 'codex',
    sessionId: 'B',
    bootstrap: [ids('bootstrap')],
  }), {
    targetBackend: 'codex',
    targetSessionId: 'B',
    bootstrap: [ids('bootstrap')],
    sourceRefs: nativeSourceRefs('claude', 'A', source),
    written: [written(source[0]!.logicalId, source[0]!.contentDigest, 'seeded')],
  });
  const reordered = read('codex', 'B', [
    { prefix: 'seeded', userText: 'source user', assistantText: 'source answer' },
    { prefix: 'bootstrap' },
  ]);

  rejects(() => normalizeNativeReadWithProvenance(reordered, state), 40);
});

test('append planning allows only equal target or strict source suffix', () => {
  const source = logicalTurnsFromNative(read('claude', 'A', [{ prefix: 'a1' }, { prefix: 'a2' }, { prefix: 'a3' }]));
  assert.equal(planSeedAppend(source.slice(0, 2), source.slice(0, 2)).status, 'noop');
  const append = planSeedAppend(source, source.slice(0, 2));
  assert.equal(append.status, 'append');
  assert.deepEqual(append.missing.map((turn) => turn.logicalId), [source[2]!.logicalId]);
  rejects(() => planSeedAppend(source.slice(0, 2), source), 40);
  rejects(() => planSeedAppend(source, [source[0]!, source[2]!]), 40);
});

test('append planning rejects same logical id with different content digest', () => {
  const source = logicalTurnsFromNative(read('claude', 'A', [
    { prefix: 'a1', userText: 'user', assistantText: 'answer' },
    { prefix: 'a2', userText: 'next', assistantText: 'answer next' },
  ]));
  const changedPrefix = {
    ...source[0]!,
    assistantText: 'changed answer',
    contentDigest: contentDigest(source[0]!.userText, 'changed answer'),
  };

  rejects(() => planSeedAppend(source, [changedPrefix]), 40);
});
