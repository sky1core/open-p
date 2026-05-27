import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveInitialTurnSessionId } from '../src/core/backend-session-policy.js';

test('resolveInitialTurnSessionId omits session id on first turns', () => {
  assert.equal(resolveInitialTurnSessionId({
    resume: false,
    backendSessionId: 'open-p-session',
  }), null);
});

test('resolveInitialTurnSessionId always uses resume id on resume turns', () => {
  assert.equal(resolveInitialTurnSessionId({
    resume: true,
    backendSessionId: 'existing-backend-session',
  }), 'existing-backend-session');
});
