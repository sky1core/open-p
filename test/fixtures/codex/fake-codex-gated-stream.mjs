#!/usr/bin/env node
import { existsSync, writeFileSync } from 'node:fs';

const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const ANSWER = 'gated stream answer';

const lastMessagePath = valueAfter('--output-last-message');
if (lastMessagePath) {
  writeFileSync(lastMessagePath, `${ANSWER}\n`, 'utf8');
}

writeJson({ type: 'thread.started', thread_id: SESSION_ID });
writeJson({ type: 'turn.started' });
writeJson({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: ANSWER } });
if (process.env.OPENP_FAKE_CODEX_READY_FILE) {
  writeFileSync(process.env.OPENP_FAKE_CODEX_READY_FILE, 'ready', 'utf8');
}

await waitForRelease();

writeJson({
  type: 'turn.completed',
  usage: { input_tokens: 10, cached_input_tokens: 5, output_tokens: 2 },
});

function valueAfter(flag) {
  const args = process.argv.slice(2);
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function waitForRelease() {
  const releaseFile = process.env.OPENP_FAKE_CODEX_RELEASE_FILE;
  if (!releaseFile) return;

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (existsSync(releaseFile)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${releaseFile}`);
}
