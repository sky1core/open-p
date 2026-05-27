import assert from 'node:assert/strict';
import test from 'node:test';
import { ClaudeCodeBackgroundRouter, isClaudeCodeTaskNotificationLine } from '../src/backends/claude/background-parser.js';

function line(event: unknown): string {
  return JSON.stringify(event);
}

test('routes assistant text only after task-notification user events', () => {
  const router = new ClaudeCodeBackgroundRouter();

  assert.deepEqual(router.consumeLine(line({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'active text' }] },
  })), []);
  assert.deepEqual(router.consumeLine(line({
    type: 'user',
    uuid: 'background-user',
    origin: { kind: 'task-notification' },
    message: { content: 'task complete' },
  })), []);
  assert.deepEqual(router.consumeLine(line({
    type: 'assistant',
    parentUuid: 'background-user',
    message: {
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: '  background text\n' }],
    },
  })), ['  background text\n']);
});

test('flushes background text on result fallback and ignores malformed lines', () => {
  const router = new ClaudeCodeBackgroundRouter();

  assert.deepEqual(router.consumeLine('local noise'), []);
  assert.deepEqual(router.consumeLine(line({
    type: 'user',
    uuid: 'background-user',
    origin: { kind: 'task-notification' },
  })), []);
  assert.deepEqual(router.consumeLine(line({
    type: 'assistant',
    parentUuid: 'background-user',
    message: {
      content: [
        { type: 'text', text: 'one' },
        { type: 'text', text: 'two' },
      ],
    },
  })), []);
  assert.deepEqual(router.consumeLine(line({ type: 'result', parentUuid: 'background-user' })), ['one\n\ntwo']);
});

test('does not route active assistant text with a non-background parent', () => {
  const router = new ClaudeCodeBackgroundRouter();

  assert.deepEqual(router.consumeLine(line({
    type: 'user',
    uuid: 'background-user',
    origin: { kind: 'task-notification' },
    message: { content: 'task complete' },
  })), []);
  assert.deepEqual(router.consumeLine(line({
    type: 'assistant',
    parentUuid: 'active-parent',
    message: {
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'active result' }],
    },
  })), []);
  assert.deepEqual(router.consumeLine(line({
    type: 'assistant',
    parentUuid: 'background-user',
    message: {
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'background text' }],
    },
  })), ['background text']);
});

test('does not route parentless assistant text after task-notification', () => {
  const router = new ClaudeCodeBackgroundRouter();

  assert.deepEqual(router.consumeLine(line({
    type: 'user',
    uuid: 'background-user',
    origin: { kind: 'task-notification' },
    message: { content: 'task complete' },
  })), []);
  assert.deepEqual(router.consumeLine(line({
    type: 'assistant',
    message: {
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'active result or background text' }],
    },
  })), []);
});

test('synthetic no-response assistant closes linked background task without routing text', () => {
  const router = new ClaudeCodeBackgroundRouter();

  assert.deepEqual(router.consumeLine(line({
    type: 'user',
    uuid: 'background-user',
    origin: { kind: 'task-notification' },
    message: { content: 'task complete' },
  })), []);
  assert.deepEqual(router.consumeLine(line({
    type: 'assistant',
    parentUuid: 'background-user',
    message: {
      model: '<synthetic>',
      stop_reason: 'stop_sequence',
      stop_sequence: '',
      content: [{ type: 'text', text: 'No response requested.' }],
    },
  })), []);
  assert.deepEqual(router.consumeLine(line({
    type: 'assistant',
    parentUuid: 'background-user',
    message: {
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'late background text' }],
    },
  })), []);
});

test('detects task-notification lines for route capture', () => {
  assert.equal(isClaudeCodeTaskNotificationLine(line({
    type: 'user',
    origin: { kind: 'task-notification' },
  })), true);
  assert.equal(isClaudeCodeTaskNotificationLine(line({
    type: 'user',
    origin: { kind: 'manual' },
  })), false);
  assert.equal(isClaudeCodeTaskNotificationLine('not json'), false);
});
