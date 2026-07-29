import assert from 'node:assert/strict';
import test from 'node:test';
import { OPENCODE_DESCRIPTOR } from '../../src/backends/opencode/descriptor.js';

test('OpenCode descriptor does not advertise a hardcoded reasoning effort catalog', () => {
  assert.deepEqual(OPENCODE_DESCRIPTOR.reasoningEfforts, []);
});
