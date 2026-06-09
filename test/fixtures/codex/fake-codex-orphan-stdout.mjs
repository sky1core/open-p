#!/usr/bin/env node
// Parent mode: writes the ready line, spawns a grandchild that inherits the
// stdout pipe, then exits immediately. The grandchild keeps the pipe open so
// the runner must settle through the post-exit grace timer.
// Grandchild mode (--grandchild):
//   1. sleeps ~200ms, then writes one JSONL line (arrives after parent exit,
//      before the 1s grace settle)
//   2. if OPENP_FAKE_CODEX_LATE_RELEASE_FILE is set, waits for that file and
//      writes a second JSONL line (arrives after the runner promise settles)
//   3. if OPENP_FAKE_CODEX_DONE_FILE is set, writes it after all lines
//   4. if OPENP_FAKE_CODEX_EXIT_RELEASE_FILE is set, waits for that file
//      before exiting (holds the stdout pipe open past the grace settle)
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const selfPath = fileURLToPath(import.meta.url);

if (process.argv[2] === '--grandchild') {
  await runGrandchild();
  process.exit(0);
}

writeJson({ type: 'fixture.ready' });
const grandchild = spawn(process.execPath, [selfPath, '--grandchild'], {
  stdio: ['ignore', 'inherit', 'ignore'],
  detached: true,
  env: process.env,
});
grandchild.unref();
process.exit(0);

async function runGrandchild() {
  await delay(200);
  writeJson({
    type: 'item.completed',
    item: { id: 'item_grandchild', type: 'agent_message', text: 'grandchild line' },
  });

  if (process.env.OPENP_FAKE_CODEX_LATE_RELEASE_FILE) {
    await waitForFile(process.env.OPENP_FAKE_CODEX_LATE_RELEASE_FILE);
    writeJson({
      type: 'item.completed',
      item: { id: 'item_late', type: 'agent_message', text: 'late grandchild line' },
    });
  }

  if (process.env.OPENP_FAKE_CODEX_DONE_FILE) {
    writeFileSync(process.env.OPENP_FAKE_CODEX_DONE_FILE, 'done', 'utf8');
  }

  if (process.env.OPENP_FAKE_CODEX_EXIT_RELEASE_FILE) {
    await waitForFile(process.env.OPENP_FAKE_CODEX_EXIT_RELEASE_FILE);
  }
}

function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function waitForFile(path) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      return;
    }
    await delay(20);
  }
  throw new Error(`timed out waiting for ${path}`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
