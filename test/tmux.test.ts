import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildTmuxShellCommand, selectReapableOpenpSessions, TmuxSession } from '../src/runners/tmux.js';

test('reaper selects only same-session-id orphans, excluding the session being created', () => {
  const sessionName = 'openp-ffaee9f17b62-newrand';
  const candidates = [
    'openp-ffaee9f17b62-newrand', // the new session itself — must NOT be reaped
    'openp-ffaee9f17b62-orphan1', // leaked orphan for the same session id — reap
    'openp-ffaee9f17b62-orphan2', // another leaked orphan — reap
    'openp-aaaaaaaaaaaa-other', // different session id — must NOT be reaped
    'quota-12345', // unrelated tmux session — must NOT be reaped
  ];
  assert.deepEqual(
    selectReapableOpenpSessions(sessionName, candidates),
    ['openp-ffaee9f17b62-orphan1', 'openp-ffaee9f17b62-orphan2'],
  );
});

test('reaper selects nothing when no same-session-id orphan exists', () => {
  assert.deepEqual(
    selectReapableOpenpSessions('openp-ffaee9f17b62-newrand', ['openp-bbbbbbbbbbbb-x', 'quota-1']),
    [],
  );
});

test('reaper never reaps non-open-p sessions even on a shared prefix', () => {
  assert.deepEqual(
    selectReapableOpenpSessions('quota-123-new', ['quota-123-old', 'openp-x-y']),
    [],
  );
});

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

test('tmux session captures only the visible pane for prompt readiness', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openp-fake-tmux-'));
  const fakeTmux = join(dir, 'fake-tmux.js');
  const logPath = join(dir, 'commands.log');
  await writeFile(fakeTmux, `#!/usr/bin/env node
const fs = require('node:fs');
const logPath = ${JSON.stringify(logPath)};
const args = process.argv.slice(2);
fs.appendFileSync(logPath, JSON.stringify(args) + '\\n');
if (args[0] === 'capture-pane') {
  process.stdout.write('visible screen\\n');
}
process.exit(0);
`);
  await chmod(fakeTmux, 0o755);

  const session = new TmuxSession(fakeTmux, 'fake-session', 10);
  assert.equal(await session.captureText(), 'visible screen\n');

  const commandLog = await readFile(logPath, 'utf8');
  const commandLines = commandLog.trim().split('\n').map((line) => JSON.parse(line) as string[]);
  assert.deepEqual(commandLines[0], ['capture-pane', '-pt', 'fake-session']);
});

test('tmux session captures only the cursor row for input readiness', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openp-fake-tmux-'));
  const fakeTmux = join(dir, 'fake-tmux.js');
  const logPath = join(dir, 'commands.log');
  await writeFile(fakeTmux, `#!/usr/bin/env node
const fs = require('node:fs');
const logPath = ${JSON.stringify(logPath)};
const args = process.argv.slice(2);
fs.appendFileSync(logPath, JSON.stringify(args) + '\\n');
if (args[0] === 'display-message' && args.includes('#{cursor_y}')) {
  process.stdout.write('3\\n');
  process.exit(0);
}
if (args[0] === 'capture-pane') {
  if (args.includes('-S') && args.includes('-E')) {
    process.stdout.write('❯\\n');
  } else {
    process.stdout.write('old output\\n❯\\nfooter\\n');
  }
}
process.exit(0);
`);
  await chmod(fakeTmux, 0o755);

  const session = new TmuxSession(fakeTmux, 'fake-session', 10);
  assert.equal(await session.captureCursorLine(), '❯');

  const commandLog = await readFile(logPath, 'utf8');
  const commandLines = commandLog.trim().split('\n').map((line) => JSON.parse(line) as string[]);
  assert.deepEqual(commandLines[0], ['display-message', '-p', '-t', 'fake-session', '#{cursor_y}']);
  assert.deepEqual(commandLines[1], ['capture-pane', '-p', '-t', 'fake-session', '-S', '3', '-E', '3']);
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
