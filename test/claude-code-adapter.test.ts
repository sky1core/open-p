import assert from 'node:assert/strict';
import test from 'node:test';
import { exitPtyAfterTurn } from '../src/backends/claude-code/adapter.js';

test('single-turn backend propagates PTY exit failure after successful turn', async () => {
  await assert.rejects(
    () => exitPtyAfterTurn({
      exit: async () => {
        throw new Error('exit failed');
      },
    }, null),
    /exit failed/,
  );
});

test('single-turn backend does not mask the primary turn failure with PTY exit failure', async () => {
  await assert.doesNotReject(() => exitPtyAfterTurn({
    exit: async () => {
      throw new Error('exit failed');
    },
  }, new Error('primary failed')));
});
