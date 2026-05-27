#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SESSION_ID = '33333333-3333-4333-8333-333333333333';
const ANSWER_ONE = 'stdout first answer';
const ANSWER_TWO = 'stdout second answer';
const ANSWER_FINAL = 'stdout final answer';
const TOOL_OUTPUT = 'tool output from stdout\n';

const codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex');
const logDir = join(codexHome, 'sessions', '2026', '05', '23');
const logPath = join(logDir, `rollout-${SESSION_ID}.jsonl`);
mkdirSync(logDir, { recursive: true });
writeFileSync(logPath, '', 'utf8');

const lastMessagePath = valueAfter('--output-last-message');
if (lastMessagePath) {
  writeFileSync(lastMessagePath, `${ANSWER_FINAL}\n`, 'utf8');
}

appendLog({ type: 'turn_context', payload: { model: 'codex-mirror-model' } });
appendLog({ type: 'event_msg', payload: { type: 'user_message', message: 'hello' } });

writeStdout({ type: 'thread.started', thread_id: SESSION_ID });
writeStdout({ type: 'turn.started' });

writeStdout({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: ANSWER_ONE } });
appendLog({ type: 'event_msg', payload: { type: 'agent_message', phase: 'commentary', message: ANSWER_ONE } });
appendLog({ type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: ANSWER_ONE }] } });

writeStdout({ type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: '/bin/zsh -lc echo tool', aggregated_output: '', exit_code: null, status: 'in_progress' } });
writeStdout({ type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: '/bin/zsh -lc echo tool', aggregated_output: TOOL_OUTPUT, exit_code: 0, status: 'completed' } });
appendLog({ type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"echo tool"}', call_id: 'call_mirror_tool' } });
appendLog({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_mirror_tool', output: TOOL_OUTPUT } });
appendLog({
  type: 'event_msg',
  payload: {
    type: 'token_count',
    info: {
      model_context_window: 258400,
      last_token_usage: { input_tokens: 333, cached_input_tokens: 44, output_tokens: 5 },
    },
  },
});

writeStdout({ type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: ANSWER_TWO } });
appendLog({ type: 'event_msg', payload: { type: 'agent_message', phase: 'commentary', message: ANSWER_TWO } });
appendLog({ type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: ANSWER_TWO }] } });

writeStdout({ type: 'item.completed', item: { id: 'item_3', type: 'agent_message', text: ANSWER_FINAL } });
appendLog({ type: 'event_msg', payload: { type: 'agent_message', phase: 'final_answer', message: ANSWER_FINAL } });
appendLog({ type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: ANSWER_FINAL }] } });
appendLog({
  type: 'event_msg',
  payload: {
    type: 'token_count',
    info: {
      model_context_window: 258400,
      last_token_usage: { input_tokens: 444, cached_input_tokens: 55, output_tokens: 6 },
    },
  },
});
appendLog({ type: 'event_msg', payload: { type: 'task_complete' } });

writeStdout({
  type: 'turn.completed',
  usage: { input_tokens: 10, cached_input_tokens: 5, output_tokens: 2 },
});

function valueAfter(flag) {
  const args = process.argv.slice(2);
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function writeStdout(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function appendLog(value) {
  appendFileSync(logPath, `${JSON.stringify(value)}\n`, 'utf8');
}
