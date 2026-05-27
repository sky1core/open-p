import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCodexBin } from '../src/backends/codex/bin.js';

test('resolveCodexBin returns "codex" by default', () => {
  assert.equal(resolveCodexBin(), 'codex');
});
