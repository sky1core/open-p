#!/usr/bin/env node
import { appendFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const CODEX_HOME_DIR = process.env.CODEX_HOME?.trim() || join(tmpdir(), 'openp-fake-codex-home');
const SESSION_DIR = join(CODEX_HOME_DIR, 'sessions', '2026', '05', '23');
const LOG_PATH = join(SESSION_DIR, `rollout-${SESSION_ID}.jsonl`);

if (process.env.OPENP_FAKE_CODEX_ARGS_LOG) {
  appendFileSync(process.env.OPENP_FAKE_CODEX_ARGS_LOG, `ARGS\t${args.join('\t')}\n`, 'utf8');
}

const prompt = await readPrompt();
mkdirSync(SESSION_DIR, { recursive: true });

appendLog({ type: 'turn_context', payload: { model: 'codex-test-model' } });
appendLog({
  type: 'response_item',
  payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] },
});
appendLog({ type: 'event_msg', payload: { type: 'user_message', message: prompt } });
appendLog({
  type: 'response_item',
  payload: { type: 'reasoning', summary: [{ text: 'Thinking about it...' }], content: null },
});
appendLog({
  type: 'event_msg',
  payload: {
    type: 'token_count',
    info: {
      total_token_usage: { input_tokens: 200, cached_input_tokens: 100, output_tokens: 40 },
      last_token_usage: { input_tokens: 200, cached_input_tokens: 100, output_tokens: 40 },
      model_context_window: 200000,
    },
  },
});
appendLog({
  type: 'response_item',
  payload: {
    type: 'message',
    role: 'assistant',
    phase: 'final_answer',
    content: [{ type: 'output_text', text: 'final answer here' }],
  },
});
appendLog({
  type: 'event_msg',
  payload: {
    type: 'token_count',
    info: {
      total_token_usage: { input_tokens: 1700, cached_input_tokens: 900, output_tokens: 340 },
      last_token_usage: { input_tokens: 1500, cached_input_tokens: 800, output_tokens: 300 },
      model_context_window: 200000,
    },
  },
});
appendLog({ type: 'event_msg', payload: { type: 'task_complete' } });

writeStdout({
  type: 'response_item',
  payload: { type: 'reasoning', summary: [{ text: 'Thinking about it...' }], content: null },
});
writeStdout({
  type: 'response_item',
  payload: {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'final answer here' }],
  },
});
writeStdout({
  type: 'turn.completed',
  session_id: SESSION_ID,
  result: 'final answer here',
  usage: { input_tokens: 200, output_tokens: 40, cached_input_tokens: 100 },
});

async function readPrompt() {
  const promptArg = args.at(-1);
  if (promptArg === '-') {
    const chunks = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  if (promptArg === undefined) {
    return 'hello';
  }

  if (promptArg.startsWith('-')) {
    process.stderr.write(`error: unexpected argument '${promptArg}' found\n`);
    process.exit(2);
  }

  return promptArg;
}

function writeStdout(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function appendLog(value) {
  appendFileSync(LOG_PATH, `${JSON.stringify(value)}\n`, 'utf8');
}
