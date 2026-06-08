import assert from 'node:assert/strict';
import test from 'node:test';
import { isSafeSessionId, MAX_SESSION_ID_BYTES } from '../src/core/session-id.js';

test('accepts opaque provider-generated session ids', () => {
  assert.equal(isSafeSessionId('not-a-uuid'), true);
  assert.equal(isSafeSessionId('agent.session:01@provider%test+ok='), true);
  assert.equal(isSafeSessionId('019e424e-23f7-7fe3-a303-d6b64e11d51d'), true);
});

test('rejects session ids that are unsafe as path components', () => {
  assert.equal(isSafeSessionId(''), false);
  assert.equal(isSafeSessionId(' leading-space'), false);
  assert.equal(isSafeSessionId('trailing-space '), false);
  assert.equal(isSafeSessionId('has/slash'), false);
  assert.equal(isSafeSessionId('has\\backslash'), false);
  assert.equal(isSafeSessionId('-dash-leading'), false);
  assert.equal(isSafeSessionId('--help'), false);
  assert.equal(isSafeSessionId('has\nnewline'), false);
  assert.equal(isSafeSessionId('a'.repeat(MAX_SESSION_ID_BYTES + 1)), false);
});
