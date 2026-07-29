import assert from 'node:assert/strict';
import test from 'node:test';
import type { NativeSessionTurn, NativeWrittenTurn, SeedWriteTurn } from '../../src/core/backend.js';
import { OpenPError } from '../../src/core/errors.js';
import { assertNativeAppendCandidate } from '../../src/core/native-append-preflight.js';

const before: readonly NativeSessionTurn[] = [{
  userText: 'old user',
  assistantText: 'old assistant',
  nativeIds: { userId: 'old-u', assistantIds: ['old-a'], completionId: 'old-c' },
}];
const requested: readonly SeedWriteTurn[] = [{
  logicalId: 'logical-new',
  userText: 'new user',
  assistantText: 'new assistant',
  contentDigest: 'digest-new',
  sourceNativeIds: null,
}];
const written: readonly NativeWrittenTurn[] = [{
  logicalId: 'logical-new',
  contentDigest: 'digest-new',
  nativeIds: { userId: 'new-u', assistantIds: ['new-a'], completionId: 'new-c' },
}];
const candidate: readonly NativeSessionTurn[] = [
  ...before,
  {
    userText: 'new user',
    assistantText: 'new assistant',
    nativeIds: { userId: 'new-u', assistantIds: ['new-a'], completionId: 'new-c' },
  },
];

function verify(overrides: Partial<Parameters<typeof assertNativeAppendCandidate>[0]> = {}): void {
  assertNativeAppendCandidate({ backend: 'Test', before, requested, written, candidate, ...overrides });
}

function rejects(overrides: Partial<Parameters<typeof assertNativeAppendCandidate>[0]>): void {
  assert.throws(
    () => verify(overrides),
    (error) => error instanceof OpenPError && error.exitCode === 40,
  );
}

test('native append preflight accepts an exact preserved prefix and exact requested suffix', () => {
  assert.doesNotThrow(() => verify());
});

test('native append preflight rejects prefix loss, mutation, reordering, and native-id drift', () => {
  rejects({ candidate: candidate.slice(1) });
  rejects({ candidate: [{ ...before[0]!, userText: 'changed' }, candidate[1]!] });
  rejects({
    candidate: [
      { ...before[0]!, nativeIds: { ...before[0]!.nativeIds, completionId: 'changed' } },
      candidate[1]!,
    ],
  });
  const secondOldTurn: NativeSessionTurn = {
    userText: 'second old user',
    assistantText: 'second old assistant',
    nativeIds: { userId: 'old-u-2', assistantIds: ['old-a-2'], completionId: 'old-c-2' },
  };
  rejects({
    before: [before[0]!, secondOldTurn],
    candidate: [secondOldTurn, before[0]!, candidate[1]!],
  });
});

test('native append preflight rejects suffix text, native ids, logical ids, and digests that drift', () => {
  rejects({ candidate: [before[0]!, { ...candidate[1]!, assistantText: 'changed' }] });
  rejects({
    candidate: [
      before[0]!,
      { ...candidate[1]!, nativeIds: { ...candidate[1]!.nativeIds, assistantIds: ['changed'] } },
    ],
  });
  rejects({ written: [{ ...written[0]!, logicalId: 'changed' }] });
  rejects({ written: [{ ...written[0]!, contentDigest: 'changed' }] });
});
