import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveKiroBin } from '../src/backends/kiro/bin.js';

test('resolveKiroBin defaults to kiro-cli', () => {
  assert.equal(resolveKiroBin(), 'kiro-cli');
});
