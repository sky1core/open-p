import assert from 'node:assert/strict';
import test from 'node:test';
import { TRANSCRIPT_CONTEXT_POLICY, prepareWorkerTurnInput } from '../src/core/worker-input.js';

test('prepares first turn as raw user message', () => {
  const prepared = prepareWorkerTurnInput({
    sessionId: null,
    isFirstTurn: true,
    projectRoot: '/work/open-p',
    message: 'continue',
    seedContext: 'seed must not be injected',
    transcript: [{ role: 'assistant', content: 'old' }],
  });

  assert.equal(prepared.isFirstTurn, true);
  assert.equal(prepared.prompt, 'continue');
  assert.equal(prepared.transcriptPolicy, TRANSCRIPT_CONTEXT_POLICY);
});

test('prepares resume turn as raw user message', () => {
  const prepared = prepareWorkerTurnInput({
    sessionId: '11111111-1111-4111-8111-111111111111',
    isFirstTurn: false,
    projectRoot: '/work/open-p',
    message: 'next turn',
    seedContext: 'must not be duplicated',
    transcript: [{ role: 'user', content: 'old' }],
  });

  assert.equal(prepared.isFirstTurn, false);
  assert.equal(prepared.prompt, 'next turn');
  assert.equal(prepared.transcriptPolicy, TRANSCRIPT_CONTEXT_POLICY);
});

test('keeps explicit first turn raw even with an existing backend session id', () => {
  const prepared = prepareWorkerTurnInput({
    sessionId: '11111111-1111-4111-8111-111111111111',
    isFirstTurn: true,
    projectRoot: '/work/open-p',
    message: 'first with known id',
    seedContext: null,
  });

  assert.equal(prepared.isFirstTurn, true);
  assert.equal(prepared.prompt, 'first with known id');
});

test('rejects missing first-turn intent instead of inferring it from session id', () => {
  assert.throws(
    () => prepareWorkerTurnInput({
      sessionId: null,
      projectRoot: '/work/open-p',
      message: 'missing explicit flag',
    } as Parameters<typeof prepareWorkerTurnInput>[0]),
    /worker turn requires explicit isFirstTurn/,
  );
});
