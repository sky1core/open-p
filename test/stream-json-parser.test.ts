import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { formatWorkerTurnResult } from '../src/core/output.js';
import { parseStreamJsonLines } from '../src/core/stream-json-parser.js';

function line(event: unknown): string {
  return JSON.stringify(event);
}

test('uses result event as result content and does not treat assistant text as reasoning', () => {
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
        result: 'result answer',
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

  assert.equal(result?.content, 'result answer');
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

test('parses openp streaming snapshots without replaying result assistant as intermediate text', () => {
  const intermediate: string[] = [];
  const result = parseStreamJsonLines(
    [
      line({
        openp: {
          version: 1,
          form: 'streaming',
          scope: 'active',
          output: { answer: 'A' },
          structuredOutput: null,
          metadata: {},
        },
      }),
      line({
        openp: {
          version: 1,
          form: 'streaming',
          scope: 'active',
          output: { answer: 'AB' },
          structuredOutput: null,
          metadata: {},
        },
      }),
      line({
        openp: {
          version: 1,
          form: 'result',
          scope: 'active',
          output: {
            answer: ['AB'],
            reasoning: [],
            toolCall: [],
            toolResult: [],
          },
          structuredOutput: null,
          metadata: {
            usage: {
              inputTokens: null,
              outputTokens: null,
              cacheReadInputTokens: null,
            },
            stopReason: 'end_turn',
            numTurns: 1,
            durationMs: 1,
            totalCostUsd: null,
          },
        },
      }),
    ],
    {
      onIntermediateText: (text) => intermediate.push(text),
    },
  );

  assert.equal(result?.content, 'AB');
  assert.deepEqual(intermediate, ['A', 'AB']);
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

test('publishes and preserves tool-use assistant text as answer text', () => {
  const intermediate: string[] = [];
  const result = parseStreamJsonLines(
    [
      line({
        type: 'assistant',
        message: {
          id: 'msg_tool',
          stop_reason: 'tool_use',
          content: [
            { type: 'text', text: '도구를 확인합니다.' },
            { type: 'tool_use', name: 'Read', input: {} },
          ],
        },
      }),
      line({
        type: 'assistant',
        message: {
          id: 'msg_final',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: '최종 답변입니다.' }],
        },
      }),
      line({ type: 'result', result: '최종 답변입니다.' }),
    ],
    {
      onIntermediateText: (text) => intermediate.push(text),
    },
  );

  assert.equal(result?.content, '최종 답변입니다.');
  assert.deepEqual(result?.diagnostics.toolsUsed, ['Read']);
  assert.deepEqual(intermediate, [
    '도구를 확인합니다.',
    '도구를 확인합니다.\n\n최종 답변입니다.',
  ]);
  const assistantEvents = result?.assistantEvents ?? [];
  assert.equal(assistantEvents.length, 2);
  assert.deepEqual(assistantTexts(assistantEvents), ['도구를 확인합니다.', '최종 답변입니다.']);
});

test('formats Claude stdout assistant text and terminal result without duplicate final answer', () => {
  const { openp } = openPFromClaudeFixture(
    'redacted-stdout-tool-use-result-repeat.jsonl',
    'turn-reference-shape',
  );

  assert.deepEqual(openp.output.answer, [
    '파일을 읽겠습니다.',
    '파일에는 `alpha=1`, `beta=2` 두 개의 키-값 쌍이 정의되어 있습니다.',
  ]);
  assert.deepEqual(openp.output.toolCall, [{
    type: 'tool_use',
    id: 'toolu_redacted_read',
    name: 'Read',
    input: { file_path: '/redacted/workspace/data/input.txt' },
    caller: { type: 'direct' },
  }]);
  assert.deepEqual(openp.output.toolResult, [{
    type: 'tool_result',
    toolUseId: 'toolu_redacted_read',
    content: '1\talpha=1\n2\tbeta=2\n3\t',
  }]);
});

test('formats redacted Claude long-answer stdout fixture as one complete result answer', () => {
  const { result, openp } = openPFromClaudeFixture(
    'redacted-stdout-long-answer-stream.jsonl',
    'turn-long-answer-reference',
  );

  assert.equal(openp.output.answer.length, 1);
  assert.equal(openp.output.answer[0], result.content);
  assert.equal(openp.output.answer[0].includes('## 7.'), true);
  assert.equal(openp.output.reasoning.length, 1);
  assert.equal(openp.output.toolCall.length, 0);
  assert.equal(openp.output.toolResult.length, 0);
});

test('formats redacted Claude structured-output stdout fixture without dropping tool metadata', () => {
  const { openp } = openPFromClaudeFixture(
    'redacted-stdout-structured-output.jsonl',
    'turn-structured-reference',
  );

  assert.equal(openp.output.answer.length, 1);
  assert.equal(openp.output.answer[0].includes('스키마에 맞는 JSON을 출력했습니다.'), true);
  assert.equal(openp.output.reasoning.length, 1);
  assert.deepEqual(openp.output.toolCall.map((toolCall: Record<string, unknown>) => toolCall.name), [
    'StructuredOutput',
  ]);
  assert.deepEqual(openp.output.toolResult, [{
    type: 'tool_result',
    toolUseId: 'toolu_redacted_01',
    content: 'Structured output provided successfully',
  }]);
  assert.deepEqual(Object.keys(openp.structuredOutput).sort(), [
    'answer',
    'checks',
    'sessionLog',
    'stdout',
  ]);
});

test('formats redacted Claude complex tool-use stdout fixture with all answers and tool results', () => {
  const { result, openp } = openPFromClaudeFixture(
    'redacted-stdout-tool-use-file-complex.jsonl',
    'turn-tool-use-reference',
  );

  assert.equal(openp.output.answer.length, 2);
  assert.equal(openp.output.answer[0], '`data/input.txt`를 읽고 `data/result.txt`를 생성한다.');
  assert.equal(openp.output.answer[1], result.content);
  assert.equal(openp.output.answer.filter((answer: string) => answer === result.content).length, 1);
  assert.equal(openp.output.reasoning.length, 1);
  assert.deepEqual(openp.output.toolCall.map((toolCall: Record<string, unknown>) => toolCall.name), [
    'Read',
    'Write',
  ]);
  assert.deepEqual(openp.output.toolResult.map((toolResult: Record<string, unknown>) => toolResult.toolUseId), [
    'toolu_redacted_01',
    'toolu_redacted_02',
  ]);
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

test('does not copy result answer echo into reasoning content', () => {
  const result = parseStreamJsonLines([
    line({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'result answer' }],
      },
    }),
    line({ type: 'result', result: 'result answer' }),
  ]);

  assert.equal(result?.content, 'result answer');
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
      line({ type: 'result', result: 'active result' }),
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

test('treats an empty result event as non-result lifecycle output', () => {
  assert.equal(parseStreamJsonLines([
    line({ type: 'result', result: '' }),
  ]), null);
});

test('treats a whitespace-only result event as non-result lifecycle output', () => {
  assert.equal(parseStreamJsonLines([
    line({ type: 'result', result: '   \n' }),
  ]), null);
});

test('does not treat explicit error result text as result content', () => {
  assert.equal(parseStreamJsonLines([
    line({
      type: 'result',
      subtype: 'error',
      is_error: true,
      api_error_status: 500,
      result: 'backend failed in result text',
      error: { message: 'backend failed' },
    }),
  ]), null);
});

test('does not treat each explicit error result signal as result content', () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly fields: Record<string, unknown>;
  }> = [
    { name: 'is_error', fields: { is_error: true } },
    { name: 'subtype', fields: { subtype: 'error' } },
    { name: 'api_error_status', fields: { api_error_status: 500 } },
    { name: 'error', fields: { error: { message: 'backend failed' } } },
  ];

  for (const item of cases) {
    assert.equal(
      parseStreamJsonLines([
        line({
          type: 'result',
          result: 'backend failed in result text',
          ...item.fields,
        }),
      ]),
      null,
      item.name,
    );
  }
});

test('ignores an empty lifecycle result before a later result', () => {
  const result = parseStreamJsonLines([
    line({ type: 'system', subtype: 'init', session_id: 'session-1' }),
    line({ type: 'system', subtype: 'compact_boundary' }),
    line({ type: 'result', session_id: 'session-1', result: '' }),
    line({
      type: 'assistant',
      session_id: 'session-1',
      message: {
        content: [{ type: 'text', text: 'result answer' }],
        stop_reason: 'end_turn',
      },
    }),
    line({ type: 'result', session_id: 'session-1', result: 'result answer' }),
  ]);

  assert.equal(result?.content, 'result answer');
  assert.equal(result?.sessionId, 'session-1');
});

test('does not let empty lifecycle result diagnostics override a later result', () => {
  const result = parseStreamJsonLines([
    line({ type: 'system', subtype: 'init', session_id: 'session-1' }),
    line({
      type: 'result',
      session_id: 'session-1',
      result: '',
      num_turns: 99,
      duration_ms: 999,
      total_cost_usd: 9,
      usage: { input_tokens: 100, output_tokens: 200, cache_read_input_tokens: 300 },
      stop_reason: 'lifecycle',
    }),
    line({
      type: 'assistant',
      session_id: 'session-1',
      message: {
        content: [{ type: 'text', text: 'result answer' }],
        stop_reason: 'end_turn',
      },
    }),
    line({
      type: 'result',
      session_id: 'session-1',
      result: 'result answer',
      num_turns: 1,
      duration_ms: 10,
      total_cost_usd: 0.01,
      usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3 },
      stop_reason: 'end_turn',
    }),
  ]);

  assert.equal(result?.content, 'result answer');
  assert.equal(result?.diagnostics.numTurns, 1);
  assert.equal(result?.diagnostics.durationMs, 10);
  assert.equal(result?.diagnostics.totalCostUsd, 0.01);
  assert.equal(result?.diagnostics.inputTokens, 1);
  assert.equal(result?.diagnostics.outputTokens, 2);
  assert.equal(result?.diagnostics.cacheReadInputTokens, 3);
  assert.equal(result?.diagnostics.stopReason, 'end_turn');
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
      line({ type: 'result', result: 'active result' }),
      line({ type: 'user', origin: { kind: 'task-notification' }, message: { content: 'task complete' } }),
      line({
        type: 'assistant',
        message: {
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'background done' }],
        },
      }),
      line({ type: 'result', result: 'must not replace active result' }),
    ],
    {
      onIntermediateText: (text) => intermediate.push(text),
      onBackgroundAssistantText: (text) => background.push(text),
    },
  );

  assert.equal(result?.content, 'active result');
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
    line({ type: 'result', result: 'active result', num_turns: 1 }),
  ]);

  assert.equal(result?.content, 'active result');
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
      line({ type: 'result', result: 'active result', num_turns: 1 }),
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

  assert.equal(result?.content, 'active result');
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
      line({ type: 'result', result: 'active result', num_turns: 1 }),
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

  assert.equal(result?.content, 'active result');
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
      result: 'active result',
      num_turns: 1,
      duration_ms: 123,
      total_cost_usd: 0.01,
    }),
  ]);

  assert.equal(result?.content, 'active result');
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
      result: 'active result',
      num_turns: 1,
      duration_ms: 123,
      total_cost_usd: 0.01,
    }),
  ]);

  assert.equal(result?.content, 'active result');
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
    line({ type: 'result', result: 'active result', num_turns: 1 }),
  ]);

  assert.equal(result?.content, 'active result');
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
      line({ type: 'result', result: 'active result' }),
    ],
    {
      onBackgroundAssistantText: (text) => background.push(text),
    },
  );

  assert.equal(result?.content, 'active result');
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
    line({ type: 'result', result: 'active result' }),
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

  assert.equal(result?.content, 'active result');
  assert.equal(result?.reasoningContent, 'active thinking');
  assert.deepEqual(result?.backgroundTexts, ['background done']);
  assert.deepEqual(result?.diagnostics.toolsUsed, ['Read']);
  assert.equal(result?.diagnostics.inputTokens, 7);
  assert.equal(result?.diagnostics.cacheReadInputTokens, 3);
  assert.equal(result?.diagnostics.outputTokens, 2);
  assert.equal(result?.diagnostics.lastSubturnContextTokens, 10);
  assert.equal(result?.diagnostics.stopReason, 'active_stop');
});

test('ignores malformed lines, local command noise, unknown events, and missing turn result', () => {
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

function assistantTexts(events: readonly { readonly message: Record<string, unknown> }[]): string[] {
  return events.flatMap((event) => {
    const content = event.message.content;
    if (!Array.isArray(content)) {
      return [];
    }
    return content.flatMap((block) => {
      if (!block || typeof block !== 'object' || Array.isArray(block)) {
        return [];
      }
      const item = block as Record<string, unknown>;
      return item.type === 'text' && typeof item.text === 'string' ? [item.text] : [];
    });
  });
}

function openPFromClaudeFixture(fileName: string, turnId: string) {
  const lines = readFileSync(`test/fixtures/claude/${fileName}`, 'utf8').trim().split('\n');
  const result = parseStreamJsonLines(lines);
  assert.ok(result);
  const openp = JSON.parse(formatWorkerTurnResult({
    ...result,
    sessionId: result.sessionId ?? '11111111-1111-4111-8111-111111111111',
  }, {
    turnId,
    backend: 'claude',
  })).openp;
  return { result, openp };
}

test('extracts contextWindow from result event modelUsage', () => {
  const result = parseStreamJsonLines([
    line({ type: 'system', subtype: 'init', session_id: 'session-1' }),
    line({
      type: 'assistant',
      message: {
        model: 'claude-sonnet-4-6',
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, cache_read_input_tokens: 0, output_tokens: 5 },
        content: [{ type: 'text', text: 'hello' }],
      },
    }),
    line({
      type: 'result',
      subtype: 'success',
      session_id: 'session-1',
      result: 'hello',
      num_turns: 1,
      duration_ms: 100,
      modelUsage: {
        'claude-sonnet-4-6': { contextWindow: 200_000, maxOutputTokens: 32_000 },
      },
    }),
  ]);
  assert.ok(result);
  assert.equal(result.diagnostics.contextWindow, 200_000);
});

test('extracts contextWindow from modelUsage with model suffix variant', () => {
  const result = parseStreamJsonLines([
    line({ type: 'system', subtype: 'init', session_id: 'session-1' }),
    line({
      type: 'assistant',
      message: {
        model: 'claude-opus-4-7',
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, cache_read_input_tokens: 0, output_tokens: 5 },
        content: [{ type: 'text', text: 'hello' }],
      },
    }),
    line({
      type: 'result',
      subtype: 'success',
      session_id: 'session-1',
      result: 'hello',
      num_turns: 1,
      duration_ms: 100,
      modelUsage: {
        'claude-opus-4-7[1m]': { contextWindow: 1_000_000, maxOutputTokens: 64_000 },
      },
    }),
  ]);
  assert.ok(result);
  assert.equal(result.diagnostics.contextWindow, 1_000_000);
});

test('contextWindow is null when backend does not provide modelUsage', () => {
  const result = parseStreamJsonLines([
    line({ type: 'system', subtype: 'init', session_id: 'session-1' }),
    line({
      type: 'result',
      subtype: 'success',
      session_id: 'session-1',
      result: 'hello',
      num_turns: 1,
      duration_ms: 100,
    }),
  ]);
  assert.ok(result);
  assert.equal(result.diagnostics.contextWindow, null);
});
