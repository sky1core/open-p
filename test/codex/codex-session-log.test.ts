import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  extractSessionLogResult,
  findCodexSessionLogPath,
  getCodexSessionLogBaseline,
  readCodexSessionLogResult,
  readCodexSessionLogResultSinceBaseline,
} from '../../src/backends/codex/session-log.js';
import { createCodexBackendProvider } from '../../src/backends/codex/index.js';
import { EXIT_CODES, OpenPError } from '../../src/core/errors.js';
import { formatWorkerTurnResult } from '../../src/core/output.js';

// A caller turn boundary as Codex writes it: the `response_item` user record immediately followed
// by its `event_msg user_message` mirror. Both records are required — the mirror alone is not
// caller evidence.
function codexUserTurn(message = 'prompt', passthroughTurnId?: string): string {
  return [
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: message }],
        ...(passthroughTurnId
          ? { internal_chat_message_metadata_passthrough: { turn_id: passthroughTurnId } }
          : {}),
      },
    }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message } }),
  ].join('\n');
}

function readCodexSessionLogFixture(name: string): string {
  return readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');
}

function firstBlocks(events: readonly any[]): any[] {
  return events.map((event) => (event.message.content as any[])[0]);
}

function openPOutputForCodexSessionResult(result: ReturnType<typeof extractSessionLogResult>): any {
  const output = formatWorkerTurnResult({
    content: result.content ?? '',
    reasoningContent: result.reasoningContent,
    assistantEvents: result.commentaryEvents,
    sessionId: result.sessionId ?? 'codex-session',
    diagnostics: {
      numTurns: 1,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cacheReadInputTokens: result.usage.cacheReadInputTokens,
      model: result.model,
      contextWindow: result.contextWindow,
      lastSubturnUsage: result.lastSubturnUsage,
      lastSubturnContextTokens: null,
      durationMs: 1,
      totalCostUsd: null,
      stopReason: 'end_turn',
      toolsUsed: [],
      autoCompacted: null,
      intermediateTextCount: null,
    },
  }, {
    turnId: 'turn_fixture_001',
    backend: 'codex',
  });
  return JSON.parse(output).openp.output;
}

test('extractSessionLogResult preserves assistant text with an unknown native phase', () => {
  const result = extractSessionLogResult([
    codexUserTurn(),
    JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'agent_message',
        phase: 'draft',
        id: 'draft-1',
        message: 'draft answer',
      },
    }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }),
  ].join('\n'));

  assert.equal(result.content, 'draft answer');
  assert.equal(result.commentaryEvents.length, 1);
  assert.deepEqual(firstBlocks(result.commentaryEvents), [{ type: 'text', text: 'draft answer' }]);
});

test('extractSessionLogResult keeps final display text when an unknown native phase follows', () => {
  const result = extractSessionLogResult([
    codexUserTurn(),
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        phase: 'final_answer',
        id: 'final-1',
        content: [{ type: 'output_text', text: 'final answer' }],
      },
    }),
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        phase: 'draft',
        id: 'draft-1',
        content: [{ type: 'output_text', text: 'draft answer' }],
      },
    }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }),
  ].join('\n'));

  assert.equal(result.content, 'final answer');
  assert.deepEqual(firstBlocks(result.commentaryEvents), [
    { type: 'text', text: 'final answer' },
    { type: 'text', text: 'draft answer' },
  ]);
});

test('extractSessionLogResult lets final display text override an earlier unknown native phase', () => {
  const result = extractSessionLogResult([
    codexUserTurn(),
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        phase: 'draft',
        id: 'draft-1',
        content: [{ type: 'output_text', text: 'draft answer' }],
      },
    }),
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        phase: 'final_answer',
        id: 'final-1',
        content: [{ type: 'output_text', text: 'final answer' }],
      },
    }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }),
  ].join('\n'));

  assert.equal(result.content, 'final answer');
  assert.deepEqual(firstBlocks(result.commentaryEvents), [
    { type: 'text', text: 'draft answer' },
    { type: 'text', text: 'final answer' },
  ]);
});

test('findCodexSessionLogPath requires exact or dash-prefixed session suffix', async () => {
  const prev = process.env.CODEX_HOME;
  const codexHome = await mkdtemp(join(tmpdir(), 'openp-codex-home-'));
  const sessionDir = join(codexHome, 'sessions', '2026', '05', '20');
  await mkdir(sessionDir, { recursive: true });
  process.env.CODEX_HOME = codexHome;

  try {
    await writeFile(join(sessionDir, 'rollout-xabc.jsonl'), '{}\n');
    assert.equal(await findCodexSessionLogPath('abc'), null);

    const expected = join(sessionDir, 'rollout-abc.jsonl');
    await writeFile(expected, '{}\n');
    assert.equal(await findCodexSessionLogPath('abc'), expected);
  } finally {
    if (prev === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = prev;
    }
  }
});

test('findCodexSessionLogPath rejects duplicate session id log paths', async () => {
  const prev = process.env.CODEX_HOME;
  const codexHome = await mkdtemp(join(tmpdir(), 'openp-codex-home-'));
  const sessionDir = join(codexHome, 'sessions', '2026', '05', '20');
  await mkdir(sessionDir, { recursive: true });
  process.env.CODEX_HOME = codexHome;

  try {
    await writeFile(join(sessionDir, 'rollout-a-dup.jsonl'), '{}\n');
    await writeFile(join(sessionDir, 'rollout-b-dup.jsonl'), '{}\n');
    await assert.rejects(
      () => findCodexSessionLogPath('dup'),
      (error) => error instanceof OpenPError &&
        error.exitCode === EXIT_CODES.protocolViolation &&
        error.reasonCode === 'ambiguous_candidate' &&
        error.message.includes('ambiguous Codex session log paths'),
    );
  } finally {
    if (prev === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = prev;
    }
  }
});

test('Codex session-log helpers use only the explicit homeDir', async () => {
  const sessionId = 'explicit-home-session';
  const firstHome = await mkdtemp(join(tmpdir(), 'openp-codex-home-a-'));
  const secondHome = await mkdtemp(join(tmpdir(), 'openp-codex-home-b-'));
  const firstDir = join(firstHome, 'sessions', '2026', '05', '20');
  const secondDir = join(secondHome, 'sessions', '2026', '05', '20');
  await mkdir(firstDir, { recursive: true });
  await mkdir(secondDir, { recursive: true });
  const firstPath = join(firstDir, `rollout-${sessionId}.jsonl`);
  const secondPath = join(secondDir, `rollout-${sessionId}.jsonl`);
  await writeFile(firstPath, [
    JSON.stringify({ type: 'turn_context', payload: { model: 'codex-first-home' } }),
    codexUserTurn(),
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        phase: 'final_answer',
        content: [{ type: 'output_text', text: 'first home answer' }],
      },
    }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }),
    '',
  ].join('\n'));
  await writeFile(secondPath, [
    JSON.stringify({ type: 'turn_context', payload: { model: 'codex-second-home' } }),
    codexUserTurn(),
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        phase: 'final_answer',
        content: [{ type: 'output_text', text: 'second home answer' }],
      },
    }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }),
    '',
  ].join('\n'));

  assert.equal(await findCodexSessionLogPath(sessionId, secondHome), secondPath);
  assert.equal(
    await createCodexBackendProvider({ id: 'codex-explicit', homeDir: secondHome })
      .resolveSessionLogPath(sessionId, process.cwd()),
    secondPath,
  );
  const baseline = await getCodexSessionLogBaseline(sessionId, { homeDir: secondHome });
  assert.equal(baseline.logPath, secondPath);
  const result = await readCodexSessionLogResult(sessionId, 0, { homeDir: secondHome });
  assert.equal(result?.content, 'second home answer');
  assert.equal(result?.model, 'codex-second-home');
  const resultSinceBaseline = await readCodexSessionLogResultSinceBaseline(sessionId, {
    offsetBytes: 0,
    preexisting: false,
    logPath: null,
  }, { homeDir: secondHome });
  assert.equal(resultSinceBaseline?.content, 'second home answer');
});

test('findCodexSessionLogPath fails closed when the sessions directory cannot be read', async () => {
  const prev = process.env.CODEX_HOME;
  const codexHome = await mkdtemp(join(tmpdir(), 'openp-codex-home-'));
  await writeFile(join(codexHome, 'sessions'), 'not a directory\n');
  process.env.CODEX_HOME = codexHome;

  try {
    await assert.rejects(
      () => findCodexSessionLogPath('abc'),
      (error) => error instanceof OpenPError
        && error.exitCode === EXIT_CODES.protocolViolation
        && error.message.includes('session log directory is unreadable'),
    );
  } finally {
    if (prev === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = prev;
    }
  }
});

// A turn that runs tools reports usage more than once, and the two numbers derived from those
// records come from opposite ends of the run: the whole-turn usage is their sum, while the last
// subturn's usage and the context window are whatever the final record said.
test('extractSessionLogResult sums turn usage across token counts but takes the last subturn from the final one', () => {
  const tokenCount = (input: number, output: number, cached: number, window: number) => JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        model_context_window: window,
        last_token_usage: { input_tokens: input, output_tokens: output, cached_input_tokens: cached },
      },
    },
  });
  const log = [
    codexUserTurn('fixture prompt'),
    tokenCount(500, 20, 100, 128000),
    tokenCount(900, 40, 300, 200000),
    JSON.stringify({
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'FIXTURE-ANSWER' }] },
    }),
    JSON.stringify({ type: 'turn.completed', session_id: 'ses-fixture-token-counts' }),
  ].join('\n');

  const result = extractSessionLogResult(log);
  // Cache reads are reported separately, so each record contributes input_tokens - cached.
  assert.deepEqual(result.usage, { inputTokens: 1000, outputTokens: 60, cacheReadInputTokens: 400 });
  assert.deepEqual(result.lastSubturnUsage, { inputTokens: 600, outputTokens: 40, cacheReadInputTokens: 300 });
  assert.equal(result.contextWindow, 200000);
});

// Codex writes usage records that carry no usable count. Reading one as if it did would replace a
// real subturn's numbers with an empty one, so each is skipped and the last real record still
// stands as the latest.
test('extractSessionLogResult skips usage records that state no usable input count', () => {
  const usageRecord = (info: unknown) => JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info } });
  const log = [
    codexUserTurn('fixture prompt'),
    usageRecord({ model_context_window: 128000, last_token_usage: { input_tokens: 500, output_tokens: 20, cached_input_tokens: 100 } }),
    usageRecord({ model_context_window: 999999, last_token_usage: { input_tokens: 0, output_tokens: 99, cached_input_tokens: 0 } }),
    usageRecord({ model_context_window: 888888 }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'token_count' } }),
    JSON.stringify({
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'FIXTURE-ANSWER' }] },
    }),
    JSON.stringify({ type: 'turn.completed', session_id: 'ses-fixture-unusable-usage' }),
  ].join('\n');

  const result = extractSessionLogResult(log);
  assert.deepEqual(result.usage, { inputTokens: 400, outputTokens: 20, cacheReadInputTokens: 100 });
  assert.deepEqual(result.lastSubturnUsage, { inputTokens: 400, outputTokens: 20, cacheReadInputTokens: 100 });
  assert.equal(result.contextWindow, 128000);
});

// Cache reads are subtracted from the input count, so a record that states no cache read has to
// leave the input count whole rather than treat the absent field as some other number.
test('extractSessionLogResult keeps the input count whole when a usage record states no cache read', () => {
  const log = [
    codexUserTurn('fixture prompt'),
    JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { model_context_window: 128000, last_token_usage: { input_tokens: 700, output_tokens: 30 } },
      },
    }),
    JSON.stringify({
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'FIXTURE-ANSWER' }] },
    }),
    JSON.stringify({ type: 'turn.completed', session_id: 'ses-fixture-no-cache-read' }),
  ].join('\n');

  const result = extractSessionLogResult(log);
  assert.deepEqual(result.usage, { inputTokens: 700, outputTokens: 30, cacheReadInputTokens: null });
  assert.deepEqual(result.lastSubturnUsage, { inputTokens: 700, outputTokens: 30, cacheReadInputTokens: null });
});

test('extractSessionLogResult extracts content, reasoning, commentary, usage, and session id', () => {
  const log = [
    JSON.stringify({ type: 'turn_context', payload: { model: 'codex-mini' } }),
    JSON.stringify({ type: 'thread.started', thread_id: 'ses-111' }),
    codexUserTurn(),
    JSON.stringify({
      type: 'response_item',
      payload: { type: 'reasoning', summary: [{ text: 'thinking about it' }] },
    }),
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message', role: 'assistant', phase: 'commentary',
        content: [{ type: 'output_text', text: 'checking files...' }],
      },
    }),
    JSON.stringify({
      type: 'event_msg',
      payload: { type: 'agent_message', phase: 'progress', message: 'running tests...' },
    }),
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'function_call',
        call_id: 'call_1',
        name: 'shell',
        arguments: '{"cmd":"npm test"}',
      },
    }),
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'call_1',
        output: 'ok',
      },
    }),
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'custom_tool_call',
        call_id: 'call_patch',
        name: 'apply_patch',
        input: '*** Begin Patch\n*** End Patch\n',
      },
    }),
    JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'patch_apply_end',
        call_id: 'call_patch',
        stdout: 'Success. Updated files\n',
        stderr: '',
        success: true,
        changes: { 'data/result.txt': { type: 'add', content: 'ok\n' } },
        status: 'completed',
      },
    }),
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'custom_tool_call_output',
        call_id: 'call_patch',
        output: '{"output":"ok","metadata":{"exit_code":0}}',
      },
    }),
    JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          model_context_window: 128000,
          last_token_usage: { input_tokens: 500, output_tokens: 20, cached_input_tokens: 100 },
        },
      },
    }),
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message', role: 'assistant',
        content: [{ type: 'output_text', text: 'result answer' }],
      },
    }),
    JSON.stringify({
      type: 'turn.completed',
      session_id: 'ses-111',
      result: 'result answer from turn.completed',
      usage: { input_tokens: 800, output_tokens: 30, cached_input_tokens: 200 },
    }),
  ].join('\n');

  const result = extractSessionLogResult(log);
  assert.equal(result.content, 'result answer from turn.completed');
  assert.equal(result.reasoningContent, 'thinking about it');
  assert.equal(result.sessionId, 'ses-111');
  assert.equal(result.model, 'codex-mini');
  assert.equal(result.contextWindow, 128000);
  // usage comes from token_count last_token_usage sums; turn.completed.usage
  // (a stdout-only shape absent from real session logs) must be ignored here.
  assert.deepEqual(result.usage, { inputTokens: 400, outputTokens: 20, cacheReadInputTokens: 100 });
  assert.deepEqual(result.lastSubturnUsage, { inputTokens: 400, outputTokens: 20, cacheReadInputTokens: 100 });
  assert.equal(result.commentaryEvents.length, 8);
  const c0 = result.commentaryEvents[0]!.message.content as any[];
  assert.equal(c0[0].text, 'checking files...');
  const c1 = result.commentaryEvents[1]!.message.content as any[];
  assert.equal(c1[0].text, 'running tests...');
  const c2 = result.commentaryEvents[2]!.message.content as any[];
  assert.equal(c2[0].type, 'tool_use');
  assert.equal(c2[0].name, 'shell');
  assert.deepEqual(c2[0].input, { cmd: 'npm test' });
  const c3 = result.commentaryEvents[3]!.message.content as any[];
  assert.equal(c3[0].type, 'tool_result');
  assert.equal(c3[0].tool_use_id, 'call_1');
  assert.equal(c3[0].content, 'ok');
  const c4 = result.commentaryEvents[4]!.message.content as any[];
  assert.equal(c4[0].type, 'tool_use');
  assert.equal(c4[0].id, 'call_patch');
  assert.equal(c4[0].name, 'apply_patch');
  assert.equal(c4[0].input, '*** Begin Patch\n*** End Patch\n');
  const c5 = result.commentaryEvents[5]!.message.content as any[];
  assert.equal(c5[0].type, 'tool_result');
  assert.equal(c5[0].tool_use_id, 'call_patch');
  assert.match(c5[0].content, /Success\. Updated files/);
  const c6 = result.commentaryEvents[6]!.message.content as any[];
  assert.equal(c6[0].type, 'tool_result');
  assert.equal(c6[0].tool_use_id, 'call_patch');
  assert.match(c6[0].content, /"output":"ok"/);
  const c7 = result.commentaryEvents[7]!.message.content as any[];
  assert.equal(c7[0].text, 'result answer');
});

test('extractSessionLogResult preserves synthetic Codex tool-use session-log fixture artifacts', () => {
  const result = extractSessionLogResult(readCodexSessionLogFixture('fixture-session-log-tool-use-file.jsonl'));
  const blocks = firstBlocks(result.commentaryEvents);
  const publicOutput = openPOutputForCodexSessionResult(result);

  assert.equal(result.content?.includes('sum=15'), true);
  assert.equal(result.content?.length, 160);
  assert.equal(result.commentaryEvents.length, 15);
  assert.deepEqual(blocks.map((block) => block.type), [
    'text',
    'tool_use',
    'tool_use',
    'tool_result',
    'tool_result',
    'text',
    'tool_use',
    'tool_result',
    'tool_result',
    'text',
    'tool_use',
    'tool_use',
    'tool_result',
    'tool_result',
    'text',
  ]);
  assert.equal(result.model, 'fixture-codex-model');
  assert.equal(result.contextWindow, 200000);
  assert.deepEqual(result.lastSubturnUsage, {
    inputTokens: 500,
    outputTokens: 320,
    cacheReadInputTokens: 2000,
  });
  assert.equal(publicOutput.answer.length, 4);
  assert.equal(publicOutput.toolCall.length, 5);
  assert.equal(publicOutput.toolResult.length, 6);
  assert.equal(publicOutput.reasoning.length, 0);
});

test('extractSessionLogResult preserves synthetic Codex structured-output session-log fixture', () => {
  const result = extractSessionLogResult(readCodexSessionLogFixture('fixture-session-log-structured-output.jsonl'));
  const structured = JSON.parse(result.content ?? 'null');

  assert.equal(result.content?.length, 290);
  assert.equal(result.commentaryEvents.length, 1);
  assert.equal(result.model, 'fixture-codex-model');
  assert.equal(result.contextWindow, 200000);
  assert.deepEqual(result.lastSubturnUsage, {
    inputTokens: 3000,
    outputTokens: 350,
    cacheReadInputTokens: 1200,
  });
  assert.equal(structured.stdoutRelation.includes('fixture stdout relation'), true);
  assert.equal(Array.isArray(structured.checks), true);
});

test('extractSessionLogResult falls back to response_item when turn.completed has no result', () => {
  const log = [
    codexUserTurn(),
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message', role: 'assistant', phase: 'final_answer',
        content: [{ type: 'output_text', text: 'fallback answer' }],
      },
    }),
    JSON.stringify({ type: 'turn.completed', session_id: 'ses-222' }),
  ].join('\n');

  const result = extractSessionLogResult(log);
  assert.equal(result.content, 'fallback answer');
});

test('extractSessionLogResult preserves repeated equal final answers from different native items', () => {
  const log = [
    codexUserTurn(),
    JSON.stringify({
      type: 'response_item',
      payload: {
        id: 'resp_1',
        type: 'message', role: 'assistant', phase: 'final_answer',
        content: [{ type: 'output_text', text: 'repeat answer' }],
      },
    }),
    JSON.stringify({
      type: 'response_item',
      payload: {
        id: 'resp_2',
        type: 'message', role: 'assistant', phase: 'final_answer',
        content: [{ type: 'output_text', text: 'repeat answer' }],
      },
    }),
    JSON.stringify({ type: 'turn.completed', session_id: 'ses-repeat', result: 'repeat answer' }),
  ].join('\n');

  const result = extractSessionLogResult(log);
  const publicOutput = openPOutputForCodexSessionResult(result);

  assert.equal(result.commentaryEvents.length, 2);
  assert.deepEqual(publicOutput.answer, ['repeat answer', 'repeat answer']);
});

test('extractSessionLogResult emits one answer for a Codex event_msg/response_item mirror pair', () => {
  const log = [
    codexUserTurn(),
    JSON.stringify({
      type: 'event_msg',
      payload: { type: 'agent_message', phase: 'commentary', message: 'checking files...' },
    }),
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        phase: 'commentary',
        content: [{ type: 'output_text', text: 'checking files...' }],
      },
    }),
    JSON.stringify({ type: 'turn.completed', session_id: 'ses-equal-artifacts', result: 'done' }),
  ].join('\n');

  const result = extractSessionLogResult(log);
  const publicOutput = openPOutputForCodexSessionResult(result);

  assert.equal(result.commentaryEvents.length, 1);
  assert.deepEqual(publicOutput.answer, ['checking files...', 'done']);
});

test('extractSessionLogResult preserves an equal response_item after an intervening record', () => {
  const log = [
    codexUserTurn(),
    JSON.stringify({
      type: 'event_msg',
      payload: { type: 'agent_message', phase: 'commentary', message: 'checking files...' },
    }),
    JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-test' } }),
    JSON.stringify({
      type: 'response_item',
      payload: {
        id: 'response_after_boundary',
        type: 'message',
        role: 'assistant',
        phase: 'commentary',
        content: [{ type: 'output_text', text: 'checking files...' }],
      },
    }),
    JSON.stringify({ type: 'turn.completed', session_id: 'ses-separated-artifacts', result: 'done' }),
  ].join('\n');

  const result = extractSessionLogResult(log);
  const publicOutput = openPOutputForCodexSessionResult(result);

  assert.equal(result.commentaryEvents.length, 2);
  assert.deepEqual(publicOutput.answer, ['checking files...', 'checking files...', 'done']);
});

test('extractSessionLogResult preserves adjacent messages whose native text differs', () => {
  const log = [
    codexUserTurn(),
    JSON.stringify({
      type: 'event_msg',
      payload: { type: 'agent_message', phase: 'commentary', message: 'checking files...' },
    }),
    JSON.stringify({
      type: 'response_item',
      payload: {
        id: 'response_with_trailing_newline',
        type: 'message',
        role: 'assistant',
        phase: 'commentary',
        content: [{ type: 'output_text', text: 'checking files...\n' }],
      },
    }),
    JSON.stringify({ type: 'turn.completed', session_id: 'ses-distinct-native-text', result: 'done' }),
  ].join('\n');

  const result = extractSessionLogResult(log);
  const publicOutput = openPOutputForCodexSessionResult(result);

  assert.equal(result.commentaryEvents.length, 2);
  assert.deepEqual(publicOutput.answer, ['checking files...', 'checking files...', 'done']);
});

test('extractSessionLogResult preserves item.started stdout tool artifacts', () => {
  const log = [
    codexUserTurn(),
    JSON.stringify({
      type: 'item.started',
      item: {
        id: 'cmd_1',
        type: 'command_execution',
        command: 'npm test',
        status: 'in_progress',
      },
    }),
    JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'cmd_1',
        type: 'command_execution',
        command: 'npm test',
        aggregated_output: 'ok',
        exit_code: 0,
        status: 'completed',
      },
    }),
    JSON.stringify({
      type: 'item.started',
      item: {
        id: 'file_1',
        type: 'file_change',
        changes: [{ path: 'README.md', kind: 'modify' }],
        status: 'in_progress',
      },
    }),
    JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'file_1',
        type: 'file_change',
        changes: [{ path: 'README.md', kind: 'modify' }],
        status: 'completed',
      },
    }),
    JSON.stringify({ type: 'turn.completed', session_id: 'ses-tool', result: 'done' }),
  ].join('\n');

  const result = extractSessionLogResult(log);
  assert.equal(result.content, 'done');
  assert.equal(result.commentaryEvents.length, 4);
  const commandStart = result.commentaryEvents[0]!.message.content as any[];
  assert.equal(commandStart[0].type, 'tool_use');
  assert.equal(commandStart[0].id, 'cmd_1');
  assert.equal(commandStart[0].name, 'command_execution');
  assert.deepEqual(commandStart[0].input, { command: 'npm test', status: 'in_progress' });
  const commandEnd = result.commentaryEvents[1]!.message.content as any[];
  assert.equal(commandEnd[0].type, 'tool_result');
  assert.equal(commandEnd[0].tool_use_id, 'cmd_1');
  assert.match(commandEnd[0].content, /"output":"ok"/);
  const fileStart = result.commentaryEvents[2]!.message.content as any[];
  assert.equal(fileStart[0].type, 'tool_use');
  assert.equal(fileStart[0].id, 'file_1');
  assert.equal(fileStart[0].name, 'file_change');
  const fileEnd = result.commentaryEvents[3]!.message.content as any[];
  assert.equal(fileEnd[0].type, 'tool_result');
  assert.equal(fileEnd[0].tool_use_id, 'file_1');
});

test('extractSessionLogResult rejects malformed non-empty JSONL lines', () => {
  const log = [
    JSON.stringify({ type: 'turn_context', payload: { model: 'codex-mini' } }),
    '{not json',
    JSON.stringify({ type: 'turn.completed', session_id: 'ses-bad', result: 'done' }),
  ].join('\n');

  assert.throws(
    () => extractSessionLogResult(log),
    (error) => error instanceof OpenPError &&
      error.exitCode === EXIT_CODES.protocolViolation &&
      error.reasonCode === 'unsupported_artifact_shape' &&
      error.message.includes('Codex session log contains malformed JSONL'),
  );
});

test('readCodexSessionLogResult propagates malformed readable session log errors', async () => {
  const prev = process.env.CODEX_HOME;
  const codexHome = await mkdtemp(join(tmpdir(), 'openp-codex-home-'));
  const sessionDir = join(codexHome, 'sessions', '2026', '05', '20');
  await mkdir(sessionDir, { recursive: true });
  process.env.CODEX_HOME = codexHome;

  try {
    await writeFile(join(sessionDir, 'rollout-ses-bad.jsonl'), [
      JSON.stringify({ type: 'thread.started', thread_id: 'ses-bad' }),
      '{not json',
      JSON.stringify({ type: 'turn.completed', session_id: 'ses-bad', result: 'done' }),
      '',
    ].join('\n'));
    await assert.rejects(
      () => readCodexSessionLogResult('ses-bad'),
      /Codex session log contains malformed JSONL/,
    );
  } finally {
    if (prev === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = prev;
    }
  }
});

test('extractSessionLogResult falls back to final_answer event_msg when turn.completed has no result', () => {
  const log = [
    codexUserTurn(),
    JSON.stringify({
      type: 'event_msg',
      payload: { type: 'agent_message', phase: 'final_answer', message: 'event final' },
    }),
    JSON.stringify({ type: 'turn.completed', session_id: 'ses-223' }),
  ].join('\n');

  const result = extractSessionLogResult(log);
  assert.equal(result.content, 'event final');
  assert.equal(result.commentaryEvents.length, 1);
  const event = result.commentaryEvents[0]!.message.content as any[];
  assert.equal(event[0].text, 'event final');
});

test('extractSessionLogResult falls back to unphased event_msg when turn.completed has no result', () => {
  const log = [
    codexUserTurn(),
    JSON.stringify({
      type: 'event_msg',
      payload: { type: 'agent_message', message: 'event final' },
    }),
    JSON.stringify({ type: 'turn.completed', session_id: 'ses-225' }),
  ].join('\n');

  const result = extractSessionLogResult(log);
  assert.equal(result.content, 'event final');
  assert.equal(result.commentaryEvents.length, 1);
  const event = result.commentaryEvents[0]!.message.content as any[];
  assert.equal(event[0].text, 'event final');
});

test('extractSessionLogResult falls back to final_answer item.completed when turn.completed has no result', () => {
  const log = [
    codexUserTurn(),
    JSON.stringify({
      type: 'item.completed',
      item: { id: 'item_0', type: 'agent_message', phase: 'final_answer', text: 'item final' },
    }),
    JSON.stringify({ type: 'turn.completed', session_id: 'ses-224' }),
  ].join('\n');

  const result = extractSessionLogResult(log);
  assert.equal(result.content, 'item final');
  assert.equal(result.commentaryEvents.length, 1);
  const event = result.commentaryEvents[0]!.message.content as any[];
  assert.equal(event[0].text, 'item final');
});

test('extractSessionLogResult falls back to unphased item.completed when turn.completed has no result', () => {
  const log = [
    codexUserTurn(),
    JSON.stringify({
      type: 'item.completed',
      item: { id: 'item_0', type: 'agent_message', text: 'item final' },
    }),
    JSON.stringify({ type: 'turn.completed', session_id: 'ses-226' }),
  ].join('\n');

  const result = extractSessionLogResult(log);
  assert.equal(result.content, 'item final');
  assert.equal(result.commentaryEvents.length, 1);
  const event = result.commentaryEvents[0]!.message.content as any[];
  assert.equal(event[0].text, 'item final');
});

test('extractSessionLogResult returns empty commentary when no commentary events', () => {
  const log = [
    codexUserTurn(),
    JSON.stringify({
      type: 'turn.completed',
      result: 'answer',
      session_id: 'ses-333',
      usage: { input_tokens: 100, output_tokens: 10 },
    }),
  ].join('\n');

  const result = extractSessionLogResult(log);
  assert.equal(result.content, 'answer');
  assert.equal(result.commentaryEvents.length, 0);
  assert.equal(result.reasoningContent, null);
});

function codexTokenCount(
  total: { input: number; cached: number; output: number },
  last: { input: number; cached: number; output: number },
): string {
  return JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: total.input,
          cached_input_tokens: total.cached,
          output_tokens: total.output,
        },
        last_token_usage: {
          input_tokens: last.input,
          cached_input_tokens: last.cached,
          output_tokens: last.output,
        },
        model_context_window: 400000,
      },
    },
  });
}

test('extractSessionLogResult fills aggregate usage from a single token_count last_token_usage', () => {
  const log = [
    codexUserTurn(),
    // total deliberately differs from last (resumed session): using total must fail.
    codexTokenCount({ input: 9999, cached: 8888, output: 777 }, { input: 500, cached: 100, output: 20 }),
    JSON.stringify({
      type: 'event_msg',
      payload: { type: 'agent_message', phase: 'final_answer', message: 'single subturn answer' },
    }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }),
  ].join('\n');

  const result = extractSessionLogResult(log);
  assert.equal(result.content, 'single subturn answer');
  assert.deepEqual(result.usage, { inputTokens: 400, outputTokens: 20, cacheReadInputTokens: 100 });
  assert.deepEqual(result.lastSubturnUsage, { inputTokens: 400, outputTokens: 20, cacheReadInputTokens: 100 });
});

test('extractSessionLogResult keeps fully cached token_count subturns valid', () => {
  const log = [
    codexUserTurn(),
    codexTokenCount({ input: 50000, cached: 49000, output: 5 }, { input: 50000, cached: 49000, output: 5 }),
    JSON.stringify({
      type: 'event_msg',
      payload: { type: 'agent_message', phase: 'final_answer', message: 'cached answer' },
    }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }),
  ].join('\n');

  const result = extractSessionLogResult(log);
  assert.equal(result.content, 'cached answer');
  assert.deepEqual(result.lastSubturnUsage, {
    inputTokens: 1000,
    outputTokens: 5,
    cacheReadInputTokens: 49000,
  });
  assert.equal(
    (result.lastSubturnUsage?.inputTokens ?? 0) + (result.lastSubturnUsage?.cacheReadInputTokens ?? 0),
    50000,
  );
  assert.equal(result.contextWindow, 400000);
});

test('extractSessionLogResult sums aggregate usage across multi-subturn token_count events', () => {
  // Each record states a session-cumulative total beside the subturn's own usage. Only the subturn
  // figures may be summed; adding the cumulative ones would count every earlier subturn again. The
  // counts here are invented round numbers chosen so both readings are distinguishable by eye.
  const log = [
    codexUserTurn(),
    codexTokenCount({ input: 10000, cached: 2000, output: 100 }, { input: 10000, cached: 2000, output: 100 }),
    codexTokenCount({ input: 30000, cached: 10000, output: 300 }, { input: 20000, cached: 8000, output: 200 }),
    codexTokenCount({ input: 60000, cached: 25000, output: 600 }, { input: 30000, cached: 15000, output: 300 }),
    codexTokenCount({ input: 100000, cached: 49000, output: 1000 }, { input: 40000, cached: 24000, output: 400 }),
    JSON.stringify({
      type: 'event_msg',
      payload: { type: 'agent_message', phase: 'final_answer', message: 'multi subturn answer' },
    }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }),
  ].join('\n');

  const result = extractSessionLogResult(log);
  // Subturn inputs net of cache reads: 8000 + 12000 + 15000 + 16000.
  assert.deepEqual(result.usage, {
    inputTokens: 51000,
    outputTokens: 1000,
    cacheReadInputTokens: 49000,
  });
  assert.deepEqual(result.lastSubturnUsage, {
    inputTokens: 16000,
    outputTokens: 400,
    cacheReadInputTokens: 24000,
  });
});

test('extractSessionLogResult scoped resume tail reports the resumed turn usage without session totals', () => {
  // A resumed turn's record still carries the session-cumulative total, which covers turns the
  // caller is not asking about. Only the resumed turn's own usage is this turn's. The two figures
  // are invented and deliberately far apart so a reader taking the wrong one is obvious.
  const resumedTail = [
    codexUserTurn(),
    codexTokenCount({ input: 90000, cached: 30000, output: 900 }, { input: 25000, cached: 5000, output: 50 }),
    JSON.stringify({
      type: 'event_msg',
      payload: { type: 'agent_message', phase: 'final_answer', message: 'resumed turn answer' },
    }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }),
  ].join('\n');

  const result = extractSessionLogResult(resumedTail);
  assert.equal(result.content, 'resumed turn answer');
  assert.deepEqual(result.usage, {
    inputTokens: 20000,
    outputTokens: 50,
    cacheReadInputTokens: 5000,
  });
});

test('extractSessionLogResult keeps usage null without token_count events', () => {
  const log = [
    codexUserTurn(),
    JSON.stringify({
      type: 'event_msg',
      payload: { type: 'agent_message', phase: 'final_answer', message: 'answer without usage' },
    }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }),
  ].join('\n');

  const result = extractSessionLogResult(log);
  assert.equal(result.content, 'answer without usage');
  assert.deepEqual(result.usage, { inputTokens: null, outputTokens: null, cacheReadInputTokens: null });
  assert.equal(result.lastSubturnUsage, null);
});

test('extractSessionLogResult rejects missing active turn boundary', () => {
  const log = [
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message', role: 'assistant',
        content: [{ type: 'output_text', text: 'stale answer' }],
      },
    }),
    JSON.stringify({ type: 'turn.completed', session_id: 'ses-stale', result: 'stale answer' }),
  ].join('\n');

  assert.throws(
    () => extractSessionLogResult(log),
    (error) => error instanceof OpenPError &&
      error.exitCode === EXIT_CODES.protocolViolation &&
      error.reasonCode === 'missing_turn_boundary' &&
      error.message.includes('Codex session log is missing active turn boundary'),
  );
});

test('extractSessionLogResult rejects multiple active turn boundaries', () => {
  const log = [
    codexUserTurn(),
    codexUserTurn(),
    JSON.stringify({ type: 'turn.completed', session_id: 'ses-multi', result: 'answer' }),
  ].join('\n');

  assert.throws(
    () => extractSessionLogResult(log),
    (error) => error instanceof OpenPError &&
      error.exitCode === EXIT_CODES.protocolViolation &&
      error.reasonCode === 'multiple_turn_boundaries' &&
      error.message.includes('Codex session log contains multiple active turn boundaries'),
  );
});

const OWN_TURN = '019f0000-0000-7000-8000-000000000001';
const OTHER_TURN = '019f0000-0000-7000-8000-000000000002';

function taskStarted(turnId: string): string {
  return JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } });
}

function taskComplete(turnId: string): string {
  return JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: turnId } });
}

// The record Codex writes for the settings a turn runs under. It names its turn at the payload top
// level, the same place the task lifecycle records name theirs.
function turnContext(turnId: string, model: string, effort: string, sandboxType: string): string {
  return JSON.stringify({
    type: 'turn_context',
    payload: { turn_id: turnId, model, effort, sandbox_policy: { type: sandboxType } },
  });
}

// A user record Codex injects into the transcript (environment context, AGENTS.md instructions).
// It carries a passthrough turn_id but no `user_message` mirror, so it is not caller evidence.
function injectedUserRecord(text: string, passthroughTurnId?: string): string {
  return JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text }],
      ...(passthroughTurnId
        ? { internal_chat_message_metadata_passthrough: { turn_id: passthroughTurnId } }
        : {}),
    },
  });
}

function assistantMessage(text: string, phase: string, passthroughTurnId?: string): string {
  return JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      phase,
      content: [{ type: 'output_text', text }],
      ...(passthroughTurnId
        ? { internal_chat_message_metadata_passthrough: { turn_id: passthroughTurnId } }
        : {}),
    },
  });
}

// Design test 1: another controller opens a turn while this turn is still running, so both turns'
// records interleave in the segment. The other turn's caller is that turn's boundary, not this
// one's, so the segment still has exactly one active turn boundary.
test('extractSessionLogResult accepts a concurrent turn caller and returns this turn answer', () => {
  const log = [
    taskStarted(OWN_TURN),
    codexUserTurn('own prompt', OWN_TURN),
    assistantMessage('own progress', 'commentary', OWN_TURN),
    taskStarted(OTHER_TURN),
    codexUserTurn('concurrent prompt', OTHER_TURN),
    assistantMessage('concurrent progress', 'commentary', OTHER_TURN),
    assistantMessage('own interleaved progress', 'commentary', OWN_TURN),
    assistantMessage('concurrent turn answer', 'final_answer', OTHER_TURN),
    taskComplete(OTHER_TURN),
    assistantMessage('own turn answer', 'final_answer', OWN_TURN),
    taskComplete(OWN_TURN),
  ].join('\n');

  const result = extractSessionLogResult(log);
  assert.equal(result.content, 'own turn answer');
  assert.equal(result.hasCompletionEvidence, true);
});

// A turn_context produces no output, so output attribution never filters it. Left unbound, the
// concurrent turn's record is the last one read and its settings are reported as this turn's --
// which would make the reported effort and permission mode describe a turn the caller never ran.
test('extractSessionLogResult keeps a concurrent turn settings out of this turn diagnostics', () => {
  const log = [
    taskStarted(OWN_TURN),
    codexUserTurn('own prompt', OWN_TURN),
    turnContext(OWN_TURN, 'fixture-model-own', 'fixture-effort-own', 'fixture-sandbox-own'),
    taskStarted(OTHER_TURN),
    codexUserTurn('concurrent prompt', OTHER_TURN),
    turnContext(OTHER_TURN, 'fixture-model-other', 'fixture-effort-other', 'fixture-sandbox-other'),
    assistantMessage('concurrent turn answer', 'final_answer', OTHER_TURN),
    taskComplete(OTHER_TURN),
    assistantMessage('own turn answer', 'final_answer', OWN_TURN),
    taskComplete(OWN_TURN),
  ].join('\n');

  const result = extractSessionLogResult(log);
  assert.equal(result.content, 'own turn answer');
  assert.equal(result.model, 'fixture-model-own');
  assert.equal(result.effort, 'fixture-effort-own');
  assert.equal(result.permissionMode, 'fixture-sandbox-own');
});

// A concurrent turn_context that names no turn cannot be bound to a turn. Reporting nothing is the
// honest answer; reporting it anyway would attribute another turn's settings to this one.
test('extractSessionLogResult reports no settings for a concurrent turn_context that names no turn', () => {
  const log = [
    taskStarted(OWN_TURN),
    codexUserTurn('own prompt', OWN_TURN),
    taskStarted(OTHER_TURN),
    codexUserTurn('concurrent prompt', OTHER_TURN),
    JSON.stringify({
      type: 'turn_context',
      payload: { model: 'fixture-model-other', effort: 'fixture-effort-other' },
    }),
    assistantMessage('concurrent turn answer', 'final_answer', OTHER_TURN),
    taskComplete(OTHER_TURN),
    assistantMessage('own turn answer', 'final_answer', OWN_TURN),
    taskComplete(OWN_TURN),
  ].join('\n');

  const result = extractSessionLogResult(log);
  assert.equal(result.content, 'own turn answer');
  assert.equal(result.model, null);
  assert.equal(result.effort, null);
  assert.equal(result.permissionMode, null);
});

// A turn whose caller was written before this segment begins is not one of the segment's callers,
// so nothing marks the segment as holding more than one turn. Records that turn writes afterwards
// still land here, and a turn_context among them would otherwise be read as this turn's.
test('extractSessionLogResult keeps out a turn_context naming another turn in a single-caller segment', () => {
  const log = [
    taskStarted(OWN_TURN),
    codexUserTurn('own prompt', OWN_TURN),
    turnContext(OWN_TURN, 'fixture-model-own', 'fixture-effort-own', 'fixture-sandbox-own'),
    turnContext(OTHER_TURN, 'fixture-model-other', 'fixture-effort-other', 'fixture-sandbox-other'),
    assistantMessage('own turn answer', 'final_answer', OWN_TURN),
    taskComplete(OWN_TURN),
  ].join('\n');

  const result = extractSessionLogResult(log);
  assert.equal(result.content, 'own turn answer');
  assert.equal(result.model, 'fixture-model-own');
  assert.equal(result.effort, 'fixture-effort-own');
  assert.equal(result.permissionMode, 'fixture-sandbox-own');
});

// Ordering decides what an unchecked record costs: a record this turn cannot claim that lands after
// this turn's own would otherwise overwrite settings that were already known to be right.
// Most Codex logs name the caller's turn through the open turn window rather than on the caller
// record itself, and the settings comparison is only as good as that binding. Without this, dropping
// the window fallback reports no settings at all for that whole shape and no test notices.
test('extractSessionLogResult reports settings for a caller bound to its turn by the open window', () => {
  const log = [
    taskStarted(OWN_TURN),
    codexUserTurn('own prompt'),
    turnContext(OWN_TURN, 'fixture-model-own', 'fixture-effort-own', 'fixture-sandbox-own'),
    assistantMessage('own turn answer', 'final_answer'),
    taskComplete(OWN_TURN),
  ].join('\n');

  const result = extractSessionLogResult(log);
  assert.equal(result.content, 'own turn answer');
  assert.equal(result.model, 'fixture-model-own');
  assert.equal(result.effort, 'fixture-effort-own');
  assert.equal(result.permissionMode, 'fixture-sandbox-own');
});

// A record with no payload states no settings and names no turn, so it says nothing about this turn
// and must not clear what a record that did name this turn already established.
test('extractSessionLogResult keeps settings a named record established when a payload-less record follows', () => {
  const log = [
    taskStarted(OWN_TURN),
    codexUserTurn('own prompt', OWN_TURN),
    turnContext(OWN_TURN, 'fixture-model-own', 'fixture-effort-own', 'fixture-sandbox-own'),
    JSON.stringify({ type: 'turn_context' }),
    assistantMessage('own turn answer', 'final_answer', OWN_TURN),
    taskComplete(OWN_TURN),
  ].join('\n');

  const result = extractSessionLogResult(log);
  assert.equal(result.content, 'own turn answer');
  assert.equal(result.model, 'fixture-model-own');
  assert.equal(result.effort, 'fixture-effort-own');
  assert.equal(result.permissionMode, 'fixture-sandbox-own');
});

test('extractSessionLogResult keeps the settings of the turn that named itself over a later unnamed record', () => {
  const log = [
    taskStarted(OWN_TURN),
    codexUserTurn('own prompt', OWN_TURN),
    turnContext(OWN_TURN, 'fixture-model-own', 'fixture-effort-own', 'fixture-sandbox-own'),
    JSON.stringify({
      type: 'turn_context',
      payload: {
        model: 'fixture-model-unnamed',
        effort: 'fixture-effort-unnamed',
        sandbox_policy: { type: 'fixture-sandbox-unnamed' },
      },
    }),
    assistantMessage('own turn answer', 'final_answer', OWN_TURN),
    taskComplete(OWN_TURN),
  ].join('\n');

  const result = extractSessionLogResult(log);
  assert.equal(result.content, 'own turn answer');
  assert.equal(result.model, 'fixture-model-own');
  assert.equal(result.effort, 'fixture-effort-own');
  assert.equal(result.permissionMode, 'fixture-sandbox-own');
});

// A caller that carries no turn evidence leaves this turn without a turn to compare against, so a
// record naming some other turn cannot be shown to be this turn's however few callers are present.
test('extractSessionLogResult reports no settings for a named turn_context when the caller names no turn', () => {
  const log = [
    codexUserTurn('own prompt'),
    turnContext(OTHER_TURN, 'fixture-model-other', 'fixture-effort-other', 'fixture-sandbox-other'),
    JSON.stringify({
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'own turn answer' }] },
    }),
    JSON.stringify({ type: 'turn.completed', session_id: 'ses-fixture-unbound-caller' }),
  ].join('\n');

  const result = extractSessionLogResult(log);
  assert.equal(result.content, 'own turn answer');
  assert.equal(result.model, null);
  assert.equal(result.effort, null);
  assert.equal(result.permissionMode, null);
});

// Design test 2: two callers bound to this same turn are a split prompt submission, which the
// input-submission protocol still rejects.
test('extractSessionLogResult rejects two callers bound to the same turn', () => {
  const log = [
    taskStarted(OWN_TURN),
    codexUserTurn('first half', OWN_TURN),
    codexUserTurn('second half', OWN_TURN),
    assistantMessage('own turn answer', 'final_answer', OWN_TURN),
    taskComplete(OWN_TURN),
  ].join('\n');

  assert.throws(
    () => extractSessionLogResult(log),
    (error) => error instanceof OpenPError &&
      error.exitCode === EXIT_CODES.protocolViolation &&
      error.reasonCode === 'multiple_turn_boundaries',
  );
});

// Design test 3: a `user_message` mirror with no preceding user record is not caller evidence.
test('extractSessionLogResult rejects a segment whose only user evidence is an orphan mirror', () => {
  const log = [
    taskStarted(OWN_TURN),
    JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'orphan mirror' } }),
    assistantMessage('own turn answer', 'final_answer', OWN_TURN),
    taskComplete(OWN_TURN),
  ].join('\n');

  assert.throws(
    () => extractSessionLogResult(log),
    (error) => error instanceof OpenPError &&
      error.exitCode === EXIT_CODES.protocolViolation &&
      error.reasonCode === 'missing_turn_boundary',
  );
});

// Design test 4: a window-bound (pre-passthrough) caller with no passthrough binds to the open
// task_started window, so the segment still resolves its own active turn boundary.
test('extractSessionLogResult attributes a window-bound caller without passthrough by open window', () => {
  const log = [
    taskStarted(OWN_TURN),
    codexUserTurn('own prompt'),
    assistantMessage('own progress', 'commentary'),
    assistantMessage('own turn answer', 'final_answer'),
    taskComplete(OWN_TURN),
  ].join('\n');

  const result = extractSessionLogResult(log);
  assert.equal(result.content, 'own turn answer');
  assert.equal(result.hasCompletionEvidence, true);
});

// A concurrent segment whose output records carry no turn evidence (window-bound generation) is not
// resolvable. Open-window position is not output evidence, so this keeps failing exactly as it does
// on the released contract rather than answering from a guess.
test('extractSessionLogResult fails closed on a concurrent segment with window-bound output', () => {
  const log = [
    taskStarted(OWN_TURN),
    codexUserTurn('own prompt'),
    assistantMessage('own progress', 'commentary'),
    taskStarted(OTHER_TURN),
    codexUserTurn('concurrent prompt'),
    assistantMessage('concurrent turn answer', 'final_answer'),
    taskComplete(OTHER_TURN),
    assistantMessage('own turn answer', 'final_answer'),
    taskComplete(OWN_TURN),
  ].join('\n');

  assert.throws(
    () => extractSessionLogResult(log),
    (error) => error instanceof OpenPError &&
      error.exitCode === EXIT_CODES.protocolViolation &&
      error.reasonCode === 'multiple_turn_boundaries' &&
      error.message.includes('Codex session log contains multiple active turn boundaries'),
  );
});

// An `event_msg agent_message` with no mirror partner carries no turn id at all. Inside a concurrent
// segment it is not resolvable and must fail closed.
test('extractSessionLogResult fails closed on a concurrent segment with an orphan agent_message', () => {
  const log = [
    taskStarted(OWN_TURN),
    codexUserTurn('own prompt', OWN_TURN),
    taskStarted(OTHER_TURN),
    codexUserTurn('concurrent prompt', OTHER_TURN),
    JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'orphan progress', phase: 'commentary' } }),
    assistantMessage('own turn answer', 'final_answer', OWN_TURN),
    taskComplete(OWN_TURN),
  ].join('\n');

  assert.throws(
    () => extractSessionLogResult(log),
    (error) => error instanceof OpenPError &&
      error.exitCode === EXIT_CODES.protocolViolation &&
      error.reasonCode === 'multiple_turn_boundaries',
  );
});

// Boundary guard: a segment with a single caller turn is untouched. Every output is this turn's, so
// records without turn evidence stay in the result and no attribution check applies.
test('extractSessionLogResult leaves a single-caller-turn segment untouched despite unbound output', () => {
  const log = [
    taskStarted(OWN_TURN),
    codexUserTurn('own prompt', OWN_TURN),
    JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'orphan progress', phase: 'commentary' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'reasoning', summary: [{ text: 'unbound reasoning' }] } }),
    assistantMessage('own turn answer', 'final_answer'),
    taskComplete(OWN_TURN),
  ].join('\n');

  const result = extractSessionLogResult(log);
  assert.equal(result.content, 'own turn answer');
  assert.equal(result.reasoningContent, 'unbound reasoning');
  assert.equal(result.commentaryEvents.length, 2);
});

// The ordering risk the boundary fix alone would leave: the concurrent turn's final answer lands
// after this turn's answer but before this turn's task_complete. Selecting the last final answer in
// the segment would silently return the wrong turn's answer.
test('extractSessionLogResult keeps this turn answer when a concurrent final answer lands last', () => {
  const log = [
    taskStarted(OWN_TURN),
    codexUserTurn('own prompt', OWN_TURN),
    taskStarted(OTHER_TURN),
    codexUserTurn('concurrent prompt', OTHER_TURN),
    assistantMessage('own turn answer', 'final_answer', OWN_TURN),
    assistantMessage('concurrent turn answer', 'final_answer', OTHER_TURN),
    taskComplete(OTHER_TURN),
    taskComplete(OWN_TURN),
  ].join('\n');

  const result = extractSessionLogResult(log);
  assert.equal(result.content, 'own turn answer');
  assert.notEqual(result.content, 'concurrent turn answer');
});

// Concurrent turn reasoning and tool artifacts are that turn's output and must not enter this
// turn's reasoning or commentary either.
test('extractSessionLogResult keeps concurrent turn reasoning and tools out of this turn output', () => {
  const passthrough = (turnId: string) => ({ internal_chat_message_metadata_passthrough: { turn_id: turnId } });
  const log = [
    taskStarted(OWN_TURN),
    codexUserTurn('own prompt', OWN_TURN),
    JSON.stringify({ type: 'response_item', payload: { type: 'reasoning', summary: [{ text: 'own reasoning' }], ...passthrough(OWN_TURN) } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'function_call', call_id: 'call_own', name: 'own_tool', arguments: '{}', ...passthrough(OWN_TURN) } }),
    taskStarted(OTHER_TURN),
    codexUserTurn('concurrent prompt', OTHER_TURN),
    JSON.stringify({ type: 'response_item', payload: { type: 'reasoning', summary: [{ text: 'concurrent reasoning' }], ...passthrough(OTHER_TURN) } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'function_call', call_id: 'call_other', name: 'concurrent_tool', arguments: '{}', ...passthrough(OTHER_TURN) } }),
    assistantMessage('concurrent turn answer', 'final_answer', OTHER_TURN),
    taskComplete(OTHER_TURN),
    assistantMessage('own turn answer', 'final_answer', OWN_TURN),
    taskComplete(OWN_TURN),
  ].join('\n');

  const result = extractSessionLogResult(log);
  assert.equal(result.content, 'own turn answer');
  assert.equal(result.reasoningContent, 'own reasoning');
  const toolNames = result.commentaryEvents
    .flatMap((event) => (event.message.content as any[]))
    .filter((block) => block?.type === 'tool_use')
    .map((block) => block.name);
  assert.deepEqual(toolNames, ['own_tool']);
});

// Design test 5: injected user records carry a passthrough turn_id but no mirror, so passthrough
// alone must not qualify a caller.
test('extractSessionLogResult does not count mirror-less injected user records as callers', () => {
  const log = [
    taskStarted(OWN_TURN),
    injectedUserRecord('<environment_context>\n  <cwd>/redacted/workspace</cwd>\n</environment_context>', OWN_TURN),
    codexUserTurn('own prompt', OWN_TURN),
    injectedUserRecord('# AGENTS.md instructions for /redacted/workspace', OWN_TURN),
    assistantMessage('own turn answer', 'final_answer', OWN_TURN),
    taskComplete(OWN_TURN),
  ].join('\n');

  const result = extractSessionLogResult(log);
  assert.equal(result.content, 'own turn answer');
});

// Design test 6: regression for the observed run-path failures. A second controller opened a
// concurrent turn while openp's turn was still running, interleaving both turns' records. Before the
// turn-attribution fix this segment failed with exit 40 multiple_turn_boundaries.
test('extractSessionLogResult recovers the openp turn from a synthetic concurrent-turn segment', () => {
  const result = extractSessionLogResult(
    readCodexSessionLogFixture('fixture-session-log-concurrent-turns.jsonl'),
  );
  assert.equal(result.content, 'FIXTURE_OWN_FINAL');
  assert.notEqual(result.content, 'FIXTURE_CONCURRENT_FINAL');
  assert.equal(result.hasCompletionEvidence, true);
  assert.equal(result.model, 'fixture-codex-model');
  assert.deepEqual(result.usage, { inputTokens: 300, outputTokens: 55, cacheReadInputTokens: 1600 });

  // No text from the concurrently running turn reaches this turn's output.
  const texts = result.commentaryEvents.map((event) => (event.message.content as any[])[0]?.text);
  assert.deepEqual(texts, [
    'FIXTURE_OWN_PROGRESS_A',
    'FIXTURE_OWN_PROGRESS_B',
    'FIXTURE_OWN_FINAL',
  ]);
});

test('extractSessionLogResult reports the effort Codex recorded for the turn', () => {
  // Codex writes the effort it ran with onto the same turn_context record that carries the model.
  // Reading only the model there left callers unable to tell which effort a finished turn used.
  const log = [
    codexUserTurn('fixture prompt'),
    JSON.stringify({ type: 'turn_context', payload: { model: 'fixture-model-alpha', effort: 'fixture-effort-alpha' } }),
    JSON.stringify({
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'FIXTURE-ANSWER' }] },
    }),
    JSON.stringify({ type: 'turn.completed', session_id: 'ses-fixture-effort' }),
  ].join('\n');

  const result = extractSessionLogResult(log);
  assert.equal(result.model, 'fixture-model-alpha');
  assert.equal(result.effort, 'fixture-effort-alpha');
});

test('extractSessionLogResult reports a null effort when the turn context states none', () => {
  const log = [
    codexUserTurn('fixture prompt'),
    JSON.stringify({ type: 'turn_context', payload: { model: 'fixture-model-alpha' } }),
    JSON.stringify({
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'FIXTURE-ANSWER' }] },
    }),
    JSON.stringify({ type: 'turn.completed', session_id: 'ses-fixture-effort' }),
  ].join('\n');

  const result = extractSessionLogResult(log);
  assert.equal(result.model, 'fixture-model-alpha');
  assert.equal(result.effort, null);
});

test('extractSessionLogResult does not carry an earlier turn effort into a later one', () => {
  // A later turn_context replaces the whole context, so an effort the caller changed between turns
  // must not read back as the one the previous turn ran with.
  const log = [
    codexUserTurn('fixture prompt'),
    JSON.stringify({ type: 'turn_context', payload: { model: 'fixture-model-alpha', effort: 'fixture-effort-alpha' } }),
    JSON.stringify({ type: 'turn_context', payload: { model: 'fixture-model-beta', effort: 'fixture-effort-beta' } }),
    JSON.stringify({
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'FIXTURE-ANSWER' }] },
    }),
    JSON.stringify({ type: 'turn.completed', session_id: 'ses-fixture-effort' }),
  ].join('\n');

  const result = extractSessionLogResult(log);
  assert.equal(result.model, 'fixture-model-beta');
  assert.equal(result.effort, 'fixture-effort-beta');
});
