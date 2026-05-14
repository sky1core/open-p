import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { extractClaudeCodeIntermediateContent, extractClaudeCodeIntermediateText, parseClaudeCodeJsonlTurn } from '../src/backends/claude-code/turn-parser.js';
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

test('returns null until completion metadata is present', () => {
  assert.equal(parseClaudeCodeJsonlTurn([
    userLine('hello'),
    assistantLine([{ type: 'text', text: 'ok' }], undefined, 'end_turn'),
  ], TURN_ID), null);
});

test('parses final assistant text appended after completion metadata', () => {
  const result = parseClaudeCodeJsonlTurn([
    userLine('hello'),
    assistantLine([{ type: 'thinking', thinking: 'working' }], undefined, 'end_turn'),
    durationLine(100),
    assistantLine([{ type: 'text', text: 'ok' }], undefined, 'end_turn'),
  ], TURN_ID);

  assert.equal(result?.text, 'ok');
  assert.equal(result?.diagnostics.durationMs, 100);
});

test('does not treat intermediate assistant text as reasoning when it differs from final answer', () => {
  const result = parseClaudeCodeJsonlTurn([
    userLine('hello'),
    assistantLine([{ type: 'text', text: 'working' }]),
    assistantLine([{ type: 'text', text: 'ok' }], undefined, 'end_turn'),
    durationLine(100),
  ], TURN_ID);

  assert.equal(result?.text, 'ok');
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

  assert.equal(result?.text, 'ok');
  assert.equal(result?.reasoningContent, null);
  assert.equal(extractClaudeCodeIntermediateText(lines), null);
});

test('keeps active final when task-notification background has parent uuid linkage', () => {
  const result = parseClaudeCodeJsonlTurn([
    userLine('hello', 'user-1'),
    assistantLine([{ type: 'text', text: 'working' }], undefined, undefined, 'assistant-progress', 'user-1'),
    taskNotificationLine('background task complete', 'background-user', 'assistant-progress'),
    assistantLine([{ type: 'text', text: 'active final' }], undefined, 'end_turn', 'assistant-final', 'assistant-progress'),
    assistantLine([{ type: 'text', text: 'background done' }], undefined, 'end_turn', 'background-assistant', 'background-user'),
    durationLine(100),
  ], TURN_ID);

  assert.equal(result?.text, 'active final');
  assert.equal(result?.reasoningContent, null);
});

test('keeps parentless active final after a linked background task has ended', () => {
  const result = parseClaudeCodeJsonlTurn([
    userLine('hello', 'user-1'),
    assistantLine([{ type: 'text', text: 'working' }], undefined, undefined, 'assistant-progress', 'user-1'),
    taskNotificationLine('background task complete', 'background-user', 'assistant-progress'),
    assistantLine([{ type: 'text', text: 'background done' }], undefined, 'end_turn', 'background-assistant', 'background-user'),
    assistantLine([{ type: 'text', text: 'active final' }], undefined, 'end_turn'),
    durationLine(100),
  ], TURN_ID);

  assert.equal(result?.text, 'active final');
  assert.equal(result?.reasoningContent, null);
  assert.equal(extractClaudeCodeIntermediateText([
    userLine('hello', 'user-1'),
    assistantLine([{ type: 'text', text: 'working' }], undefined, undefined, 'assistant-progress', 'user-1'),
    taskNotificationLine('background task complete', 'background-user', 'assistant-progress'),
    assistantLine([{ type: 'text', text: 'background done' }], undefined, 'end_turn', 'background-assistant', 'background-user'),
    assistantLine([{ type: 'text', text: 'active final' }], undefined, 'end_turn'),
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
    assistantLine([{ type: 'text', text: 'active final' }], undefined, 'end_turn'),
    durationLine(100),
  ], TURN_ID);

  assert.equal(result?.text, 'active final');
  assert.equal(result?.reasoningContent, null);
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
      assistantLine([{ type: 'text', text: 'maybe active final' }], undefined, 'end_turn'),
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
      assistantLine([{ type: 'text', text: 'active final' }], undefined, 'end_turn'),
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

test('uses StructuredOutput-only tool input as final text when no assistant text exists', () => {
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

test('uses StructuredOutput-only active final during linked background interleave', () => {
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

test('parses final text as structured output when schema mode has no StructuredOutput tool event', () => {
  const result = parseClaudeCodeJsonlTurn([
    userLine('hello'),
    assistantLine([{ type: 'text', text: '{"ok":true}' }], undefined, 'end_turn'),
    durationLine(10),
  ], TURN_ID, { structuredOutputRequested: true });

  assert.deepEqual(result?.structuredOutput, { ok: true });
});

test('parses a single fenced json final text as structured output in schema mode', () => {
  const result = parseClaudeCodeJsonlTurn([
    userLine('hello'),
    assistantLine([{ type: 'text', text: '```json\n{"ok":true}\n```' }], undefined, 'end_turn'),
    durationLine(10),
  ], TURN_ID, { structuredOutputRequested: true });

  assert.deepEqual(result?.structuredOutput, { ok: true });
});

test('rejects fenced json with surrounding prose as structured output fallback', () => {
  assert.throws(
    () => parseClaudeCodeJsonlTurn([
      userLine('hello'),
      assistantLine([{ type: 'text', text: 'Here is the result:\n```json\n{"ok":true}\n```' }], undefined, 'end_turn'),
      durationLine(10),
    ], TURN_ID, { structuredOutputRequested: true }),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.protocolViolation,
  );
});

test('fails closed when schema mode final text is not valid JSON and no StructuredOutput tool event exists', () => {
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
  const text = await readFile(new URL('./fixtures/claude-code/redacted-live-turn.jsonl', import.meta.url), 'utf8');
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

test('parses a redacted Claude Code reasoning fixture variant', async () => {
  const text = await readFile(new URL('./fixtures/claude-code/redacted-reasoning-variant.jsonl', import.meta.url), 'utf8');
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
  const text = await readFile(new URL('./fixtures/claude-code/redacted-task-notification-variant.jsonl', import.meta.url), 'utf8');
  const lines = text.trimEnd().split('\n');

  assert.throws(
    () => parseClaudeCodeJsonlTurn(lines, 'fixture-task-turn'),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.protocolViolation,
  );
  assert.equal(extractClaudeCodeIntermediateText(lines), null);
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
): string {
  return JSON.stringify({
    type: 'assistant',
    ...(uuid ? { uuid } : {}),
    ...(parentUuid ? { parentUuid } : {}),
    message: {
      ...(usage ? { usage } : {}),
      ...(stopReason ? { stop_reason: stopReason } : {}),
      content,
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
