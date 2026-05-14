import assert from 'node:assert/strict';
import test from 'node:test';
import { CLAUDE_CODE_DESCRIPTOR } from '../src/backends/claude-code/descriptor.js';

test('Claude Code descriptor publishes backend identity and implemented capabilities', () => {
  assert.equal(CLAUDE_CODE_DESCRIPTOR.id, 'claude-code');
  assert.notEqual(CLAUDE_CODE_DESCRIPTOR.id, 'claude');
  assert.notEqual(CLAUDE_CODE_DESCRIPTOR.id, 'codex');
  assert.deepEqual(CLAUDE_CODE_DESCRIPTOR.capabilities, {
    streaming: true,
    streamingGranularity: 'subturn',
    backgroundAssistant: true,
    reasoningContent: true,
    abort: true,
    persistentProcess: true,
  });
});

test('Claude Code descriptor leaves model metadata to configured local backends', () => {
  assert.equal(CLAUDE_CODE_DESCRIPTOR.defaultModel, null);
  assert.deepEqual(CLAUDE_CODE_DESCRIPTOR.models, []);
  assert.equal(CLAUDE_CODE_DESCRIPTOR.contextWindow, null);
  assert.deepEqual(CLAUDE_CODE_DESCRIPTOR.contextWindowsByModel, {});
});
