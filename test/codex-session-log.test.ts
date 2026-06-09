import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  extractLatestTokenCount,
  extractSessionLogResult,
  findCodexSessionLogPath,
  readCodexSessionLogResult,
} from '../src/backends/codex/session-log.js';
import { EXIT_CODES, OpenPError } from '../src/core/errors.js';
import { formatWorkerTurnResult } from '../src/core/output.js';

function codexUserTurn(): string {
  return JSON.stringify({
    type: 'event_msg',
    payload: { type: 'user_message', message: 'prompt' },
  });
}

function readCodexSessionLogFixture(name: string): string {
  return readFileSync(new URL(`./fixtures/codex/${name}`, import.meta.url), 'utf8');
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
    turnId: 'turn_redacted_fixture',
    backend: 'codex',
  });
  return JSON.parse(output).openp.output;
}

test('extractLatestTokenCount returns null for empty log', () => {
  assert.equal(extractLatestTokenCount(''), null);
  assert.equal(extractLatestTokenCount('\n\n'), null);
});

test('extractLatestTokenCount returns null when no token_count events', () => {
  const log = [
    JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'hello' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [] } }),
  ].join('\n');
  assert.equal(extractLatestTokenCount(log), null);
});

test('extractLatestTokenCount extracts diagnostics from token_count event', () => {
  const log = [
    JSON.stringify({ type: 'turn_context', payload: { model: 'codex-test-model' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'working...' } }),
    JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          model_context_window: 200000,
          last_token_usage: {
            input_tokens: 1500,
            output_tokens: 300,
            cached_input_tokens: 800,
          },
        },
      },
    }),
  ].join('\n');

  const result = extractLatestTokenCount(log);
  assert.ok(result);
  assert.equal(result.inputTokens, 1500);
  assert.equal(result.outputTokens, 300);
  assert.equal(result.cacheReadInputTokens, 800);
  assert.equal(result.contextWindow, 200000);
  assert.equal(result.model, 'codex-test-model');
});

test('extractLatestTokenCount uses the last token_count event', () => {
  const log = [
    JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          model_context_window: 200000,
          last_token_usage: { input_tokens: 100, output_tokens: 10 },
        },
      },
    }),
    JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          model_context_window: 200000,
          last_token_usage: { input_tokens: 2000, output_tokens: 500, cached_input_tokens: 1200 },
        },
      },
    }),
  ].join('\n');

  const result = extractLatestTokenCount(log);
  assert.ok(result);
  assert.equal(result.inputTokens, 2000);
  assert.equal(result.outputTokens, 500);
  assert.equal(result.cacheReadInputTokens, 1200);
});

test('extractLatestTokenCount returns null when input_tokens is 0', () => {
  const log = JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        model_context_window: 200000,
        last_token_usage: { input_tokens: 0, output_tokens: 0 },
      },
    },
  });
  assert.equal(extractLatestTokenCount(log), null);
});

test('extractLatestTokenCount handles missing cached_input_tokens', () => {
  const log = JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        last_token_usage: { input_tokens: 500, output_tokens: 50 },
      },
    },
  });

  const result = extractLatestTokenCount(log);
  assert.ok(result);
  assert.equal(result.inputTokens, 500);
  assert.equal(result.outputTokens, 50);
  assert.equal(result.cacheReadInputTokens, null);
  assert.equal(result.contextWindow, null);
});

test('extractLatestTokenCount ignores malformed lines gracefully', () => {
  const log = [
    'not json at all',
    '{"broken":',
    JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          model_context_window: 128000,
          last_token_usage: { input_tokens: 800, output_tokens: 120 },
        },
      },
    }),
    'trailing garbage',
  ].join('\n');

  const result = extractLatestTokenCount(log);
  assert.ok(result);
  assert.equal(result.inputTokens, 800);
  assert.equal(result.outputTokens, 120);
  assert.equal(result.contextWindow, 128000);
});

test('extractLatestTokenCount returns null for token_count without info', () => {
  const log = JSON.stringify({
    type: 'event_msg',
    payload: { type: 'token_count' },
  });
  assert.equal(extractLatestTokenCount(log), null);
});

test('extractLatestTokenCount returns null for token_count without last_token_usage', () => {
  const log = JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { model_context_window: 200000 },
    },
  });
  assert.equal(extractLatestTokenCount(log), null);
});

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
      /ambiguous Codex session log paths/,
    );
  } finally {
    if (prev === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = prev;
    }
  }
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
  assert.deepEqual(result.usage, { inputTokens: 500, outputTokens: 20, cacheReadInputTokens: 100 });
  assert.deepEqual(result.lastSubturnUsage, { inputTokens: 500, outputTokens: 20, cacheReadInputTokens: 100 });
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

test('extractSessionLogResult preserves redacted Codex tool-use session-log fixture artifacts', () => {
  const result = extractSessionLogResult(readCodexSessionLogFixture('redacted-session-log-tool-use-file.jsonl'));
  const blocks = firstBlocks(result.commentaryEvents);
  const publicOutput = openPOutputForCodexSessionResult(result);

  assert.equal(result.content?.includes('sum=89'), true);
  assert.equal(result.content?.length, 622);
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
  assert.equal(result.model, 'gpt-5.5');
  assert.equal(result.contextWindow, 258400);
  assert.deepEqual(result.lastSubturnUsage, {
    inputTokens: 29269,
    outputTokens: 517,
    cacheReadInputTokens: 28544,
  });
  assert.equal(publicOutput.answer.length, 4);
  assert.equal(publicOutput.toolCall.length, 5);
  assert.equal(publicOutput.toolResult.length, 6);
  assert.equal(publicOutput.reasoning.length, 0);
});

test('extractSessionLogResult preserves redacted Codex structured-output session-log fixture', () => {
  const result = extractSessionLogResult(readCodexSessionLogFixture('redacted-session-log-structured-output.jsonl'));
  const structured = JSON.parse(result.content ?? 'null');

  assert.equal(result.content?.length, 859);
  assert.equal(result.commentaryEvents.length, 1);
  assert.equal(result.model, 'gpt-5.5');
  assert.equal(result.contextWindow, 258400);
  assert.deepEqual(result.lastSubturnUsage, {
    inputTokens: 27939,
    outputTokens: 664,
    cacheReadInputTokens: 2432,
  });
  assert.equal(structured.stdoutRelation.includes('transport/output surface'), true);
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
    /Codex session log contains malformed JSONL/,
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
        model_context_window: 258400,
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
  assert.deepEqual(result.usage, { inputTokens: 500, outputTokens: 20, cacheReadInputTokens: 100 });
  assert.deepEqual(result.lastSubturnUsage, { inputTokens: 500, outputTokens: 20, cacheReadInputTokens: 100 });
});

test('extractSessionLogResult sums aggregate usage across multi-subturn token_count events', () => {
  // Values mirror .agents/references/full-suite/20260524-195248/cases/codex-gpt-5.5/tool-use-file/codex-session-log.jsonl
  const log = [
    codexUserTurn(),
    codexTokenCount({ input: 28014, cached: 3456, output: 392 }, { input: 28014, cached: 3456, output: 392 }),
    codexTokenCount({ input: 56648, cached: 30976, output: 627 }, { input: 28634, cached: 27520, output: 235 }),
    codexTokenCount({ input: 85557, cached: 59520, output: 858 }, { input: 28909, cached: 28544, output: 231 }),
    codexTokenCount({ input: 114826, cached: 88064, output: 1375 }, { input: 29269, cached: 28544, output: 517 }),
    JSON.stringify({
      type: 'event_msg',
      payload: { type: 'agent_message', phase: 'final_answer', message: 'multi subturn answer' },
    }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }),
  ].join('\n');

  const result = extractSessionLogResult(log);
  assert.deepEqual(result.usage, {
    inputTokens: 114826,
    outputTokens: 1375,
    cacheReadInputTokens: 88064,
  });
  assert.deepEqual(result.lastSubturnUsage, {
    inputTokens: 29269,
    outputTokens: 517,
    cacheReadInputTokens: 28544,
  });
});

test('extractSessionLogResult scoped resume tail reports the resumed turn usage without session totals', () => {
  // Values mirror turn 2 of .agents/references/openp-codex-live-0721-usage-probe/20260610-070233/codex-session-log.jsonl:
  // total_token_usage is session-cumulative (52394 includes turn 1); last_token_usage is the resumed turn alone.
  const resumedTail = [
    codexUserTurn(),
    codexTokenCount({ input: 52394, cached: 15616, output: 51 }, { input: 26318, cached: 4992, output: 18 }),
    JSON.stringify({
      type: 'event_msg',
      payload: { type: 'agent_message', phase: 'final_answer', message: 'resumed turn answer' },
    }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }),
  ].join('\n');

  const result = extractSessionLogResult(resumedTail);
  assert.equal(result.content, 'resumed turn answer');
  assert.deepEqual(result.usage, {
    inputTokens: 26318,
    outputTokens: 18,
    cacheReadInputTokens: 4992,
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
    /Codex session log is missing active turn boundary/,
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
    /Codex session log contains multiple active turn boundaries/,
  );
});
