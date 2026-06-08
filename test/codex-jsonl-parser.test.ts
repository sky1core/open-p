import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseCodexOutput,
  parseCodexJsonlLine,
  processCodexStdoutLine,
  type CodexStreamState,
} from '../src/backends/codex/jsonl-parser.js';
import { formatWorkerTurnResult } from '../src/core/output.js';

function createStreamState(): CodexStreamState {
  return {
    assistantText: '',
    reasoningText: '',
    lastAssistantText: null,
    lastAgentMessageMirrorCandidate: null,
    assistantEventSequence: 0,
    streamFinalAssistantText: true,
  };
}

function readCodexFixture(name: string): string {
  return readFileSync(new URL(`./fixtures/codex/${name}`, import.meta.url), 'utf8');
}

function firstBlocks(events: readonly any[]): any[] {
  return events.map((event) => (event.message.content as any[])[0]);
}

function collectCodexStdoutStreaming(stdout: string): {
  readonly answerSnapshots: readonly string[];
  readonly snapshotBlocks: readonly any[];
} {
  const state = createStreamState();
  const answerSnapshots: string[] = [];
  const snapshotBlocks: any[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    processCodexStdoutLine(line, state, {
      onAssistantText: (text) => answerSnapshots.push(text),
      onAssistantSnapshot: (snapshot) => snapshotBlocks.push((snapshot.message.content as any[])[0]),
    });
  }
  return { answerSnapshots, snapshotBlocks };
}

function openPOutputForCodexParsed(parsed: ReturnType<typeof parseCodexOutput>): any {
  const output = formatWorkerTurnResult({
    content: parsed.content ?? '',
    reasoningContent: parsed.reasoningContent,
    assistantEvents: parsed.assistantEvents,
    sessionId: parsed.sessionId ?? 'codex-session',
    diagnostics: {
      numTurns: 1,
      inputTokens: parsed.usage.inputTokens,
      outputTokens: parsed.usage.outputTokens,
      cacheReadInputTokens: parsed.usage.cacheReadInputTokens,
      contextWindow: null,
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

test('parseCodexOutput preserves redacted Codex long-answer stdout fixture', () => {
  const parsed = parseCodexOutput(readCodexFixture('redacted-stdout-long-answer-no-tool.jsonl'), null);

  assert.equal(parsed.content?.length, 1311);
  assert.equal(parsed.sessionId, '019e0000-0000-7000-8000-000000000001');
  assert.deepEqual(parsed.usage, {
    inputTokens: 27915,
    outputTokens: 1059,
    cacheReadInputTokens: 3456,
  });
  assert.deepEqual(firstBlocks(parsed.assistantEvents).map((block) => block.type), ['text']);
});

test('parseCodexOutput preserves redacted Codex tool-use stdout fixture output kinds', () => {
  const stdout = readCodexFixture('redacted-stdout-tool-use-file.jsonl');
  const parsed = parseCodexOutput(stdout, null);
  const blocks = firstBlocks(parsed.assistantEvents);
  const publicOutput = openPOutputForCodexParsed(parsed);

  assert.equal(parsed.content?.includes('sum=89'), true);
  assert.equal(parsed.content?.length, 622);
  assert.equal(parsed.sessionId, '019e0000-0000-7000-8000-000000000002');
  assert.equal(parsed.assistantEvents.length, 14);
  assert.deepEqual(blocks.map((block) => block.type), [
    'text',
    'tool_use',
    'tool_result',
    'tool_use',
    'tool_result',
    'text',
    'tool_use',
    'tool_result',
    'text',
    'tool_use',
    'tool_result',
    'tool_use',
    'tool_result',
    'text',
  ]);
  assert.equal(publicOutput.answer.length, 4);
  assert.equal(publicOutput.toolCall.length, 5);
  assert.equal(publicOutput.toolResult.length, 5);
  assert.equal(publicOutput.reasoning.length, 0);
});

test('processCodexStdoutLine streams redacted Codex tool-use stdout fixture as stdout-local cumulative snapshots', () => {
  const streaming = collectCodexStdoutStreaming(readCodexFixture('redacted-stdout-tool-use-file.jsonl'));

  assert.equal(streaming.answerSnapshots.length, 4);
  assert.equal(streaming.answerSnapshots[0]?.startsWith('현재 디렉터리에서'), true);
  assert.equal(streaming.answerSnapshots[1]?.startsWith(`${streaming.answerSnapshots[0]}\n\n`), true);
  assert.equal(streaming.answerSnapshots[2]?.startsWith(`${streaming.answerSnapshots[1]}\n\n`), true);
  assert.equal(streaming.answerSnapshots[3]?.startsWith(`${streaming.answerSnapshots[2]}\n\n`), true);
  assert.equal(streaming.answerSnapshots[3]?.length, 869);
  assert.deepEqual(streaming.snapshotBlocks.map((block) => block.type), [
    'tool_use',
    'tool_result',
    'tool_use',
    'tool_result',
    'tool_use',
    'tool_result',
    'tool_use',
    'tool_result',
    'tool_use',
    'tool_result',
  ]);
});

test('parseCodexOutput preserves redacted Codex structured-output stdout fixture as JSON text', () => {
  const parsed = parseCodexOutput(readCodexFixture('redacted-stdout-structured-output.jsonl'), null);
  const structured = JSON.parse(parsed.content ?? 'null');

  assert.equal(parsed.content?.length, 859);
  assert.equal(parsed.sessionId, '019e0000-0000-7000-8000-000000000003');
  assert.equal(structured.answer.includes('에이전트 CLI reference artifact'), true);
  assert.equal(Array.isArray(structured.checks), true);
  assert.deepEqual(parsed.usage, {
    inputTokens: 27939,
    outputTokens: 664,
    cacheReadInputTokens: 2432,
  });
});

test('parseCodexOutput extracts content and session id from turn.completed', () => {
  const stdout = [
    JSON.stringify({ type: 'turn.completed', session_id: '00000000-0000-4000-8000-000000000001', result: 'result answer', usage: { input_tokens: 100, cached_input_tokens: 50, output_tokens: 20 } }),
  ].join('\n');
  const parsed = parseCodexOutput(stdout, null);
  assert.equal(parsed.content, 'result answer');
  assert.equal(parsed.sessionId, '00000000-0000-4000-8000-000000000001');
  assert.equal(parsed.usage.inputTokens, 100);
  assert.equal(parsed.usage.outputTokens, 20);
  assert.equal(parsed.usage.cacheReadInputTokens, 50);
});

test('parseCodexOutput extracts session id from thread.started', () => {
  const sessionId = 'agent-session_01:opaque';
  const stdout = [
    JSON.stringify({ type: 'thread.started', thread_id: sessionId }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] } }),
  ].join('\n');

  const parsed = parseCodexOutput(stdout, null);
  assert.equal(parsed.content, 'ok');
  assert.equal(parsed.sessionId, sessionId);
});

test('parseCodexOutput preserves assistant text with an unknown native phase', () => {
  const stdout = [
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
  ].join('\n');

  const parsed = parseCodexOutput(stdout, null);
  assert.equal(parsed.content, 'draft answer');
  assert.equal(parsed.assistantEvents.length, 1);
  assert.deepEqual(firstBlocks(parsed.assistantEvents), [{ type: 'text', text: 'draft answer' }]);
});

test('parseCodexOutput keeps final display text when an unknown native phase follows', () => {
  const stdout = [
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
  ].join('\n');

  const parsed = parseCodexOutput(stdout, null);
  assert.equal(parsed.content, 'final answer');
  assert.deepEqual(firstBlocks(parsed.assistantEvents), [
    { type: 'text', text: 'final answer' },
    { type: 'text', text: 'draft answer' },
  ]);
});

test('parseCodexOutput lets final display text override an earlier unknown native phase', () => {
  const stdout = [
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
  ].join('\n');

  const parsed = parseCodexOutput(stdout, null);
  assert.equal(parsed.content, 'final answer');
  assert.deepEqual(firstBlocks(parsed.assistantEvents), [
    { type: 'text', text: 'draft answer' },
    { type: 'text', text: 'final answer' },
  ]);
});

test('processCodexStdoutLine streams assistant text with an unknown native phase as answer', () => {
  const state = createStreamState();
  const snapshots: string[] = [];
  processCodexStdoutLine(JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      phase: 'draft',
      id: 'draft-1',
      content: [{ type: 'output_text', text: 'draft answer' }],
    },
  }), state, {
    onAssistantText: (text) => snapshots.push(text),
  });

  assert.deepEqual(snapshots, ['draft answer']);
});

test('parseCodexOutput ignores unrelated generic session id fields', () => {
  const stdout = [
    JSON.stringify({ type: 'session_configured', session_id: 'agent-session_01:opaque' }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] } }),
  ].join('\n');

  const parsed = parseCodexOutput(stdout, null);
  assert.equal(parsed.content, 'ok');
  assert.equal(parsed.sessionId, null);
});

test('parseCodexOutput does not promote metadata-only JSON events to content', () => {
  const stdout = JSON.stringify({ type: 'thread.started', thread_id: 'agent-session_01:opaque' });

  const parsed = parseCodexOutput(stdout, null);
  assert.equal(parsed.content, null);
  assert.equal(parsed.sessionId, 'agent-session_01:opaque');
});

test('parseCodexOutput ignores unsafe turn.completed session ids', () => {
  const stdout = JSON.stringify({
    type: 'turn.completed',
    session_id: '../outside',
    result: 'ok',
  });

  const parsed = parseCodexOutput(stdout, null);
  assert.equal(parsed.content, 'ok');
  assert.equal(parsed.sessionId, null);
});

test('parseCodexOutput extracts reasoning from response_item', () => {
  const stdout = [
    JSON.stringify({ type: 'response_item', payload: { type: 'reasoning', summary: [{ text: 'Thought A' }, { text: 'Thought B' }], content: null } }),
    JSON.stringify({ type: 'turn.completed', session_id: 'sid', result: 'answer' }),
  ].join('\n');
  const parsed = parseCodexOutput(stdout, null);
  assert.equal(parsed.reasoningContent, 'Thought A\n\nThought B');
  assert.equal(parsed.content, 'answer');
});

test('parseCodexOutput falls back to assistant message output_text', () => {
  const stdout = [
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'msg text' }] } }),
  ].join('\n');
  const parsed = parseCodexOutput(stdout, null);
  assert.equal(parsed.content, 'msg text');
});

test('parseCodexOutput does not promote commentary or progress response_item text to result content', () => {
  const stdout = [
    JSON.stringify({ type: 'thread.started', thread_id: '019e460f-bfc8-7c12-ae80-281798743e5b' }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'checking files...' }] } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'progress', content: [{ type: 'output_text', text: 'working...' }] } }),
  ].join('\n');

  const parsed = parseCodexOutput(stdout, null);
  assert.equal(parsed.content, null);
  assert.equal(parsed.sessionId, '019e460f-bfc8-7c12-ae80-281798743e5b');
  assert.equal(parsed.assistantEvents.length, 2);
  assert.deepEqual(
    parsed.assistantEvents.map((event) => (event.message.content as any[])[0]?.text),
    ['checking files...', 'working...'],
  );
});

test('parseCodexOutput promotes final_answer response_item text to result content', () => {
  const stdout = [
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'checking files...' }] } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'result answer' }] } }),
  ].join('\n');

  const parsed = parseCodexOutput(stdout, null);
  assert.equal(parsed.content, 'result answer');
  assert.equal(parsed.assistantEvents.length, 2);
  assert.equal((parsed.assistantEvents[0]!.message.content as any[])[0].text, 'checking files...');
  assert.equal((parsed.assistantEvents[1]!.message.content as any[])[0].text, 'result answer');
});

test('parseCodexOutput promotes final_answer event_msg agent_message text to result content', () => {
  const stdout = [
    JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'event final', phase: 'final_answer' } }),
  ].join('\n');

  const parsed = parseCodexOutput(stdout, null);
  assert.equal(parsed.content, 'event final');
  assert.equal(parsed.assistantEvents.length, 1);
  assert.equal((parsed.assistantEvents[0]!.message.content as any[])[0].text, 'event final');
});

test('parseCodexOutput promotes unphased event_msg agent_message text to result content', () => {
  const stdout = [
    JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'event final' } }),
  ].join('\n');

  const parsed = parseCodexOutput(stdout, null);
  assert.equal(parsed.content, 'event final');
  assert.equal(parsed.assistantEvents.length, 1);
  assert.equal((parsed.assistantEvents[0]!.message.content as any[])[0].text, 'event final');
});

test('parseCodexOutput promotes final_answer item.completed agent_message text to result content', () => {
  const stdout = [
    JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'item final', phase: 'final_answer' } }),
  ].join('\n');

  const parsed = parseCodexOutput(stdout, null);
  assert.equal(parsed.content, 'item final');
  assert.equal(parsed.assistantEvents.length, 1);
  assert.equal((parsed.assistantEvents[0]!.message.content as any[])[0].text, 'item final');
});

test('parseCodexOutput promotes unphased item.completed agent_message text to result content', () => {
  const stdout = [
    JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'item final' } }),
  ].join('\n');

  const parsed = parseCodexOutput(stdout, null);
  assert.equal(parsed.content, 'item final');
  assert.equal(parsed.assistantEvents.length, 1);
  assert.equal((parsed.assistantEvents[0]!.message.content as any[])[0].text, 'item final');
});

test('parseCodexOutput preserves function call snapshots from stdout', () => {
  const stdout = [
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'function_call',
        call_id: 'call_1',
        name: 'read_file',
        arguments: '{"path":"README.md"}',
      },
    }),
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'call_1',
        output: 'file text',
      },
    }),
    JSON.stringify({ type: 'turn.completed', session_id: 'sid', result: 'done' }),
  ].join('\n');

  const parsed = parseCodexOutput(stdout, null);
  const toolUse = (parsed.assistantEvents[0]?.message.content as any[])[0];
  const toolResult = (parsed.assistantEvents[1]?.message.content as any[])[0];
  assert.equal(parsed.content, 'done');
  assert.equal(parsed.assistantEvents.length, 2);
  assert.equal(toolUse.type, 'tool_use');
  assert.equal(toolUse.id, 'call_1');
  assert.equal(toolUse.name, 'read_file');
  assert.deepEqual(toolUse.input, { path: 'README.md' });
  assert.equal(toolResult.type, 'tool_result');
  assert.equal(toolResult.tool_use_id, 'call_1');
  assert.equal(toolResult.content, 'file text');
});

test('parseCodexOutput preserves Codex custom tools and stdout tool artifacts', () => {
  const stdout = [
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
      type: 'response_item',
      payload: {
        type: 'custom_tool_call_output',
        call_id: 'call_patch',
        output: '{"output":"ok","metadata":{"exit_code":0}}',
      },
    }),
    JSON.stringify({
      type: 'item.started',
      item: {
        id: 'item_cmd',
        type: 'command_execution',
        command: '/bin/zsh -lc pwd',
        aggregated_output: '',
        exit_code: null,
        status: 'in_progress',
      },
    }),
    JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'item_cmd',
        type: 'command_execution',
        command: '/bin/zsh -lc pwd',
        aggregated_output: '/tmp/work\n',
        exit_code: 0,
        status: 'completed',
      },
    }),
    JSON.stringify({
      type: 'item.started',
      item: {
        id: 'item_file',
        type: 'file_change',
        changes: [{ path: 'data/result.txt', kind: 'add' }],
        status: 'in_progress',
      },
    }),
    JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'item_file',
        type: 'file_change',
        changes: [{ path: 'data/result.txt', kind: 'add' }],
        status: 'completed',
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
    JSON.stringify({ type: 'turn.completed', session_id: 'sid', result: 'done' }),
  ].join('\n');

  const parsed = parseCodexOutput(stdout, null);
  const blocks = parsed.assistantEvents.map((event) => (event.message.content as any[])[0]);
  assert.equal(parsed.content, 'done');
  assert.equal(parsed.assistantEvents.length, 7);
  assert.deepEqual(blocks.map((block) => block.type), [
    'tool_use',
    'tool_result',
    'tool_use',
    'tool_result',
    'tool_use',
    'tool_result',
    'tool_result',
  ]);
  assert.equal(blocks[0].id, 'call_patch');
  assert.equal(blocks[0].name, 'apply_patch');
  assert.equal(blocks[0].input, '*** Begin Patch\n*** End Patch\n');
  assert.equal(blocks[1].tool_use_id, 'call_patch');
  assert.equal(blocks[2].id, 'item_cmd');
  assert.equal(blocks[2].name, 'command_execution');
  assert.deepEqual(blocks[2].input, { command: '/bin/zsh -lc pwd', status: 'in_progress' });
  assert.equal(String(blocks[3].content).includes('"output":"/tmp/work\\n"'), true);
  assert.equal(blocks[4].id, 'item_file');
  assert.equal(blocks[4].name, 'file_change');
  assert.equal(String(blocks[5].content).includes('data/result.txt'), true);
  assert.equal(blocks[6].tool_use_id, 'call_patch');
  assert.equal(String(blocks[6].content).includes('Success. Updated files'), true);
});

test('parseCodexOutput prefers response_item message output_text over lastMessageFileContent', () => {
  const stdout = [
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'jsonl final' }] } }),
  ].join('\n');

  const parsed = parseCodexOutput(stdout, 'file fallback');
  assert.equal(parsed.content, 'jsonl final');
});

test('parseCodexOutput promotes unphased item.completed agent_message text in completed turns', () => {
  const stdout = [
    JSON.stringify({ type: 'thread.started', thread_id: '019e460f-bfc8-7c12-ae80-281798743e5b' }),
    JSON.stringify({ type: 'turn.started' }),
    JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'RAW_SHAPE_OK' } }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 5, output_tokens: 2 } }),
  ].join('\n');

  const parsed = parseCodexOutput(stdout, null);
  assert.equal(parsed.content, 'RAW_SHAPE_OK');
  assert.equal(parsed.sessionId, '019e460f-bfc8-7c12-ae80-281798743e5b');
  assert.equal(parsed.usage.inputTokens, 10);
  assert.equal(parsed.assistantEvents.length, 1);
  assert.equal((parsed.assistantEvents[0]!.message.content as any[])[0].text, 'RAW_SHAPE_OK');
});

test('parseCodexOutput prefers unphased item.completed agent_message text over lastMessageFileContent', () => {
  const stdout = [
    JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'progress text' } }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } }),
  ].join('\n');

  const parsed = parseCodexOutput(stdout, 'final file text');
  assert.equal(parsed.content, 'progress text');
});

test('parseCodexOutput falls back to lastMessageFileContent', () => {
  const parsed = parseCodexOutput('', 'file fallback');
  assert.equal(parsed.content, 'file fallback');
});

test('parseCodexOutput returns null content when stdout is empty and no file', () => {
  const parsed = parseCodexOutput('', null);
  assert.equal(parsed.content, null);
});

test('parseCodexJsonlLine ignores non-JSON', () => {
  assert.equal(parseCodexJsonlLine('not json'), null);
  assert.equal(parseCodexJsonlLine(''), null);
  assert.equal(parseCodexJsonlLine('  '), null);
});

test('parseCodexJsonlLine parses valid JSON object', () => {
  const result = parseCodexJsonlLine('{"type":"test"}');
  assert.deepEqual(result, { type: 'test' });
});

test('processCodexStdoutLine accumulates assistant text', () => {
  const state = createStreamState();
  const texts: string[] = [];
  processCodexStdoutLine(
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] } }),
    state,
    { onAssistantText: (t) => texts.push(t) },
  );
  assert.equal(state.assistantText, 'hello');
  assert.equal(state.lastAssistantText, 'hello');
  assert.deepEqual(texts, ['hello']);

  processCodexStdoutLine(
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'world' }] } }),
    state,
    { onAssistantText: (t) => texts.push(t) },
  );
  assert.equal(state.assistantText, 'hello\n\nworld');
  assert.equal(state.lastAssistantText, 'world');
  assert.deepEqual(texts, ['hello', 'hello\n\nworld']);
});

test('processCodexStdoutLine streams response_item commentary as Codex-owned answer snapshot', () => {
  const state = createStreamState();
  const texts: string[] = [];
  const snapshots: string[] = [];
  processCodexStdoutLine(
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'checking files...' }] } }),
    state,
    {
      onAssistantText: (t) => texts.push(t),
      onAssistantSnapshot: (snapshot) => snapshots.push((snapshot.message.content as any[])[0]?.text),
    },
  );

  assert.equal(state.assistantText, 'checking files...');
  assert.equal(state.lastAssistantText, 'checking files...');
  assert.deepEqual(texts, ['checking files...']);
  assert.deepEqual(snapshots, ['checking files...']);
});

test('processCodexStdoutLine streams response_item final_answer as assistant text', () => {
  const state = createStreamState();
  const texts: string[] = [];
  processCodexStdoutLine(
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'result answer' }] } }),
    state,
    { onAssistantText: (t) => texts.push(t) },
  );

  assert.equal(state.assistantText, 'result answer');
  assert.equal(state.lastAssistantText, 'result answer');
  assert.deepEqual(texts, ['result answer']);
});

test('processCodexStdoutLine suppresses final_answer streaming only inside Codex state policy', () => {
  const state = { ...createStreamState(), streamFinalAssistantText: false };
  const texts: string[] = [];
  processCodexStdoutLine(
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'checking files...' }] } }),
    state,
    { onAssistantText: (t) => texts.push(t) },
  );
  processCodexStdoutLine(
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '{"ok":true}' }] } }),
    state,
    { onAssistantText: (t) => texts.push(t) },
  );

  assert.equal(state.assistantText, 'checking files...');
  assert.equal(state.lastAssistantText, 'checking files...');
  assert.deepEqual(texts, ['checking files...']);
});

test('processCodexStdoutLine accumulates reasoning text', () => {
  const state = createStreamState();
  const texts: string[] = [];
  processCodexStdoutLine(
    JSON.stringify({ type: 'response_item', payload: { type: 'reasoning', summary: [{ text: 'thinking...' }], content: null } }),
    state,
    { onReasoningText: (t) => texts.push(t) },
  );
  assert.equal(state.reasoningText, 'thinking...');
  assert.deepEqual(texts, ['thinking...']);
});

test('processCodexStdoutLine emits only one snapshot for Codex event_msg/response_item assistant mirrors', () => {
  const state = createStreamState();
  const texts: string[] = [];
  const snapshots: string[] = [];
  const callbacks = {
    onAssistantText: (t: string) => texts.push(t),
    onAssistantSnapshot: (snapshot: any) => snapshots.push(snapshot.message.content[0]?.text),
  };
  processCodexStdoutLine(
    JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'checking files...', phase: 'commentary' } }),
    state,
    callbacks,
  );
  processCodexStdoutLine(
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'checking files...' }] } }),
    state,
    callbacks,
  );

  assert.equal(state.assistantText, 'checking files...');
  assert.equal(state.lastAssistantText, 'checking files...');
  assert.deepEqual(texts, ['checking files...']);
  assert.deepEqual(snapshots, ['checking files...']);
});

test('processCodexStdoutLine preserves repeated commentary event_msg snapshots and answer streaming', () => {
  const state = createStreamState();
  const texts: string[] = [];
  const snapshots: string[] = [];
  const callbacks = {
    onAssistantText: (text: string) => texts.push(text),
    onAssistantSnapshot: (snapshot: any) => snapshots.push(snapshot.message.content[0]?.text),
  };
  for (let i = 0; i < 2; i += 1) {
    processCodexStdoutLine(
      JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'checking files...', phase: 'commentary' } }),
      state,
      callbacks,
    );
  }

  assert.equal(state.assistantText, 'checking files...\n\nchecking files...');
  assert.equal(state.lastAssistantText, 'checking files...');
  assert.deepEqual(texts, ['checking files...', 'checking files...\n\nchecking files...']);
  assert.deepEqual(snapshots, ['checking files...', 'checking files...']);
});

test('processCodexStdoutLine streams unphased event_msg agent_message as assistant text', () => {
  const state = createStreamState();
  const texts: string[] = [];
  processCodexStdoutLine(
    JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'result answer' } }),
    state,
    { onAssistantText: (t) => texts.push(t) },
  );

  assert.equal(state.assistantText, 'result answer');
  assert.equal(state.lastAssistantText, 'result answer');
  assert.deepEqual(texts, ['result answer']);
});

test('processCodexStdoutLine streams final_answer event_msg agent_message as assistant text', () => {
  const state = createStreamState();
  const texts: string[] = [];
  processCodexStdoutLine(
    JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'result answer', phase: 'final_answer' } }),
    state,
    { onAssistantText: (t) => texts.push(t) },
  );

  assert.equal(state.assistantText, 'result answer');
  assert.equal(state.lastAssistantText, 'result answer');
  assert.deepEqual(texts, ['result answer']);
});

test('processCodexStdoutLine streams progress-phase agent_message as Codex-owned answer snapshot', () => {
  const state = createStreamState();
  const texts: string[] = [];
  const snapshots: string[] = [];
  processCodexStdoutLine(
    JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'working answer', phase: 'progress' } }),
    state,
    {
      onAssistantText: (t) => texts.push(t),
      onAssistantSnapshot: (snapshot) => snapshots.push((snapshot.message.content as any[])[0]?.text),
    },
  );

  assert.equal(state.assistantText, 'working answer');
  assert.equal(state.lastAssistantText, 'working answer');
  assert.deepEqual(texts, ['working answer']);
  assert.deepEqual(snapshots, ['working answer']);
});

test('processCodexStdoutLine streams unphased item.completed agent_message text', () => {
  const state = createStreamState();
  const texts: string[] = [];
  processCodexStdoutLine(
    JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'RAW_SHAPE_OK' } }),
    state,
    { onAssistantText: (t) => texts.push(t) },
  );

  assert.equal(state.assistantText, 'RAW_SHAPE_OK');
  assert.equal(state.lastAssistantText, 'RAW_SHAPE_OK');
  assert.deepEqual(texts, ['RAW_SHAPE_OK']);
});

test('processCodexStdoutLine streams final_answer item.completed agent_message text', () => {
  const state = createStreamState();
  const texts: string[] = [];
  processCodexStdoutLine(
    JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', phase: 'final_answer', text: 'RAW_SHAPE_OK' } }),
    state,
    { onAssistantText: (t) => texts.push(t) },
  );

  assert.equal(state.assistantText, 'RAW_SHAPE_OK');
  assert.equal(state.lastAssistantText, 'RAW_SHAPE_OK');
  assert.deepEqual(texts, ['RAW_SHAPE_OK']);
});

test('processCodexStdoutLine preserves repeated assistant text across Codex event shapes', () => {
  const state = createStreamState();
  const texts: string[] = [];
  const callbacks = { onAssistantText: (t: string) => texts.push(t) };

  processCodexStdoutLine(
    JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'same answer' } }),
    state,
    callbacks,
  );
  processCodexStdoutLine(
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'same answer' }] } }),
    state,
    callbacks,
  );

  assert.equal(state.assistantText, 'same answer\n\nsame answer');
  assert.deepEqual(texts, ['same answer', 'same answer\n\nsame answer']);

  const reverseState = createStreamState();
  const reverseTexts: string[] = [];
  const reverseCallbacks = { onAssistantText: (t: string) => reverseTexts.push(t) };

  processCodexStdoutLine(
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'same answer' }] } }),
    reverseState,
    reverseCallbacks,
  );
  processCodexStdoutLine(
    JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'same answer' } }),
    reverseState,
    reverseCallbacks,
  );

  assert.equal(reverseState.assistantText, 'same answer\n\nsame answer');
  assert.deepEqual(reverseTexts, ['same answer', 'same answer\n\nsame answer']);
});

test('processCodexStdoutLine preserves repeated latest text after accumulated updates', () => {
  const state = createStreamState();
  const texts: string[] = [];
  const callbacks = { onAssistantText: (t: string) => texts.push(t) };

  processCodexStdoutLine(
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'partial' }] } }),
    state,
    callbacks,
  );
  processCodexStdoutLine(
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'partial final' }] } }),
    state,
    callbacks,
  );
  processCodexStdoutLine(
    JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'partial final' } }),
    state,
    callbacks,
  );

  assert.equal(state.assistantText, 'partial\n\npartial final\n\npartial final');
  assert.equal(state.lastAssistantText, 'partial final');
  assert.deepEqual(texts, ['partial', 'partial\n\npartial final', 'partial\n\npartial final\n\npartial final']);
});

test('processCodexStdoutLine accumulates discrete assistant messages without replacement', () => {
  const state = createStreamState();
  const texts: string[] = [];
  const callbacks = { onAssistantText: (t: string) => texts.push(t) };

  processCodexStdoutLine(
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'A' }] } }),
    state,
    callbacks,
  );
  processCodexStdoutLine(
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'B' }] } }),
    state,
    callbacks,
  );
  processCodexStdoutLine(
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'C' }] } }),
    state,
    callbacks,
  );

  assert.equal(state.assistantText, 'A\n\nB\n\nC');
  assert.equal(state.lastAssistantText, 'C');
  assert.deepEqual(texts, ['A', 'A\n\nB', 'A\n\nB\n\nC']);
});

test('processCodexStdoutLine preserves prefix-like discrete assistant messages', () => {
  const state = createStreamState();
  const texts: string[] = [];
  const callbacks = { onAssistantText: (t: string) => texts.push(t) };

  processCodexStdoutLine(
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'A' }] } }),
    state,
    callbacks,
  );
  processCodexStdoutLine(
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'AB' }] } }),
    state,
    callbacks,
  );
  processCodexStdoutLine(
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'ABC' }] } }),
    state,
    callbacks,
  );

  assert.equal(state.assistantText, 'A\n\nAB\n\nABC');
  assert.equal(state.lastAssistantText, 'ABC');
  assert.deepEqual(texts, ['A', 'A\n\nAB', 'A\n\nAB\n\nABC']);
});

test('processCodexStdoutLine accumulates discrete assistant messages after separate preceding text', () => {
  const state = createStreamState();
  const texts: string[] = [];
  const callbacks = { onAssistantText: (t: string) => texts.push(t) };

  processCodexStdoutLine(
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'Intro' }] } }),
    state,
    callbacks,
  );
  processCodexStdoutLine(
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'A' }] } }),
    state,
    callbacks,
  );
  processCodexStdoutLine(
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'B' }] } }),
    state,
    callbacks,
  );
  processCodexStdoutLine(
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'C' }] } }),
    state,
    callbacks,
  );

  const expected = 'Intro\n\nA\n\nB\n\nC';
  assert.equal(state.assistantText, expected);
  assert.equal(state.lastAssistantText, 'C');
  assert.deepEqual(texts, ['Intro', 'Intro\n\nA', 'Intro\n\nA\n\nB', expected]);
});

test('processCodexStdoutLine preserves prefix-like discrete assistant messages after separate text', () => {
  const state = createStreamState();
  const texts: string[] = [];
  const callbacks = { onAssistantText: (t: string) => texts.push(t) };

  processCodexStdoutLine(
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'Intro' }] } }),
    state,
    callbacks,
  );
  processCodexStdoutLine(
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'A' }] } }),
    state,
    callbacks,
  );
  processCodexStdoutLine(
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'AB' }] } }),
    state,
    callbacks,
  );
  processCodexStdoutLine(
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'ABC' }] } }),
    state,
    callbacks,
  );

  const expected = 'Intro\n\nA\n\nAB\n\nABC';
  assert.equal(state.assistantText, expected);
  assert.equal(state.lastAssistantText, 'ABC');
  assert.deepEqual(texts, ['Intro', 'Intro\n\nA', 'Intro\n\nA\n\nAB', expected]);
});

test('processCodexStdoutLine streams unphased item text even if commentary carried the same text', () => {
  const state = createStreamState();
  const texts: string[] = [];
  const callbacks = { onAssistantText: (t: string) => texts.push(t) };

  processCodexStdoutLine(
    JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'same answer', phase: 'commentary' } }),
    state,
    callbacks,
  );
  processCodexStdoutLine(
    JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'same answer' } }),
    state,
    callbacks,
  );

  assert.equal(state.assistantText, 'same answer\n\nsame answer');
  assert.equal(state.lastAssistantText, 'same answer');
  assert.deepEqual(texts, ['same answer', 'same answer\n\nsame answer']);
});

test('processCodexStdoutLine streams unphased item text even if an older commentary event repeated it', () => {
  const state = createStreamState();
  const texts: string[] = [];
  const callbacks = { onAssistantText: (t: string) => texts.push(t) };

  processCodexStdoutLine(
    JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'first progress', phase: 'commentary' } }),
    state,
    callbacks,
  );
  processCodexStdoutLine(
    JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'second progress', phase: 'progress' } }),
    state,
    callbacks,
  );
  processCodexStdoutLine(
    JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'first progress' } }),
    state,
    callbacks,
  );

  assert.equal(state.assistantText, 'first progress\n\nsecond progress\n\nfirst progress');
  assert.equal(state.lastAssistantText, 'first progress');
  assert.deepEqual(texts, [
    'first progress',
    'first progress\n\nsecond progress',
    'first progress\n\nsecond progress\n\nfirst progress',
  ]);
});

test('parseCodexOutput handles usage without cached_input_tokens', () => {
  const stdout = JSON.stringify({ type: 'turn.completed', session_id: 'sid', result: 'ok', usage: { input_tokens: 50, output_tokens: 10 } });
  const parsed = parseCodexOutput(stdout, null);
  assert.equal(parsed.usage.inputTokens, 50);
  assert.equal(parsed.usage.cacheReadInputTokens, null);
});
