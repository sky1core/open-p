import assert from 'node:assert/strict';
import test from 'node:test';
import { toWorkerTurnResult } from '../src/core/worker-result.js';
import type { TurnResult } from '../src/core/types.js';

test('maps current turn result to null-safe worker result diagnostics', () => {
  const result: TurnResult = {
    turnId: 'turn-1',
    text: 'hello',
    reasoningContent: 'reasoning',
    structuredOutput: { ok: true },
    requestId: 'req_1',
    diagnostics: {
      durationMs: 123,
      toolsUsed: ['Bash'],
      usage: {
        inputTokens: 10,
        cacheReadInputTokens: 5,
        outputTokens: 3,
      },
      rawEventCount: 4,
    },
  };

  assert.deepEqual(toWorkerTurnResult(result, 'session-1', {
    contextWindow: 200_000,
    intermediateTextCount: 2,
  }), {
    content: 'hello',
    reasoningContent: 'reasoning',
    structuredOutput: { ok: true },
    requestId: 'req_1',
    sessionId: 'session-1',
    diagnostics: {
      numTurns: null,
      inputTokens: 10,
      outputTokens: 3,
      cacheReadInputTokens: 5,
      contextWindow: 200_000,
      lastSubturnContextTokens: null,
      durationMs: 123,
      totalCostUsd: null,
      stopReason: null,
      toolsUsed: ['Bash'],
      autoCompacted: null,
      intermediateTextCount: 2,
    },
  });
});

test('maps last subturn context usage from explicit last subturn usage', () => {
  const result: TurnResult = {
    turnId: 'turn-1',
    text: 'hello',
    diagnostics: {
      durationMs: 123,
      toolsUsed: [],
      usage: {
        inputTokens: 100,
        cacheReadInputTokens: 200,
        outputTokens: 30,
      },
      lastSubturnUsage: {
        inputTokens: 10,
        cacheReadInputTokens: 5,
        outputTokens: 3,
      },
      rawEventCount: 4,
    },
  };

  const workerResult = toWorkerTurnResult(result, 'session-1');

  assert.deepEqual(workerResult.diagnostics.lastSubturnUsage, {
    inputTokens: 10,
    cacheReadInputTokens: 5,
    outputTokens: 3,
  });
  assert.equal(workerResult.diagnostics.lastSubturnContextTokens, 15);
});

test('does not fabricate context usage when token fields are missing', () => {
  const result: TurnResult = {
    turnId: 'turn-1',
    text: 'hello',
    diagnostics: {
      durationMs: null,
      toolsUsed: [],
      usage: {
        inputTokens: 10,
        cacheReadInputTokens: null,
        outputTokens: null,
      },
      rawEventCount: 4,
    },
  };

  assert.equal(toWorkerTurnResult(result, 'session-1').diagnostics.lastSubturnContextTokens, null);
});
