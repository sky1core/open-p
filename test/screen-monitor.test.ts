import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPublishableIntermediateText } from '../src/backends/claude/screen-monitor.js';

test('screen intermediate publishing accepts any non-identical non-empty text', () => {
  assert.equal(isPublishableIntermediateText('hello', null), true);
  assert.equal(isPublishableIntermediateText('hello world', 'hello'), true);
  assert.equal(isPublishableIntermediateText('HELLO world', 'hello'), true);
  assert.equal(isPublishableIntermediateText('world', 'hello'), true);
  assert.equal(isPublishableIntermediateText('hello', 'hello'), false);
  assert.equal(isPublishableIntermediateText('', 'hello'), false);
  assert.equal(isPublishableIntermediateText(null, 'hello'), false);
});
