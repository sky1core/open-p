import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createPartialMessageStreamState,
  extractAssistantSnapshotReasoningText,
  formatBackgroundAssistantTextEvent,
  formatIntermediateReasoningEvent,
  formatIntermediateTextEvent,
  formatPartialDeltaEvents,
  formatPartialMessageStopEvents,
  formatPartialTextDeltaEvents,
  formatPartialMessageLifecycleEvents,
  formatSystemInitEvent,
  formatSystemStatusEvent,
  formatTurnResult,
  formatWorkerTurnResult,
  resolveStructuredOutputToolUseId,
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

test('formats text output as final text only', () => {
  assert.equal(formatTurnResult(RESULT, {
    outputFormat: 'text',
    backendSessionId: '11111111-1111-4111-8111-111111111111',
  }), 'hello\n');
});

test('formats json output as one newline-terminated object', () => {
  const output = formatTurnResult(RESULT, {
    outputFormat: 'json',
    backendSessionId: '11111111-1111-4111-8111-111111111111',
  });

  assert.match(output, /\n$/);
  const parsed = stripVolatileIds(JSON.parse(output));
  assert.deepEqual(parsed, {
    type: 'result',
    subtype: 'success',
    session_id: '11111111-1111-4111-8111-111111111111',
    is_error: false,
    api_error_status: null,
    duration_api_ms: null,
    ttft_ms: null,
    result: '',
    num_turns: 1,
    duration_ms: 123,
    total_cost_usd: null,
    stop_reason: 'end_turn',
    usage: {
      input_tokens: 10,
      output_tokens: 3,
      cache_read_input_tokens: null,
    },
    permission_denials: [],
    structured_output: { ok: true },
    terminal_reason: 'completed',
    fast_mode_state: 'off',
  });
  assertNoOpenPOnlyStreamFields(parsed);
});

test('formats direct CLI result with parsed stop reason', () => {
  const result: TurnResult = {
    ...RESULT,
    structuredOutput: undefined,
    diagnostics: {
      ...RESULT.diagnostics,
      stopReason: 'max_tokens',
    },
  };

  const jsonOutput = formatTurnResult(result, {
    outputFormat: 'json',
    backendSessionId: '11111111-1111-4111-8111-111111111111',
  });
  const streamOutput = formatTurnResult(result, {
    outputFormat: 'stream-json',
    backendSessionId: '11111111-1111-4111-8111-111111111111',
  });

  assert.equal(JSON.parse(jsonOutput).stop_reason, 'max_tokens');
  const terminalResult = parseJsonLinesWithoutVolatileIds(streamOutput)
    .filter((event) => event.type === 'result')
    .at(-1);
  assert.equal(terminalResult?.stop_reason, 'max_tokens');
});

test('formats stream-json output as claude-style assistant and result events', () => {
  const output = formatTurnResult(RESULT, {
    outputFormat: 'stream-json',
    backendSessionId: '11111111-1111-4111-8111-111111111111',
  });

  assert.match(output, /\n$/);
  const parsed = parseJsonLinesWithoutVolatileIds(output);
  assert.deepEqual(parsed, [
    {
      type: 'system',
      subtype: 'init',
      session_id: '11111111-1111-4111-8111-111111111111',
      output_style: 'default',
      fast_mode_state: 'off',
    },
    {
      type: 'assistant',
      session_id: '11111111-1111-4111-8111-111111111111',
      parent_tool_use_id: null,
      request_id: 'req_1',
      message: {
        type: 'message',
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            name: 'StructuredOutput',
            input: { ok: true },
            caller: { type: 'direct' },
          },
        ],
        stop_reason: null,
        stop_sequence: null,
        stop_details: null,
        usage: {
          input_tokens: 10,
          output_tokens: 3,
          cache_read_input_tokens: null,
        },
        diagnostics: null,
        context_management: null,
      },
    },
    {
      type: 'user',
      session_id: '11111111-1111-4111-8111-111111111111',
      parent_tool_use_id: null,
      tool_use_result: 'Structured output provided successfully',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            content: 'Structured output provided successfully',
          },
        ],
      },
    },
    {
      type: 'result',
      subtype: 'success',
      session_id: '11111111-1111-4111-8111-111111111111',
      is_error: false,
      api_error_status: null,
      duration_api_ms: null,
      ttft_ms: null,
      result: '',
      num_turns: 1,
      duration_ms: 123,
      total_cost_usd: null,
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 10,
        output_tokens: 3,
        cache_read_input_tokens: null,
      },
      permission_denials: [],
      structured_output: { ok: true },
      terminal_reason: 'completed',
      fast_mode_state: 'off',
    },
  ]);
  for (const event of parsed) assertNoOpenPOnlyStreamFields(event);
});

test('formats stream-json result event with structured output', () => {
  const reviewResult: TurnResult = {
    ...RESULT,
    text: 'Reviewed the change and produced structured output.',
    structuredOutput: {
      status: 'pass',
      summary: 'ok',
      findings: [],
    },
  };
  const output = formatTurnResult(reviewResult, {
    outputFormat: 'stream-json',
    backendSessionId: '11111111-1111-4111-8111-111111111111',
  });

  const parsed = parseJsonLinesWithoutVolatileIds(output);
  const terminalResult = parsed.filter((event) => event.type === 'result').at(-1);
  assert.equal(parsed[0]?.type, 'system');
  assert.equal(parsed[0]?.subtype, 'init');
  assert.equal(parsed[0]?.session_id, '11111111-1111-4111-8111-111111111111');
  assert.equal(terminalResult?.result, '');
  assert.deepEqual(terminalResult?.structured_output, {
    status: 'pass',
    summary: 'ok',
    findings: [],
  });
});

test('formats structured fallback snapshots as StructuredOutput tool_use instead of JSON text', () => {
  const output = formatTurnResult({
    ...RESULT,
    text: '{"ok":true}',
    structuredOutput: { ok: true },
    assistantEvents: [
      {
        message: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'using structured output' }],
          stop_reason: null,
          stop_sequence: null,
          stop_details: null,
          diagnostics: null,
          context_management: null,
        },
      },
      {
        message: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: '{"ok":true}' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          stop_details: null,
          diagnostics: null,
          context_management: null,
        },
      },
    ],
  }, {
    outputFormat: 'stream-json',
    backendSessionId: '11111111-1111-4111-8111-111111111111',
  });

  const parsed = parseJsonLinesWithoutVolatileIds(output);
  const assistantContents = parsed
    .filter((event) => event.type === 'assistant')
    .map((event) => ((event.message as Record<string, unknown>).content as Array<Record<string, unknown>>).map((block) => block.type));
  const assistantTextBlocks = parsed
    .filter((event) => event.type === 'assistant')
    .flatMap((event) => ((event.message as Record<string, unknown>).content as Array<Record<string, unknown>>))
    .filter((block) => block.type === 'text')
    .map((block) => block.text);

  assert.deepEqual(assistantContents, [['thinking'], ['tool_use']]);
  assert.deepEqual(assistantTextBlocks, []);
  assert.equal(parsed.some((event) => event.type === 'user'), true);
});

test('uses existing StructuredOutput tool_use id for matching tool_result', () => {
  const output = formatTurnResult({
    ...RESULT,
    assistantEvents: [
      {
        message: {
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_backend',
              name: 'StructuredOutput',
              input: { ok: true },
            },
          ],
          stop_reason: 'tool_use',
          stop_sequence: null,
          stop_details: null,
          diagnostics: null,
          context_management: null,
        },
      },
    ],
  }, {
    outputFormat: 'stream-json',
    backendSessionId: '11111111-1111-4111-8111-111111111111',
    structuredOutputToolUseId: 'toolu_partial',
  });

  const events = output.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
  const userEvent = events.find((event) => event.type === 'user');
  const content = ((userEvent?.message as Record<string, unknown>).content as Array<Record<string, unknown>>);

  assert.equal(content[0]?.tool_use_id, 'toolu_backend');
});

test('uses same StructuredOutput tool_use id across partial and final events', () => {
  const result: TurnResult = {
    ...RESULT,
    assistantEvents: [
      {
        message: {
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_backend',
              name: 'StructuredOutput',
              input: { ok: true },
            },
          ],
          stop_reason: 'tool_use',
          stop_sequence: null,
          stop_details: null,
          diagnostics: null,
          context_management: null,
        },
      },
    ],
  };
  const structuredOutputToolUseId = resolveStructuredOutputToolUseId({
    structuredOutput: result.structuredOutput,
    assistantEvents: result.assistantEvents,
    preferredToolUseId: 'toolu_generated',
  });

  const partialState = createPartialMessageStreamState();
  const output = [
    formatPartialMessageLifecycleEvents(partialState, {
      sessionId: '11111111-1111-4111-8111-111111111111',
      structuredOutput: result.structuredOutput,
      structuredOutputToolUseId,
      stopReason: 'tool_use',
    }),
    formatTurnResult(result, {
      outputFormat: 'stream-json',
      backendSessionId: '11111111-1111-4111-8111-111111111111',
      includeSystemInit: false,
      structuredOutputToolUseId,
    }),
  ].join('');

  const events = output.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
  const partialToolUseId = events
    .filter((event) => event.type === 'stream_event')
    .map((event) => event.event as Record<string, unknown>)
    .find((event) => event.type === 'content_block_start')
    ?.content_block as Record<string, unknown> | undefined;
  const assistantToolUseIds = events
    .filter((event) => event.type === 'assistant')
    .flatMap((event) => ((event.message as Record<string, unknown>).content as Array<Record<string, unknown>>))
    .filter((block) => block.type === 'tool_use')
    .map((block) => block.id);
  const userToolResultIds = events
    .filter((event) => event.type === 'user')
    .flatMap((event) => ((event.message as Record<string, unknown>).content as Array<Record<string, unknown>>))
    .filter((block) => block.type === 'tool_result')
    .map((block) => block.tool_use_id);

  assert.equal(partialToolUseId?.id, 'toolu_backend');
  assert.deepEqual(assistantToolUseIds, ['toolu_backend']);
  assert.deepEqual(userToolResultIds, ['toolu_backend']);
});

test('formats stream-json result without duplicate system init when caller already emitted it', () => {
  const output = formatTurnResult(RESULT, {
    outputFormat: 'stream-json',
    backendSessionId: '11111111-1111-4111-8111-111111111111',
    includeSystemInit: false,
  });

  const parsed = parseJsonLinesWithoutVolatileIds(output);
  assert.equal(parsed[0]?.type, 'assistant');
  assert.equal(parsed.some((event) => event.type === 'system' && event.subtype === 'init'), false);
});

test('formats stream-json intermediate assistant events with accumulated text', () => {
  const output = formatIntermediateTextEvent({
    turnId: 'turn-1',
    text: 'working so far',
  });

  assert.match(output, /\n$/);
  assert.deepEqual(stripVolatileIds(JSON.parse(output)), {
    type: 'assistant',
    parent_tool_use_id: null,
    message: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'working so far' }],
      stop_reason: null,
      stop_sequence: null,
      stop_details: null,
      diagnostics: null,
      context_management: null,
    },
  });
});

test('formats stream-json intermediate reasoning events as assistant thinking blocks', () => {
  const output = formatIntermediateReasoningEvent({
    turnId: 'turn-1',
    sessionId: '11111111-1111-4111-8111-111111111111',
    text: 'explicit thinking',
    model: 'claude-test',
  });

  const parsed = parseJsonLinesWithoutVolatileIds(output);
  assert.deepEqual(parsed, [{
    type: 'assistant',
    session_id: '11111111-1111-4111-8111-111111111111',
    parent_tool_use_id: null,
    message: {
      type: 'message',
      role: 'assistant',
      model: 'claude-test',
      content: [{ type: 'thinking', thinking: 'explicit thinking' }],
      stop_reason: null,
      stop_sequence: null,
      stop_details: null,
      diagnostics: null,
      context_management: null,
    },
  }]);
});

test('formats stream-json intermediate reasoning events with public reasoning block shape', () => {
  const output = formatIntermediateReasoningEvent({
    turnId: 'turn-1',
    sessionId: '11111111-1111-4111-8111-111111111111',
    text: 'think block\n\nreason summary',
    contentBlocks: [
      { type: 'thinking', text: 'think block' },
      { type: 'reasoning', summary: [{ text: 'reason summary' }] },
    ],
  });

  const parsed = parseJsonLinesWithoutVolatileIds(output);
  assert.deepEqual(
    (parsed[0]?.message as Record<string, unknown>).content,
    [
      { type: 'thinking', thinking: 'think block' },
      { type: 'reasoning', summary: [{ text: 'reason summary' }] },
    ],
  );
});

test('normalizes Claude Code thinking text snapshots to public thinking field', () => {
  const output = formatTurnResult({
    ...RESULT,
    text: 'final answer',
    reasoningContent: 'think block',
    structuredOutput: undefined,
    assistantEvents: [
      {
        message: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'thinking', text: 'think block' }],
          stop_reason: null,
          stop_sequence: null,
          stop_details: null,
          diagnostics: null,
          context_management: null,
        },
      },
      {
        message: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'final answer' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          stop_details: null,
          diagnostics: null,
          context_management: null,
        },
      },
    ],
  }, {
    outputFormat: 'stream-json',
    backendSessionId: '11111111-1111-4111-8111-111111111111',
  });

  const parsed = parseJsonLinesWithoutVolatileIds(output);
  const firstAssistant = parsed.find((event) => event.type === 'assistant');
  assert.deepEqual(
    (firstAssistant?.message as Record<string, unknown>).content,
    [{ type: 'thinking', thinking: 'think block' }],
  );
});

test('formats stream-json intermediate assistant events with session id when supplied', () => {
  const output = formatIntermediateTextEvent({
    turnId: 'turn-1',
    sessionId: '11111111-1111-4111-8111-111111111111',
    text: 'working so far',
  });

  assert.deepEqual(stripVolatileIds(JSON.parse(output)), {
    type: 'assistant',
    session_id: '11111111-1111-4111-8111-111111111111',
    parent_tool_use_id: null,
    message: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'working so far' }],
      stop_reason: null,
      stop_sequence: null,
      stop_details: null,
      diagnostics: null,
      context_management: null,
    },
  });
});

test('formats worker system init event', () => {
  assert.deepEqual(stripVolatileIds(JSON.parse(formatSystemInitEvent('11111111-1111-4111-8111-111111111111'))), {
    type: 'system',
    subtype: 'init',
    session_id: '11111111-1111-4111-8111-111111111111',
    output_style: 'default',
    fast_mode_state: 'off',
  });
});

test('formats partial message status and stream_event text deltas', () => {
  assert.deepEqual(stripVolatileIds(JSON.parse(formatSystemStatusEvent({
    sessionId: '11111111-1111-4111-8111-111111111111',
    status: 'requesting',
  }))), {
    type: 'system',
    subtype: 'status',
    status: 'requesting',
    session_id: '11111111-1111-4111-8111-111111111111',
  });

  const state = createPartialMessageStreamState();
  const output = [
    formatPartialTextDeltaEvents(state, {
      sessionId: '11111111-1111-4111-8111-111111111111',
      model: 'claude-test',
      text: 'hello',
    }),
    formatPartialTextDeltaEvents(state, {
      sessionId: '11111111-1111-4111-8111-111111111111',
      model: 'claude-test',
      text: 'hello world',
    }),
    formatPartialMessageStopEvents(state, {
      sessionId: '11111111-1111-4111-8111-111111111111',
      stopReason: 'end_turn',
      usage: {
        inputTokens: 1,
        outputTokens: 2,
        cacheReadInputTokens: null,
      },
    }),
  ].join('');
  const parsed = parseJsonLinesWithoutVolatileIds(output);

  assert.deepEqual(parsed, [
    {
      type: 'stream_event',
      session_id: '11111111-1111-4111-8111-111111111111',
      parent_tool_use_id: null,
      ttft_ms: null,
      event: {
        type: 'message_start',
        message: {
          model: 'claude-test',
          type: 'message',
          role: 'assistant',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          stop_details: null,
        },
      },
    },
    {
      type: 'stream_event',
      session_id: '11111111-1111-4111-8111-111111111111',
      parent_tool_use_id: null,
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      },
    },
    {
      type: 'stream_event',
      session_id: '11111111-1111-4111-8111-111111111111',
      parent_tool_use_id: null,
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'hello' },
      },
    },
    {
      type: 'stream_event',
      session_id: '11111111-1111-4111-8111-111111111111',
      parent_tool_use_id: null,
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: ' world' },
      },
    },
    {
      type: 'stream_event',
      session_id: '11111111-1111-4111-8111-111111111111',
      parent_tool_use_id: null,
      event: {
        type: 'content_block_stop',
        index: 0,
      },
    },
    {
      type: 'stream_event',
      session_id: '11111111-1111-4111-8111-111111111111',
      parent_tool_use_id: null,
      event: {
        type: 'message_delta',
        delta: {
          stop_reason: 'end_turn',
          stop_sequence: null,
          stop_details: null,
        },
        usage: {
          input_tokens: 1,
          output_tokens: 2,
          cache_read_input_tokens: null,
        },
      },
    },
    {
      type: 'stream_event',
      session_id: '11111111-1111-4111-8111-111111111111',
      parent_tool_use_id: null,
      event: { type: 'message_stop' },
    },
  ]);
  for (const event of parsed) assertNoOpenPOnlyStreamFields(event);
});

test('does not emit corrupt partial deltas for non-prefix text replacements', () => {
  const state = createPartialMessageStreamState();
  const output = formatPartialTextDeltaEvents(state, {
    sessionId: '11111111-1111-4111-8111-111111111111',
    model: 'claude-test',
    text: 'working',
  });

  assert.throws(() => formatPartialTextDeltaEvents(state, {
      sessionId: '11111111-1111-4111-8111-111111111111',
      model: 'claude-test',
      text: 'final',
    }), /partial text replacement is not prefix-compatible/);

  const parsed = parseJsonLinesWithoutVolatileIds(output);
  const deltas = parsed
    .filter((event) => event.type === 'stream_event' && (event.event as Record<string, unknown>)?.type === 'content_block_delta')
    .map((event) => (((event.event as Record<string, unknown>).delta as Record<string, unknown>).text));

  assert.deepEqual(deltas, ['working']);
});

test('does not duplicate final partial text when live delta already reached final text', () => {
  const state = createPartialMessageStreamState();
  const output = [
    formatPartialTextDeltaEvents(state, {
      sessionId: '11111111-1111-4111-8111-111111111111',
      model: 'claude-test',
      text: 'final text',
    }),
    formatPartialTextDeltaEvents(state, {
      sessionId: '11111111-1111-4111-8111-111111111111',
      model: 'claude-test',
      text: 'final text',
    }),
    formatPartialMessageStopEvents(state, {
      sessionId: '11111111-1111-4111-8111-111111111111',
      stopReason: 'end_turn',
    }),
  ].join('');

  const parsed = parseJsonLinesWithoutVolatileIds(output);
  const deltas = parsed
    .filter((event) => event.type === 'stream_event' && (event.event as Record<string, unknown>)?.type === 'content_block_delta')
    .map((event) => (((event.event as Record<string, unknown>).delta as Record<string, unknown>).text));

  assert.deepEqual(deltas, ['final text']);
  assert.equal(parsed.at(-1)?.type, 'stream_event');
  assert.deepEqual((parsed.at(-1)?.event as Record<string, unknown>), { type: 'message_stop' });
});

test('formats partial reasoning before text with ordered content blocks', () => {
  const state = createPartialMessageStreamState();
  const output = [
    formatPartialDeltaEvents(state, {
      sessionId: '11111111-1111-4111-8111-111111111111',
      model: 'claude-test',
      text: '',
      reasoningText: 'thinking',
    }),
    formatPartialDeltaEvents(state, {
      sessionId: '11111111-1111-4111-8111-111111111111',
      model: 'claude-test',
      text: 'answer',
      reasoningText: 'thinking',
    }),
    formatPartialMessageStopEvents(state, {
      sessionId: '11111111-1111-4111-8111-111111111111',
      stopReason: 'end_turn',
    }),
  ].join('');

  const parsed = parseJsonLinesWithoutVolatileIds(output);
  const streamEvents = parsed.map((event) => event.event as Record<string, unknown>);
  assert.deepEqual(streamEvents.slice(1, 6), [
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'thinking' },
    },
    {
      type: 'content_block_stop',
      index: 0,
    },
    {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'text', text: '' },
    },
    {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'text_delta', text: 'answer' },
    },
  ]);
});

test('rejects non-prefix partial reasoning replacements', () => {
  const state = createPartialMessageStreamState();
  formatPartialDeltaEvents(state, {
    sessionId: '11111111-1111-4111-8111-111111111111',
    model: 'claude-test',
    text: '',
    reasoningText: 'first draft',
  });

  assert.throws(() => formatPartialDeltaEvents(state, {
    sessionId: '11111111-1111-4111-8111-111111111111',
    model: 'claude-test',
    text: '',
    reasoningText: 'replacement',
  }), /partial reasoning replacement is not prefix-compatible/);
});

test('ignores late partial reasoning while still emitting later text deltas', () => {
  const state = createPartialMessageStreamState();
  formatPartialDeltaEvents(state, {
    sessionId: '11111111-1111-4111-8111-111111111111',
    model: 'claude-test',
    text: 'partial',
  });

  const output = formatPartialDeltaEvents(state, {
    sessionId: '11111111-1111-4111-8111-111111111111',
    model: 'claude-test',
    text: 'partial final',
    reasoningText: 'late thinking',
  });
  const parsed = parseJsonLinesWithoutVolatileIds(output);
  const deltas = parsed
    .filter((event) => event.type === 'stream_event' && (event.event as Record<string, unknown>)?.type === 'content_block_delta')
    .map((event) => (event.event as { delta: Record<string, unknown> }).delta);

  assert.deepEqual(deltas, [{ type: 'text_delta', text: ' final' }]);
});

test('formats partial structured output as tool_use stream events', () => {
  const state = createPartialMessageStreamState();
  const output = formatPartialMessageLifecycleEvents(state, {
    sessionId: '11111111-1111-4111-8111-111111111111',
    model: 'claude-test',
    structuredOutput: { ok: true },
    structuredOutputToolUseId: 'toolu_test',
    stopReason: 'tool_use',
    usage: {
      inputTokens: 1,
      outputTokens: 2,
      cacheReadInputTokens: null,
    },
  });

  assert.deepEqual(parseJsonLinesWithoutVolatileIds(output), [
    {
      type: 'stream_event',
      session_id: '11111111-1111-4111-8111-111111111111',
      parent_tool_use_id: null,
      ttft_ms: null,
      event: {
        type: 'message_start',
        message: {
          model: 'claude-test',
          type: 'message',
          role: 'assistant',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          stop_details: null,
        },
      },
    },
    {
      type: 'stream_event',
      session_id: '11111111-1111-4111-8111-111111111111',
      parent_tool_use_id: null,
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          name: 'StructuredOutput',
          input: {},
          caller: { type: 'direct' },
        },
      },
    },
    {
      type: 'stream_event',
      session_id: '11111111-1111-4111-8111-111111111111',
      parent_tool_use_id: null,
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'input_json_delta',
          partial_json: '{"ok":true}',
        },
      },
    },
    {
      type: 'stream_event',
      session_id: '11111111-1111-4111-8111-111111111111',
      parent_tool_use_id: null,
      event: {
        type: 'content_block_stop',
        index: 0,
      },
    },
    {
      type: 'stream_event',
      session_id: '11111111-1111-4111-8111-111111111111',
      parent_tool_use_id: null,
      event: {
        type: 'message_delta',
        delta: {
          stop_reason: 'tool_use',
          stop_sequence: null,
          stop_details: null,
        },
        usage: {
          input_tokens: 1,
          output_tokens: 2,
          cache_read_input_tokens: null,
        },
      },
    },
    {
      type: 'stream_event',
      session_id: '11111111-1111-4111-8111-111111111111',
      parent_tool_use_id: null,
      event: { type: 'message_stop' },
    },
  ]);
});

test('formats stream-json background assistant events as task notifications', () => {
  const output = formatBackgroundAssistantTextEvent({
    turnId: 'turn-1',
    text: 'background done',
  });

  assert.match(output, /\n$/);
  assert.deepEqual(parseJsonLinesWithoutVolatileIds(output), [
    {
      type: 'user',
      origin: { kind: 'task-notification' },
      message: {
        role: 'user',
        content: 'background task notification',
      },
    },
    {
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'background done' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        stop_details: null,
        diagnostics: null,
        context_management: null,
      },
    },
  ]);
});

test('formats stream-json background assistant events with session id when supplied', () => {
  const output = formatBackgroundAssistantTextEvent({
    turnId: 'turn-1',
    sessionId: '11111111-1111-4111-8111-111111111111',
    text: 'background done',
  });

  const parsed = parseJsonLinesWithoutVolatileIds(output);
  assert.equal(parsed[0]?.session_id, '11111111-1111-4111-8111-111111111111');
  assert.equal(parsed[1]?.session_id, '11111111-1111-4111-8111-111111111111');
  assert.equal(parsed[0]?.sessionId, undefined);
  assert.equal(parsed[1]?.sessionId, undefined);
});

test('formats stream-json worker results with full worker diagnostics', () => {
  const output = formatWorkerTurnResult(WORKER_RESULT, {
    turnId: 'public-turn-1',
    model: 'claude-test',
  });

  assert.match(output, /\n$/);
  assert.deepEqual(parseJsonLinesWithoutVolatileIds(output), [
    {
      type: 'assistant',
      session_id: '22222222-2222-4222-8222-222222222222',
      parent_tool_use_id: null,
      request_id: 'req_worker_1',
      message: {
        type: 'message',
        role: 'assistant',
        model: 'claude-test',
        content: [
          { type: 'thinking', thinking: 'worker reasoning' },
          {
            type: 'tool_use',
            name: 'StructuredOutput',
            input: { ok: true },
            caller: { type: 'direct' },
          },
        ],
        stop_reason: null,
        stop_sequence: null,
        stop_details: null,
        usage: {
          input_tokens: 20,
          output_tokens: 4,
          cache_read_input_tokens: 5,
        },
        diagnostics: null,
        context_management: null,
      },
    },
    {
      type: 'user',
      session_id: '22222222-2222-4222-8222-222222222222',
      parent_tool_use_id: null,
      tool_use_result: 'Structured output provided successfully',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            content: 'Structured output provided successfully',
          },
        ],
      },
    },
    {
      type: 'result',
      subtype: 'success',
      session_id: '22222222-2222-4222-8222-222222222222',
      is_error: false,
      api_error_status: null,
      duration_api_ms: null,
      ttft_ms: null,
      result: '',
      num_turns: 2,
      duration_ms: 456,
      total_cost_usd: null,
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 20,
        output_tokens: 4,
        cache_read_input_tokens: 5,
      },
      modelUsage: {
        'claude-test': {
          inputTokens: 20,
          outputTokens: 4,
          cacheReadInputTokens: 5,
          contextWindow: 200000,
        },
      },
      permission_denials: [],
      structured_output: { ok: true },
      terminal_reason: 'completed',
      fast_mode_state: 'off',
    },
  ]);
  for (const event of parseJsonLinesWithoutVolatileIds(output)) {
    assertNoOpenPOnlyStreamFields(event);
  }
});

test('suppresses duplicate streamed text snapshot even when the snapshot carries assistant metadata', () => {
  const output = formatWorkerTurnResult({
    ...WORKER_RESULT,
    content: 'worker final',
    reasoningContent: null,
    structuredOutput: undefined,
    requestId: undefined,
    assistantEvents: [
      {
        requestId: 'req_snapshot',
        message: {
          type: 'message',
          role: 'assistant',
          model: 'claude-test',
          content: [{ type: 'text', text: 'worker final' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          stop_details: null,
          usage: {
            input_tokens: 20,
            output_tokens: 4,
            cache_read_input_tokens: 5,
          },
          diagnostics: null,
          context_management: null,
        },
      },
    ],
  }, {
    turnId: 'public-turn-1',
    model: 'claude-test',
    suppressAssistantTexts: ['worker final'],
    suppressFallbackAssistantText: true,
  });

  const parsed = parseJsonLinesWithoutVolatileIds(output);
  const assistantEvents = parsed.filter((event) => event.type === 'assistant');
  assert.equal(assistantEvents.length, 0);
  assert.equal(parsed.at(-1)?.type, 'result');
});

test('preserves raw Claude usage fields on result events when available', () => {
  const output = formatWorkerTurnResult({
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
        server_tool_use: {
          web_search_requests: 0,
          web_fetch_requests: 0,
        },
        service_tier: 'standard',
        inference_geo: '',
      },
    },
  }, {
    turnId: 'public-turn-1',
    model: 'claude-test',
  });

  const parsed = parseJsonLinesWithoutVolatileIds(output);
  const result = parsed.at(-1);
  assert.deepEqual(result?.usage, {
    input_tokens: 20,
    cache_creation_input_tokens: 100,
    cache_read_input_tokens: 5,
    output_tokens: 4,
    server_tool_use: {
      web_search_requests: 0,
      web_fetch_requests: 0,
    },
    service_tier: 'standard',
    inference_geo: '',
  });
});

test('suppresses duplicate streamed text snapshot when the snapshot only carries a backend message id', () => {
  const output = formatWorkerTurnResult({
    ...WORKER_RESULT,
    content: 'worker final',
    reasoningContent: null,
    structuredOutput: undefined,
    requestId: undefined,
    assistantEvents: [
      {
        message: {
          id: 'msg_backend',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'worker final' }],
          stop_reason: null,
          stop_sequence: null,
          stop_details: null,
          diagnostics: null,
          context_management: null,
        },
      },
    ],
  }, {
    turnId: 'public-turn-1',
    suppressAssistantTexts: ['worker final'],
    suppressFallbackAssistantText: true,
  });

  const parsed = output.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
  const assistantEvents = parsed.filter((event) => event.type === 'assistant');
  assert.equal(assistantEvents.length, 0);
  assert.equal(parsed.at(-1)?.type, 'result');
});

test('does not emit empty fallback assistant when duplicate streamed text only carries request id', () => {
  const output = formatWorkerTurnResult({
    ...WORKER_RESULT,
    content: 'worker final',
    reasoningContent: null,
    structuredOutput: undefined,
    requestId: 'req_worker_final',
    assistantEvents: undefined,
  }, {
    turnId: 'public-turn-1',
    suppressAssistantTexts: ['worker final'],
    suppressFallbackAssistantText: true,
  });

  const parsed = parseJsonLinesWithoutVolatileIds(output);
  const assistantEvents = parsed.filter((event) => event.type === 'assistant');
  assert.equal(assistantEvents.length, 0);
  assert.equal(parsed.at(-1)?.type, 'result');
});

test('emits fallback text after preserved non-text snapshots when streamed preview is stale', () => {
  const output = formatWorkerTurnResult({
    ...WORKER_RESULT,
    content: 'first draft',
    reasoningContent: null,
    structuredOutput: undefined,
    requestId: undefined,
    assistantEvents: [
      {
        message: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'thinking snapshot' }],
          stop_reason: null,
          stop_sequence: null,
          stop_details: null,
          diagnostics: null,
          context_management: null,
        },
      },
      {
        message: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'first draft' }],
          stop_reason: null,
          stop_sequence: null,
          stop_details: null,
          diagnostics: null,
          context_management: null,
        },
      },
    ],
  }, {
    turnId: 'public-turn-1',
    suppressAssistantTexts: ['first draft', 'second draft'],
    suppressFallbackAssistantText: true,
  });

  const parsed = parseJsonLinesWithoutVolatileIds(output);
  const assistantContents = parsed
    .filter((event) => event.type === 'assistant')
    .map((event) => ((event.message as Record<string, unknown>).content as Array<Record<string, unknown>>).map((block) => block.type));
  assert.deepEqual(assistantContents, [['thinking'], ['text']]);
  assert.equal(parsed.at(-1)?.type, 'result');
});

test('worker stream-json result does not duplicate preserved final text when streamed text is stale', () => {
  const output = formatWorkerTurnResult({
    ...WORKER_RESULT,
    content: 'worker final',
    reasoningContent: null,
    structuredOutput: undefined,
    requestId: undefined,
    assistantEvents: [
      {
        message: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'worker final' }],
          stop_reason: null,
          stop_sequence: null,
          stop_details: null,
          diagnostics: null,
          context_management: null,
        },
      },
    ],
  }, {
    turnId: 'public-turn-1',
    suppressAssistantTexts: ['draft'],
    suppressFallbackAssistantText: true,
  });

  const parsed = parseJsonLinesWithoutVolatileIds(output);
  const assistantTexts = parsed
    .filter((event) => event.type === 'assistant')
    .map((event) => (((event.message as Record<string, unknown>).content as Array<Record<string, unknown>>)[0]?.text));
  assert.deepEqual(assistantTexts, ['worker final']);
  assert.equal(parsed.at(-1)?.type, 'result');
});

test('direct stream-json result does not duplicate preserved final text when streamed text is stale', () => {
  const output = formatTurnResult({
    ...RESULT,
    text: 'final answer',
    reasoningContent: null,
    structuredOutput: undefined,
    requestId: 'req_final',
    assistantEvents: [
      {
        message: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'final answer' }],
          stop_reason: null,
          stop_sequence: null,
          stop_details: null,
          diagnostics: null,
          context_management: null,
        },
      },
    ],
  }, {
    outputFormat: 'stream-json',
    backendSessionId: '11111111-1111-4111-8111-111111111111',
    suppressAssistantTexts: ['draft'],
    suppressFallbackAssistantText: true,
  });

  const parsed = parseJsonLinesWithoutVolatileIds(output);
  const assistantTexts = parsed
    .filter((event) => event.type === 'assistant')
    .map((event) => (((event.message as Record<string, unknown>).content as Array<Record<string, unknown>>)[0]?.text));
  assert.deepEqual(assistantTexts, ['final answer']);
  assert.equal(parsed.at(-1)?.type, 'result');
});

test('worker stream-json result suppresses already streamed mixed reasoning and text snapshot', () => {
  const output = formatWorkerTurnResult({
    ...WORKER_RESULT,
    content: 'worker final',
    reasoningContent: 'thinking live',
    structuredOutput: undefined,
    requestId: undefined,
    assistantEvents: [
      {
        message: {
          type: 'message',
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'thinking live' },
            { type: 'text', text: 'work' },
          ],
          stop_reason: null,
          stop_sequence: null,
          stop_details: null,
          diagnostics: null,
          context_management: null,
        },
      },
      {
        message: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'worker final' }],
          stop_reason: null,
          stop_sequence: null,
          stop_details: null,
          diagnostics: null,
          context_management: null,
        },
      },
    ],
  }, {
    turnId: 'public-turn-1',
    suppressAssistantTexts: ['work'],
    suppressAssistantReasoningTexts: ['thinking live'],
    suppressFallbackAssistantText: true,
  });

  const parsed = parseJsonLinesWithoutVolatileIds(output);
  const assistantContents = parsed
    .filter((event) => event.type === 'assistant')
    .map((event) => ((event.message as Record<string, unknown>).content as Array<Record<string, unknown>>).map((block) => block.type));
  assert.deepEqual(assistantContents, [['text']]);
  assert.equal(parsed.at(-1)?.type, 'result');
});

test('worker stream-json result suppresses thinking text property blocks', () => {
  const output = formatWorkerTurnResult({
    ...WORKER_RESULT,
    content: 'worker final',
    reasoningContent: 'thinking live',
    structuredOutput: undefined,
    requestId: undefined,
    assistantEvents: [
      {
        message: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'thinking', text: 'thinking live' }],
          stop_reason: null,
          stop_sequence: null,
          stop_details: null,
          diagnostics: null,
          context_management: null,
        },
      },
    ],
  }, {
    turnId: 'public-turn-1',
    suppressAssistantTexts: ['worker final'],
    suppressAssistantReasoningTexts: ['thinking live'],
    suppressFallbackAssistantText: true,
  });

  const parsed = parseJsonLinesWithoutVolatileIds(output);
  assert.equal(parsed.some((event) => event.type === 'assistant'), false);
  assert.equal(parsed.at(-1)?.type, 'result');
});

test('worker stream-json result suppresses cumulative reasoning split around streamed text', () => {
  const output = formatWorkerTurnResult({
    ...WORKER_RESULT,
    content: 'worker final',
    reasoningContent: 'think A\n\nthink B',
    structuredOutput: undefined,
    requestId: undefined,
    assistantEvents: [
      {
        message: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'think A' }],
          stop_reason: null,
          stop_sequence: null,
          stop_details: null,
          diagnostics: null,
          context_management: null,
        },
      },
      {
        message: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'draft' }],
          stop_reason: null,
          stop_sequence: null,
          stop_details: null,
          diagnostics: null,
          context_management: null,
        },
      },
      {
        message: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'reasoning', summary: [{ text: 'think B' }] }],
          stop_reason: null,
          stop_sequence: null,
          stop_details: null,
          diagnostics: null,
          context_management: null,
        },
      },
    ],
  }, {
    turnId: 'public-turn-1',
    suppressAssistantTexts: ['draft', 'worker final'],
    suppressAssistantReasoningTexts: ['think A', 'think A\n\nthink B'],
    suppressFallbackAssistantText: true,
  });

  const parsed = parseJsonLinesWithoutVolatileIds(output);
  assert.equal(parsed.some((event) => event.type === 'assistant'), false);
  assert.equal(parsed.at(-1)?.type, 'result');
});

test('worker stream-json result suppresses fallback reasoning after separate streamed reasoning snapshots', () => {
  const output = formatWorkerTurnResult({
    ...WORKER_RESULT,
    content: 'worker final',
    reasoningContent: 'think A\n\nthink B',
    structuredOutput: undefined,
    requestId: undefined,
    assistantEvents: [],
  }, {
    turnId: 'public-turn-1',
    suppressAssistantTexts: ['worker final'],
    suppressAssistantReasoningTexts: ['think A', 'think B'],
    suppressFallbackAssistantText: true,
  });

  const parsed = parseJsonLinesWithoutVolatileIds(output);
  assert.equal(parsed.some((event) => event.type === 'assistant'), false);
  assert.equal(parsed.at(-1)?.type, 'result');
});

test('worker stream-json result removes streamed text from mixed tool_use snapshots', () => {
  const output = formatWorkerTurnResult({
    ...WORKER_RESULT,
    content: 'worker final',
    reasoningContent: null,
    structuredOutput: undefined,
    requestId: undefined,
    assistantEvents: [
      {
        message: {
          type: 'message',
          role: 'assistant',
          content: [
            { type: 'text', text: 'draft' },
            { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'a.txt' } },
          ],
          stop_reason: null,
          stop_sequence: null,
          stop_details: null,
          diagnostics: null,
          context_management: null,
        },
      },
    ],
  }, {
    turnId: 'public-turn-1',
    suppressAssistantTexts: ['draft', 'worker final'],
    suppressFallbackAssistantText: true,
  });

  const parsed = parseJsonLinesWithoutVolatileIds(output);
  const assistantEvents = parsed.filter((event) => event.type === 'assistant');
  assert.equal(assistantEvents.length, 1);
  assert.deepEqual(
    (assistantEvents[0]?.message as Record<string, unknown>).content,
    [{ type: 'tool_use', name: 'Read', input: { file_path: 'a.txt' } }],
  );
  assert.equal(parsed.at(-1)?.type, 'result');
});

test('worker stream-json result suppresses fully streamed mixed tool_use snapshots', () => {
  const streamedSnapshot = {
    message: {
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'text', text: 'draft' },
        { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'a.txt' } },
      ],
      stop_reason: null,
      stop_sequence: null,
      stop_details: null,
      diagnostics: null,
      context_management: null,
    },
  };
  const output = formatWorkerTurnResult({
    ...WORKER_RESULT,
    content: 'worker final',
    reasoningContent: null,
    structuredOutput: undefined,
    requestId: undefined,
    assistantEvents: [streamedSnapshot],
  }, {
    turnId: 'public-turn-1',
    suppressAssistantTexts: ['draft', 'worker final'],
    suppressAssistantSnapshots: [streamedSnapshot],
    suppressFallbackAssistantText: true,
  });

  const parsed = parseJsonLinesWithoutVolatileIds(output);
  assert.equal(parsed.some((event) => event.type === 'assistant'), false);
  assert.equal(parsed.at(-1)?.type, 'result');
});

test('worker stream-json result does not synthesize StructuredOutput assistant after streamed tool_use snapshot', () => {
  const streamedSnapshot: AssistantEventSnapshot = {
    message: {
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'text', text: 'draft' },
        { type: 'tool_use', id: 'toolu_1', name: 'StructuredOutput', input: { ok: true } },
      ],
      stop_reason: null,
      stop_sequence: null,
      stop_details: null,
      diagnostics: null,
      context_management: null,
    },
  };
  const output = formatWorkerTurnResult({
    ...WORKER_RESULT,
    content: '',
    reasoningContent: null,
    structuredOutput: { ok: true },
    requestId: undefined,
    assistantEvents: [streamedSnapshot],
  }, {
    turnId: 'public-turn-1',
    suppressAssistantTexts: ['draft'],
    suppressAssistantSnapshots: [streamedSnapshot],
    suppressFallbackAssistantText: true,
  });

  const parsed = parseJsonLinesWithoutVolatileIds(output);
  assert.equal(parsed.some((event) => event.type === 'assistant'), false);
  assert.equal(parsed.some((event) => event.type === 'user'), true);
  assert.equal(parsed.at(-1)?.type, 'result');
});

test('worker stream-json result suppresses fallback reasoning from streamed nested reasoning snapshots', () => {
  const streamedSnapshot: AssistantEventSnapshot = {
    message: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'thinking', content: [{ text: 'think nested' }] }],
      stop_reason: null,
      stop_sequence: null,
      stop_details: null,
      diagnostics: null,
      context_management: null,
    },
  };
  const streamedReasoning = extractAssistantSnapshotReasoningText(streamedSnapshot);
  assert.equal(streamedReasoning, 'think nested');

  const output = formatWorkerTurnResult({
    ...WORKER_RESULT,
    content: 'worker final',
    reasoningContent: 'think nested',
    structuredOutput: undefined,
    requestId: undefined,
    assistantEvents: [streamedSnapshot],
  }, {
    turnId: 'public-turn-1',
    suppressAssistantTexts: ['worker final'],
    suppressAssistantReasoningTexts: streamedReasoning ? [streamedReasoning] : [],
    suppressAssistantSnapshots: [streamedSnapshot],
    suppressFallbackAssistantText: true,
  });

  const parsed = parseJsonLinesWithoutVolatileIds(output);
  assert.equal(parsed.some((event) => event.type === 'assistant'), false);
  assert.equal(parsed.at(-1)?.type, 'result');
});

test('worker stream-json result drops empty reasoning left after mixed text suppression', () => {
  const output = formatWorkerTurnResult({
    ...WORKER_RESULT,
    content: 'worker final',
    reasoningContent: null,
    structuredOutput: undefined,
    requestId: undefined,
    assistantEvents: [
      {
        message: {
          type: 'message',
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: '' },
            { type: 'text', text: 'worker final' },
          ],
          stop_reason: null,
          stop_sequence: null,
          stop_details: null,
          diagnostics: null,
          context_management: null,
        },
      },
    ],
  }, {
    turnId: 'public-turn-1',
    suppressAssistantTexts: ['worker final'],
    suppressFallbackAssistantText: true,
  });

  const parsed = parseJsonLinesWithoutVolatileIds(output);
  assert.equal(parsed.some((event) => event.type === 'assistant'), false);
  assert.equal(parsed.at(-1)?.type, 'result');
});

test('suppresses duplicate streamed text snapshot when the snapshot only carries stop details metadata', () => {
  const output = formatWorkerTurnResult({
    ...WORKER_RESULT,
    content: 'worker final',
    reasoningContent: null,
    structuredOutput: undefined,
    requestId: undefined,
    assistantEvents: [
      {
        message: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'worker final' }],
          stop_reason: null,
          stop_sequence: null,
          stop_details: { type: 'tool_use' },
          diagnostics: null,
          context_management: null,
        },
      },
    ],
  }, {
    turnId: 'public-turn-1',
    suppressAssistantTexts: ['worker final'],
    suppressFallbackAssistantText: true,
  });

  const parsed = parseJsonLinesWithoutVolatileIds(output);
  const assistantEvents = parsed.filter((event) => event.type === 'assistant');
  assert.equal(assistantEvents.length, 0);
  assert.equal(parsed.at(-1)?.type, 'result');
});

test('suppresses only one metadata-free text snapshot per streamed text occurrence', () => {
  const output = formatWorkerTurnResult({
    ...WORKER_RESULT,
    content: 'ok',
    reasoningContent: null,
    structuredOutput: undefined,
    requestId: undefined,
    assistantEvents: [
      {
        message: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: null,
          stop_sequence: null,
          stop_details: null,
          diagnostics: null,
          context_management: null,
        },
      },
      {
        message: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: null,
          stop_sequence: null,
          stop_details: null,
          diagnostics: null,
          context_management: null,
        },
      },
    ],
  }, {
    turnId: 'public-turn-1',
    suppressAssistantTexts: ['ok'],
    suppressFallbackAssistantText: true,
  });

  const parsed = parseJsonLinesWithoutVolatileIds(output);
  const assistantTexts = parsed
    .filter((event) => event.type === 'assistant')
    .map((event) => (((event.message as Record<string, unknown>).content as Array<Record<string, unknown>>)[0]?.text));
  assert.deepEqual(assistantTexts, ['ok']);
  assert.equal(parsed.at(-1)?.type, 'result');
});

test('direct stream-json result suppresses already streamed default assistant text', () => {
  const output = formatTurnResult({
    ...RESULT,
    text: 'final answer',
    reasoningContent: null,
    structuredOutput: undefined,
    requestId: 'req_final',
    assistantEvents: [
      {
        message: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'final answer' }],
          stop_reason: null,
          stop_sequence: null,
          stop_details: null,
          diagnostics: null,
          context_management: null,
        },
      },
    ],
  }, {
    outputFormat: 'stream-json',
    backendSessionId: '11111111-1111-4111-8111-111111111111',
    suppressAssistantTexts: ['draft answer', 'final answer'],
    suppressFallbackAssistantText: true,
  });

  const parsed = parseJsonLinesWithoutVolatileIds(output);
  const assistantEvents = parsed.filter((event) => event.type === 'assistant');
  assert.equal(assistantEvents.length, 0);
  assert.equal(parsed.at(-1)?.type, 'result');
  assert.equal(parsed.at(-1)?.result, 'final answer');
});

test('direct stream-json result preserves non-text snapshots after streamed assistant text', () => {
  const output = formatTurnResult({
    ...RESULT,
    text: 'final answer',
    reasoningContent: null,
    structuredOutput: undefined,
    requestId: 'req_final',
    assistantEvents: [
      {
        message: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'explicit reasoning' }],
          stop_reason: null,
          stop_sequence: null,
          stop_details: null,
          diagnostics: null,
          context_management: null,
        },
      },
      {
        message: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'final answer' }],
          stop_reason: null,
          stop_sequence: null,
          stop_details: null,
          diagnostics: null,
          context_management: null,
        },
      },
    ],
  }, {
    outputFormat: 'stream-json',
    backendSessionId: '11111111-1111-4111-8111-111111111111',
    suppressAssistantTexts: ['final answer'],
    suppressFallbackAssistantText: true,
  });

  const parsed = parseJsonLinesWithoutVolatileIds(output);
  const assistantContents = parsed
    .filter((event) => event.type === 'assistant')
    .map((event) => ((event.message as Record<string, unknown>).content as Array<Record<string, unknown>>).map((block) => block.type));
  assert.deepEqual(assistantContents, [['thinking']]);
  assert.equal(parsed.at(-1)?.type, 'result');
});

test('direct stream-json result drops empty reasoning-only snapshots', () => {
  const output = formatTurnResult({
    ...RESULT,
    text: 'final answer',
    reasoningContent: null,
    structuredOutput: undefined,
    requestId: 'req_final',
    assistantEvents: [
      {
        message: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'thinking', thinking: '' }],
          stop_reason: null,
          stop_sequence: null,
          stop_details: null,
          diagnostics: null,
          context_management: null,
        },
      },
    ],
  }, {
    outputFormat: 'stream-json',
    backendSessionId: '11111111-1111-4111-8111-111111111111',
  });

  const parsed = parseJsonLinesWithoutVolatileIds(output);
  const assistantContents = parsed
    .filter((event) => event.type === 'assistant')
    .map((event) => ((event.message as Record<string, unknown>).content as Array<Record<string, unknown>>).map((block) => block.type));
  assert.deepEqual(assistantContents, [['text']]);
  assert.equal(parsed.at(-1)?.type, 'result');
});

test('direct stream-json result suppresses already streamed fallback reasoning', () => {
  const output = formatTurnResult({
    ...RESULT,
    text: 'final answer',
    reasoningContent: 'thinking live',
    structuredOutput: undefined,
    requestId: 'req_final',
    assistantEvents: undefined,
  }, {
    outputFormat: 'stream-json',
    backendSessionId: '11111111-1111-4111-8111-111111111111',
    suppressAssistantTexts: ['final answer'],
    suppressAssistantReasoningTexts: ['thinking live'],
    suppressFallbackAssistantText: true,
  });

  const parsed = parseJsonLinesWithoutVolatileIds(output);
  assert.equal(parsed.some((event) => event.type === 'assistant'), false);
  assert.equal(parsed.at(-1)?.type, 'result');
});

test('worker stream-json result suppresses cumulative streamed reasoning snapshots', () => {
  const output = formatWorkerTurnResult({
    ...WORKER_RESULT,
    content: 'worker final',
    reasoningContent: 'think A\n\nthink B',
    structuredOutput: undefined,
    requestId: undefined,
    assistantEvents: [
      {
        message: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'think A' }],
          stop_reason: null,
          stop_sequence: null,
          stop_details: null,
          diagnostics: null,
          context_management: null,
        },
      },
      {
        message: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'reasoning', summary: [{ text: 'think B' }] }],
          stop_reason: null,
          stop_sequence: null,
          stop_details: null,
          diagnostics: null,
          context_management: null,
        },
      },
    ],
  }, {
    turnId: 'public-turn-1',
    suppressAssistantTexts: ['worker final'],
    suppressAssistantReasoningTexts: ['think A\n\nthink B'],
    suppressFallbackAssistantText: true,
  });

  const parsed = parseJsonLinesWithoutVolatileIds(output);
  assert.equal(parsed.some((event) => event.type === 'assistant'), false);
  assert.equal(parsed.at(-1)?.type, 'result');
});

test('worker stream-json result suppresses repeated cumulative reasoning snapshots', () => {
  const output = formatWorkerTurnResult({
    ...WORKER_RESULT,
    content: 'worker final',
    reasoningContent: 'think A\n\nthink B',
    structuredOutput: undefined,
    requestId: undefined,
    assistantEvents: [
      {
        message: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'think A' }],
          stop_reason: null,
          stop_sequence: null,
          stop_details: null,
          diagnostics: null,
          context_management: null,
        },
      },
      {
        message: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'think A\n\nthink B' }],
          stop_reason: null,
          stop_sequence: null,
          stop_details: null,
          diagnostics: null,
          context_management: null,
        },
      },
    ],
  }, {
    turnId: 'public-turn-1',
    suppressAssistantTexts: ['worker final'],
    suppressAssistantReasoningTexts: ['think A', 'think A\n\nthink B'],
    suppressFallbackAssistantText: true,
  });

  const parsed = parseJsonLinesWithoutVolatileIds(output);
  assert.equal(parsed.some((event) => event.type === 'assistant'), false);
  assert.equal(parsed.at(-1)?.type, 'result');
});

test('worker stream-json result prefers cumulative reasoning suppression over earlier exact prefix', () => {
  const output = formatWorkerTurnResult({
    ...WORKER_RESULT,
    content: 'worker final',
    reasoningContent: 'think A\n\nthink B',
    structuredOutput: undefined,
    requestId: undefined,
    assistantEvents: [
      {
        message: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'think A' }],
          stop_reason: null,
          stop_sequence: null,
          stop_details: null,
          diagnostics: null,
          context_management: null,
        },
      },
      {
        message: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'reasoning', summary: [{ text: 'think B' }] }],
          stop_reason: null,
          stop_sequence: null,
          stop_details: null,
          diagnostics: null,
          context_management: null,
        },
      },
    ],
  }, {
    turnId: 'public-turn-1',
    suppressAssistantTexts: ['worker final'],
    suppressAssistantReasoningTexts: ['think A', 'think A\n\nthink B'],
    suppressFallbackAssistantText: true,
  });

  const parsed = parseJsonLinesWithoutVolatileIds(output);
  assert.equal(parsed.some((event) => event.type === 'assistant'), false);
  assert.equal(parsed.at(-1)?.type, 'result');
});

function parseJsonLinesWithoutVolatileIds(output: string): Record<string, unknown>[] {
  return output.trim().split('\n').map((line) => stripVolatileIds(JSON.parse(line)) as Record<string, unknown>);
}

function stripVolatileIds(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripVolatileIds);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === 'uuid' || key === 'id') {
      continue;
    }
    if (key === 'timestamp' || key === 'tool_use_id') {
      continue;
    }
    result[key] = stripVolatileIds(child);
  }
  return result;
}

function assertNoOpenPOnlyStreamFields(event: Record<string, unknown>): void {
  assert.equal(Object.prototype.hasOwnProperty.call(event, 'turnId'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(event, 'sessionId'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(event, 'text'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(event, 'diagnostics'), false);
  const modelUsage = event.modelUsage;
  if (modelUsage && typeof modelUsage === 'object' && !Array.isArray(modelUsage)) {
    assert.equal(Object.prototype.hasOwnProperty.call(modelUsage, 'openp'), false);
  }
}
