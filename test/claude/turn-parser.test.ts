import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { extractClaudeCodeIntermediateContent, extractClaudeCodeIntermediateText, parseClaudeCodeJsonlTurn } from '../../src/backends/claude/turn-parser.js';
import {
  extractLocalCommandName,
  isCallerUserTurn,
  isSystemLocalCommandEvent,
  rememberLocalCommandTranscriptPromptId,
} from '../../src/backends/claude/turn-boundary-predicates.js';
import { EXIT_CODES, OpenPError } from '../../src/core/errors.js';
import { formatTurnResult } from '../../src/core/output.js';

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
          id: 'claude_event_2',
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
          id: 'claude_event_3',
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
        cacheCreationInputTokens: null,
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

test('surfaces Claude assistant fallback block as a result warning and actual model', () => {
  const result = parseClaudeCodeJsonlTurn([
    userLine('hello'),
    JSON.stringify({
      type: 'assistant',
      requestId: 'req_fallback_start',
      message: {
        model: 'claude-opus-4-8',
        content: [{
          type: 'fallback',
          from: { model: 'claude-fable-5' },
          to: { model: 'claude-opus-4-8' },
        }],
        stop_reason: 'tool_use',
      },
    }),
    JSON.stringify({
      type: 'assistant',
      requestId: 'req_fallback_done',
      message: {
        model: 'claude-opus-4-8',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 1,
          cache_read_input_tokens: 2,
          output_tokens: 3,
        },
      },
    }),
    durationLine(10),
  ], TURN_ID);

  assert.equal(result?.diagnostics.model, 'claude-opus-4-8');
  assert.equal(result?.warnings?.length, 1);
  assert.equal(result?.warnings?.[0]?.code, 'model_refusal_fallback');
  assert.equal(result?.warnings?.[0]?.severity, 'warning');
  assert.match(result?.warnings?.[0]?.message ?? '', /claude-fable-5/);
  assert.match(result?.warnings?.[0]?.message ?? '', /claude-opus-4-8/);

  const openp = parseOpenP(formatTurnResult(result!, {
    outputFormat: 'json',
    backendSessionId: '11111111-1111-4111-8111-111111111111',
    backend: 'claude',
    model: 'claude-fable-5',
  }));
  assert.equal(openp.metadata.model, 'claude-opus-4-8');
  assert.equal(openp.metadata.warnings[0].code, 'model_refusal_fallback');
  assert.deepEqual(openp.metadata.messageBlocks[0], {
    type: 'fallback',
    from: { model: 'claude-fable-5' },
    to: { model: 'claude-opus-4-8' },
  });
});

test('surfaces Claude system model fallback event as a result warning and actual model', () => {
  const result = parseClaudeCodeJsonlTurn([
    userLine('hello'),
    JSON.stringify({
      type: 'system',
      subtype: 'model_refusal_fallback',
      originalModel: 'claude-fable-5',
      fallbackModel: 'claude-opus-4-8',
      apiRefusalCategory: 'safety',
      trigger: 'model_safety',
      content: 'fallback notice',
    }),
    JSON.stringify({
      type: 'assistant',
      requestId: 'req_fallback_done',
      message: {
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 1,
          cache_read_input_tokens: 2,
          output_tokens: 3,
        },
      },
    }),
    durationLine(10),
  ], TURN_ID);

  assert.equal(result?.diagnostics.model, 'claude-opus-4-8');
  assert.equal(result?.warnings?.length, 1);
  assert.equal(result?.warnings?.[0]?.code, 'model_refusal_fallback');
  assert.equal(result?.warnings?.[0]?.severity, 'warning');
  assert.match(result?.warnings?.[0]?.message ?? '', /claude-fable-5/);
  assert.match(result?.warnings?.[0]?.message ?? '', /claude-opus-4-8/);

  const openp = parseOpenP(formatTurnResult(result!, {
    outputFormat: 'json',
    backendSessionId: '11111111-1111-4111-8111-111111111111',
    backend: 'claude',
    model: 'claude-fable-5',
  }));
  assert.equal(openp.metadata.model, 'claude-opus-4-8');
  assert.equal(openp.metadata.warnings[0].code, 'model_refusal_fallback');
  assert.equal(Object.prototype.hasOwnProperty.call(openp.metadata, 'messageBlocks'), false);
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
    cacheCreationInputTokens: null,
    outputTokens: 1,
  });
  assert.deepEqual(result?.diagnostics.lastSubturnUsage, {
    inputTokens: 1,
    cacheReadInputTokens: 10,
    cacheCreationInputTokens: null,
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

test('includes Claude cache creation tokens in derived last subturn context usage', () => {
  const result = parseClaudeCodeJsonlTurn([
    userLine('hello'),
    assistantLine([{ type: 'text', text: 'ok' }], {
      input_tokens: 2,
      cache_read_input_tokens: 559_407,
      cache_creation_input_tokens: 6_407,
      output_tokens: 1,
      iterations: [
        {
          type: 'message',
          input_tokens: 2,
          cache_read_input_tokens: 559_407,
          cache_creation_input_tokens: 6_407,
          output_tokens: 1,
        },
      ],
    }, 'end_turn'),
    durationLine(10),
  ], TURN_ID);

  assert.deepEqual(result?.diagnostics.usage, {
    inputTokens: 2,
    cacheReadInputTokens: 559_407,
    cacheCreationInputTokens: 6_407,
    outputTokens: 1,
  });
  assert.deepEqual(result?.diagnostics.lastSubturnUsage, {
    inputTokens: 2,
    cacheReadInputTokens: 559_407,
    cacheCreationInputTokens: 6_407,
    outputTokens: 1,
  });

  const openp = parseOpenP(formatTurnResult(result!, {
    outputFormat: 'json',
    backendSessionId: '11111111-1111-4111-8111-111111111111',
    backend: 'claude',
  }));
  assert.equal(openp.metadata.lastSubturnContextTokens, 565_816);
  assert.deepEqual(openp.metadata.lastSubturnUsage, {
    inputTokens: 2,
    outputTokens: 1,
    cacheReadInputTokens: 559_407,
    cacheCreationInputTokens: 6_407,
  });
  assert.deepEqual(openp.metadata.usage, {
    inputTokens: 2,
    outputTokens: 1,
    cacheReadInputTokens: 559_407,
    cacheCreationInputTokens: 6_407,
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
    cacheCreationInputTokens: null,
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

test('preserves completed content when a provider error interrupts after the completion marker', () => {
  // A rate-limit (429) provider error arrives as a synthetic assistant event AFTER the backend already
  // closed sub-turns (answer text + tool_use/tool_result with a real file write) and still emitted the
  // turn_duration completion marker. The completed content must be preserved, not discarded.
  const lines = [
    userLine('do the work'),
    assistantLine([{ type: 'text', text: 'here is my plan' }], undefined, 'tool_use'),
    assistantLine([{ type: 'tool_use', name: 'Write', id: 'toolu_1', input: { file_path: '/tmp/x' } }], undefined, 'tool_use'),
    toolResultUserLine('toolu_1', 'wrote file'),
    assistantLine([{ type: 'text', text: 'done writing' }], undefined, 'tool_use'),
    claudeApiErrorAssistantLine("You've hit your session limit · resets 8am (Asia/Seoul)", 429, 'rate_limit'),
    durationLine(1234),
  ];

  const result = parseClaudeCodeJsonlTurn(lines, TURN_ID);
  assert.ok(result);
  // (a) completed answer preserved; (c) the api-error notice text is NOT promoted into the answer.
  assert.equal(result.text, 'here is my plan\n\ndone writing');
  assert.equal(result.text.includes('session limit'), false);
  // (b) toolCall + toolResult preserved.
  assert.deepEqual(result.diagnostics.toolsUsed, ['Write']);
  const hasToolResult = (result.assistantEvents ?? []).some((event) =>
    event.message.content.some((block) => block.type === 'tool_result'));
  assert.equal(hasToolResult, true);
  // (d) single provider_error_interrupted warning carrying the status and the verbatim notice text.
  const warnings = result.warnings ?? [];
  assert.equal(warnings.length, 1);
  const warning = warnings[0]!;
  assert.equal(warning.code, 'provider_error_interrupted');
  assert.match(warning.message, /429/);
  assert.match(warning.message, /You've hit your session limit · resets 8am \(Asia\/Seoul\)/);
  // (e) interruption stop reason + third emit-path exit code signal.
  assert.equal(result.diagnostics.stopReason, 'provider_error');
  assert.equal(result.interruptedExitCode, EXIT_CODES.backendExited);
});

test('emits an interrupted result with empty answer when only tool activity completed before a provider error', () => {
  // No completed answer text, but a Write tool ran (real side effect). The empty answer must not block
  // the result: the tool records must survive the interruption.
  const lines = [
    userLine('write the file'),
    assistantLine([{ type: 'tool_use', name: 'Write', id: 'toolu_1', input: { file_path: '/tmp/x' } }], undefined, 'tool_use'),
    toolResultUserLine('toolu_1', 'wrote file'),
    claudeApiErrorAssistantLine("You've hit your session limit · resets 8am (Asia/Seoul)", 429, 'rate_limit'),
    durationLine(1234),
  ];

  const result = parseClaudeCodeJsonlTurn(lines, TURN_ID);
  assert.ok(result);
  assert.equal(result.text, '');
  assert.deepEqual(result.diagnostics.toolsUsed, ['Write']);
  const hasToolResult = (result.assistantEvents ?? []).some((event) =>
    event.message.content.some((block) => block.type === 'tool_result'));
  assert.equal(hasToolResult, true);
  assert.equal((result.warnings ?? []).some((warning) => warning.code === 'provider_error_interrupted'), true);
  assert.equal(result.diagnostics.stopReason, 'provider_error');
  assert.equal(result.interruptedExitCode, EXIT_CODES.backendExited);
});

test('still fails closed on a provider error with no completed answer or tool activity', () => {
  // Nothing completed before the error: there is nothing to preserve, so the pre-existing fail-closed
  // behavior (backend exit + the same message shape) is retained.
  const lines = [
    userLine('generate image'),
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
});

test('preserves partial answer on provider-error interruption for a structured-output turn instead of failing JSON parsing', () => {
  // structuredOutputRequested=true would normally run the JSON fallback on the answer text. Here the
  // provider error interrupted before the answer was completed, so the partial answer is not valid JSON.
  // The interruption must be preserved (answer + warning + exit code), not replaced by an exit-40 parse
  // failure, and structuredOutput must stay absent (the turn never produced a complete one).
  const lines = [
    userLine('produce structured output'),
    assistantLine([{ type: 'text', text: 'partial answer before the limit' }], undefined, 'tool_use'),
    claudeApiErrorAssistantLine("You've hit your session limit · resets 8am (Asia/Seoul)", 429, 'rate_limit'),
    durationLine(1234),
  ];

  const result = parseClaudeCodeJsonlTurn(lines, TURN_ID, { structuredOutputRequested: true });
  assert.ok(result);
  assert.equal(result.text, 'partial answer before the limit');
  assert.equal(result.structuredOutput, undefined);
  assert.equal(result.interruptedExitCode, EXIT_CODES.backendExited);
  assert.equal((result.warnings ?? []).some((warning) => warning.code === 'provider_error_interrupted'), true);
  assert.equal(result.diagnostics.stopReason, 'provider_error');
});

test('returns null (no result) when a provider error is not followed by a completion marker', () => {
  // Without the turn_duration completion marker the parser does not synthesize a partial result; the
  // wait loop keeps its fail-closed backend-exit / timeout behavior instead.
  const lines = [
    userLine('do the work'),
    assistantLine([{ type: 'text', text: 'partial answer' }], undefined, 'tool_use'),
    claudeApiErrorAssistantLine("You've hit your session limit", 429, 'rate_limit'),
    // no turn_duration
  ];

  assert.equal(parseClaudeCodeJsonlTurn(lines, TURN_ID), null);
  // The streaming path still skips the api-error notice and keeps the completed intermediate text.
  assert.equal(
    extractClaudeCodeIntermediateContent(lines, { includeTerminalAssistant: true }).text,
    'partial answer',
  );
});

test('returns null until completion metadata is present', () => {
  assert.equal(parseClaudeCodeJsonlTurn([
    userLine('hello'),
    assistantLine([{ type: 'text', text: 'ok' }], undefined, 'end_turn'),
  ], TURN_ID), null);
});

test('resets stale pre-caller completion with assistant evidence when the caller turn appears', () => {
  const result = parseClaudeCodeJsonlTurn([
    assistantLine([{ type: 'text', text: 'stale answer' }], undefined, 'end_turn'),
    durationLine(1),
    userLine('real prompt'),
    assistantLine([{ type: 'text', text: 'fresh answer' }], undefined, 'end_turn'),
    durationLine(12),
  ], TURN_ID);

  assert.equal(result?.text, 'fresh answer');
  assert.equal(result?.diagnostics.durationMs, 12);
});

test('exposes stable rejection reason code for missing Claude caller turn boundary', () => {
  assert.throws(
    () => parseClaudeCodeJsonlTurn([
      assistantLine([{ type: 'text', text: 'stale answer' }], undefined, 'end_turn'),
      durationLine(100),
    ], TURN_ID),
    (error) => error instanceof OpenPError &&
      error.exitCode === EXIT_CODES.protocolViolation &&
      error.reasonCode === 'missing_turn_boundary',
  );
});

test('does not count `! …` shell command transcripts as caller user turns', () => {
  // `! cmd` runs are written as type:user transcript events (<bash-input>/<bash-stdout>) with no
  // promptId. They are CLI activity, not caller prompts; counting them as caller user turns makes a
  // turn that ran a shell command fail with exit 40 "multiple caller user-turn boundaries".
  const result = parseClaudeCodeJsonlTurn([
    userLine('do the thing'),
    userLine('<bash-input> git push origin main</bash-input>'),
    userLine('<bash-stdout></bash-stdout><bash-stderr>pre-push: refused</bash-stderr>'),
    assistantLine([{ type: 'text', text: 'ok' }], undefined, 'end_turn'),
    durationLine(100),
  ], TURN_ID);

  assert.equal(result?.text, 'ok');
});

test('keeps a caller prompt that starts with a bash tag when it carries a promptId', () => {
  // Only promptId-less shell transcripts are excluded; a real caller prompt (which carries a
  // promptId) that merely starts with a bash tag must still count as the caller turn, not be dropped.
  const result = parseClaudeCodeJsonlTurn([
    JSON.stringify({
      type: 'user',
      promptId: 'real-prompt-1',
      message: { role: 'user', content: '<bash-input> explain this transcript</bash-input>' },
    }),
    assistantLine([{ type: 'text', text: 'explained' }], undefined, 'end_turn'),
    durationLine(10),
  ], TURN_ID);

  assert.equal(result?.text, 'explained');
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
        id: 'claude_event_3',
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
    (error) => error instanceof OpenPError &&
      error.exitCode === EXIT_CODES.protocolViolation &&
      error.reasonCode === 'unsupported_artifact_shape',
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

test('parses a synthetic live-shape Claude Code JSONL fixture', async () => {
  const text = await readFile(new URL('./fixture-live-turn.jsonl', import.meta.url), 'utf8');
  const lines = text.trimEnd().split('\n');

  const result = parseClaudeCodeJsonlTurn(lines, 'fixture-turn');

  assert.equal(result?.text, 'fixture live turn answer ok');
  assert.equal(result?.reasoningContent, null);
  assert.deepEqual(result?.diagnostics.usage, {
    inputTokens: 7,
    cacheReadInputTokens: 150,
    cacheCreationInputTokens: 2500,
    outputTokens: 45,
  });
  assert.equal(result?.diagnostics.durationMs, 1500);
});

test('parses last subturn usage from a synthetic Claude Code usage-iterations fixture', async () => {
  const text = await readFile(
    new URL('./fixture-live-turn-usage-iterations.jsonl', import.meta.url),
    'utf8',
  );
  const lines = text.trimEnd().split('\n');

  const result = parseClaudeCodeJsonlTurn(lines, 'fixture-usage-iterations-turn');

  assert.equal(result?.text, 'fixture usage iterations answer ok');
  assert.deepEqual(result?.diagnostics.usage, {
    inputTokens: 9,
    cacheReadInputTokens: 500,
    cacheCreationInputTokens: 300,
    outputTokens: 80,
  });
  assert.deepEqual(result?.diagnostics.lastSubturnUsage, {
    inputTokens: 3,
    cacheReadInputTokens: 300,
    cacheCreationInputTokens: 50,
    outputTokens: 50,
  });
  assert.equal(result?.diagnostics.durationMs, 2000);
});

test('parses a synthetic Claude Code reasoning fixture variant', async () => {
  const text = await readFile(new URL('./fixture-reasoning-variant.jsonl', import.meta.url), 'utf8');
  const lines = text.trimEnd().split('\n');

  const result = parseClaudeCodeJsonlTurn(lines, 'fixture-reasoning-turn');

  assert.equal(result?.text, 'fixture reasoning answer ok');
  assert.equal(result?.reasoningContent, 'fixture think alpha\n\nfixture think beta');
  assert.deepEqual(result?.diagnostics.usage, {
    inputTokens: 11,
    cacheReadInputTokens: 60,
    cacheCreationInputTokens: null,
    outputTokens: 70,
  });
  assert.equal(result?.diagnostics.durationMs, 2500);
});

test('fails closed on an unlinked synthetic Claude Code task-notification fixture variant', async () => {
  const text = await readFile(new URL('./fixture-task-notification-variant.jsonl', import.meta.url), 'utf8');
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
    (error) => error instanceof OpenPError &&
      error.exitCode === EXIT_CODES.protocolViolation &&
      error.reasonCode === 'multiple_turn_boundaries',
  );
});

test('ignores post-completion scheduled local command user transcripts as active caller boundaries', () => {
  const result = parseClaudeCodeJsonlTurn([
    userLine('real prompt'),
    assistantLine([{ type: 'text', text: 'result answer' }], undefined, 'end_turn'),
    durationLine(10),
    JSON.stringify({
      type: 'system',
      subtype: 'local_command',
      content: '<command-name>/loop</command-name>',
    }),
    JSON.stringify({
      type: 'system',
      subtype: 'local_command',
      content: '<local-command-stdout>system scheduled output</local-command-stdout>',
    }),
    assistantLine([{ type: 'text', text: 'system scheduled task answer' }], undefined, 'end_turn'),
    JSON.stringify({
      type: 'user',
      promptId: 'scheduled-loop-command',
      message: {
        role: 'user',
        content: '<command-name>/loop</command-name>\n<command-message>/loop</command-message>',
      },
    }),
    JSON.stringify({
      type: 'user',
      promptId: 'scheduled-loop-command',
      message: {
        role: 'user',
        content: '<local-command-stdout>scheduled loop output</local-command-stdout>',
      },
    }),
    assistantLine([{ type: 'text', text: 'scheduled task answer' }], undefined, 'end_turn'),
  ], TURN_ID);

  assert.equal(result?.text, 'result answer');
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

test('classifies string-message local command transcripts the same in wait-loop and parser paths', () => {
  assertLocalCommandTranscriptShapeIsNotCaller({
    promptId: 'local-command-string-message',
    caveatEvent: {
      type: 'user',
      isMeta: true,
      promptId: 'local-command-string-message',
      message: '<local-command-caveat>generated while running local commands</local-command-caveat>',
    },
    commandEvent: {
      type: 'user',
      promptId: 'local-command-string-message',
      message: '<command-name>/compact</command-name>\n<command-message>compact</command-message>',
    },
  });
});

test('classifies kind-text data local command transcripts the same in wait-loop and parser paths', () => {
  assertLocalCommandTranscriptShapeIsNotCaller({
    promptId: 'local-command-kind-text-data',
    caveatEvent: {
      type: 'user',
      isMeta: true,
      promptId: 'local-command-kind-text-data',
      message: {
        role: 'user',
        content: [
          {
            kind: 'text',
            data: '<local-command-caveat>generated while running local commands</local-command-caveat>',
          },
        ],
      },
    },
    commandEvent: {
      type: 'user',
      promptId: 'local-command-kind-text-data',
      message: {
        role: 'user',
        content: [
          {
            kind: 'text',
            data: '<command-name>/compact</command-name>\n<command-message>compact</command-message>',
          },
        ],
      },
    },
  });
});

test('classifies system local_command transcripts the same in wait-loop and parser paths', () => {
  const commandEvent = {
    type: 'system',
    subtype: 'local_command',
    content: '<command-name>/ultrareview</command-name>\n<command-message>ultrareview</command-message>\n<command-args></command-args>',
  };
  const stdoutEvent = {
    type: 'system',
    subtype: 'local_command',
    content: '<local-command-stdout>fixture local command stdout line</local-command-stdout>',
  };

  // A system local_command event registers no promptId (it carries no `<local-command-caveat>` wrapper).
  const waitLoopPromptIds = new Set<string>();
  rememberLocalCommandTranscriptPromptId(waitLoopPromptIds, commandEvent);
  rememberLocalCommandTranscriptPromptId(waitLoopPromptIds, stdoutEvent);
  assert.equal(waitLoopPromptIds.size, 0);

  // Wait-loop classification: neither system event is a caller user turn.
  assert.equal(isCallerUserTurn(commandEvent, waitLoopPromptIds, { isTaskNotification: false }), false);
  assert.equal(isCallerUserTurn(stdoutEvent, waitLoopPromptIds, { isTaskNotification: false }), false);

  // Shared recognizer surface both state machines read from.
  assert.equal(isSystemLocalCommandEvent(commandEvent), true);
  assert.equal(extractLocalCommandName(commandEvent), '/ultrareview');
  assert.equal(extractLocalCommandName(stdoutEvent), null);

  // Parser path: the same system events are ignored and do not become a second caller boundary, so a
  // normal turn with a real caller user turn still resolves to its assistant answer.
  const parserResult = parseClaudeCodeJsonlTurn([
    userLine('real prompt'),
    JSON.stringify(commandEvent),
    JSON.stringify(stdoutEvent),
    assistantLine([{ type: 'text', text: 'result answer' }], undefined, 'end_turn'),
    durationLine(10),
  ], TURN_ID);
  assert.equal(parserResult?.text, 'result answer');
});

test('keeps seeded local-command prompt ids after the caller user turn', () => {
  const lines = [
    userLine('real prompt'),
    JSON.stringify({
      type: 'user',
      promptId: 'compact-command',
      message: {
        role: 'user',
        content: '<local-command-stderr>late compact diagnostic</local-command-stderr>',
      },
    }),
    assistantLine([{ type: 'text', text: 'answer after late transcript' }], undefined, 'end_turn'),
    durationLine(10),
  ];

  const result = parseClaudeCodeJsonlTurn(lines, TURN_ID, {
    initialLocalCommandTranscriptPromptIds: new Set(['compact-command']),
  });

  assert.equal(result?.text, 'answer after late transcript');
});

test('keeps intermediate assistant content across late seeded local-command transcript events', () => {
  const lines = [
    userLine('real prompt'),
    assistantLine([{ type: 'text', text: 'stream before late transcript' }]),
    JSON.stringify({
      type: 'user',
      promptId: 'compact-command',
      message: {
        role: 'user',
        content: '<local-command-stderr>late compact diagnostic</local-command-stderr>',
      },
    }),
  ];

  const content = extractClaudeCodeIntermediateContent(lines, {
    includeTerminalAssistant: true,
    initialLocalCommandTranscriptPromptIds: new Set(['compact-command']),
  });

  assert.equal(content.text, 'stream before late transcript');
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

function assertLocalCommandTranscriptShapeIsNotCaller(options: {
  readonly promptId: string;
  readonly caveatEvent: Record<string, unknown>;
  readonly commandEvent: Record<string, unknown>;
}): void {
  const waitLoopPromptIds = new Set<string>();
  rememberLocalCommandTranscriptPromptId(waitLoopPromptIds, options.caveatEvent);
  assert.equal(waitLoopPromptIds.has(options.promptId), true);
  assert.equal(
    isCallerUserTurn(options.commandEvent, waitLoopPromptIds, { isTaskNotification: false }),
    false,
  );

  const parserResult = parseClaudeCodeJsonlTurn([
    userLine('real prompt'),
    JSON.stringify(options.caveatEvent),
    JSON.stringify(options.commandEvent),
    assistantLine([{ type: 'text', text: 'result answer' }], undefined, 'end_turn'),
    durationLine(10),
  ], TURN_ID);
  assert.equal(parserResult?.text, 'result answer');
}

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

function toolResultUserLine(toolUseId: string, content: string): string {
  return JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{ tool_use_id: toolUseId, type: 'tool_result', content }],
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

function parseOpenP(output: string): Record<string, any> {
  assert.match(output, /\n$/);
  const event = JSON.parse(output) as Record<string, any>;
  assert.deepEqual(Object.keys(event), ['openp']);
  return event.openp;
}

// Line builders below follow the live Claude Code session-log event shape.
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
    version: '9.9.9',
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
    version: '9.9.9',
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
    version: '9.9.9',
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
    version: '9.9.9',
  });
}

test('reports the permission mode Claude settled on for the turn', () => {
  // Claude states the mode on the caller record that opens the turn, and it is not always the one it
  // was given: a policy or a settings key downgrades it without failing the turn.
  const lines = [
    JSON.stringify({ type: 'permission-mode', permissionMode: 'fixture-mode-alpha' }),
    JSON.stringify({
      type: 'user',
      permissionMode: 'fixture-mode-alpha',
      uuid: 'fixture-user',
      message: { role: 'user', content: 'fixture prompt' },
    }),
    JSON.stringify({
      type: 'assistant',
      uuid: 'fixture-assistant',
      message: { id: 'fixture-message', role: 'assistant', content: [{ type: 'text', text: 'FIXTURE-ANSWER' }] },
    }),
    JSON.stringify({ type: 'system', subtype: 'turn_duration', uuid: 'fixture-completion', durationMs: 1 }),
  ];

  const result = parseClaudeCodeJsonlTurn(lines, 'fixture-turn');
  assert.equal(result?.diagnostics.permissionMode, 'fixture-mode-alpha');
});

test('reports a null permission mode when Claude states none', () => {
  const lines = [
    JSON.stringify({
      type: 'user',
      uuid: 'fixture-user',
      message: { role: 'user', content: 'fixture prompt' },
    }),
    JSON.stringify({
      type: 'assistant',
      uuid: 'fixture-assistant',
      message: { id: 'fixture-message', role: 'assistant', content: [{ type: 'text', text: 'FIXTURE-ANSWER' }] },
    }),
    JSON.stringify({ type: 'system', subtype: 'turn_duration', uuid: 'fixture-completion', durationMs: 1 }),
  ];

  const result = parseClaudeCodeJsonlTurn(lines, 'fixture-turn');
  assert.equal(result?.diagnostics.permissionMode, undefined);
});

test('does not report a later turn permission mode as the finished turn one', () => {
  // Records belonging to the next turn state that turn's mode. Reading them into the finished turn
  // is worse than reporting nothing: it is a downgrade signal that never happened, and it goes wrong
  // exactly when the mode changed between turns — the case this field exists for.
  const lines = [
    JSON.stringify({
      type: 'user',
      permissionMode: 'fixture-mode-alpha',
      uuid: 'fixture-user',
      message: { role: 'user', content: 'fixture prompt' },
    }),
    JSON.stringify({
      type: 'assistant',
      uuid: 'fixture-assistant',
      message: { id: 'fixture-message', role: 'assistant', content: [{ type: 'text', text: 'FIXTURE-ANSWER' }] },
    }),
    JSON.stringify({ type: 'system', subtype: 'turn_duration', uuid: 'fixture-completion', durationMs: 1 }),
    JSON.stringify({
      type: 'user',
      permissionMode: 'fixture-mode-beta',
      uuid: 'fixture-next-user',
      message: { role: 'user', content: 'fixture next prompt' },
    }),
  ];

  const result = parseClaudeCodeJsonlTurn(lines, 'fixture-turn');
  assert.equal(result?.diagnostics.permissionMode, 'fixture-mode-alpha');
});
