#!/usr/bin/env node
import { appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const RESULT_TEXT = '{"ok":true}';

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
    payload: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: RESULT_TEXT }],
    },
  },
  {
    type: 'turn.completed',
    session_id: SESSION_ID,
    result: RESULT_TEXT,
    usage: {
      input_tokens: 2200,
      cached_input_tokens: 350,
      output_tokens: 45,
    },
  },
];

await mkdir(logDir, { recursive: true });
await appendFile(logPath, events.map((event) => JSON.stringify(event)).join('\n') + '\n', 'utf8');

emitStdout({
  type: 'turn.completed',
  session_id: SESSION_ID,
  result: RESULT_TEXT,
  usage: {
    input_tokens: 2200,
    cached_input_tokens: 350,
    output_tokens: 45,
  },
});
