#!/usr/bin/env node
import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const sessionId = process.argv.at(-2) ?? '22222222-2222-4222-8222-222222222222';
const codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex');
const oldLogPath = join(codexHome, 'sessions', '2026', '05', '23', `rollout-${sessionId}.jsonl`);
const newLogPath = join(codexHome, 'sessions', '2026', '05', '24', `rollout-${sessionId}.jsonl`);

const oldSize = await stat(oldLogPath).then((st) => st.size, () => 0);
await rename(oldLogPath, `${oldLogPath}.moved`).catch(() => undefined);
await mkdir(dirname(newLogPath), { recursive: true });

const replacementEvents = [
  { type: 'event_msg', payload: { type: 'user_message', message: 'replacement prompt' } },
  {
    type: 'turn.completed',
    session_id: sessionId,
    result: 'replacement log answer',
    usage: { input_tokens: 50, output_tokens: 10 },
  },
];

await writeFile(
  newLogPath,
  `${' '.repeat(oldSize)}${replacementEvents.map((event) => JSON.stringify(event)).join('\n')}\n`,
  'utf8',
);

process.stdout.write(`${JSON.stringify({
  type: 'turn.completed',
  session_id: sessionId,
  result: 'stdout fallback answer',
  usage: { input_tokens: 50, output_tokens: 10 },
})}\n`);
