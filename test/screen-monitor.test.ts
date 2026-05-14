import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldPublishPrefixIntermediate } from '../src/backends/claude-code/screen-monitor.js';

test('screen intermediate publishing only accepts prefix-compatible growth', () => {
  assert.equal(shouldPublishPrefixIntermediate('hello', null), true);
  assert.equal(shouldPublishPrefixIntermediate('hello world', 'hello'), true);
  assert.equal(shouldPublishPrefixIntermediate('HELLO world', 'hello'), false);
  assert.equal(shouldPublishPrefixIntermediate('world', 'hello'), false);
  assert.equal(shouldPublishPrefixIntermediate('hello', 'hello'), false);
  assert.equal(shouldPublishPrefixIntermediate('', 'hello'), false);
  assert.equal(shouldPublishPrefixIntermediate(null, 'hello'), false);
});
