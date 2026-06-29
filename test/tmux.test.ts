import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { OpenPError } from '../src/core/errors.js';
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
    }, ['ANTHROPIC_'], {
      ANTHROPIC_BASE_URL: 'ambient-base',
      ANTHROPIC_TEST_ENV: 'ambient-extra',
    }),
    "env -u ANTHROPIC_BASE_URL -u ANTHROPIC_TEST_ENV ANTHROPIC_BASE_URL=http://127.0.0.1:9999 claude --resume 'session id'",
  );
});

// ANTHROPIC_BASE_URL is always unset (even when absent from the ambient env) via the backend-injected
// unsetEnv list — this preserves the prior hardcoded behavior of forcing the key onto the unset list.
test('tmux shell command always unsets ANTHROPIC_BASE_URL via unsetEnv even when ambient lacks it', () => {
  assert.equal(
    buildTmuxShellCommand('claude', [], {
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:9999',
    }, ['ANTHROPIC_'], {
      OTHER_ENV: 'present',
    }, ['CLAUDE_CONFIG_DIR', 'ANTHROPIC_BASE_URL']),
    'env -u ANTHROPIC_BASE_URL -u CLAUDE_CONFIG_DIR ANTHROPIC_BASE_URL=http://127.0.0.1:9999 claude',
  );
});

test('tmux shell command can unset ambient Claude config dir while injecting an instance config dir', () => {
  assert.equal(
    buildTmuxShellCommand('claude', [], {
      CLAUDE_CONFIG_DIR: '/tmp/openp-claude-alt',
    }, ['ANTHROPIC_'], {
      ANTHROPIC_BASE_URL: 'ambient-base',
      CLAUDE_CONFIG_DIR: '/tmp/ambient-claude',
    }, ['CLAUDE_CONFIG_DIR']),
    'env -u ANTHROPIC_BASE_URL -u CLAUDE_CONFIG_DIR CLAUDE_CONFIG_DIR=/tmp/openp-claude-alt claude',
  );
});

test('tmux shell command does not strip Anthropic env unless isolation is requested', () => {
  assert.equal(
    buildTmuxShellCommand('claude', [], {}, []),
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

test('tmux session treats a dead pane as not alive even when the session remains', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openp-fake-tmux-'));
  const fakeTmux = join(dir, 'fake-tmux.js');
  const logPath = join(dir, 'commands.log');
  await writeFile(fakeTmux, `#!/usr/bin/env node
const fs = require('node:fs');
const logPath = ${JSON.stringify(logPath)};
const args = process.argv.slice(2);
fs.appendFileSync(logPath, JSON.stringify(args) + '\\n');
if (args[0] === 'has-session') {
  process.exit(0);
}
if (args[0] === 'display-message' && args.includes('#{pane_dead}')) {
  process.stdout.write('1\\n');
  process.exit(0);
}
process.exit(0);
`);
  await chmod(fakeTmux, 0o755);

  const session = new TmuxSession(fakeTmux, 'fake-session', 10);
  assert.equal(await session.isAlive(), false);

  const commandLog = await readFile(logPath, 'utf8');
  assert.match(commandLog, /"has-session","-t","fake-session"/);
  assert.match(commandLog, /"display-message","-p","-t","fake-session","#\{pane_dead\}"/);
});

test('tmux session exit retries with interrupt before a second graceful exit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openp-fake-tmux-'));
  const fakeTmux = join(dir, 'fake-tmux.js');
  const statePath = join(dir, 'state.json');
  const logPath = join(dir, 'commands.log');
  await writeFile(statePath, JSON.stringify({ alive: true, interrupted: false, exitAttempts: 0 }));
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
  if (input.trim() === '/exit') {
    state.exitAttempts += 1;
  }
  if (input.trim() === '/exit' && state.interrupted && state.exitAttempts >= 2) {
    state.alive = false;
    writeState(state);
  } else {
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
  const interruptIndexes = commandLines
    .map((args, index) => args[0] === 'send-keys' && args.includes('C-c') ? index : -1)
    .filter((index) => index >= 0);
  const clearIndexes = commandLines
    .map((args, index) => args[0] === 'send-keys' && args.includes('C-u') ? index : -1)
    .filter((index) => index >= 0);

  assert.equal(pasteIndexes.length, 2);
  assert.equal(clearIndexes.length, 2);
  assert.equal(interruptIndexes.length, 2);
  for (const pasteCommand of pasteCommands) {
    assert.deepEqual(pasteCommand.slice(0, 4), ['paste-buffer', '-p', '-r', '-b']);
  }
  assert.ok(interruptIndexes[0]! < clearIndexes[0]!);
  assert.ok(clearIndexes[0]! < pasteIndexes[0]!);
  assert.ok(pasteIndexes[0]! < interruptIndexes[1]!);
  assert.ok(interruptIndexes[1]! < clearIndexes[1]!);
  assert.ok(clearIndexes[1]! < pasteIndexes[1]!);
  assert.match(commandLog, /"send-keys","-t","fake-session","C-c"/);
});

test('tmux session exit failure reports pane diagnostics', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openp-fake-tmux-'));
  const fakeTmux = join(dir, 'fake-tmux.js');
  await writeFile(fakeTmux, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'has-session') {
  process.exit(0);
}
if (args[0] === 'display-message' && args.includes('#{pane_dead}')) {
  process.stdout.write('0\\n');
  process.exit(0);
}
if (args[0] === 'display-message' && args.includes('#{pane_pid}')) {
  process.stdout.write('12345\\n');
  process.exit(0);
}
if (args[0] === 'display-message' && args.includes('#{pane_current_command}')) {
  process.stdout.write('claude\\n');
  process.exit(0);
}
if (args[0] === 'display-message' && args.includes('#{cursor_y}')) {
  process.stdout.write('2\\n');
  process.exit(0);
}
process.exit(0);
`);
  await chmod(fakeTmux, 0o755);

  const session = new TmuxSession(fakeTmux, 'fake-session', 10);
  await assert.rejects(
    () => session.exit(),
    (error) => {
      assert.ok(error instanceof OpenPError);
      assert.equal(error.details?.kind, 'tmux_exit_failure');
      assert.equal(error.details?.sessionName, 'fake-session');
      assert.equal(error.details?.exitTimeoutMs, 10);
      assert.equal(error.details?.sessionAlive, true);
      assert.equal(error.details?.paneDead, '0');
      assert.equal(error.details?.panePid, 12345);
      assert.equal(error.details?.paneCurrentCommand, 'claude');
      assert.equal(error.details?.cursorY, '2');
      return true;
    },
  );
});

test('tmux session clears multiline draft before submitting graceful exit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openp-fake-tmux-'));
  const fakeTmux = join(dir, 'fake-tmux.js');
  const statePath = join(dir, 'state.json');
  const bufferPath = join(dir, 'buffer.txt');
  const logPath = join(dir, 'commands.log');
  const submissionsPath = join(dir, 'submissions.log');
  await writeFile(statePath, JSON.stringify({ alive: true, draft: 'leftover first line\\n\\nleftover cursor line' }));
  await writeFile(fakeTmux, `#!/usr/bin/env node
const fs = require('node:fs');
const statePath = ${JSON.stringify(statePath)};
const bufferPath = ${JSON.stringify(bufferPath)};
const logPath = ${JSON.stringify(logPath)};
const submissionsPath = ${JSON.stringify(submissionsPath)};
const args = process.argv.slice(2);
fs.appendFileSync(logPath, JSON.stringify(args) + '\\n');
const readState = () => JSON.parse(fs.readFileSync(statePath, 'utf8'));
const writeState = (state) => fs.writeFileSync(statePath, JSON.stringify(state));
if (args[0] === 'has-session') {
  process.exit(readState().alive ? 0 : 1);
}
if (args[0] === 'display-message' && args.includes('#{pane_dead}')) {
  process.stdout.write('0\\n');
  process.exit(0);
}
if (args[0] === 'load-buffer') {
  fs.writeFileSync(bufferPath, fs.readFileSync(0, 'utf8'));
  process.exit(0);
}
if (args[0] === 'paste-buffer') {
  const state = readState();
  state.draft += fs.readFileSync(bufferPath, 'utf8');
  writeState(state);
  process.exit(0);
}
if (args[0] === 'send-keys' && args.includes('C-c')) {
  const state = readState();
  state.draft = '';
  writeState(state);
  process.exit(0);
}
if (args[0] === 'send-keys' && args.includes('C-u')) {
  const state = readState();
  state.draft = state.draft.replace(/[^\\n]*$/, '');
  writeState(state);
  process.exit(0);
}
if (args[0] === 'send-keys' && args.includes('Enter')) {
  const state = readState();
  fs.appendFileSync(submissionsPath, state.draft + '\\n');
  if (state.draft === '/exit') {
    state.alive = false;
  }
  writeState(state);
  process.exit(0);
}
process.exit(0);
`);
  await chmod(fakeTmux, 0o755);

  const session = new TmuxSession(fakeTmux, 'fake-session', 10);
  await session.exit();

  assert.equal((await readFile(submissionsPath, 'utf8')).trim(), '/exit');
  assert.equal(await session.isAlive(), false);
  const commandLog = await readFile(logPath, 'utf8');
  assert.match(commandLog, /"send-keys","-t","fake-session","C-c"/);
});

test('tmux session marks closed when first interrupt exits the session', async () => {
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
if (args[0] === 'send-keys' && args.includes('C-c')) {
  writeState({ alive: false });
  process.exit(0);
}
if (args[0] === 'load-buffer' || args[0] === 'paste-buffer') {
  process.exit(2);
}
process.exit(0);
`);
  await chmod(fakeTmux, 0o755);
  let closedCount = 0;

  const session = new TmuxSession(fakeTmux, 'fake-session', 10, undefined, () => {
    closedCount += 1;
  });
  await session.exit();

  assert.equal(closedCount >= 1, true);
  const commandLog = await readFile(logPath, 'utf8');
  assert.match(commandLog, /"send-keys","-t","fake-session","C-c"/);
  assert.doesNotMatch(commandLog, /"load-buffer"/);
  assert.doesNotMatch(commandLog, /"paste-buffer"/);
});

test('tmux session marks closed after successful graceful exit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openp-fake-tmux-'));
  const fakeTmux = join(dir, 'fake-tmux.js');
  const statePath = join(dir, 'state.json');
  const bufferPath = join(dir, 'buffer.txt');
  await writeFile(statePath, JSON.stringify({ alive: true }));
  await writeFile(fakeTmux, `#!/usr/bin/env node
const fs = require('node:fs');
const statePath = ${JSON.stringify(statePath)};
const bufferPath = ${JSON.stringify(bufferPath)};
const args = process.argv.slice(2);
const readState = () => JSON.parse(fs.readFileSync(statePath, 'utf8'));
const writeState = (state) => fs.writeFileSync(statePath, JSON.stringify(state));
if (args[0] === 'has-session') {
  process.exit(readState().alive ? 0 : 1);
}
if (args[0] === 'load-buffer') {
  fs.writeFileSync(bufferPath, fs.readFileSync(0, 'utf8'));
  process.exit(0);
}
if (args[0] === 'paste-buffer') {
  process.exit(0);
}
if (args[0] === 'send-keys') {
  const input = fs.existsSync(bufferPath) ? fs.readFileSync(bufferPath, 'utf8') : '';
  if (input.trim() === '/exit') {
    writeState({ alive: false });
  }
  process.exit(0);
}
if (args[0] === 'display-message') {
  process.stdout.write('0\\n');
  process.exit(0);
}
process.exit(0);
`);
  await chmod(fakeTmux, 0o755);
  let closedCount = 0;

  const session = new TmuxSession(fakeTmux, 'fake-session', 10, undefined, () => {
    closedCount += 1;
  });
  await session.exit();

  assert.equal(closedCount >= 1, true);
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

// The backend artifact rules require a multiline-prompt transport regression test, and the Claude
// prompt-submission contract mandates a byte-level transport test: a multiline prompt
// must reach the backend as a single caller turn, so prompt-internal line breaks must travel through the
// paste path (load-buffer bytes + bracketed/literal paste-buffer) and must NOT be turned into Enter/submit
// actions. This drives the real TmuxSession.write/submit production path through a fake tmux that records
// the exact stdin bytes it loaded and every command it received.
test('tmux session transports a multiline prompt as one paste with no submit, then submits exactly once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openp-fake-tmux-'));
  const fakeTmux = join(dir, 'fake-tmux.js');
  const logPath = join(dir, 'commands.log');
  const bufferPath = join(dir, 'buffer.txt');
  // A prompt with several lines, an internal blank line, leading/trailing spaces, and a CRLF segment.
  // Every one of these line breaks is prompt data, not a submit boundary.
  const multilinePrompt = 'first line\nsecond line\n\n  indented third\nline with CR\r\nlast line';
  await writeFile(fakeTmux, `#!/usr/bin/env node
const fs = require('node:fs');
const logPath = ${JSON.stringify(logPath)};
const bufferPath = ${JSON.stringify(bufferPath)};
const args = process.argv.slice(2);
fs.appendFileSync(logPath, JSON.stringify(args) + '\\n');
if (args[0] === 'load-buffer') {
  // Capture the exact bytes tmux would store in the paste buffer.
  fs.writeFileSync(bufferPath, fs.readFileSync(0));
  process.exit(0);
}
process.exit(0);
`);
  await chmod(fakeTmux, 0o755);

  const session = new TmuxSession(fakeTmux, 'fake-session', 10);
  // Production prompt-submission order: adapter.ts calls pty.write(prompt) then pty.submit().
  await session.write(multilinePrompt);
  const afterWriteLog = await readFile(logPath, 'utf8');
  await session.submit();

  // 1. Byte-level fidelity: the loaded buffer must equal the original prompt bytes exactly, so no line
  //    break is dropped, collapsed, or converted before it reaches tmux.
  const loadedBuffer = await readFile(bufferPath);
  assert.equal(loadedBuffer.toString('utf8'), multilinePrompt);
  assert.deepEqual(loadedBuffer, Buffer.from(multilinePrompt, 'utf8'));

  // 2. write() must not emit any Enter/submit: prompt-internal newlines are not submit actions. If write
  //    split the prompt by newline into per-line send-keys, this would fail.
  const writeCommands = afterWriteLog.trim().split('\n').map((line) => JSON.parse(line) as string[]);
  assert.equal(writeCommands.filter((cmd) => cmd[0] === 'send-keys').length, 0);

  // 3. The whole prompt travels through one paste-buffer, with the literal/bracketed flags (-p -r) that
  //    preserve LF instead of tmux's default LF->CR replacement (plain paste-buffer is invalid here).
  const allCommands = (await readFile(logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as string[]);
  const loadBufferCount = allCommands.filter((cmd) => cmd[0] === 'load-buffer').length;
  const pasteCommands = allCommands.filter((cmd) => cmd[0] === 'paste-buffer');
  assert.equal(loadBufferCount, 1);
  assert.equal(pasteCommands.length, 1);
  assert.deepEqual(pasteCommands[0]!.slice(0, 3), ['paste-buffer', '-p', '-r']);

  // 4. submit() is the only operation that produces an Enter, and it does so exactly once.
  const enterCommands = allCommands.filter((cmd) => cmd[0] === 'send-keys' && cmd[cmd.length - 1] === 'Enter');
  assert.equal(enterCommands.length, 1);
  assert.deepEqual(enterCommands[0], ['send-keys', '-t', 'fake-session', 'Enter']);

  // 5. The single Enter happens after the paste, never interleaved with the prompt bytes.
  const pasteIndex = allCommands.findIndex((cmd) => cmd[0] === 'paste-buffer');
  const enterIndex = allCommands.findIndex((cmd) => cmd[0] === 'send-keys' && cmd[cmd.length - 1] === 'Enter');
  assert.ok(pasteIndex >= 0 && enterIndex > pasteIndex);
});
