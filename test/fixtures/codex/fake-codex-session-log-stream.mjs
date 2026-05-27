#!/usr/bin/env node
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SESSION_ID = '22222222-2222-4222-8222-222222222222';

const codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex');
const logDir = join(codexHome, 'sessions', '2026', '05', '23');
const logPath = join(logDir, `rollout-${SESSION_ID}.jsonl`);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function emitStdout(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

async function appendLog(event) {
  await appendFile(logPath, `${JSON.stringify(event)}\n`, 'utf8');
}

await mkdir(logDir, { recursive: true });
await writeFile(logPath, '', 'utf8');

emitStdout({ type: 'thread.started', thread_id: SESSION_ID });

await appendLog({ type: 'turn_context', payload: { model: 'codex-log-model' } });
await appendLog({ type: 'event_msg', payload: { type: 'user_message', message: 'hello' } });
await sleep(100);
await appendLog({
  type: 'event_msg',
  payload: {
    type: 'token_count',
    info: {
      model_context_window: 258400,
      last_token_usage: {
        input_tokens: 111,
        cached_input_tokens: 22,
        output_tokens: 3,
      },
    },
  },
});
await sleep(100);
await appendLog({
  type: 'event_msg',
  payload: {
    type: 'agent_message',
    phase: 'commentary',
    message: 'session log commentary',
  },
});
await sleep(100);
await appendLog({
  type: 'event_msg',
  payload: {
    type: 'agent_message',
    phase: 'final_answer',
    message: 'session log final answer',
  },
});
await appendLog({
  type: 'event_msg',
  payload: {
    type: 'token_count',
    info: {
      model_context_window: 258400,
      last_token_usage: {
        input_tokens: 333,
        cached_input_tokens: 44,
        output_tokens: 5,
      },
    },
  },
});
await appendLog({
  type: 'turn.completed',
  session_id: SESSION_ID,
  result: 'session log final answer',
  usage: {
    input_tokens: 999,
    cached_input_tokens: 222,
    output_tokens: 11,
  },
});
await sleep(50);

emitStdout({
  type: 'turn.completed',
  session_id: SESSION_ID,
  result: 'session log final answer',
  usage: {
    input_tokens: 999,
    cached_input_tokens: 222,
    output_tokens: 11,
  },
});
