import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildTmuxShellCommand, TmuxSession } from '../src/runners/tmux.js';

test('tmux shell command can isolate Anthropic env for local backends', () => {
  assert.equal(
    buildTmuxShellCommand('claude', ['--resume', 'session id'], {
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:9999',
    }, true, {
      ANTHROPIC_BASE_URL: 'ambient-base',
      ANTHROPIC_TEST_ENV: 'ambient-extra',
    }),
    "env -u ANTHROPIC_BASE_URL -u ANTHROPIC_TEST_ENV ANTHROPIC_BASE_URL=http://127.0.0.1:9999 claude --resume 'session id'",
  );
});

test('tmux shell command does not strip Anthropic env unless isolation is requested', () => {
  assert.equal(
    buildTmuxShellCommand('claude', [], {}, false),
    'env claude',
  );
});

test('tmux session exit retries with interrupt before a second graceful exit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openp-fake-tmux-'));
  const fakeTmux = join(dir, 'fake-tmux.js');
  const statePath = join(dir, 'state.json');
  const logPath = join(dir, 'commands.log');
  await writeFile(statePath, JSON.stringify({ alive: true, interrupted: false }));
  await writeFile(fakeTmux, `#!/usr/bin/env node
const fs = require('node:fs');
const statePath = ${JSON.stringify(statePath)};
const logPath = ${JSON.stringify(logPath)};
const args = process.argv.slice(2);
fs.appendFileSync(logPath, JSON.stringify(args) + '\\n');
const readState = () => JSON.parse(fs.readFileSync(statePath, 'utf8'));
const writeState = (state) => fs.writeFileSync(statePath, JSON.stringify(state));
if (args[0] === 'has-session') {
  process.exit(readState().alive ? 0 : 1);
}
if (args[0] === 'load-buffer') {
  const input = fs.readFileSync(0, 'utf8');
  fs.writeFileSync(${JSON.stringify(join(dir, 'buffer.txt'))}, input);
  process.exit(0);
}
if (args[0] === 'paste-buffer') {
  const state = readState();
  const input = fs.readFileSync(${JSON.stringify(join(dir, 'buffer.txt'))}, 'utf8');
  if (input.trim() === '/exit' && state.interrupted) {
    state.alive = false;
    writeState(state);
  }
  process.exit(0);
}
if (args[0] === 'send-keys' && args.includes('C-c')) {
  const state = readState();
  state.interrupted = true;
  writeState(state);
  process.exit(0);
}
process.exit(0);
`);
  await chmod(fakeTmux, 0o755);

  const session = new TmuxSession(fakeTmux, 'fake-session', 10);
  await session.exit();

  assert.equal(await session.isAlive(), false);
  const commandLog = await readFile(logPath, 'utf8');
  const commandLines = commandLog.trim().split('\n').map((line) => JSON.parse(line) as string[]);
  const pasteIndexes = commandLines
    .map((args, index) => args[0] === 'paste-buffer' ? index : -1)
    .filter((index) => index >= 0);
  const pasteCommands = pasteIndexes.map((index) => commandLines[index]!);
  const interruptIndex = commandLines.findIndex((args) => args[0] === 'send-keys' && args.includes('C-c'));

  assert.equal(pasteIndexes.length, 2);
  for (const pasteCommand of pasteCommands) {
    assert.deepEqual(pasteCommand.slice(0, 4), ['paste-buffer', '-p', '-r', '-b']);
  }
  assert.ok(pasteIndexes[0]! < interruptIndex);
  assert.ok(interruptIndex < pasteIndexes[1]!);
  assert.match(commandLog, /"send-keys","-t","fake-session","C-c"/);
});

test('tmux session terminate kills the owned session', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openp-fake-tmux-'));
  const fakeTmux = join(dir, 'fake-tmux.js');
  const statePath = join(dir, 'state.json');
  const logPath = join(dir, 'commands.log');
  await writeFile(statePath, JSON.stringify({ alive: true }));
  await writeFile(fakeTmux, `#!/usr/bin/env node
const fs = require('node:fs');
const statePath = ${JSON.stringify(statePath)};
const logPath = ${JSON.stringify(logPath)};
const args = process.argv.slice(2);
fs.appendFileSync(logPath, JSON.stringify(args) + '\\n');
const readState = () => JSON.parse(fs.readFileSync(statePath, 'utf8'));
const writeState = (state) => fs.writeFileSync(statePath, JSON.stringify(state));
if (args[0] === 'has-session') {
  process.exit(readState().alive ? 0 : 1);
}
if (args[0] === 'kill-session') {
  const state = readState();
  state.alive = false;
  writeState(state);
  process.exit(0);
}
process.exit(0);
`);
  await chmod(fakeTmux, 0o755);

  const session = new TmuxSession(fakeTmux, 'fake-session', 10);
  await session.terminate('SIGTERM');

  assert.equal(await session.isAlive(), false);
  const commandLog = await readFile(logPath, 'utf8');
  assert.match(commandLog, /"kill-session","-t","fake-session"/);
});

test('tmux session terminate sends the requested signal to the pane process group', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openp-fake-tmux-'));
  const fakeTmux = join(dir, 'fake-tmux.js');
  const statePath = join(dir, 'state.json');
  const logPath = join(dir, 'commands.log');
  await writeFile(statePath, JSON.stringify({ alive: true }));
  await writeFile(fakeTmux, `#!/usr/bin/env node
const fs = require('node:fs');
const statePath = ${JSON.stringify(statePath)};
const logPath = ${JSON.stringify(logPath)};
const args = process.argv.slice(2);
fs.appendFileSync(logPath, JSON.stringify(args) + '\\n');
const readState = () => JSON.parse(fs.readFileSync(statePath, 'utf8'));
const writeState = (state) => fs.writeFileSync(statePath, JSON.stringify(state));
if (args[0] === 'has-session') {
  process.exit(readState().alive ? 0 : 1);
}
if (args[0] === 'display-message') {
  process.stdout.write('4321\\n');
  process.exit(0);
}
if (args[0] === 'kill-session') {
  const state = readState();
  state.alive = false;
  writeState(state);
  process.exit(0);
}
process.exit(0);
`);
  await chmod(fakeTmux, 0o755);

  const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  const session = new TmuxSession(fakeTmux, 'fake-session', 10, (pid, signal) => {
    signals.push({ pid, signal });
  });

  await session.terminate('SIGTERM');
  assert.equal(await session.isAlive(), true);
  await session.terminate('SIGKILL');

  assert.equal(await session.isAlive(), false);
  assert.deepEqual(signals, [
    { pid: -4321, signal: 'SIGTERM' },
    { pid: -4321, signal: 'SIGKILL' },
  ]);
  const commandLog = await readFile(logPath, 'utf8');
  assert.match(commandLog, /"display-message","-p","-t","fake-session","#\{pane_pid\}"/);
  assert.match(commandLog, /"kill-session","-t","fake-session"/);
});
