import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildIntermediateAssistantSnapshotEvents,
  createStreamingMessageState,
  formatBackgroundAssistantTextEvent,
  formatIntermediateReasoningEvent,
  formatIntermediateTextEvent,
  formatStreamingAnswerSnapshotEvents,
  formatStreamingMessageSnapshotEvents,
  formatTurnResult,
  formatWorkerTurnResult,
  resetStreamingMessageState,
} from '../src/core/output.js';
import type { AssistantEventSnapshot, TurnResult } from '../src/core/types.js';
import type { WorkerTurnResult } from '../src/core/worker-types.js';

const RESULT: TurnResult = {
  turnId: 'turn-1',
  text: 'hello',
  structuredOutput: { ok: true },
  requestId: 'req_1',
  diagnostics: {
    durationMs: 123,
    toolsUsed: ['Bash'],
    usage: {
      inputTokens: 10,
      cacheReadInputTokens: null,
      outputTokens: 3,
    },
    rawEventCount: 4,
  },
};

const WORKER_RESULT: WorkerTurnResult = {
  content: 'worker hello',
  reasoningContent: 'worker reasoning',
  structuredOutput: { ok: true },
  requestId: 'req_worker_1',
  sessionId: '22222222-2222-4222-8222-222222222222',
  diagnostics: {
    numTurns: 2,
    inputTokens: 20,
    outputTokens: 4,
    cacheReadInputTokens: 5,
    contextWindow: 200000,
    lastSubturnContextTokens: 25,
    durationMs: 456,
    totalCostUsd: null,
    stopReason: 'end_turn',
    toolsUsed: ['Read'],
    autoCompacted: false,
    intermediateTextCount: 1,
  },
};

test('formats text output as result answer text only', () => {
  assert.equal(formatTurnResult(RESULT, {
    outputFormat: 'text',
    backendSessionId: '11111111-1111-4111-8111-111111111111',
  }), 'hello\n');
});

test('formats verbose text output with marker after result answer text', () => {
  assert.equal(formatTurnResult(RESULT, {
    outputFormat: 'text',
    backendSessionId: '11111111-1111-4111-8111-111111111111',
    verbose: true,
  }), [
    'hello',
    '[openp verbose] enabled',
    '',
  ].join('\n'));
});

test('formats text output with opt-in warnings after result answer text', () => {
  assert.equal(formatTurnResult(RESULT, {
    outputFormat: 'text',
    backendSessionId: '11111111-1111-4111-8111-111111111111',
    warnings: [{
      severity: 'warning',
      code: 'streaming_result_diagnostic',
      message: 'Streaming result diagnostics were detected (1); result was preserved. Use --debug-log to record details.',
    }],
  }), [
    'hello',
    '[openp warning] streaming_result_diagnostic: Streaming result diagnostics were detected (1); result was preserved. Use --debug-log to record details.',
    '',
  ].join('\n'));
});

test('formats json output as one top-level openp result record', () => {
  const openp = parseJsonOpenP(formatTurnResult({
    ...RESULT,
    structuredOutput: undefined,
    reasoningContent: 'visible reasoning',
  }, {
    outputFormat: 'json',
    backendSessionId: '11111111-1111-4111-8111-111111111111',
    backend: 'codex',
    model: 'codex-test',
    contextWindow: 258400,
  }));

  assert.equal(openp.version, 1);
  assert.equal(openp.form, 'result');
  assert.equal(openp.scope, 'active');
  assert.equal(openp.turnId, 'turn-1');
  assert.equal(openp.sessionId, '11111111-1111-4111-8111-111111111111');
  assert.deepEqual(resultOutput(openp).answer, ['hello']);
  assert.deepEqual(resultOutput(openp).reasoning, ['visible reasoning']);
  assert.deepEqual(resultOutput(openp).toolCall, []);
  assert.deepEqual(resultOutput(openp).toolResult, []);
  assert.deepEqual(metadata(openp).usage, {
    inputTokens: 10,
    outputTokens: 3,
    cacheReadInputTokens: null,
  });
  assert.equal(metadata(openp).lastSubturnContextTokens, null);
  assert.deepEqual(metadata(openp).modelUsage, {
    'codex-test': {
      contextWindow: 258400,
      inputTokens: 10,
      outputTokens: 3,
    },
  });
  assert.equal(metadata(openp).stopReason, null);
  assert.equal(metadata(openp).numTurns, null);
});

test('formats result metadata with derived last subturn context token usage', () => {
  const openp = parseJsonOpenP(formatTurnResult({
    ...RESULT,
    structuredOutput: undefined,
    diagnostics: {
      ...RESULT.diagnostics,
      usage: {
        inputTokens: 100,
        cacheReadInputTokens: 200,
        outputTokens: 30,
      },
      lastSubturnUsage: {
        inputTokens: 7,
        cacheReadInputTokens: 3,
        outputTokens: 2,
      },
    },
  }, {
    outputFormat: 'json',
    backendSessionId: '11111111-1111-4111-8111-111111111111',
    backend: 'codex',
    model: 'codex-test',
    contextWindow: 258400,
  }));

  assert.deepEqual(metadata(openp).usage, {
    inputTokens: 100,
    outputTokens: 30,
    cacheReadInputTokens: 200,
  });
  assert.deepEqual(metadata(openp).lastSubturnUsage, {
    inputTokens: 7,
    outputTokens: 2,
    cacheReadInputTokens: 3,
  });
  assert.equal(metadata(openp).lastSubturnContextTokens, 10);
  assert.deepEqual(metadata(openp).modelUsage, {
    'codex-test': {
      contextWindow: 258400,
      inputTokens: 100,
      outputTokens: 30,
      cacheReadInputTokens: 200,
    },
  });
});

test('does not derive last subturn context token usage from aggregate-only usage', () => {
  const openp = parseJsonOpenP(formatTurnResult({
    ...RESULT,
    structuredOutput: undefined,
    diagnostics: {
      ...RESULT.diagnostics,
      usage: {
        inputTokens: 100,
        cacheReadInputTokens: 200,
        outputTokens: 30,
      },
    },
  }, {
    outputFormat: 'json',
    backendSessionId: '11111111-1111-4111-8111-111111111111',
    backend: 'codex',
    model: 'codex-test',
    contextWindow: 258400,
  }));

  assert.deepEqual(metadata(openp).usage, {
    inputTokens: 100,
    outputTokens: 30,
    cacheReadInputTokens: 200,
  });
  assert.equal(Object.prototype.hasOwnProperty.call(metadata(openp), 'lastSubturnUsage'), false);
  assert.equal(metadata(openp).lastSubturnContextTokens, null);
});

test('formats json warnings under openp metadata only', () => {
  const openp = parseJsonOpenP(formatTurnResult(RESULT, {
    outputFormat: 'json',
    backendSessionId: '11111111-1111-4111-8111-111111111111',
    warnings: [{
      severity: 'warning',
      code: 'streaming_result_diagnostic',
      message: 'Streaming result diagnostics were detected (1); result was preserved. Use --debug-log to record details.',
    }],
  }));

  assert.deepEqual(metadata(openp).warnings, [{
    severity: 'warning',
    code: 'streaming_result_diagnostic',
    message: 'Streaming result diagnostics were detected (1); result was preserved. Use --debug-log to record details.',
  }]);
});

test('formats structured output as result toolCall and toolResult without answer prose', () => {
  const openp = parseJsonOpenP(formatTurnResult(RESULT, {
    outputFormat: 'json',
    backendSessionId: '11111111-1111-4111-8111-111111111111',
    backend: 'codex',
  }));
  const output = resultOutput(openp);
  const toolCall = output.toolCall[0]!;

  assert.deepEqual(output.answer, []);
  assert.deepEqual(output.reasoning, []);
  assert.equal(toolCall.type, 'tool_use');
  assert.equal(typeof toolCall.id, 'string');
  assert.equal(toolCall.name, 'StructuredOutput');
  assert.deepEqual(toolCall.input, { ok: true });
  assert.deepEqual(toolCall.caller, { type: 'direct' });
  assert.deepEqual(output.toolResult, [{
    type: 'tool_result',
    toolUseId: toolCall.id,
    content: 'Structured output provided successfully',
  }]);
  assert.deepEqual(openp.structuredOutput, { ok: true });
});

test('formats stream-json output as one terminal result record', () => {
  const events = parseOpenPRecords(formatTurnResult(RESULT, {
    outputFormat: 'stream-json',
    backendSessionId: '11111111-1111-4111-8111-111111111111',
  }));

  assert.equal(events.length, 1);
  assert.equal(events[0]?.form, 'result');
  assert.deepEqual((events[0]?.output as Record<string, unknown>).answer, []);
  assert.ok(resultOutput(events[0]!).toolCall.length > 0);
  assert.equal(metadata(events[0]!).stopReason, null);
  assert.equal(metadata(events[0]!).numTurns, null);
});

test('formats intermediate answer as one streaming snapshot, not a delta field', () => {
  const openp = parseSingleOpenPRecord(formatIntermediateTextEvent({
    turnId: 'turn-1',
    text: 'working so far',
  }));

  assert.equal(openp.form, 'streaming');
  assert.equal(openp.scope, 'active');
  assert.deepEqual(openp.output, { answer: 'working so far' });
});

test('formats intermediate reasoning as one streaming reasoning snapshot', () => {
  const openp = parseSingleOpenPRecord(formatIntermediateReasoningEvent({
    turnId: 'turn-1',
    sessionId: '11111111-1111-4111-8111-111111111111',
    text: 'explicit thinking',
    model: 'claude-test',
  }));

  assert.equal(openp.form, 'streaming');
  assert.equal(openp.sessionId, '11111111-1111-4111-8111-111111111111');
  assert.deepEqual(openp.output, { reasoning: 'explicit thinking' });
  assert.equal(metadata(openp).model, 'claude-test');
});

test('formats cumulative answer snapshots as cumulative values', () => {
  const state = createStreamingMessageState();
  const output = [
    formatStreamingAnswerSnapshotEvents(state, {
      sessionId: '11111111-1111-4111-8111-111111111111',
      model: 'claude-test',
      text: 'hello',
    }),
    formatStreamingAnswerSnapshotEvents(state, {
      sessionId: '11111111-1111-4111-8111-111111111111',
      model: 'claude-test',
      text: 'hello world',
    }),
  ].join('');
  resetStreamingMessageState(state);

  assert.deepEqual(parseOpenPRecords(output).map(streamingOutput), [
    { answer: 'hello' },
    { answer: 'hello world' },
  ]);
});

test('does not duplicate streaming answer when the snapshot repeats', () => {
  const state = createStreamingMessageState();
  const output = [
    formatStreamingAnswerSnapshotEvents(state, {
      sessionId: '11111111-1111-4111-8111-111111111111',
      model: 'claude-test',
      text: 'result text',
    }),
    formatStreamingAnswerSnapshotEvents(state, {
      sessionId: '11111111-1111-4111-8111-111111111111',
      model: 'claude-test',
      text: 'result text',
    }),
  ].join('');
  resetStreamingMessageState(state);

  assert.deepEqual(parseOpenPRecords(output).map(streamingOutput), [
    { answer: 'result text' },
  ]);
});

test('rejects non-prefix answer and reasoning streaming replacements', () => {
  const answerState = createStreamingMessageState();
  formatStreamingAnswerSnapshotEvents(answerState, {
    sessionId: '11111111-1111-4111-8111-111111111111',
    model: 'claude-test',
    text: 'working',
  });
  assert.throws(() => formatStreamingAnswerSnapshotEvents(answerState, {
    sessionId: '11111111-1111-4111-8111-111111111111',
    model: 'claude-test',
    text: 'final',
  }), /streaming answer replacement is not prefix-compatible/);

  const reasoningState = createStreamingMessageState();
  formatStreamingMessageSnapshotEvents(reasoningState, {
    sessionId: '11111111-1111-4111-8111-111111111111',
    model: 'claude-test',
    text: '',
    reasoningText: 'first draft',
  });
  assert.throws(() => formatStreamingMessageSnapshotEvents(reasoningState, {
    sessionId: '11111111-1111-4111-8111-111111111111',
    model: 'claude-test',
    text: '',
    reasoningText: 'replacement',
  }), /streaming reasoning replacement is not prefix-compatible/);
});

test('formats mixed streaming reasoning and answer as separate oneOf records', () => {
  const state = createStreamingMessageState();
  const events = parseOpenPRecords(formatStreamingMessageSnapshotEvents(state, {
    turnId: 'turn-1',
    sessionId: '11111111-1111-4111-8111-111111111111',
    model: 'claude-test',
    text: 'answer',
    reasoningText: 'thinking',
  }));
  resetStreamingMessageState(state);

  assert.deepEqual(events.map(streamingOutput), [
    { reasoning: 'thinking' },
    { answer: 'answer' },
  ]);
  assert.equal(events.every((event) => Object.keys(streamingOutput(event)).length === 1), true);
});

test('formats background assistant text as background streaming answer', () => {
  const openp = parseSingleOpenPRecord(formatBackgroundAssistantTextEvent({
    turnId: 'turn-1',
    sessionId: '11111111-1111-4111-8111-111111111111',
    text: 'background done',
  }));

  assert.equal(openp.form, 'streaming');
  assert.equal(openp.scope, 'background');
  assert.equal(openp.sessionId, '11111111-1111-4111-8111-111111111111');
  assert.deepEqual(openp.output, { answer: 'background done' });
});

test('formats worker result with full diagnostics in openp metadata', () => {
  const openp = parseSingleOpenPRecord(formatWorkerTurnResult(WORKER_RESULT, {
    turnId: 'public-turn-1',
    model: 'claude-test',
  }));
  const output = resultOutput(openp);

  assert.equal(openp.form, 'result');
  assert.equal(openp.sessionId, '22222222-2222-4222-8222-222222222222');
  assert.deepEqual(output.reasoning, ['worker reasoning']);
  assert.equal(output.toolCall[0]?.name, 'StructuredOutput');
  assert.deepEqual(metadata(openp).usage, {
    inputTokens: 20,
    outputTokens: 4,
    cacheReadInputTokens: 5,
  });
  assert.deepEqual(metadata(openp).modelUsage, {
    'claude-test': {
      inputTokens: 20,
      outputTokens: 4,
      cacheReadInputTokens: 5,
      contextWindow: 200000,
    },
  });
  assert.equal(metadata(openp).lastSubturnContextTokens, 25);
  assert.equal(metadata(openp).numTurns, 2);
  assert.equal(metadata(openp).durationMs, 456);
  assert.equal(metadata(openp).stopReason, 'end_turn');
});

test('formats worker result unknown diagnostics as null, not fabricated defaults', () => {
  const openp = parseSingleOpenPRecord(formatWorkerTurnResult({
    ...WORKER_RESULT,
    diagnostics: {
      ...WORKER_RESULT.diagnostics,
      numTurns: null,
      stopReason: null,
    },
  }, {
    turnId: 'public-turn-null-diagnostics',
    model: 'claude-test',
  }));

  assert.equal(metadata(openp).numTurns, null);
  assert.equal(metadata(openp).stopReason, null);
});

test('formats worker result metadata with last subturn usage separate from aggregate usage', () => {
  const openp = parseSingleOpenPRecord(formatWorkerTurnResult({
    ...WORKER_RESULT,
    diagnostics: {
      ...WORKER_RESULT.diagnostics,
      inputTokens: 100,
      cacheReadInputTokens: 200,
      outputTokens: 30,
      lastSubturnUsage: {
        inputTokens: 7,
        cacheReadInputTokens: 3,
        outputTokens: 2,
      },
      lastSubturnContextTokens: null,
    },
  }, {
    turnId: 'public-turn-1',
    model: 'claude-test',
  }));

  assert.deepEqual(metadata(openp).usage, {
    inputTokens: 100,
    outputTokens: 30,
    cacheReadInputTokens: 200,
  });
  assert.deepEqual(metadata(openp).lastSubturnUsage, {
    inputTokens: 7,
    outputTokens: 2,
    cacheReadInputTokens: 3,
  });
  assert.equal(metadata(openp).lastSubturnContextTokens, 10);
  assert.deepEqual(metadata(openp).modelUsage, {
    'claude-test': {
      inputTokens: 100,
      outputTokens: 30,
      cacheReadInputTokens: 200,
      contextWindow: 200000,
    },
  });
});

test('structured-output fallback snapshots do not expose raw JSON as answer prose', () => {
  const openp = parseSingleOpenPRecord(formatWorkerTurnResult({
    ...WORKER_RESULT,
    content: '{"ok":true}',
    reasoningContent: 'schema reasoning',
    structuredOutput: { ok: true },
    assistantEvents: [{
      message: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: '{"ok":true}' }],
        stop_reason: 'end_turn',
      },
    }],
  }, {
    turnId: 'public-turn-1',
  }));
  const output = resultOutput(openp);

  assert.deepEqual(output.answer, []);
  assert.deepEqual(output.reasoning, ['schema reasoning']);
  assert.equal(output.toolCall[0]?.name, 'StructuredOutput');
  assert.deepEqual(openp.structuredOutput, { ok: true });
});

test('tool-bearing snapshots preserve answer and tool metadata in result arrays', () => {
  const result: TurnResult = {
    ...RESULT,
    text: 'done',
    structuredOutput: undefined,
    assistantEvents: [
      {
        message: {
          type: 'message',
          role: 'assistant',
          id: 'msg-tool',
          stop_reason: 'tool_use',
          content: [
            { type: 'text', text: 'checking file' },
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'Read',
              input: { file_path: 'README.md' },
            },
          ],
        },
      },
      {
        message: {
          type: 'message',
          role: 'assistant',
          id: 'msg-final',
          stop_reason: 'end_turn',
          content: [
            { type: 'text', text: 'done' },
          ],
        },
      },
    ],
  };
  assert.equal(formatTurnResult(result, {
    outputFormat: 'text',
    backendSessionId: '11111111-1111-4111-8111-111111111111',
    backend: 'claude',
  }), 'checking file\n\ndone\n');

  const openp = parseSingleOpenPRecord(formatTurnResult(result, {
    outputFormat: 'stream-json',
    backendSessionId: '11111111-1111-4111-8111-111111111111',
    backend: 'claude',
  }));
  const output = resultOutput(openp);

  assert.deepEqual(output.answer, ['checking file', 'done']);
  assert.deepEqual(output.toolCall, [{
    type: 'tool_use',
    id: 'toolu_1',
    name: 'Read',
    input: { file_path: 'README.md' },
  }]);
});

test('result aggregate preserves repeated equal assistant answers from different messages', () => {
  const firstSnapshot: AssistantEventSnapshot = {
    message: {
      id: 'msg-repeat-1',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'same answer' }],
      stop_reason: null,
    },
  };
  const secondSnapshot: AssistantEventSnapshot = {
    message: {
      id: 'msg-repeat-2',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'same answer' }],
      stop_reason: null,
    },
  };
  const openp = parseSingleOpenPRecord(formatWorkerTurnResult({
    ...WORKER_RESULT,
    content: 'same answer\n\nsame answer',
    reasoningContent: null,
    structuredOutput: undefined,
    assistantEvents: [firstSnapshot, secondSnapshot],
  }, {
    turnId: 'public-turn-1',
  }));

  assert.deepEqual(resultOutput(openp).answer, ['same answer', 'same answer']);
});

test('streamed non-semantic result snapshot does not duplicate terminal result answer fallback', () => {
  const snapshot: AssistantEventSnapshot = {
    message: {
      id: 'msg-final',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'same answer' }],
      stop_reason: 'end_turn',
    },
  };
  const openp = parseSingleOpenPRecord(formatTurnResult({
    ...RESULT,
    text: 'same answer',
    structuredOutput: undefined,
    reasoningContent: null,
    assistantEvents: [snapshot],
  }, {
    outputFormat: 'stream-json',
    backendSessionId: '11111111-1111-4111-8111-111111111111',
    suppressAssistantSnapshots: [snapshot],
  }));

  assert.deepEqual(resultOutput(openp).answer, ['same answer']);
});

test('streamed reasoning snapshots do not duplicate terminal aggregate reasoning fallback', () => {
  const firstReasoningSnapshot: AssistantEventSnapshot = {
    message: {
      id: 'msg-reasoning-1',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'thinking', thinking: 'think A' }],
      stop_reason: 'tool_use',
    },
  };
  const secondReasoningSnapshot: AssistantEventSnapshot = {
    message: {
      id: 'msg-reasoning-2',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'thinking', thinking: 'think B' }],
      stop_reason: 'tool_use',
    },
  };
  const openp = parseSingleOpenPRecord(formatTurnResult({
    ...RESULT,
    text: 'done',
    structuredOutput: undefined,
    reasoningContent: 'think A\n\nthink B',
    assistantEvents: [firstReasoningSnapshot, secondReasoningSnapshot],
  }, {
    outputFormat: 'stream-json',
    backendSessionId: '11111111-1111-4111-8111-111111111111',
    suppressAssistantSnapshots: [firstReasoningSnapshot, secondReasoningSnapshot],
  }));

  assert.deepEqual(resultOutput(openp).reasoning, ['think A', 'think B']);
});

test('streamed reasoning snapshots suppress whitespace-only terminal reasoning duplicates', () => {
  const reasoningSnapshot: AssistantEventSnapshot = {
    message: {
      id: 'msg-reasoning-1',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'thinking', thinking: 'think block' }],
      stop_reason: 'tool_use',
    },
  };
  const openp = parseSingleOpenPRecord(formatTurnResult({
    ...RESULT,
    text: 'done',
    structuredOutput: undefined,
    reasoningContent: '  think block\n',
    assistantEvents: [reasoningSnapshot],
  }, {
    outputFormat: 'stream-json',
    backendSessionId: '11111111-1111-4111-8111-111111111111',
    suppressAssistantSnapshots: [reasoningSnapshot],
  }));

  assert.deepEqual(resultOutput(openp).reasoning, ['think block']);
});

test('terminal reasoning fallback preserves whitespace-only reasoning when it was not emitted', () => {
  const openp = parseSingleOpenPRecord(formatTurnResult({
    ...RESULT,
    text: 'done',
    structuredOutput: undefined,
    reasoningContent: '  \n',
    assistantEvents: [],
  }, {
    outputFormat: 'stream-json',
    backendSessionId: '11111111-1111-4111-8111-111111111111',
  }));

  assert.deepEqual(resultOutput(openp).reasoning, ['  \n']);
});

test('suppressed tool snapshots preserve all tool calls in the result aggregate', () => {
  const streamedSnapshot: AssistantEventSnapshot = {
    message: {
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'toolu_read', name: 'Read', input: { file_path: 'a.txt' } },
        { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'openp' } },
        { type: 'tool_result', tool_use_id: 'toolu_read', content: 'file contents', is_error: false },
      ],
      stop_reason: null,
    },
  };
  const openp = parseSingleOpenPRecord(formatWorkerTurnResult({
    ...WORKER_RESULT,
    content: 'worker final',
    reasoningContent: null,
    structuredOutput: undefined,
    assistantEvents: [streamedSnapshot],
  }, {
    turnId: 'public-turn-1',
    suppressAssistantSnapshots: [streamedSnapshot],
  }));

  assert.deepEqual(resultOutput(openp).answer, ['worker final']);
  assert.deepEqual(resultOutput(openp).toolCall, [
    {
      type: 'tool_use',
      id: 'toolu_read',
      name: 'Read',
      input: { file_path: 'a.txt' },
    },
    {
      type: 'server_tool_use',
      id: 'srv_1',
      name: 'web_search',
      input: { query: 'openp' },
    },
  ]);
  assert.deepEqual(resultOutput(openp).toolResult, [{
    type: 'tool_result',
    toolUseId: 'toolu_read',
    content: 'file contents',
    isError: false,
  }]);
});

test('previously emitted streaming tool snapshots preserve all tool calls in the result aggregate', () => {
  const streamedSnapshot: AssistantEventSnapshot = {
    message: {
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'toolu_read', name: 'Read', input: { file_path: 'a.txt' } },
        { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'openp' } },
        { type: 'tool_result', tool_use_id: 'toolu_read', content: 'file contents', is_error: false },
      ],
      stop_reason: null,
    },
  };
  const previouslyEmittedAssistantEvents = buildIntermediateAssistantSnapshotEvents({
    snapshot: streamedSnapshot,
    sessionId: 'worker-session-1',
    turnId: 'public-turn-1',
  });
  const openp = parseSingleOpenPRecord(formatWorkerTurnResult({
    ...WORKER_RESULT,
    content: 'worker final',
    reasoningContent: null,
    structuredOutput: undefined,
    assistantEvents: [streamedSnapshot],
  }, {
    turnId: 'public-turn-1',
    suppressAssistantSnapshots: [streamedSnapshot],
    previouslyEmittedAssistantEvents,
  }));

  assert.deepEqual(resultOutput(openp).toolCall.map((toolCall) => toolCall.id), [
    'toolu_read',
    'srv_1',
  ]);
  assert.deepEqual(resultOutput(openp).toolResult, [{
    type: 'tool_result',
    toolUseId: 'toolu_read',
    content: 'file contents',
    isError: false,
  }]);
});

test('metadata-only assistant snapshots preserve neutral messageBlocks without synthesizing answer', () => {
  const openp = parseSingleOpenPRecord(formatTurnResult({
    ...RESULT,
    text: '',
    reasoningContent: null,
    structuredOutput: undefined,
    assistantEvents: [{
      message: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'backend_status', state: 'running' }],
      },
    }],
  }, {
    outputFormat: 'stream-json',
    backendSessionId: '11111111-1111-4111-8111-111111111111',
    backend: 'codex',
  }));

  assert.deepEqual(resultOutput(openp), {
    answer: [],
    reasoning: [],
    toolCall: [],
    toolResult: [],
  });
  assert.deepEqual(metadata(openp).messageBlocks, [{ type: 'backend_status', state: 'running' }]);
});

test('metadata messageBlocks reject public output aliases and backend content payload aliases', () => {
  const openp = parseSingleOpenPRecord(formatTurnResult({
    ...RESULT,
    text: 'hello',
    structuredOutput: undefined,
    assistantEvents: [{
      message: {
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'backend_status', answerText: 'hello' },
          { type: 'assistant.message', detail: { state: 'legacy alias' } },
          { type: 'backend_status', answer: 'hello' },
          { type: 'backend_status', detail: { type: 'assistant.event', state: 'legacy alias' } },
          { type: 'backend_status', detail: { type: 'answer', state: 'canonical output alias' } },
          { type: 'backend_status', detail: { answerText: 'hello' } },
          { type: 'backend_status', detail: { type: 'tool_use', id: 'toolu_nested', name: 'Read' } },
          { type: 'backend_status', nested: [{ type: 'output_text', value: 'hello' }] },
          { type: 'backend_status', toolCall: { name: 'Read' } },
        ],
      },
    }],
  }, {
    outputFormat: 'stream-json',
    backendSessionId: '11111111-1111-4111-8111-111111111111',
    backend: 'codex',
  }));

  assert.equal(Object.prototype.hasOwnProperty.call(metadata(openp), 'messageBlocks'), false);
});

test('metadata messageBlocks keep neutral blocks when forbidden alias blocks are mixed in', () => {
  const openp = parseSingleOpenPRecord(formatTurnResult({
    ...RESULT,
    text: 'hello',
    structuredOutput: undefined,
    assistantEvents: [{
      message: {
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'backend_status', state: 'running' },
          { type: 'backend_status', answerText: 'hello' },
          { type: 'backend_hint', detail: { state: 'ok' } },
          { type: 'assistant.event', detail: { state: 'legacy alias' } },
        ],
      },
    }],
  }, {
    outputFormat: 'stream-json',
    backendSessionId: '11111111-1111-4111-8111-111111111111',
    backend: 'codex',
  }));

  assert.deepEqual(metadata(openp).messageBlocks, [
    { type: 'backend_status', state: 'running' },
    { type: 'backend_hint', detail: { state: 'ok' } },
  ]);
});

test('result metadata keeps raw backend usage without top-level legacy fields', () => {
  const openp = parseSingleOpenPRecord(formatWorkerTurnResult({
    ...WORKER_RESULT,
    content: 'worker final',
    reasoningContent: null,
    structuredOutput: undefined,
    diagnostics: {
      ...WORKER_RESULT.diagnostics,
      rawUsage: {
        input_tokens: 20,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 5,
        output_tokens: 4,
        service_tier: 'standard',
      },
    },
  }, {
    turnId: 'public-turn-1',
    model: 'claude-test',
  }));

  assert.deepEqual(metadata(openp).rawUsage, {
    input_tokens: 20,
    cache_creation_input_tokens: 100,
    cache_read_input_tokens: 5,
    output_tokens: 4,
    service_tier: 'standard',
  });
});

function parseJsonOpenP(output: string): Record<string, any> {
  assert.match(output, /\n$/);
  const event = JSON.parse(output) as Record<string, any>;
  assert.deepEqual(Object.keys(event), ['openp']);
  assertOpenPRecord(event.openp);
  return event.openp;
}

function parseSingleOpenPRecord(output: string): Record<string, any> {
  const records = parseOpenPRecords(output);
  assert.equal(records.length, 1);
  return records[0]!;
}

function parseOpenPRecords(output: string): Array<Record<string, any>> {
  assert.match(output, /\n$/);
  return output.trim().split('\n').filter(Boolean).map((line) => {
    const event = JSON.parse(line) as Record<string, any>;
    assert.deepEqual(Object.keys(event), ['openp']);
    assertOpenPRecord(event.openp);
    return event.openp;
  });
}

function assertOpenPRecord(openp: Record<string, any>): void {
  assert.ok(openp && typeof openp === 'object' && !Array.isArray(openp));
  assert.ok(openp.form === 'streaming' || openp.form === 'result');
  assert.ok(openp.scope === 'active' || openp.scope === 'background');
  assert.ok(openp.output && typeof openp.output === 'object' && !Array.isArray(openp.output));
  for (const field of forbiddenPublicPayloadFields()) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(openp, field),
      false,
      `openp must not expose ${field}`,
    );
  }
  if (openp.form === 'streaming') {
    const keys = Object.keys(openp.output);
    assert.equal(keys.length, 1);
    assert.ok(['answer', 'reasoning', 'toolCall', 'toolResult'].includes(keys[0]!));
  } else {
    assert.deepEqual(Object.keys(openp.output).sort(), ['answer', 'reasoning', 'toolCall', 'toolResult'].sort());
    assert.ok(Array.isArray(openp.output.answer));
    assert.ok(Array.isArray(openp.output.reasoning));
    assert.ok(Array.isArray(openp.output.toolCall));
    assert.ok(Array.isArray(openp.output.toolResult));
  }
  const itemMetadata = openp.metadata && typeof openp.metadata === 'object' && !Array.isArray(openp.metadata)
    ? openp.metadata as Record<string, unknown>
    : {};
  if (Array.isArray(itemMetadata.messageBlocks)) {
    for (const block of itemMetadata.messageBlocks) {
      assertNeutralOpenPMetadataBlock(block);
    }
  }
}

function forbiddenPublicPayloadFields(): string[] {
  return [
    'type',
    'kind',
    'text',
    'textDelta',
    'answerText',
    'answers',
    'reasoningText',
    'reasoning',
    'toolCalls',
    'toolResults',
    'assistant.message',
    'assistant.event',
  ];
}

function streamingOutput(openp: Record<string, any>): Record<string, unknown> {
  assert.equal(openp.form, 'streaming');
  return openp.output as Record<string, unknown>;
}

function resultOutput(openp: Record<string, any>): {
  answer: string[];
  reasoning: string[];
  toolCall: Array<Record<string, any>>;
  toolResult: Array<Record<string, any>>;
} {
  assert.equal(openp.form, 'result');
  const output = openp.output as Record<string, unknown>;
  return {
    answer: output.answer as string[],
    reasoning: output.reasoning as string[],
    toolCall: output.toolCall as Array<Record<string, any>>,
    toolResult: output.toolResult as Array<Record<string, any>>,
  };
}

function metadata(openp: Record<string, any>): Record<string, any> {
  assert.ok(openp.metadata && typeof openp.metadata === 'object' && !Array.isArray(openp.metadata));
  return openp.metadata as Record<string, any>;
}

function assertNeutralOpenPMetadataBlock(block: unknown): void {
  assert.ok(block && typeof block === 'object' && !Array.isArray(block));
  const item = block as Record<string, unknown>;
  assert.equal(typeof item.type, 'string');
  assert.equal([
    'answer',
    'toolCall',
    'toolResult',
    'output',
    'kind',
    'text',
    'textDelta',
    'answerText',
    'answers',
    'reasoningText',
    'thinking',
    'reasoning',
    'toolCalls',
    'toolResults',
    'assistantEvents',
    'assistant.message',
    'assistant.event',
    'tool_use',
    'server_tool_use',
    'tool_result',
    'output_text',
    'message.partial',
    'message.final',
  ].includes(String(item.type)), false);
  assert.equal(hasOpenPMetadataForbiddenField(item), false);
}

function isForbiddenOpenPMetadataTypeValue(value: string): boolean {
  return new Set([
    'answer',
    'toolCall',
    'toolResult',
    'output',
    'kind',
    'text',
    'textDelta',
    'answerText',
    'answers',
    'reasoningText',
    'thinking',
    'reasoning',
    'toolCalls',
    'toolResults',
    'assistantEvents',
    'assistant.message',
    'assistant.event',
    'tool_use',
    'server_tool_use',
    'tool_result',
    'output_text',
    'message.partial',
    'message.final',
  ]).has(value);
}

function hasOpenPMetadataForbiddenField(value: unknown): boolean {
  const forbiddenFields = new Set([
    'answer',
    'toolCall',
    'toolResult',
    'output',
    'kind',
    'text',
    'textDelta',
    'answerText',
    'answers',
    'reasoningText',
    'thinking',
    'reasoning',
    'toolCalls',
    'toolResults',
    'assistantEvents',
    'assistant.message',
    'assistant.event',
    'input',
    'content',
    'tool_use_id',
    'is_error',
  ]);
  const visit = (item: unknown): boolean => {
    if (Array.isArray(item)) {
      return item.some((nested) => visit(nested));
    }
    if (!item || typeof item !== 'object') {
      return false;
    }
    for (const [key, nested] of Object.entries(item as Record<string, unknown>)) {
      if (forbiddenFields.has(key)) {
        return true;
      }
      if (
        key === 'type' &&
        typeof nested === 'string' &&
        isForbiddenOpenPMetadataTypeValue(nested)
      ) {
        return true;
      }
      if (visit(nested)) {
        return true;
      }
    }
    return false;
  };
  return visit(value);
}

function answerSnapshot(id: string, text: string, semanticKind?: 'commentary'): AssistantEventSnapshot {
  return {
    message: { id, role: 'assistant', content: [{ type: 'text', text }] },
    requestId: null,
    ...(semanticKind ? { semanticKind } : {}),
  };
}

const PREFIX_DIAGNOSTICS: TurnResult['diagnostics'] = {
  durationMs: null,
  toolsUsed: [],
  usage: { inputTokens: null, cacheReadInputTokens: null, outputTokens: null },
  rawEventCount: 1,
};

function prefixResult(text: string, assistantEvents: readonly AssistantEventSnapshot[]): TurnResult {
  return {
    turnId: 'turn-prefix',
    text,
    requestId: null,
    sessionId: '33333333-3333-4333-8333-333333333333',
    assistantEvents,
    diagnostics: PREFIX_DIAGNOSTICS,
  };
}

function resultAnswerArray(output: string): string[] {
  for (const line of output.trim().split('\n')) {
    const record = JSON.parse(line) as { openp?: { form?: string; output?: { answer?: string[] } } };
    if (record.openp?.form === 'result') {
      return record.openp.output?.answer ?? [];
    }
  }
  throw new Error('no result record found');
}

test('text output keeps the result answer remainder missing from snapshots', () => {
  const output = formatTurnResult(prefixResult('A\n\nB', [answerSnapshot('msg-1', 'A')]), {
    outputFormat: 'text',
    backendSessionId: '33333333-3333-4333-8333-333333333333',
  });
  assert.equal(output, 'A\n\nB\n');
});

test('text output keeps the confirmed answer when snapshots are commentary only', () => {
  const output = formatTurnResult(prefixResult('A', [answerSnapshot('msg-1', 'progress note', 'commentary')]), {
    outputFormat: 'text',
    backendSessionId: '33333333-3333-4333-8333-333333333333',
  });
  assert.equal(output, 'progress note\n\nA\n');
});

test('json result fallback appends only the missing answer remainder after prefix snapshots', () => {
  const output = formatTurnResult(prefixResult('A\n\nB', [answerSnapshot('msg-1', 'A')]), {
    outputFormat: 'json',
    backendSessionId: '33333333-3333-4333-8333-333333333333',
  });
  assert.deepEqual(resultAnswerArray(output), ['A', 'B']);
});

test('json result fallback keeps the full answer text when snapshots are unrelated', () => {
  const output = formatTurnResult(prefixResult('Z', [answerSnapshot('msg-1', 'A')]), {
    outputFormat: 'json',
    backendSessionId: '33333333-3333-4333-8333-333333333333',
  });
  assert.deepEqual(resultAnswerArray(output), ['A', 'Z']);
});

test('json result emits no fallback when snapshots already cover the answer text', () => {
  const output = formatTurnResult(prefixResult('A\n\nB', [answerSnapshot('msg-1', 'A'), answerSnapshot('msg-2', 'B')]), {
    outputFormat: 'json',
    backendSessionId: '33333333-3333-4333-8333-333333333333',
  });
  assert.deepEqual(resultAnswerArray(output), ['A', 'B']);
});

test('stream-json result fallback appends only the missing answer remainder after suppressed prefix snapshot', () => {
  const snapshot = answerSnapshot('msg-1', 'A');
  const output = formatTurnResult(prefixResult('A\n\nB', [snapshot]), {
    outputFormat: 'stream-json',
    backendSessionId: '33333333-3333-4333-8333-333333333333',
    suppressAssistantSnapshots: [snapshot],
  });
  assert.deepEqual(resultAnswerArray(output), ['A', 'B']);
});

test('worker result fallback appends only the missing answer remainder after prefix snapshots', () => {
  const workerResult: WorkerTurnResult = {
    content: 'A\n\nB',
    reasoningContent: null,
    requestId: null,
    sessionId: '33333333-3333-4333-8333-333333333333',
    assistantEvents: [answerSnapshot('msg-1', 'A')],
    diagnostics: {
      numTurns: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadInputTokens: null,
      contextWindow: null,
      lastSubturnContextTokens: null,
      durationMs: null,
      totalCostUsd: null,
      stopReason: null,
      toolsUsed: [],
      autoCompacted: false,
      intermediateTextCount: null,
    },
  };
  const output = formatWorkerTurnResult(workerResult, { turnId: 'turn-prefix' });
  assert.deepEqual(resultAnswerArray(output), ['A', 'B']);
});

test('worker result fallback appends only the missing answer remainder after suppressed prefix snapshot', () => {
  const snapshot = answerSnapshot('msg-1', 'A');
  const workerResult: WorkerTurnResult = {
    content: 'A\n\nB',
    reasoningContent: null,
    requestId: null,
    sessionId: '33333333-3333-4333-8333-333333333333',
    assistantEvents: [snapshot],
    diagnostics: {
      numTurns: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadInputTokens: null,
      contextWindow: null,
      lastSubturnContextTokens: null,
      durationMs: null,
      totalCostUsd: null,
      stopReason: null,
      toolsUsed: [],
      autoCompacted: false,
      intermediateTextCount: null,
    },
  };
  const output = formatWorkerTurnResult(workerResult, {
    turnId: 'turn-prefix',
    suppressAssistantSnapshots: [snapshot],
  });
  assert.deepEqual(resultAnswerArray(output), ['A', 'B']);
});

test('worker result fallback appends only the missing answer remainder after multiple suppressed prefix snapshots', () => {
  const firstSnapshot = answerSnapshot('msg-1', 'A');
  const secondSnapshot = answerSnapshot('msg-2', 'B');
  const workerResult: WorkerTurnResult = {
    content: 'A\n\nB\n\nC',
    reasoningContent: null,
    requestId: null,
    sessionId: '33333333-3333-4333-8333-333333333333',
    assistantEvents: [firstSnapshot, secondSnapshot],
    diagnostics: {
      numTurns: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadInputTokens: null,
      contextWindow: null,
      lastSubturnContextTokens: null,
      durationMs: null,
      totalCostUsd: null,
      stopReason: null,
      toolsUsed: [],
      autoCompacted: false,
      intermediateTextCount: null,
    },
  };
  const output = formatWorkerTurnResult(workerResult, {
    turnId: 'turn-prefix',
    suppressAssistantSnapshots: [firstSnapshot, secondSnapshot],
  });
  assert.deepEqual(resultAnswerArray(output), ['A', 'B', 'C']);
});
