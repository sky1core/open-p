#!/usr/bin/env node
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const sessionId = '22222222-2222-4222-8222-222222222222';
const codexHome = process.env.CODEX_HOME;
if (!codexHome) {
  process.stderr.write('CODEX_HOME is required\n');
  process.exit(1);
}

const logDir = join(codexHome, 'sessions', '2026', '05', '23');
mkdirSync(logDir, { recursive: true });
const logPath = join(logDir, `rollout-${sessionId}.jsonl`);

const event = (value) => JSON.stringify(value);
appendFileSync(logPath, [
  event({ type: 'turn_context', payload: { model: 'codex-no-final-model' } }),
  event({ type: 'event_msg', payload: { type: 'user_message', message: 'current prompt' } }),
  event({
    type: 'event_msg',
    payload: {
      type: 'agent_message',
      phase: 'commentary',
      message: 'checking status before final',
    },
  }),
  event({
    type: 'event_msg',
    payload: {
      type: 'task_complete',
      turn_id: '019e0000-0000-7000-8000-000000000099',
      last_agent_message: null,
    },
  }),
  '',
].join('\n'));

process.stdout.write(event({
  type: 'thread.started',
  thread_id: sessionId,
}) + '\n');

process.stdout.write(event({
  type: 'event_msg',
  payload: {
    type: 'agent_message',
    phase: 'commentary',
    message: 'checking status before final',
  },
}) + '\n');

process.exit(1);
