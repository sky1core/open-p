#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const argsLog = process.env.OPENP_FAKE_CODEX_ARGS_LOG;

if (argsLog) {
  const alreadyLaunched = existsSync(argsLog);
  appendFileSync(argsLog, `${JSON.stringify(process.argv.slice(2))}\n`, 'utf8');
  if (alreadyLaunched) {
    process.stderr.write('seed bootstrap target launched more than once\n');
    process.exit(99);
  }
}

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), 'fixture-codex-bootstrap.jsonl');
const entries = readFileSync(fixturePath, 'utf8')
  .trimEnd()
  .split('\n')
  .map((line) => JSON.parse(line));
for (const entry of entries) {
  if (entry.type === 'session_meta') {
    entry.payload.id = SESSION_ID;
    entry.payload.session_id = SESSION_ID;
    entry.payload.cwd = process.cwd();
  }
  if (entry.type === 'turn_context') {
    entry.payload.cwd = process.cwd();
    entry.payload.workspace_roots = [process.cwd()];
  }
}

const codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex');
const logPath = join(codexHome, 'sessions', '2026', '05', '23', `rollout-${SESSION_ID}.jsonl`);
mkdirSync(dirname(logPath), { recursive: true });
writeFileSync(logPath, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8');

writeStdout({ type: 'thread.started', thread_id: SESSION_ID });
writeStdout({ type: 'item.completed', item: { id: 'bootstrap-answer', type: 'agent_message', text: 'HELLO_OK' } });
writeStdout({
  type: 'turn.completed',
  session_id: SESSION_ID,
  result: 'HELLO_OK',
  usage: { input_tokens: 10, cached_input_tokens: 5, output_tokens: 2 },
});

function writeStdout(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
