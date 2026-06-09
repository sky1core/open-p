#!/usr/bin/env node
import { appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SESSION_ID = '22222222-2222-4222-8222-222222222222';

const codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex');
const logDir = join(codexHome, 'sessions', '2026', '05', '23');
const logPath = join(logDir, `rollout-${SESSION_ID}.jsonl`);

function emitStdout(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

const events = [
  { type: 'turn_context', payload: { model: 'codex-current-model' } },
  { type: 'event_msg', payload: { type: 'user_message', message: 'resume prompt' } },
  {
    type: 'response_item',
    payload: { type: 'reasoning', summary: [{ text: 'current turn reasoning' }] },
  },
  {
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      phase: 'commentary',
      content: [{ type: 'output_text', text: 'current turn commentary' }],
    },
  },
  {
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        // total_token_usage is session-cumulative (includes the previous turn);
        // last_token_usage is this subturn alone.
        total_token_usage: {
          input_tokens: 1900,
          cached_input_tokens: 270,
          output_tokens: 40,
        },
        last_token_usage: {
          input_tokens: 1800,
          cached_input_tokens: 250,
          output_tokens: 30,
        },
        model_context_window: 200000,
      },
    },
  },
  {
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: 2100,
          cached_input_tokens: 320,
          output_tokens: 50,
        },
        last_token_usage: {
          input_tokens: 200,
          cached_input_tokens: 50,
          output_tokens: 10,
        },
        model_context_window: 200000,
      },
    },
  },
  {
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      phase: 'final_answer',
      content: [{ type: 'output_text', text: 'current turn final answer' }],
    },
  },
  {
    type: 'event_msg',
    payload: { type: 'task_complete' },
  },
];

await mkdir(logDir, { recursive: true });
await appendFile(logPath, events.map((event) => JSON.stringify(event)).join('\n') + '\n', 'utf8');

emitStdout({
  type: 'turn.completed',
  session_id: SESSION_ID,
  result: 'current turn final answer',
  usage: {
    input_tokens: 2200,
    cached_input_tokens: 350,
    output_tokens: 45,
  },
});
