import test from 'node:test';
import assert from 'node:assert/strict';
import { KIRO_DESCRIPTOR } from '../src/backends/kiro/descriptor.js';

test('Kiro descriptor publishes ACP backend boundaries', () => {
  assert.equal(KIRO_DESCRIPTOR.id, 'kiro');
  assert.equal(KIRO_DESCRIPTOR.commandDisplay, 'kiro-cli acp');
  assert.deepEqual(KIRO_DESCRIPTOR.capabilities, {
    streaming: true,
    streamingGranularity: 'subturn',
    backgroundAssistant: false,
    reasoningContent: false,
    abort: true,
    persistentProcess: false,
  });
});

test('Kiro descriptor publishes common execution modes without a hardcoded effort catalog', () => {
  assert.deepEqual(KIRO_DESCRIPTOR.reasoningEfforts, []);
  assert.deepEqual(KIRO_DESCRIPTOR.executionModes, ['default', 'danger-full-access']);
});
