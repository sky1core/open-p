import assert from 'node:assert/strict';
import test from 'node:test';
import { toWorkerTurnResult } from '../../src/core/worker-result.js';
import type { TurnResult } from '../../src/core/types.js';

test('maps current turn result without synthesizing backend context capacity', () => {
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

  const legacyMappingOptions = {
    contextWindow: 200_000,
    intermediateTextCount: 2,
  };
  assert.deepEqual(toWorkerTurnResult(result, 'session-1', legacyMappingOptions), {
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
      contextWindow: null,
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

test('maps backend-reported effort through worker diagnostics', () => {
  const result: TurnResult = {
    turnId: 'turn-effort-alpha',
    text: 'hello',
    diagnostics: {
      durationMs: 123,
      toolsUsed: [],
      usage: {
        inputTokens: 10,
        cacheReadInputTokens: 5,
        outputTokens: 3,
      },
      effort: 'actual-effort-alpha',
      rawEventCount: 4,
    },
  };

  const workerResult = toWorkerTurnResult(result, 'session-effort-alpha');

  assert.equal(workerResult.diagnostics.effort, 'actual-effort-alpha');
});

test('maps cache creation tokens through worker diagnostics and context usage', () => {
  const result: TurnResult = {
    turnId: 'turn-1',
    text: 'hello',
    diagnostics: {
      durationMs: 123,
      toolsUsed: [],
      usage: {
        inputTokens: 2,
        cacheReadInputTokens: 559_407,
        cacheCreationInputTokens: 6_407,
        outputTokens: 1,
      },
      lastSubturnUsage: {
        inputTokens: 2,
        cacheReadInputTokens: 559_407,
        cacheCreationInputTokens: 6_407,
        outputTokens: 1,
      },
      rawEventCount: 4,
    },
  };

  const workerResult = toWorkerTurnResult(result, 'session-1');

  assert.equal(workerResult.diagnostics.cacheCreationInputTokens, 6_407);
  assert.deepEqual(workerResult.diagnostics.lastSubturnUsage, {
    inputTokens: 2,
    cacheReadInputTokens: 559_407,
    cacheCreationInputTokens: 6_407,
    outputTokens: 1,
  });
  assert.equal(workerResult.diagnostics.lastSubturnContextTokens, 565_816);
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

test('maps a backend-reported permission mode through worker diagnostics', () => {
  const result: TurnResult = {
    turnId: 'turn-permission-alpha',
    text: 'hello',
    diagnostics: {
      durationMs: 123,
      toolsUsed: [],
      usage: { inputTokens: 10, cacheReadInputTokens: 5, outputTokens: 3 },
      permissionMode: 'actual-mode-alpha',
      rawEventCount: 4,
    },
  };

  assert.equal(toWorkerTurnResult(result, 'session-permission-alpha').diagnostics.permissionMode, 'actual-mode-alpha');
});
