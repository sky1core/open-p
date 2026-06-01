#!/usr/bin/env node
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const sessionId = process.argv.at(-2) ?? '22222222-2222-4222-8222-222222222222';
const codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex');
const logDir = join(codexHome, 'sessions', '2026', '05', '23');
const logPath = join(logDir, `rollout-${sessionId}.jsonl`);

const events = [
  { type: 'event_msg', payload: { type: 'user_message', message: 'resume prompt' } },
  {
    type: 'turn.completed',
    session_id: sessionId,
    result: 'unreadable log answer',
    usage: { input_tokens: 50, output_tokens: 10 },
  },
];

await mkdir(logDir, { recursive: true });
await writeFile(logPath, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8');
await chmod(logPath, 0o000);

process.stdout.write(`${JSON.stringify({
  type: 'turn.completed',
  session_id: sessionId,
  result: 'stdout fallback answer',
  usage: { input_tokens: 50, output_tokens: 10 },
})}\n`);
