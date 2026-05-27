#!/usr/bin/env node
import { rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const sessionId = process.argv.at(-2) ?? '22222222-2222-4222-8222-222222222222';
const codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex');
const logPath = join(codexHome, 'sessions', '2026', '05', '23', `rollout-${sessionId}.jsonl`);

try {
  await rename(logPath, `${logPath}.moved`);
} catch {
  // The test asserts open-p does not treat this as a stdout-only run.
}

process.stdout.write(`${JSON.stringify({
  type: 'turn.completed',
  session_id: sessionId,
  result: 'stdout fallback answer',
  usage: { input_tokens: 50, output_tokens: 10 },
})}\n`);
