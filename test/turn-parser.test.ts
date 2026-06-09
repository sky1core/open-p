import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { extractClaudeCodeIntermediateContent, extractClaudeCodeIntermediateText, parseClaudeCodeJsonlTurn } from '../src/backends/claude/turn-parser.js';
import { EXIT_CODES, OpenPError } from '../src/core/errors.js';

const TURN_ID = 'turn-1';

test('parses a raw Claude Code turn from appended JSONL events', () => {
  const lines = [
    userLine('hello'),
    assistantLine([{ type: 'tool_use', name: 'Bash', id: 'toolu_1' }], {
      input_tokens: 10,
      cache_read_input_tokens: 20,
      output_tokens: 5,
    }),
    assistantLine([{ type: 'text', text: 'ok' }], {
      input_tokens: 11,
      cache_read_input_tokens: 21,
      output_tokens: 6,
    }, 'end_turn'),
    durationLine(1234),
  ];

  const result = parseClaudeCodeJsonlTurn(lines, TURN_ID);

  assert.deepEqual(result, {
    turnId: TURN_ID,
    text: 'ok',
    reasoningContent: null,
    assistantEvents: [
      {
        message: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'tool_use', name: 'Bash', id: 'toolu_1' }],
          stop_reason: null,
          stop_sequence: null,
          stop_details: null,
          usage: {
            input_tokens: 10,
            cache_read_input_tokens: 20,
            output_tokens: 5,
          },
          diagnostics: null,
          context_management: null,
        },
      },
      {
        message: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          stop_details: null,
          usage: {
            input_tokens: 11,
            cache_read_input_tokens: 21,
            output_tokens: 6,
          },
          diagnostics: null,
          context_management: null,
        },
      },
    ],
    diagnostics: {
      durationMs: 1234,
      stopReason: 'end_turn',
      toolsUsed: ['Bash'],
      usage: {
        inputTokens: 11,
        cacheReadInputTokens: 21,
        outputTokens: 6,
      },
      rawUsage: {
        input_tokens: 11,
        cache_read_input_tokens: 21,
        output_tokens: 6,
      },
      rawEventCount: 4,
    },
  });
});

test('uses final Claude usage iteration for last subturn usage', () => {
  const result = parseClaudeCodeJsonlTurn([
    userLine('hello'),
    assistantLine([{ type: 'text', text: 'ok' }], {
      input_tokens: 1,
      cache_read_input_tokens: 10,
      output_tokens: 1,
      iterations: [
        {
          type: 'message',
          input_tokens: 1,
          cache_read_input_tokens: 10,
          output_tokens: 125,
        },
      ],
    }, 'end_turn'),
    durationLine(10),
  ], TURN_ID);

  assert.deepEqual(result?.diagnostics.usage, {
    inputTokens: 1,
    cacheReadInputTokens: 10,
    outputTokens: 1,
  });
  assert.deepEqual(result?.diagnostics.lastSubturnUsage, {
    inputTokens: 1,
    cacheReadInputTokens: 10,
    outputTokens: 125,
  });
  assert.deepEqual(result?.diagnostics.rawUsage, {
    input_tokens: 1,
    cache_read_input_tokens: 10,
    output_tokens: 1,
    iterations: [
      {
        type: 'message',
        input_tokens: 1,
        cache_read_input_tokens: 10,
        output_tokens: 125,
      },
    ],
  });
});

test('does not reuse an earlier Claude usage iteration when final iteration has no token fields', () => {
  const result = parseClaudeCodeJsonlTurn([
    userLine('hello'),
    assistantLine([{ type: 'text', text: 'ok' }], {
      input_tokens: 3,
      cache_read_input_tokens: 4,
      output_tokens: 5,
      iterations: [
        {
          type: 'message',
          input_tokens: 99,
          cache_read_input_tokens: 88,
          output_tokens: 77,
        },
        {
          type: 'message',
          done: true,
        },
      ],
    }, 'end_turn'),
    durationLine(10),
  ], TURN_ID);

  assert.deepEqual(result?.diagnostics.usage, {
    inputTokens: 3,
    cacheReadInputTokens: 4,
    outputTokens: 5,
  });
  assert.equal(Object.prototype.hasOwnProperty.call(result?.diagnostics ?? {}, 'lastSubturnUsage'), false);
});

test('does not strip marker-looking assistant text', () => {
  const markerText = [
    'OPENP_FINAL_START id=turn-1 nonce=nonce-1',
    'literal',
    'OPENP_FINAL_END id=turn-1 nonce=nonce-1',
  ].join('\n');

  const result = parseClaudeCodeJsonlTurn([
    userLine('print these marker-looking strings'),
    assistantLine([{ type: 'text', text: markerText }], undefined, 'end_turn'),
    durationLine(10),
  ], TURN_ID);

  assert.equal(result?.text, markerText);
});

test('fails closed on Claude Code synthetic API error assistant events', () => {
  const lines = [
    userLine('generate image'),
    assistantLine([{ type: 'text', text: 'starting generation' }], undefined, 'tool_use'),
    claudeApiErrorAssistantLine(
      'Please run /login · API Error: 401 The socket connection was closed unexpectedly.',
      401,
      'authentication_failed',
    ),
    durationLine(10),
  ];

  assert.throws(
    () => parseClaudeCodeJsonlTurn(lines, TURN_ID),
    (error) =>
      error instanceof OpenPError &&
      error.exitCode === EXIT_CODES.backendExited &&
      error.message.includes('Claude Code API error for turn turn-1') &&
      error.message.includes('status 401') &&
      error.message.includes('authentication_failed'),
  );
  assert.equal(
    extractClaudeCodeIntermediateContent(lines, { includeTerminalAssistant: true }).text,
    'starting generation',
  );
});

test('returns null until completion metadata is present', () => {
  assert.equal(parseClaudeCodeJsonlTurn([
    userLine('hello'),
    assistantLine([{ type: 'text', text: 'ok' }], undefined, 'end_turn'),
  ], TURN_ID), null);
});

test('parses result assistant text appended after completion metadata', () => {
  const result = parseClaudeCodeJsonlTurn([
    userLine('hello'),
    assistantLine([{ type: 'thinking', thinking: 'working' }], undefined, 'end_turn'),
    durationLine(100),
    assistantLine([{ type: 'text', text: 'ok' }], undefined, 'end_turn'),
  ], TURN_ID);

  assert.equal(result?.text, 'ok');
  assert.equal(result?.diagnostics.durationMs, 100);
});

test('does not treat intermediate assistant text as reasoning when it differs from result answer', () => {
  const result = parseClaudeCodeJsonlTurn([
    userLine('hello'),
    assistantLine([{ type: 'text', text: 'working' }]),
    assistantLine([{ type: 'text', text: 'ok' }], undefined, 'end_turn'),
    durationLine(100),
  ], TURN_ID);

  assert.equal(result?.text, 'working\n\nok');
  assert.equal(result?.reasoningContent, null);
});

test('clears stale stop reason when later assistant snapshot omits it', () => {
  const result = parseClaudeCodeJsonlTurn([
    userLine('hello'),
    assistantLine([{ type: 'tool_use', name: 'Read' }], undefined, 'tool_use'),
    assistantLine([{ type: 'text', text: 'ok' }]),
    durationLine(100),
  ], TURN_ID);

  assert.equal(result?.text, 'ok');
  assert.equal(result?.diagnostics.stopReason, null);
});

test('replaces same-message assistant snapshot after a terminal stop marker', () => {
  const result = parseClaudeCodeJsonlTurn([
    userLine('hello'),
    assistantLine([{ type: 'text', text: 'hel' }], undefined, 'end_turn', undefined, undefined, 'msg_1'),
    assistantLine([{ type: 'text', text: 'hello' }], undefined, undefined, undefined, undefined, 'msg_1'),
    durationLine(100),
  ], TURN_ID);

  assert.equal(result?.text, 'hello');
});

test('resets intermediate text when a newer user turn appears in the observed segment', () => {
  const lines = [
    userLine('old'),
    assistantLine([{ type: 'text', text: 'old progress' }]),
    userLine('new'),
    assistantLine([{ type: 'text', text: 'new progress' }]),
  ];

  assert.equal(extractClaudeCodeIntermediateText(lines), 'new progress');
});

test('publishes the current JSONL assistant text as intermediate', () => {
  const lines = [
    userLine('hello'),
    assistantLine([{ type: 'text', text: 'could be final' }]),
  ];

  assert.equal(extractClaudeCodeIntermediateText(lines), 'could be final');
  assert.equal(parseClaudeCodeJsonlTurn([...lines, durationLine(100)], TURN_ID)?.text, 'could be final');
});

test('accumulates Claude Code session-log assistant text segments into result text', () => {
  const lines = [
    userLine('hello'),
    assistantLine([{ type: 'text', text: 'A' }]),
    assistantLine([{ type: 'text', text: 'B' }]),
    assistantLine([{ type: 'text', text: 'C' }], undefined, 'end_turn'),
  ];

  assert.equal(extractClaudeCodeIntermediateContent(lines, { includeTerminalAssistant: true }).text, 'A\n\nB\n\nC');
  assert.equal(parseClaudeCodeJsonlTurn([...lines, durationLine(100)], TURN_ID)?.text, 'A\n\nB\n\nC');
});

test('replaces cumulative Claude Code session-log assistant text snapshots', () => {
  const lines = [
    userLine('hello'),
    assistantLine([{ type: 'text', text: 'A' }], undefined, undefined, undefined, undefined, 'msg-one'),
    assistantLine([{ type: 'text', text: 'A\n\nB' }], undefined, undefined, undefined, undefined, 'msg-one'),
    assistantLine([{ type: 'text', text: 'A\n\nB\n\nC' }], undefined, 'end_turn', undefined, undefined, 'msg-one'),
  ];

  assert.equal(extractClaudeCodeIntermediateContent(lines, { includeTerminalAssistant: true }).text, 'A\n\nB\n\nC');
  assert.equal(parseClaudeCodeJsonlTurn([...lines, durationLine(100)], TURN_ID)?.text, 'A\n\nB\n\nC');
});

test('keeps idless prefix-compatible Claude Code assistant segments separate', () => {
  const lines = [
    userLine('hello'),
    assistantLine([{ type: 'text', text: 'A' }]),
    assistantLine([{ type: 'text', text: 'A again' }]),
    assistantLine([{ type: 'text', text: 'C' }], undefined, 'end_turn'),
  ];

  assert.equal(parseClaudeCodeJsonlTurn([...lines, durationLine(100)], TURN_ID)?.text, 'A\n\nA again\n\nC');
});

test('keeps idless newline-prefix-compatible Claude Code assistant segments separate', () => {
  const lines = [
    userLine('hello'),
    assistantLine([{ type: 'text', text: 'A' }]),
    assistantLine([{ type: 'text', text: 'A\n\nB' }]),
  ];

  assert.equal(parseClaudeCodeJsonlTurn([...lines, durationLine(100)], TURN_ID)?.text, 'A\n\nA\n\nB');
});

test('replaces prior same-message Claude Code tool-use answer snapshot without dropping it', () => {
  const lines = [
    userLine('hello'),
    assistantLine([{ type: 'text', text: '도구를' }], undefined, undefined, undefined, undefined, 'msg-tool'),
    assistantLine([
      { type: 'text', text: '도구를 확인합니다.' },
      { type: 'tool_use', name: 'Read', id: 'toolu_1', input: { file_path: 'a.txt' } },
    ], undefined, 'tool_use', undefined, undefined, 'msg-tool'),
    assistantLine([{ type: 'text', text: '최종 답변입니다.' }], undefined, 'end_turn', undefined, undefined, 'msg-final'),
    durationLine(100),
  ];

  assert.equal(parseClaudeCodeJsonlTurn(lines, TURN_ID)?.text, '도구를 확인합니다.\n\n최종 답변입니다.');
  assert.equal(
    extractClaudeCodeIntermediateContent(lines, { includeTerminalAssistant: true }).text,
    '도구를 확인합니다.\n\n최종 답변입니다.',
  );
});

test('treats terminal Claude Code assistant text as a boundary before later text', () => {
  const lines = [
    userLine('hello'),
    assistantLine([{ type: 'text', text: 'A' }], undefined, 'end_turn'),
    assistantLine([{ type: 'text', text: 'A again' }]),
  ];

  assert.equal(parseClaudeCodeJsonlTurn([...lines, durationLine(100)], TURN_ID)?.text, 'A\n\nA again');
});

test('keeps duplicate Claude Code assistant text after a terminal boundary', () => {
  const lines = [
    userLine('hello'),
    assistantLine([{ type: 'text', text: 'A' }], undefined, 'end_turn', undefined, undefined, 'msg-one'),
    assistantLine([{ type: 'text', text: 'A' }], undefined, undefined, undefined, undefined, 'msg-two'),
  ];

  assert.equal(parseClaudeCodeJsonlTurn([...lines, durationLine(100)], TURN_ID)?.text, 'A\n\nA');
});

test('replaces duplicate Claude Code assistant metadata snapshots for the same message id', () => {
  const lines = [
    userLine('hello'),
    assistantLine([{ type: 'text', text: 'A' }], undefined, undefined, undefined, undefined, 'msg-one'),
    assistantLine([{ type: 'text', text: 'A' }], undefined, 'end_turn', undefined, undefined, 'msg-one'),
    assistantLine([{ type: 'text', text: 'A\n\nB' }], undefined, undefined, undefined, undefined, 'msg-one'),
  ];

  assert.equal(parseClaudeCodeJsonlTurn([...lines, durationLine(100)], TURN_ID)?.text, 'A\n\nB');
});

test('accumulates intermediate reasoning across assistant subturns', () => {
  const lines = [
    userLine('hello'),
    assistantLine([{ type: 'thinking', thinking: 'think A' }]),
    assistantLine([{ type: 'reasoning', summary: [{ text: 'think B' }] }]),
  ];

  assert.deepEqual(extractClaudeCodeIntermediateContent(lines), {
    text: null,
    reasoningText: 'think A\n\nthink B',
    reasoningContentBlocks: [
      { type: 'thinking', thinking: 'think A' },
      { type: 'reasoning', summary: [{ text: 'think B' }] },
    ],
    assistantSnapshot: {
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
  });
});

test('does not mix task-notification assistant text into the active turn result', () => {
  const lines = [
    userLine('hello', 'active-user'),
    assistantLine([{ type: 'text', text: 'working' }], undefined, undefined, 'assistant-progress', 'active-user'),
    taskNotificationLine('task complete', 'background-user', 'assistant-progress'),
    assistantLine([{ type: 'text', text: 'background done' }], undefined, 'end_turn', 'background-assistant', 'background-user'),
    assistantLine([{ type: 'text', text: 'ok' }], undefined, 'end_turn', 'assistant-final', 'assistant-progress'),
    durationLine(100),
  ];

  const result = parseClaudeCodeJsonlTurn(lines, TURN_ID);

  assert.equal(result?.text, 'working\n\nok');
  assert.equal(result?.reasoningContent, null);
  assert.equal(extractClaudeCodeIntermediateText(lines), null);
});

test('keeps active result when task-notification background has parent uuid linkage', () => {
  const result = parseClaudeCodeJsonlTurn([
    userLine('hello', 'user-1'),
    assistantLine([{ type: 'text', text: 'working' }], undefined, undefined, 'assistant-progress', 'user-1'),
    taskNotificationLine('background task complete', 'background-user', 'assistant-progress'),
    assistantLine([{ type: 'text', text: 'active result' }], undefined, 'end_turn', 'assistant-final', 'assistant-progress'),
    assistantLine([{ type: 'text', text: 'background done' }], undefined, 'end_turn', 'background-assistant', 'background-user'),
    durationLine(100),
  ], TURN_ID);

  assert.equal(result?.text, 'working\n\nactive result');
  assert.equal(result?.reasoningContent, null);
});

test('keeps parentless active result after a linked background task has ended', () => {
  const result = parseClaudeCodeJsonlTurn([
    userLine('hello', 'user-1'),
    assistantLine([{ type: 'text', text: 'working' }], undefined, undefined, 'assistant-progress', 'user-1'),
    taskNotificationLine('background task complete', 'background-user', 'assistant-progress'),
    assistantLine([{ type: 'text', text: 'background done' }], undefined, 'end_turn', 'background-assistant', 'background-user'),
    assistantLine([{ type: 'text', text: 'active result' }], undefined, 'end_turn'),
    durationLine(100),
  ], TURN_ID);

  assert.equal(result?.text, 'working\n\nactive result');
  assert.equal(result?.reasoningContent, null);
  assert.equal(extractClaudeCodeIntermediateText([
    userLine('hello', 'user-1'),
    assistantLine([{ type: 'text', text: 'working' }], undefined, undefined, 'assistant-progress', 'user-1'),
    taskNotificationLine('background task complete', 'background-user', 'assistant-progress'),
    assistantLine([{ type: 'text', text: 'background done' }], undefined, 'end_turn', 'background-assistant', 'background-user'),
    assistantLine([{ type: 'text', text: 'active result' }], undefined, 'end_turn'),
  ]), null);
});

test('synthetic no-response assistant can close a linked background task without becoming active text', () => {
  const result = parseClaudeCodeJsonlTurn([
    userLine('hello', 'user-1'),
    assistantLine([{ type: 'text', text: 'working' }], undefined, undefined, 'assistant-progress', 'user-1'),
    taskNotificationLine('background task complete', 'background-user', 'assistant-progress'),
    JSON.stringify({
      type: 'assistant',
      parentUuid: 'background-user',
      message: {
        model: '<synthetic>',
        content: [{ type: 'text', text: 'No response requested.' }],
        stop_reason: 'stop_sequence',
        stop_sequence: '',
      },
    }),
    assistantLine([{ type: 'text', text: 'active result' }], undefined, 'end_turn'),
    durationLine(100),
  ], TURN_ID);

  assert.equal(result?.text, 'working\n\nactive result');
  assert.equal(result?.reasoningContent, null);
});

test('keeps a real Claude no-response answer when it is not synthetic', () => {
  const result = parseClaudeCodeJsonlTurn([
    userLine('hello'),
    assistantLine([{ type: 'text', text: 'No response requested.' }], undefined, 'end_turn'),
    durationLine(10),
  ], TURN_ID);

  assert.equal(result?.text, 'No response requested.');
});

test('fails closed when task-notification ordering is ambiguous without uuid linkage', () => {
  assert.throws(
    () => parseClaudeCodeJsonlTurn([
      userLine('hello'),
      assistantLine([{ type: 'text', text: 'working' }]),
      JSON.stringify({
        type: 'user',
        origin: { kind: 'task-notification' },
        message: { content: 'task complete' },
      }),
      assistantLine([{ type: 'text', text: 'maybe active result' }], undefined, 'end_turn'),
      durationLine(100),
    ], TURN_ID),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.protocolViolation,
  );
});

test('fails closed instead of returning background text when parentless active/background order is ambiguous', () => {
  assert.throws(
    () => parseClaudeCodeJsonlTurn([
      userLine('hello'),
      taskNotificationLine('background task complete', 'background-user'),
      assistantLine([{ type: 'text', text: 'active result' }], undefined, 'end_turn'),
      assistantLine([{ type: 'text', text: 'background done' }], undefined, 'end_turn'),
      durationLine(100),
    ], TURN_ID),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.protocolViolation,
  );
});

test('fails closed when turn duration arrives while an unlinked task-notification is unresolved', () => {
  assert.throws(
    () => parseClaudeCodeJsonlTurn([
      userLine('hello'),
      assistantLine([{ type: 'text', text: 'working' }]),
      taskNotificationLine('background task complete'),
      durationLine(100),
    ], TURN_ID),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.protocolViolation,
  );
});

test('fails closed when parentless task-notification text has no end-turn marker yet', () => {
  assert.throws(
    () => parseClaudeCodeJsonlTurn([
      userLine('hello'),
      taskNotificationLine('background task complete'),
      assistantLine([{ type: 'text', text: 'parentless first text' }]),
      assistantLine([{ type: 'text', text: 'parentless second text' }], undefined, 'end_turn'),
      durationLine(100),
    ], TURN_ID),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.protocolViolation,
  );
});

test('captures Claude Code StructuredOutput tool input for json-schema output', () => {
  const result = parseClaudeCodeJsonlTurn([
    userLine('hello'),
    assistantLine([
      {
        type: 'tool_use',
        id: 'toolu_1',
        name: 'StructuredOutput',
        input: { ok: true, label: 'OPENP_SCHEMA' },
      },
    ]),
    assistantLine([{ type: 'text', text: 'done' }], undefined, 'end_turn'),
    durationLine(10),
  ], TURN_ID);

  assert.deepEqual(result?.structuredOutput, { ok: true, label: 'OPENP_SCHEMA' });
  assert.deepEqual(result?.diagnostics.toolsUsed, ['StructuredOutput']);
});

test('preserves Claude Code request id for public assistant event output', () => {
  const result = parseClaudeCodeJsonlTurn([
    userLine('hello'),
    JSON.stringify({
      type: 'assistant',
      requestId: 'req_abc123',
      message: {
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
      },
    }),
    durationLine(10),
  ], TURN_ID);

  assert.equal(result?.requestId, 'req_abc123');
});

test('uses StructuredOutput-only tool input as result text when no assistant text exists', () => {
  const result = parseClaudeCodeJsonlTurn([
    userLine('hello'),
    assistantLine([
      {
        type: 'tool_use',
        id: 'toolu_1',
        name: 'StructuredOutput',
        input: { ok: true },
      },
    ], undefined, 'end_turn'),
    durationLine(10),
  ], TURN_ID, { structuredOutputRequested: true });

  assert.equal(result?.text, '{"ok":true}');
  assert.deepEqual(result?.structuredOutput, { ok: true });
});

test('uses StructuredOutput-only active result during linked background interleave', () => {
  const result = parseClaudeCodeJsonlTurn([
    userLine('hello', 'user-1'),
    taskNotificationLine('background task complete', 'background-user', 'user-1'),
    assistantLine([
      {
        type: 'tool_use',
        id: 'toolu_1',
        name: 'StructuredOutput',
        input: { ok: true },
      },
    ], undefined, 'end_turn', 'assistant-final', 'user-1'),
    durationLine(10),
  ], TURN_ID, { structuredOutputRequested: true });

  assert.equal(result?.text, '{"ok":true}');
  assert.deepEqual(result?.structuredOutput, { ok: true });
});

test('parses result text as structured output when schema mode has no StructuredOutput tool event', () => {
  const result = parseClaudeCodeJsonlTurn([
    userLine('hello'),
    assistantLine([{ type: 'text', text: '{"ok":true}' }], undefined, 'end_turn'),
    durationLine(10),
  ], TURN_ID, { structuredOutputRequested: true });

  assert.deepEqual(result?.structuredOutput, { ok: true });
});

test('parses a single fenced json result text as structured output in schema mode', () => {
  const result = parseClaudeCodeJsonlTurn([
    userLine('hello'),
    assistantLine([{ type: 'text', text: '```json\n{"ok":true}\n```' }], undefined, 'end_turn'),
    durationLine(10),
  ], TURN_ID, { structuredOutputRequested: true });

  assert.deepEqual(result?.structuredOutput, { ok: true });
});

test('extracts fenced json preceded by prose as structured output fallback', () => {
  const result = parseClaudeCodeJsonlTurn([
    userLine('hello'),
    assistantLine([{ type: 'text', text: 'Here is the result:\n```json\n{"ok":true}\n```' }], undefined, 'end_turn'),
    durationLine(10),
  ], TURN_ID, { structuredOutputRequested: true });

  assert.deepEqual(result?.structuredOutput, { ok: true });
});

test('extracts JSON after accumulated assistant prose in structured output fallback', () => {
  const result = parseClaudeCodeJsonlTurn([
    userLine('hello'),
    assistantLine([{ type: 'text', text: 'Let me check the code...' }], undefined, undefined, 'msg-1'),
    assistantLine([{ type: 'text', text: 'Analysis complete.\n{"ok":true}' }], undefined, 'end_turn', 'msg-2'),
    durationLine(10),
  ], TURN_ID, { structuredOutputRequested: true });

  assert.deepEqual(result?.structuredOutput, { ok: true });
});

test('extracts JSON from last assistant text block when earlier blocks are prose', () => {
  const result = parseClaudeCodeJsonlTurn([
    userLine('hello'),
    assistantLine([{ type: 'text', text: 'Exploring the codebase...' }], undefined, undefined, 'msg-1'),
    assistantLine([{ type: 'text', text: 'Running checks...' }], undefined, undefined, 'msg-2'),
    assistantLine([{ type: 'text', text: '{"ok":true}' }], undefined, 'end_turn', 'msg-3'),
    durationLine(10),
  ], TURN_ID, { structuredOutputRequested: true });

  assert.deepEqual(result?.structuredOutput, { ok: true });
});

test('fails closed when schema mode result text is not valid JSON and no StructuredOutput tool event exists', () => {
  assert.throws(
    () => parseClaudeCodeJsonlTurn([
      userLine('hello'),
      assistantLine([{ type: 'text', text: 'not json' }], undefined, 'end_turn'),
      durationLine(10),
    ], TURN_ID, { structuredOutputRequested: true }),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.protocolViolation,
  );
});

test('fails closed when structured output does not match the requested schema', () => {
  assert.throws(
    () => parseClaudeCodeJsonlTurn([
      userLine('hello'),
      assistantLine([{ type: 'text', text: '{"ok":"wrong"}' }], undefined, 'end_turn'),
      durationLine(10),
    ], TURN_ID, {
      structuredOutputRequested: true,
      jsonSchema: {
        type: 'object',
        properties: { ok: { type: 'boolean' } },
        required: ['ok'],
        additionalProperties: false,
      },
    }),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.protocolViolation,
  );
});

test('preserves Claude Code thinking and reasoning blocks', () => {
  const result = parseClaudeCodeJsonlTurn([
    userLine('hello'),
    assistantLine([
      { type: 'thinking', text: 'think block' },
      { type: 'reasoning', summary: [{ text: 'reason summary' }] },
    ]),
    assistantLine([{ type: 'text', text: 'ok' }], undefined, 'end_turn'),
    durationLine(100),
  ], TURN_ID);

  assert.equal(result?.reasoningContent, 'think block\n\nreason summary');
});

test('replaces cumulative Claude Code reasoning snapshots without duplicating earlier thinking', () => {
  const lines = [
    userLine('hello'),
    assistantLine([{ type: 'thinking', thinking: 'think A' }]),
    assistantLine([{ type: 'thinking', thinking: 'think A\n\nthink B' }]),
    assistantLine([{ type: 'text', text: 'ok' }], undefined, 'end_turn'),
    durationLine(100),
  ];

  const result = parseClaudeCodeJsonlTurn(lines, TURN_ID);
  const intermediate = extractClaudeCodeIntermediateContent(lines, {
    includeTerminalAssistant: true,
  });

  assert.equal(result?.reasoningContent, 'think A\n\nthink B');
  assert.equal(intermediate.reasoningText, 'think A\n\nthink B');
  assert.deepEqual(intermediate.reasoningContentBlocks, [
    { type: 'thinking', thinking: 'think A\n\nthink B' },
  ]);
});

test('replaces same-message reasoning snapshots by message id without duplicating earlier reasoning segments', () => {
  const lines = [
    liveShapeUserLine('40000000-0000-4000-8000-000000000001', 'use a tool, then answer'),
    liveShapeAssistantLine({
      messageId: 'msg_01FirstThinkSegmentAAAA',
      parentUuid: '40000000-0000-4000-8000-000000000001',
      uuid: '40000000-0000-4000-8000-000000000002',
      stopReason: 'tool_use',
      content: [{ type: 'thinking', thinking: 'first think', signature: 'sig-first' }],
    }),
    liveShapeAssistantLine({
      messageId: 'msg_01FirstThinkSegmentAAAA',
      parentUuid: '40000000-0000-4000-8000-000000000002',
      uuid: '40000000-0000-4000-8000-000000000003',
      stopReason: 'tool_use',
      content: [{ type: 'tool_use', id: 'toolu_01ReasoningDedup00001', name: 'Bash', input: { command: 'true' } }],
    }),
    liveShapeToolResultLine({
      parentUuid: '40000000-0000-4000-8000-000000000003',
      uuid: '40000000-0000-4000-8000-000000000004',
      toolUseId: 'toolu_01ReasoningDedup00001',
      content: 'ok',
    }),
    liveShapeAssistantLine({
      messageId: 'msg_01SecondThinkSegmentBBB',
      parentUuid: '40000000-0000-4000-8000-000000000004',
      uuid: '40000000-0000-4000-8000-000000000005',
      stopReason: null,
      content: [{ type: 'thinking', thinking: 'second A', signature: 'sig-second' }],
    }),
    liveShapeAssistantLine({
      messageId: 'msg_01SecondThinkSegmentBBB',
      parentUuid: '40000000-0000-4000-8000-000000000005',
      uuid: '40000000-0000-4000-8000-000000000006',
      stopReason: null,
      content: [{ type: 'thinking', thinking: 'second A\n\nsecond B', signature: 'sig-second' }],
    }),
    liveShapeAssistantLine({
      messageId: 'msg_01SecondThinkSegmentBBB',
      parentUuid: '40000000-0000-4000-8000-000000000006',
      uuid: '40000000-0000-4000-8000-000000000007',
      stopReason: 'end_turn',
      content: [{ type: 'text', text: 'final answer' }],
    }),
    liveShapeDurationLine(1500, '40000000-0000-4000-8000-000000000008'),
  ];

  const result = parseClaudeCodeJsonlTurn(lines, TURN_ID);
  const intermediate = extractClaudeCodeIntermediateContent(lines, {
    includeTerminalAssistant: true,
  });

  assert.equal(result?.text, 'final answer');
  assert.equal(result?.reasoningContent, 'first think\n\nsecond A\n\nsecond B');
  assert.equal(intermediate.text, 'final answer');
  assert.equal(intermediate.reasoningText, 'first think\n\nsecond A\n\nsecond B');
  assert.deepEqual(intermediate.reasoningContentBlocks, [
    { type: 'thinking', thinking: 'first think', signature: 'sig-first' },
    { type: 'thinking', thinking: 'second A\n\nsecond B', signature: 'sig-second' },
  ]);
});

test('keeps reasoning from a new message id as a separate segment even when it starts with earlier reasoning text', () => {
  const lines = [
    liveShapeUserLine('50000000-0000-4000-8000-000000000001', 'think twice'),
    liveShapeAssistantLine({
      messageId: 'msg_01OverMergeGuardAAAAAAA',
      parentUuid: '50000000-0000-4000-8000-000000000001',
      uuid: '50000000-0000-4000-8000-000000000002',
      stopReason: null,
      content: [{ type: 'thinking', thinking: 'alpha', signature: 'sig-a' }],
    }),
    liveShapeAssistantLine({
      messageId: 'msg_01OverMergeGuardBBBBBBB',
      parentUuid: '50000000-0000-4000-8000-000000000002',
      uuid: '50000000-0000-4000-8000-000000000003',
      stopReason: null,
      content: [{ type: 'thinking', thinking: 'alpha beta', signature: 'sig-b' }],
    }),
    liveShapeAssistantLine({
      messageId: 'msg_01OverMergeGuardBBBBBBB',
      parentUuid: '50000000-0000-4000-8000-000000000003',
      uuid: '50000000-0000-4000-8000-000000000004',
      stopReason: 'end_turn',
      content: [{ type: 'text', text: 'ok' }],
    }),
    liveShapeDurationLine(900, '50000000-0000-4000-8000-000000000005'),
  ];

  const result = parseClaudeCodeJsonlTurn(lines, TURN_ID);
  const intermediate = extractClaudeCodeIntermediateContent(lines, {
    includeTerminalAssistant: true,
  });

  assert.equal(result?.reasoningContent, 'alpha\n\nalpha beta');
  assert.equal(intermediate.reasoningText, 'alpha\n\nalpha beta');
  assert.deepEqual(intermediate.reasoningContentBlocks, [
    { type: 'thinking', thinking: 'alpha', signature: 'sig-a' },
    { type: 'thinking', thinking: 'alpha beta', signature: 'sig-b' },
  ]);
});

test('preserves Claude Code reasoning block whitespace', () => {
  const result = parseClaudeCodeJsonlTurn([
    userLine('hello'),
    assistantLine([
      { type: 'thinking', text: '  think block\n' },
      { type: 'text', text: 'ok' },
    ], {}),
    durationLine(1),
  ], TURN_ID);

  assert.equal(result?.reasoningContent, '  think block\n');
});

test('parses a redacted live Claude Code JSONL fixture', async () => {
  const text = await readFile(new URL('./fixtures/claude/redacted-live-turn.jsonl', import.meta.url), 'utf8');
  const lines = text.trimEnd().split('\n');

  const result = parseClaudeCodeJsonlTurn(lines, 'fixture-turn');

  assert.equal(result?.text, 'openp-fixture-ok');
  assert.equal(result?.reasoningContent, null);
  assert.deepEqual(result?.diagnostics.usage, {
    inputTokens: 6,
    cacheReadInputTokens: 0,
    outputTokens: 139,
  });
  assert.equal(result?.diagnostics.durationMs, 3107);
});

test('parses last subturn usage from a redacted Claude Code usage-iterations fixture', async () => {
  const text = await readFile(
    new URL('./fixtures/claude/redacted-live-turn-usage-iterations.jsonl', import.meta.url),
    'utf8',
  );
  const lines = text.trimEnd().split('\n');

  const result = parseClaudeCodeJsonlTurn(lines, 'fixture-usage-iterations-turn');

  assert.equal(result?.text, 'usage-iterations-ok');
  assert.deepEqual(result?.diagnostics.usage, {
    inputTokens: 5,
    cacheReadInputTokens: 3000,
    outputTokens: 500,
  });
  assert.deepEqual(result?.diagnostics.lastSubturnUsage, {
    inputTokens: 1,
    cacheReadInputTokens: 2800,
    outputTokens: 125,
  });
  assert.equal(result?.diagnostics.durationMs, 3000);
});

test('parses a redacted Claude Code reasoning fixture variant', async () => {
  const text = await readFile(new URL('./fixtures/claude/redacted-reasoning-variant.jsonl', import.meta.url), 'utf8');
  const lines = text.trimEnd().split('\n');

  const result = parseClaudeCodeJsonlTurn(lines, 'fixture-reasoning-turn');

  assert.equal(result?.text, 'reasoning-fixture-ok');
  assert.equal(result?.reasoningContent, 'think block\n\nreason summary');
  assert.deepEqual(result?.diagnostics.usage, {
    inputTokens: 8,
    cacheReadInputTokens: 4,
    outputTokens: 120,
  });
  assert.equal(result?.diagnostics.durationMs, 2222);
});

test('fails closed on an unlinked redacted Claude Code task-notification fixture variant', async () => {
  const text = await readFile(new URL('./fixtures/claude/redacted-task-notification-variant.jsonl', import.meta.url), 'utf8');
  const lines = text.trimEnd().split('\n');

  assert.throws(
    () => parseClaudeCodeJsonlTurn(lines, 'fixture-task-turn'),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.protocolViolation,
  );
  assert.equal(extractClaudeCodeIntermediateText(lines), null);
});

test('fails when one scoped Claude segment contains multiple caller user turns', () => {
  assert.throws(
    () => parseClaudeCodeJsonlTurn([
      userLine('first line'),
      userLine('second line'),
      assistantLine([{ type: 'text', text: 'partial answer' }], undefined, 'end_turn'),
      durationLine(10),
    ], TURN_ID),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.protocolViolation,
  );
});

test('does not treat tool_result, meta, or local command user events as caller turns', () => {
  const result = parseClaudeCodeJsonlTurn([
    userLine('run tool'),
    assistantLine([{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'a.txt' } }], undefined, 'tool_use'),
    JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'tool output' }],
      },
    }),
    JSON.stringify({
      type: 'user',
      isMeta: true,
      promptId: 'local-command-1',
      message: {
        role: 'user',
        content: [{ type: 'text', text: '<local-command-caveat>generated while running local commands</local-command-caveat>' }],
      },
    }),
    JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: '/exit',
      },
    }),
    JSON.stringify({
      type: 'system',
      subtype: 'compact_boundary',
      content: 'Conversation compacted',
    }),
    JSON.stringify({
      type: 'user',
      isCompactSummary: true,
      message: {
        role: 'user',
        content: 'This session is being continued from a previous conversation that ran out of context.',
      },
    }),
    JSON.stringify({
      type: 'user',
      promptId: 'local-command-1',
      message: {
        role: 'user',
        content: '<command-name>/compact</command-name>\n<command-message>compact</command-message>',
      },
    }),
    JSON.stringify({
      type: 'user',
      promptId: 'local-command-1',
      message: {
        role: 'user',
        content: '<local-command-stdout>Compacted (ctrl+o to see full summary)</local-command-stdout>',
      },
    }),
    assistantLine([{ type: 'text', text: 'result answer' }], undefined, 'end_turn'),
    durationLine(10),
  ], TURN_ID);

  assert.equal(result?.text, 'result answer');
  assert.equal(result?.assistantEvents?.length, 3);
  const toolResultContent = result?.assistantEvents?.[1]?.message.content as any[];
  assert.equal(toolResultContent[0].type, 'tool_result');
  assert.equal(toolResultContent[0].tool_use_id, 'toolu_1');
  assert.equal(toolResultContent[0].content, 'tool output');
});

test('treats local-command-looking prompt text as caller input without local-command caveat linkage', () => {
  const result = parseClaudeCodeJsonlTurn([
    userLine('<command-name>/compact</command-name>\n<command-message>compact</command-message>'),
    assistantLine([{ type: 'text', text: 'literal prompt handled' }], undefined, 'end_turn'),
    durationLine(10),
  ], TURN_ID);

  assert.equal(result?.text, 'literal prompt handled');
});

test('treats prompt-id local-command-looking prompt text as caller input without caveat linkage', () => {
  const result = parseClaudeCodeJsonlTurn([
    JSON.stringify({
      type: 'user',
      promptId: 'caller-prompt-id',
      message: {
        role: 'user',
        content: '<command-name>/compact</command-name>\n<command-message>compact</command-message>',
      },
    }),
    assistantLine([{ type: 'text', text: 'literal prompt with prompt id handled' }], undefined, 'end_turn'),
    durationLine(10),
  ], TURN_ID);

  assert.equal(result?.text, 'literal prompt with prompt id handled');
});

function userLine(content: string, uuid?: string, parentUuid?: string): string {
  return JSON.stringify({
    type: 'user',
    ...(uuid ? { uuid } : {}),
    ...(parentUuid ? { parentUuid } : {}),
    message: {
      role: 'user',
      content,
    },
  });
}

function taskNotificationLine(content: string, uuid?: string, parentUuid?: string): string {
  return JSON.stringify({
    type: 'user',
    ...(uuid ? { uuid } : {}),
    ...(parentUuid ? { parentUuid } : {}),
    origin: { kind: 'task-notification' },
    message: {
      role: 'user',
      content,
    },
  });
}

function assistantLine(
  content: readonly Record<string, unknown>[],
  usage?: Record<string, unknown>,
  stopReason?: string,
  uuid?: string,
  parentUuid?: string,
  messageId?: string,
): string {
  return JSON.stringify({
    type: 'assistant',
    ...(uuid ? { uuid } : {}),
    ...(parentUuid ? { parentUuid } : {}),
    message: {
      ...(messageId ? { id: messageId } : {}),
      ...(usage ? { usage } : {}),
      ...(stopReason ? { stop_reason: stopReason } : {}),
      content,
    },
  });
}

function claudeApiErrorAssistantLine(text: string, status: number, error: string): string {
  return JSON.stringify({
    type: 'assistant',
    error,
    isApiErrorMessage: true,
    apiErrorStatus: status,
    message: {
      model: '<synthetic>',
      role: 'assistant',
      stop_reason: 'stop_sequence',
      content: [{ type: 'text', text }],
      usage: {
        input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 0,
      },
    },
  });
}

function durationLine(durationMs: number): string {
  return JSON.stringify({
    type: 'system',
    subtype: 'turn_duration',
    durationMs,
  });
}

// Line builders below follow the live Claude Code session-log event shape recorded in
// .agents/references/full-suite/20260524-195248/cases/claude-sonnet-4-6/*/claude-session-log.jsonl.
const LIVE_SHAPE_SESSION_ID = '30000000-0000-4000-8000-000000000000';

function liveShapeUserLine(uuid: string, content: string): string {
  return JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    type: 'user',
    message: { role: 'user', content },
    uuid,
    timestamp: '2026-06-10T00:00:00.000Z',
    userType: 'external',
    cwd: '/redacted/workspace',
    sessionId: LIVE_SHAPE_SESSION_ID,
    version: '2.1.150',
    gitBranch: 'main',
  });
}

function liveShapeAssistantLine(options: {
  readonly messageId: string;
  readonly parentUuid: string;
  readonly uuid: string;
  readonly stopReason: string | null;
  readonly content: readonly Record<string, unknown>[];
}): string {
  return JSON.stringify({
    parentUuid: options.parentUuid,
    isSidechain: false,
    message: {
      model: 'claude-sonnet-4-6',
      id: options.messageId,
      type: 'message',
      role: 'assistant',
      content: options.content,
      stop_reason: options.stopReason,
      stop_sequence: null,
      usage: { input_tokens: 3, cache_read_input_tokens: 100, output_tokens: 50 },
    },
    requestId: 'req_011LiveShapeReasoning',
    type: 'assistant',
    uuid: options.uuid,
    timestamp: '2026-06-10T00:00:01.000Z',
    userType: 'external',
    cwd: '/redacted/workspace',
    sessionId: LIVE_SHAPE_SESSION_ID,
    version: '2.1.150',
    gitBranch: 'main',
  });
}

function liveShapeToolResultLine(options: {
  readonly parentUuid: string;
  readonly uuid: string;
  readonly toolUseId: string;
  readonly content: string;
}): string {
  return JSON.stringify({
    parentUuid: options.parentUuid,
    isSidechain: false,
    type: 'user',
    message: {
      role: 'user',
      content: [{ tool_use_id: options.toolUseId, type: 'tool_result', content: options.content }],
    },
    uuid: options.uuid,
    timestamp: '2026-06-10T00:00:02.000Z',
    toolUseResult: { stdout: options.content, stderr: '', interrupted: false, isImage: false },
    sourceToolAssistantUUID: options.parentUuid,
    userType: 'external',
    cwd: '/redacted/workspace',
    sessionId: LIVE_SHAPE_SESSION_ID,
    version: '2.1.150',
    gitBranch: 'main',
  });
}

function liveShapeDurationLine(durationMs: number, uuid: string): string {
  return JSON.stringify({
    type: 'system',
    subtype: 'turn_duration',
    durationMs,
    messageCount: 4,
    timestamp: '2026-06-10T00:00:03.000Z',
    uuid,
    cwd: '/redacted/workspace',
    sessionId: LIVE_SHAPE_SESSION_ID,
    version: '2.1.150',
  });
}
