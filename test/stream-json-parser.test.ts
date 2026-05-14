import assert from 'node:assert/strict';
import test from 'node:test';
import { parseStreamJsonLines } from '../src/core/stream-json-parser.js';
import { EXIT_CODES, OpenPError } from '../src/core/errors.js';

function line(event: unknown): string {
  return JSON.stringify(event);
}

test('uses result event as final content and does not treat assistant text as reasoning', () => {
  const intermediate: string[] = [];
  const result = parseStreamJsonLines(
    [
      line({ type: 'system', subtype: 'init', session_id: 'session-1' }),
      line({
        type: 'assistant',
        message: {
          model: 'claude-haiku',
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, cache_read_input_tokens: 2, output_tokens: 5 },
          content: [{ type: 'text', text: 'working' }],
        },
      }),
      line({
        type: 'result',
        session_id: 'session-1',
        result: 'final answer',
        num_turns: 1,
        duration_ms: 1234,
        total_cost_usd: 0.01,
      }),
    ],
    {
      contextWindowsByModel: { 'claude-haiku': 200_000 },
      onIntermediateText: (text) => intermediate.push(text),
    },
  );

  assert.equal(result?.content, 'final answer');
  assert.equal(result?.reasoningContent, null);
  assert.deepEqual(intermediate, ['working']);
  assert.deepEqual(result?.diagnostics, {
    numTurns: 1,
    inputTokens: 10,
    outputTokens: 5,
    cacheReadInputTokens: 2,
    contextWindow: 200_000,
    lastSubturnContextTokens: 12,
    durationMs: 1234,
    totalCostUsd: 0.01,
    stopReason: 'end_turn',
    toolsUsed: [],
    autoCompacted: null,
    intermediateTextCount: 1,
    rawUsage: {
      input_tokens: 10,
      cache_read_input_tokens: 2,
      output_tokens: 5,
    },
  });
});

test('keeps separate assistant text blocks when the later block has the earlier block as a prefix', () => {
  const intermediate: string[] = [];
  const result = parseStreamJsonLines(
    [
      line({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'foo' },
            { type: 'text', text: 'foobar' },
          ],
        },
      }),
      line({ type: 'result', result: 'done' }),
    ],
    {
      onIntermediateText: (text) => intermediate.push(text),
    },
  );

  assert.equal(result?.content, 'done');
  assert.deepEqual(intermediate, ['foo\n\nfoobar']);
});

test('replaces cumulative multi-block updates for the same assistant message id', () => {
  const intermediate: string[] = [];
  const result = parseStreamJsonLines(
    [
      line({
        type: 'assistant',
        message: {
          id: 'msg_same',
          stop_reason: null,
          content: [
            { type: 'text', text: 'foo' },
            { type: 'text', text: 'bar' },
          ],
        },
      }),
      line({
        type: 'assistant',
        message: {
          id: 'msg_same',
          stop_reason: null,
          content: [
            { type: 'text', text: 'foo' },
            { type: 'text', text: 'barbaz' },
          ],
        },
      }),
      line({ type: 'result', result: 'done' }),
    ],
    {
      onIntermediateText: (text) => intermediate.push(text),
    },
  );

  assert.equal(result?.content, 'done');
  assert.deepEqual(intermediate, ['foo\n\nbar', 'foo\n\nbarbaz']);
});

test('keeps separate completed assistant messages when the later message has the earlier text as a prefix', () => {
  const intermediate: string[] = [];
  const result = parseStreamJsonLines(
    [
      line({
        type: 'assistant',
        message: {
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'foo' }],
        },
      }),
      line({
        type: 'assistant',
        message: {
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'foobar' }],
        },
      }),
      line({ type: 'result', result: 'done' }),
    ],
    {
      onIntermediateText: (text) => intermediate.push(text),
    },
  );

  assert.equal(result?.content, 'done');
  assert.deepEqual(intermediate, ['foo', 'foo\n\nfoobar']);
});

test('keeps separate public assistant messages with different ids when stop reasons are null', () => {
  const intermediate: string[] = [];
  const result = parseStreamJsonLines(
    [
      line({
        type: 'assistant',
        message: {
          id: 'msg_one',
          stop_reason: null,
          content: [{ type: 'text', text: 'foo' }],
        },
      }),
      line({
        type: 'assistant',
        message: {
          id: 'msg_two',
          stop_reason: null,
          content: [{ type: 'text', text: 'foobar' }],
        },
      }),
      line({ type: 'result', result: 'done' }),
    ],
    {
      onIntermediateText: (text) => intermediate.push(text),
    },
  );

  assert.equal(result?.content, 'done');
  assert.deepEqual(intermediate, ['foo', 'foo\n\nfoobar']);
});

test('replaces the latest non-terminal assistant snapshot after a completed earlier assistant message', () => {
  const intermediate: string[] = [];
  const result = parseStreamJsonLines(
    [
      line({
        type: 'assistant',
        message: {
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'done before' }],
        },
      }),
      line({
        type: 'assistant',
        message: {
          stop_reason: null,
          content: [{ type: 'text', text: 'work' }],
        },
      }),
      line({
        type: 'assistant',
        message: {
          stop_reason: null,
          content: [{ type: 'text', text: 'work final' }],
        },
      }),
      line({ type: 'result', result: 'done' }),
    ],
    {
      onIntermediateText: (text) => intermediate.push(text),
    },
  );

  assert.equal(result?.content, 'done');
  assert.deepEqual(intermediate, ['done before', 'done before\n\nwork', 'done before\n\nwork final']);
});

test('does not let a textless assistant event make a completed text replaceable', () => {
  const intermediate: string[] = [];
  const result = parseStreamJsonLines(
    [
      line({
        type: 'assistant',
        message: {
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'foo' }],
        },
      }),
      line({
        type: 'assistant',
        message: {
          stop_reason: null,
          content: [{ type: 'thinking', thinking: 'thought only' }],
        },
      }),
      line({
        type: 'assistant',
        message: {
          stop_reason: null,
          content: [{ type: 'text', text: 'foobar' }],
        },
      }),
      line({ type: 'result', result: 'done' }),
    ],
    {
      onIntermediateText: (text) => intermediate.push(text),
    },
  );

  assert.equal(result?.content, 'done');
  assert.deepEqual(intermediate, ['foo', 'foo\n\nfoobar']);
});

test('treats a textless terminal assistant event as a text boundary', () => {
  const intermediate: string[] = [];
  const result = parseStreamJsonLines(
    [
      line({
        type: 'assistant',
        message: {
          stop_reason: null,
          content: [{ type: 'text', text: 'foo' }],
        },
      }),
      line({
        type: 'assistant',
        message: {
          stop_reason: 'tool_use',
          content: [{ type: 'tool_use', name: 'Read', input: {} }],
        },
      }),
      line({
        type: 'assistant',
        message: {
          stop_reason: null,
          content: [{ type: 'text', text: 'foobar' }],
        },
      }),
      line({ type: 'result', result: 'done' }),
    ],
    {
      onIntermediateText: (text) => intermediate.push(text),
    },
  );

  assert.equal(result?.content, 'done');
  assert.deepEqual(intermediate, ['foo', 'foo\n\nfoobar']);
});

test('preserves structured output from result events', () => {
  const result = parseStreamJsonLines([
    line({
      type: 'result',
      session_id: 'session-1',
      result: 'done',
      structured_output: { ok: true, label: 'OPENP_SCHEMA' },
    }),
  ]);

  assert.equal(result?.content, 'done');
  assert.deepEqual(result?.structuredOutput, { ok: true, label: 'OPENP_SCHEMA' });
});

test('uses structured output as content when result text is empty', () => {
  const result = parseStreamJsonLines([
    line({
      type: 'result',
      session_id: 'session-1',
      result: '',
      structured_output: { ok: true },
    }),
  ]);

  assert.equal(result?.content, '{"ok":true}');
  assert.deepEqual(result?.structuredOutput, { ok: true });
});

test('preserves StructuredOutput tool input before result events', () => {
  const result = parseStreamJsonLines([
    line({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'StructuredOutput', input: { ok: true } },
          { type: 'text', text: 'working' },
        ],
      },
    }),
    line({ type: 'result', result: 'done' }),
  ]);

  assert.equal(result?.content, 'done');
  assert.deepEqual(result?.structuredOutput, { ok: true });
  assert.deepEqual(result?.diagnostics.toolsUsed, ['StructuredOutput']);
});

test('does not copy final answer echo into reasoning content', () => {
  const result = parseStreamJsonLines([
    line({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'final answer' }],
      },
    }),
    line({ type: 'result', result: 'final answer' }),
  ]);

  assert.equal(result?.content, 'final answer');
  assert.equal(result?.reasoningContent, null);
});

test('preserves stream-json background whitespace without treating answer text as reasoning', () => {
  const background: string[] = [];
  const result = parseStreamJsonLines(
    [
      line({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: '  active progress\n' }],
        },
      }),
      line({ type: 'result', result: 'active final' }),
      line({ type: 'user', origin: { kind: 'task-notification' }, message: { content: 'task complete' } }),
      line({
        type: 'assistant',
        message: {
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: '  background done\n' }],
        },
      }),
    ],
    {
      onBackgroundAssistantText: (text) => background.push(text),
    },
  );

  assert.equal(result?.reasoningContent, null);
  assert.deepEqual(background, ['  background done\n']);
  assert.deepEqual(result?.backgroundTexts, ['  background done\n']);
});

test('throws protocol violation for empty result content', () => {
  assert.throws(
    () => parseStreamJsonLines([
      line({ type: 'result', result: '' }),
    ]),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.protocolViolation,
  );
});

test('throws protocol violation for whitespace-only result content', () => {
  assert.throws(
    () => parseStreamJsonLines([
      line({ type: 'result', result: '   \n' }),
    ]),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.protocolViolation,
  );
});

test('collects thinking, reasoning, and unique tool use names from assistant messages', () => {
  const result = parseStreamJsonLines([
    line({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Bash' },
          { type: 'tool_use', name: 'Bash' },
          { type: 'tool_use', name: 'Read' },
          { type: 'thinking', text: 'think block' },
          { type: 'reasoning', summary: [{ text: 'reason summary' }] },
        ],
      },
    }),
    line({ type: 'result', result: 'done' }),
  ]);

  assert.deepEqual(result?.diagnostics.toolsUsed, ['Bash', 'Read']);
  assert.equal(result?.reasoningContent, 'think block\n\nreason summary');
});

test('replaces cumulative reasoning assistant snapshots without duplicating prior thinking', () => {
  const result = parseStreamJsonLines([
    line({
      type: 'assistant',
      message: {
        content: [{ type: 'thinking', thinking: 'think A' }],
      },
    }),
    line({
      type: 'assistant',
      message: {
        content: [{ type: 'thinking', thinking: 'think A\n\nthink B' }],
      },
    }),
    line({ type: 'result', result: 'done' }),
  ]);

  assert.equal(result?.reasoningContent, 'think A\n\nthink B');
});

test('takes context usage from the last assistant subturn, not result aggregate usage', () => {
  const result = parseStreamJsonLines([
    line({
      type: 'assistant',
      message: {
        usage: { input_tokens: 7, cache_read_input_tokens: 3, output_tokens: 2 },
        content: [{ type: 'text', text: 'subturn' }],
      },
    }),
    line({
      type: 'result',
      result: 'final',
      usage: { input_tokens: 1000, cache_read_input_tokens: 1000, output_tokens: 1000 },
    }),
  ]);

  assert.equal(result?.diagnostics.inputTokens, 7);
  assert.equal(result?.diagnostics.cacheReadInputTokens, 3);
  assert.equal(result?.diagnostics.outputTokens, 2);
  assert.equal(result?.diagnostics.lastSubturnContextTokens, 10);
});

test('uses result usage when no assistant usage snapshot is present', () => {
  const result = parseStreamJsonLines([
    line({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'progress' }],
      },
    }),
    line({
      type: 'result',
      result: 'final',
      stop_reason: 'end_turn',
      usage: { input_tokens: 7, cache_read_input_tokens: 3, output_tokens: 2 },
    }),
  ]);

  assert.equal(result?.diagnostics.inputTokens, 7);
  assert.equal(result?.diagnostics.cacheReadInputTokens, 3);
  assert.equal(result?.diagnostics.outputTokens, 2);
  assert.equal(result?.diagnostics.lastSubturnContextTokens, 10);
  assert.equal(result?.diagnostics.stopReason, 'end_turn');
});

test('preserves raw result usage when no assistant usage snapshot is present', () => {
  const result = parseStreamJsonLines([
    line({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'progress' }],
      },
    }),
    line({
      type: 'result',
      result: 'final',
      usage: {
        input_tokens: 7,
        cache_creation_input_tokens: 11,
        cache_read_input_tokens: 3,
        output_tokens: 2,
        server_tool_use: {
          web_search_requests: 0,
          web_fetch_requests: 0,
        },
        service_tier: 'standard',
      },
    }),
  ]);

  assert.deepEqual(result?.diagnostics.rawUsage, {
    input_tokens: 7,
    cache_creation_input_tokens: 11,
    cache_read_input_tokens: 3,
    output_tokens: 2,
    server_tool_use: {
      web_search_requests: 0,
      web_fetch_requests: 0,
    },
    service_tier: 'standard',
  });
});

test('keeps assistant token counts while preserving richer result raw usage fields', () => {
  const result = parseStreamJsonLines([
    line({
      type: 'assistant',
      message: {
        usage: {
          input_tokens: 7,
          cache_read_input_tokens: 3,
          output_tokens: 2,
        },
        content: [{ type: 'text', text: 'progress' }],
      },
    }),
    line({
      type: 'result',
      result: 'final',
      usage: {
        input_tokens: 100,
        cache_creation_input_tokens: 11,
        cache_read_input_tokens: 30,
        output_tokens: 20,
        service_tier: 'standard',
      },
    }),
  ]);

  assert.equal(result?.diagnostics.inputTokens, 7);
  assert.equal(result?.diagnostics.cacheReadInputTokens, 3);
  assert.equal(result?.diagnostics.outputTokens, 2);
  assert.deepEqual(result?.diagnostics.rawUsage, {
    input_tokens: 100,
    cache_creation_input_tokens: 11,
    cache_read_input_tokens: 30,
    output_tokens: 20,
    service_tier: 'standard',
  });
});

test('keeps assistant token counts while preserving changed result raw usage values', () => {
  const result = parseStreamJsonLines([
    line({
      type: 'assistant',
      message: {
        usage: {
          input_tokens: 7,
          cache_read_input_tokens: 3,
          output_tokens: 2,
        },
        content: [{ type: 'text', text: 'progress' }],
      },
    }),
    line({
      type: 'result',
      result: 'final',
      usage: {
        input_tokens: 100,
        cache_read_input_tokens: 30,
        output_tokens: 20,
      },
    }),
  ]);

  assert.equal(result?.diagnostics.inputTokens, 7);
  assert.equal(result?.diagnostics.cacheReadInputTokens, 3);
  assert.equal(result?.diagnostics.outputTokens, 2);
  assert.deepEqual(result?.diagnostics.rawUsage, {
    input_tokens: 100,
    cache_read_input_tokens: 30,
    output_tokens: 20,
  });
});

test('routes task-notification assistant text as background output after active result', () => {
  const intermediate: string[] = [];
  const background: string[] = [];
  const result = parseStreamJsonLines(
    [
      line({
        type: 'assistant',
        message: {
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'active progress' }],
        },
      }),
      line({ type: 'result', result: 'active final' }),
      line({ type: 'user', origin: { kind: 'task-notification' }, message: { content: 'task complete' } }),
      line({
        type: 'assistant',
        message: {
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'background done' }],
        },
      }),
      line({ type: 'result', result: 'must not replace active final' }),
    ],
    {
      onIntermediateText: (text) => intermediate.push(text),
      onBackgroundAssistantText: (text) => background.push(text),
    },
  );

  assert.equal(result?.content, 'active final');
  assert.deepEqual(intermediate, ['active progress']);
  assert.deepEqual(background, ['background done']);
  assert.deepEqual(result?.backgroundTexts, ['background done']);
});

test('fails closed when task-notification result without background text has no later active result', () => {
  assert.equal(parseStreamJsonLines([
    line({
      type: 'assistant',
      message: {
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'active progress' }],
      },
    }),
    line({ type: 'user', origin: { kind: 'task-notification' }, message: { content: 'task complete' } }),
    line({ type: 'result', result: 'ambiguous result', num_turns: 99, duration_ms: 999, total_cost_usd: 9 }),
  ]), null);
});

test('fails closed when task-notification only emits whitespace before an ambiguous result', () => {
  const background: string[] = [];
  assert.equal(parseStreamJsonLines(
    [
      line({
        type: 'assistant',
        message: {
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'active progress' }],
        },
      }),
      line({ type: 'user', origin: { kind: 'task-notification' }, message: { content: 'task complete' } }),
      line({
        type: 'assistant',
        message: {
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: '   \n' }],
        },
      }),
      line({ type: 'result', result: 'ambiguous result', num_turns: 99, duration_ms: 999, total_cost_usd: 9 }),
    ],
    {
      onBackgroundAssistantText: (text) => background.push(text),
    },
  ), null);

  assert.deepEqual(background, []);
});

test('defers task-notification result without background text until a later active result', () => {
  const result = parseStreamJsonLines([
    line({
      type: 'assistant',
      message: {
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'active progress' }],
      },
    }),
    line({ type: 'user', origin: { kind: 'task-notification' }, message: { content: 'task complete' } }),
    line({ type: 'result', result: 'background result without assistant text', num_turns: 99 }),
    line({ type: 'result', result: 'active final', num_turns: 1 }),
  ]);

  assert.equal(result?.content, 'active final');
  assert.equal(result?.reasoningContent, null);
  assert.deepEqual(result?.backgroundTexts, []);
  assert.equal(result?.diagnostics.numTurns, 1);
});

test('keeps background assistant separate when active result arrives before background text', () => {
  const intermediate: string[] = [];
  const background: string[] = [];
  const result = parseStreamJsonLines(
    [
      line({
        type: 'assistant',
        message: {
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'active progress' }],
        },
      }),
      line({ type: 'user', origin: { kind: 'task-notification' }, message: { content: 'task complete' } }),
      line({ type: 'result', result: 'active final', num_turns: 1 }),
      line({
        type: 'assistant',
        message: {
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'background after final' }],
        },
      }),
      line({ type: 'result', result: 'background result after final', num_turns: 99 }),
    ],
    {
      onIntermediateText: (text) => intermediate.push(text),
      onBackgroundAssistantText: (text) => background.push(text),
    },
  );

  assert.equal(result?.content, 'active final');
  assert.equal(result?.reasoningContent, null);
  assert.deepEqual(intermediate, ['active progress']);
  assert.deepEqual(background, ['background after final']);
  assert.deepEqual(result?.backgroundTexts, ['background after final']);
  assert.equal(result?.diagnostics.numTurns, 1);
});

test('keeps tentative active result when background assistant only emits whitespace', () => {
  const background: string[] = [];
  const result = parseStreamJsonLines(
    [
      line({
        type: 'assistant',
        message: {
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'active progress' }],
        },
      }),
      line({ type: 'user', origin: { kind: 'task-notification' }, message: { content: 'task complete' } }),
      line({ type: 'result', result: 'active final', num_turns: 1 }),
      line({
        type: 'assistant',
        message: {
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: '   \n' }],
        },
      }),
      line({ type: 'result', result: 'background result', num_turns: 99 }),
    ],
    {
      onBackgroundAssistantText: (text) => background.push(text),
    },
  );

  assert.equal(result?.content, 'active final');
  assert.deepEqual(background, []);
  assert.deepEqual(result?.backgroundTexts, []);
  assert.equal(result?.diagnostics.numTurns, 1);
});

test('fails closed when task-notification assistant text ends before an ambiguous result', () => {
  const background: string[] = [];
  assert.equal(parseStreamJsonLines(
    [
      line({
        type: 'assistant',
        message: {
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'active progress' }],
        },
      }),
      line({ type: 'user', origin: { kind: 'task-notification' }, message: { content: 'task complete' } }),
      line({
        type: 'assistant',
        message: {
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'background done' }],
        },
      }),
      line({ type: 'result', result: 'ambiguous result', num_turns: 99, duration_ms: 999, total_cost_usd: 9 }),
    ],
    {
      onBackgroundAssistantText: (text) => background.push(text),
    },
  ), null);

  assert.deepEqual(background, ['background done']);
});

test('skips a matching background result before the later active result', () => {
  const result = parseStreamJsonLines([
    line({
      type: 'assistant',
      message: {
        stop_reason: 'end_turn',
        usage: { input_tokens: 7, cache_read_input_tokens: 3, output_tokens: 2 },
        content: [{ type: 'text', text: 'active progress' }],
      },
    }),
    line({ type: 'user', origin: { kind: 'task-notification' }, message: { content: 'task complete' } }),
    line({
      type: 'assistant',
      message: {
        stop_reason: 'end_turn',
        usage: { input_tokens: 100, cache_read_input_tokens: 200, output_tokens: 300 },
        content: [{ type: 'text', text: 'background done' }],
      },
    }),
    line({
      type: 'result',
      result: 'background done',
      num_turns: 99,
      duration_ms: 999,
      total_cost_usd: 9,
    }),
    line({
      type: 'result',
      result: 'active final',
      num_turns: 1,
      duration_ms: 123,
      total_cost_usd: 0.01,
    }),
  ]);

  assert.equal(result?.content, 'active final');
  assert.deepEqual(result?.backgroundTexts, ['background done']);
  assert.equal(result?.diagnostics.numTurns, 1);
  assert.equal(result?.diagnostics.durationMs, 123);
  assert.equal(result?.diagnostics.totalCostUsd, 0.01);
  assert.equal(result?.diagnostics.inputTokens, 7);
  assert.equal(result?.diagnostics.cacheReadInputTokens, 3);
  assert.equal(result?.diagnostics.outputTokens, 2);
});

test('defers a non-matching background result so the later active result wins', () => {
  const result = parseStreamJsonLines([
    line({
      type: 'assistant',
      message: {
        stop_reason: 'end_turn',
        usage: { input_tokens: 7, cache_read_input_tokens: 3, output_tokens: 2 },
        content: [{ type: 'text', text: 'active progress' }],
      },
    }),
    line({ type: 'user', origin: { kind: 'task-notification' }, message: { content: 'task complete' } }),
    line({
      type: 'assistant',
      message: {
        stop_reason: 'end_turn',
        usage: { input_tokens: 100, cache_read_input_tokens: 200, output_tokens: 300 },
        content: [{ type: 'text', text: 'background text block' }],
      },
    }),
    line({
      type: 'result',
      result: 'background result summary',
      num_turns: 99,
      duration_ms: 999,
      total_cost_usd: 9,
    }),
    line({
      type: 'result',
      result: 'active final',
      num_turns: 1,
      duration_ms: 123,
      total_cost_usd: 0.01,
    }),
  ]);

  assert.equal(result?.content, 'active final');
  assert.deepEqual(result?.backgroundTexts, ['background text block']);
  assert.equal(result?.diagnostics.numTurns, 1);
  assert.equal(result?.diagnostics.durationMs, 123);
  assert.equal(result?.diagnostics.totalCostUsd, 0.01);
  assert.equal(result?.diagnostics.inputTokens, 7);
  assert.equal(result?.diagnostics.cacheReadInputTokens, 3);
  assert.equal(result?.diagnostics.outputTokens, 2);
});

test('defers multiple background result pairs before the active result', () => {
  const result = parseStreamJsonLines([
    line({
      type: 'assistant',
      message: {
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'active progress' }],
      },
    }),
    line({ type: 'user', origin: { kind: 'task-notification' }, message: { content: 'task one' } }),
    line({
      type: 'assistant',
      message: {
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'background one' }],
      },
    }),
    line({ type: 'result', result: 'background one result', num_turns: 10 }),
    line({ type: 'user', origin: { kind: 'task-notification' }, message: { content: 'task two' } }),
    line({
      type: 'assistant',
      message: {
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'background two' }],
      },
    }),
    line({ type: 'result', result: 'background two result', num_turns: 20 }),
    line({ type: 'result', result: 'active final', num_turns: 1 }),
  ]);

  assert.equal(result?.content, 'active final');
  assert.deepEqual(result?.backgroundTexts, ['background one', 'background two']);
  assert.equal(result?.diagnostics.numTurns, 1);
});

test('defers result that flushes task-notification text until a later active result', () => {
  const background: string[] = [];
  const result = parseStreamJsonLines(
    [
      line({
        type: 'assistant',
        message: {
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'active progress' }],
        },
      }),
      line({ type: 'user', origin: { kind: 'task-notification' }, message: { content: 'task complete' } }),
      line({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'background pending' }],
        },
      }),
      line({ type: 'result', result: 'background result' }),
      line({ type: 'result', result: 'active final' }),
    ],
    {
      onBackgroundAssistantText: (text) => background.push(text),
    },
  );

  assert.equal(result?.content, 'active final');
  assert.equal(result?.reasoningContent, null);
  assert.deepEqual(background, ['background pending']);
  assert.deepEqual(result?.backgroundTexts, ['background pending']);
});

test('does not let task-notification background metadata overwrite active diagnostics', () => {
  const result = parseStreamJsonLines([
    line({
      type: 'assistant',
      message: {
        model: 'active-model',
        stop_reason: 'active_stop',
        usage: { input_tokens: 7, cache_read_input_tokens: 3, output_tokens: 2 },
        content: [
          { type: 'tool_use', name: 'Read' },
          { type: 'thinking', text: 'active thinking' },
          { type: 'text', text: 'active progress' },
        ],
      },
    }),
    line({ type: 'result', result: 'active final' }),
    line({ type: 'user', origin: { kind: 'task-notification' }, message: { content: 'task complete' } }),
    line({
      type: 'assistant',
      message: {
        model: 'background-model',
        stop_reason: 'end_turn',
        usage: { input_tokens: 100, cache_read_input_tokens: 200, output_tokens: 300 },
        content: [
          { type: 'tool_use', name: 'Bash' },
          { type: 'thinking', text: 'background thinking' },
          { type: 'text', text: 'background done' },
        ],
      },
    }),
    line({ type: 'result', result: 'background result' }),
  ]);

  assert.equal(result?.content, 'active final');
  assert.equal(result?.reasoningContent, 'active thinking');
  assert.deepEqual(result?.backgroundTexts, ['background done']);
  assert.deepEqual(result?.diagnostics.toolsUsed, ['Read']);
  assert.equal(result?.diagnostics.inputTokens, 7);
  assert.equal(result?.diagnostics.cacheReadInputTokens, 3);
  assert.equal(result?.diagnostics.outputTokens, 2);
  assert.equal(result?.diagnostics.lastSubturnContextTokens, 10);
  assert.equal(result?.diagnostics.stopReason, 'active_stop');
});

test('ignores malformed lines, local command noise, unknown events, and missing final result', () => {
  assert.equal(
    parseStreamJsonLines([
      'tmux local noise',
      '{"type":',
      line({ type: 'unknown', payload: true }),
      line({ type: 'assistant', message: { content: [{ type: 'text', text: 'partial' }] } }),
    ]),
    null,
  );
});
