#!/usr/bin/env node
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';

const argsLog = process.env.OPENP_FAKE_CODEX_ARGS_LOG;
const readyFile = process.env.OPENP_FAKE_CODEX_READY_FILE;
if (!argsLog || !readyFile) {
  process.stderr.write('missing seed hang fixture paths\n');
  process.exit(98);
}

const alreadyLaunched = existsSync(argsLog);
appendFileSync(argsLog, `${JSON.stringify(process.argv.slice(2))}\n`, 'utf8');
if (alreadyLaunched) {
  process.stderr.write('indeterminate seed target launched more than once\n');
  process.exit(99);
}

const originalParentPid = process.ppid;
writeFileSync(readyFile, `${JSON.stringify({ pid: process.pid, parentPid: originalParentPid })}\n`, {
  encoding: 'utf8',
  flag: 'wx',
  mode: 0o600,
});

setInterval(() => {
  if (process.ppid !== originalParentPid || !isAlive(originalParentPid)) {
    process.exit(0);
  }
}, 25);

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

await new Promise(() => {});
