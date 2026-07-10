import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOpenCodeJsonOutput } from '../src/backends/opencode/output-parser.js';

test('parseOpenCodeJsonOutput extracts session id and result text', () => {
  const parsed = parseOpenCodeJsonOutput([
    JSON.stringify({ type: 'assistant', sessionID: 'ses_abc', message: { role: 'assistant', content: [{ type: 'text', text: 'draft' }] } }),
    JSON.stringify({ type: 'result', sessionID: 'ses_abc', result: 'final', usage: { input_tokens: 3, output_tokens: 5 } }),
  ].join('\n'));
  assert.equal(parsed.sessionId, 'ses_abc');
  assert.equal(parsed.content, 'final');
  assert.deepEqual(parsed.usage, {
    inputTokens: 3,
    outputTokens: 5,
    cacheReadInputTokens: null,
  });
  assert.equal(parsed.rawEventCount, 2);
});

test('parseOpenCodeJsonOutput normalizes nested assistant message snapshots', () => {
  const parsed = parseOpenCodeJsonOutput([
    JSON.stringify({ type: 'assistant', sessionID: 'ses_abc', message: { role: 'assistant', content: [{ type: 'text', text: 'draft' }] } }),
    JSON.stringify({ type: 'result', sessionID: 'ses_abc', result: 'final' }),
  ].join('\n'));
  assert.deepEqual(parsed.assistantEvents.map((event) => event.message), [
    {
      id: 'msg_opencode_1_assistant',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'draft' }],
    },
  ]);
});

test('parseOpenCodeJsonOutput uses OpenCode text part events when no result event is present', () => {
  const parsed = parseOpenCodeJsonOutput([
    JSON.stringify({
      type: 'step_start',
      sessionID: 'ses_text',
      part: { type: 'step-start', sessionID: 'ses_text' },
    }),
    JSON.stringify({
      type: 'text',
      sessionID: 'ses_text',
      part: { type: 'text', text: 'pong' },
    }),
    JSON.stringify({
      type: 'step_finish',
      sessionID: 'ses_text',
      part: {
        type: 'step-finish',
        tokens: { input: 1, output: 2, cache: { read: 3 } },
      },
    }),
  ].join('\n'));
  assert.equal(parsed.sessionId, 'ses_text');
  assert.equal(parsed.content, 'pong');
  assert.deepEqual(parsed.assistantEvents.map((event) => event.message.content), [
    [{ type: 'text', text: 'pong' }],
  ]);
  assert.deepEqual(parsed.usage, {
    inputTokens: 1,
    outputTokens: 2,
    cacheReadInputTokens: 3,
  });
});

test('parseOpenCodeJsonOutput reports OpenCode error event', () => {
  const parsed = parseOpenCodeJsonOutput(JSON.stringify({
    type: 'error',
    sessionID: 'ses_err',
    error: { name: 'UnknownError', data: { message: 'Unexpected server error' } },
  }));
  assert.equal(parsed.sessionId, 'ses_err');
  assert.equal(parsed.errorMessage, 'Unexpected server error');
});

test('parseOpenCodeJsonOutput treats explicit non-error-type failures as errors', () => {
  const parsed = parseOpenCodeJsonOutput(JSON.stringify({
    type: 'result',
    subtype: 'failed',
    sessionID: 'ses_err',
    result: 'API Error',
  }));
  assert.equal(parsed.errorMessage, 'API Error');
});

test('parseOpenCodeJsonOutput preserves tool call and tool result blocks', () => {
  const parsed = parseOpenCodeJsonOutput([
    JSON.stringify({ type: 'tool_call', sessionID: 'ses_tool', id: 'call_1', name: 'bash', input: { command: 'pwd' } }),
    JSON.stringify({ type: 'tool_result', sessionID: 'ses_tool', tool_use_id: 'call_1', content: '/repo' }),
    JSON.stringify({ type: 'result', sessionID: 'ses_tool', result: 'done' }),
  ].join('\n'));
  assert.equal(parsed.toolsUsed.includes('bash'), true);
  assert.deepEqual(parsed.assistantEvents.map((event) => event.message.content), [
    [{ type: 'tool_use', id: 'call_1', name: 'bash', input: { command: 'pwd' }, caller: { type: 'opencode' } }],
    [{ type: 'tool_result', tool_use_id: 'call_1', content: '/repo' }],
  ]);
});

test('parseOpenCodeJsonOutput preserves failed tool results without failing the turn', () => {
  const parsed = parseOpenCodeJsonOutput([
    JSON.stringify({ type: 'tool_result', sessionID: 'ses_tool', tool_use_id: 'call_1', result: 'denied', is_error: true }),
    JSON.stringify({ type: 'result', sessionID: 'ses_tool', result: 'handled' }),
  ].join('\n'));
  assert.equal(parsed.errorMessage, null);
  assert.equal(parsed.content, 'handled');
  assert.deepEqual(parsed.assistantEvents.map((event) => event.message.content), [
    [{ type: 'tool_result', tool_use_id: 'call_1', content: 'denied', is_error: true }],
  ]);
});

test('parseOpenCodeJsonOutput does not promote non-result payloads to answer text', () => {
  const parsed = parseOpenCodeJsonOutput([
    JSON.stringify({ type: 'tool_result', sessionID: 'ses_tool', tool_use_id: 'call_1', result: 'tool stdout' }),
    JSON.stringify({ type: 'result', sessionID: 'ses_tool', result: 'final answer' }),
  ].join('\n'));
  assert.equal(parsed.content, 'final answer');
  assert.deepEqual(parsed.assistantEvents.map((event) => event.message.content), [
    [{ type: 'tool_result', tool_use_id: 'call_1', content: 'tool stdout' }],
  ]);
});

test('parseOpenCodeJsonOutput does not promote untyped result fields to answer text', () => {
  const parsed = parseOpenCodeJsonOutput([
    JSON.stringify({ type: 'result', sessionID: 'ses_tool', result: 'final answer' }),
    JSON.stringify({ sessionID: 'ses_tool', result: 'untyped payload' }),
  ].join('\n'));
  assert.equal(parsed.content, 'final answer');
});
