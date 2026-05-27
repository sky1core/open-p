import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCodexExec } from '../src/backends/codex/exec-runner.js';
import { isAbortError } from '../src/core/abort.js';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'codex');
const READY_LINE = '{"type":"fixture.ready"}';

test('runCodexExec captures stdout and exit code 0', async () => {
  const lines: string[] = [];
  const result = await runCodexExec({
    bin: join(FIXTURES, 'fake-codex-success.sh'),
    args: [],
    cwd: process.cwd(),
    timeoutMs: 10000,
    onStdoutLine: (line) => lines.push(line),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.signal, null);
  assert.ok(result.stdout.includes('turn.completed'));
  assert.ok(result.stdout.includes('response_item'));
  assert.equal(lines.length, 3);
});

test('runCodexExec captures stderr and non-zero exit', async () => {
  const result = await runCodexExec({
    bin: join(FIXTURES, 'fake-codex-error.sh'),
    args: [],
    cwd: process.cwd(),
    timeoutMs: 10000,
  });

  assert.equal(result.exitCode, 1);
  assert.ok(result.stderr.includes('something went wrong'));
  assert.equal(result.timedOut, false);
});

test('runCodexExec times out with SIGINT before escalation', async () => {
  const signalLog = await tempSignalLog();
  const result = await runCodexExec({
    bin: join(FIXTURES, 'fake-codex-slow.sh'),
    args: [],
    cwd: process.cwd(),
    env: { ...process.env, OPENP_FAKE_CODEX_SIGNAL_LOG: signalLog },
    timeoutMs: 500,
  });

  assert.equal(result.timedOut, true);
  assert.equal(result.signal, 'SIGINT');
  assert.deepEqual(await readSignalLog(signalLog), ['SIGINT']);
});

test('runCodexExec force kills a process that ignores graceful interruption on timeout', async () => {
  const startedAt = Date.now();
  const signalLog = await tempSignalLog();
  const result = await runCodexExec({
    bin: join(FIXTURES, 'fake-codex-ignore-interrupt.mjs'),
    args: [],
    cwd: process.cwd(),
    env: { ...process.env, OPENP_FAKE_CODEX_SIGNAL_LOG: signalLog },
    timeoutMs: 1000,
    interruptGraceMs: 50,
    terminateGraceMs: 50,
  });

  assert.equal(result.timedOut, true);
  assert.equal(result.signal, 'SIGKILL');
  assert.deepEqual(await readSignalLog(signalLog), ['SIGINT', 'SIGTERM']);
  assert.ok(Date.now() - startedAt < 5000);
});

test('runCodexExec rejects immediately if signal already aborted', async () => {
  const ac = new AbortController();
  ac.abort();

  await assert.rejects(
    runCodexExec({
      bin: join(FIXTURES, 'fake-codex-success.sh'),
      args: [],
      cwd: process.cwd(),
      timeoutMs: 10000,
      signal: ac.signal,
    }),
    isAbortError,
  );
});

test('runCodexExec aborts running process via signal', async () => {
  const ac = new AbortController();
  const signalLog = await tempSignalLog();

  setTimeout(() => ac.abort(), 300);

  const result = await runCodexExec({
    bin: join(FIXTURES, 'fake-codex-slow.sh'),
    args: [],
    cwd: process.cwd(),
    env: { ...process.env, OPENP_FAKE_CODEX_SIGNAL_LOG: signalLog },
    timeoutMs: 30000,
    signal: ac.signal,
  });

  assert.equal(result.signal, 'SIGINT');
  assert.deepEqual(await readSignalLog(signalLog), ['SIGINT']);
});

test('runCodexExec keeps user abort classified as abort when timeout is also configured', async () => {
  const ac = new AbortController();
  const signalLog = await tempSignalLog();

  const result = await runCodexExec({
    bin: join(FIXTURES, 'fake-codex-ignore-interrupt.mjs'),
    args: [],
    cwd: process.cwd(),
    env: { ...process.env, OPENP_FAKE_CODEX_SIGNAL_LOG: signalLog },
    timeoutMs: 1000,
    signal: ac.signal,
    interruptGraceMs: 100,
    terminateGraceMs: 50,
    onStdoutLine: scheduleAbortAfterReady(ac, 100),
  });

  assert.equal(result.timedOut, false);
  assert.equal(result.signal, 'SIGKILL');
  assert.deepEqual(await readSignalLog(signalLog), ['SIGINT', 'SIGTERM']);
});

test('runCodexExec keeps timeout classified as timeout when abort arrives after timeout', async () => {
  const ac = new AbortController();
  const signalLog = await tempSignalLog();

  const result = await runCodexExec({
    bin: join(FIXTURES, 'fake-codex-ignore-interrupt.mjs'),
    args: [],
    cwd: process.cwd(),
    env: { ...process.env, OPENP_FAKE_CODEX_SIGNAL_LOG: signalLog },
    timeoutMs: 1000,
    signal: ac.signal,
    interruptGraceMs: 10000,
    terminateGraceMs: 50,
    onStdoutLine: scheduleAbortAfterReady(ac, 1200),
  });

  assert.equal(result.timedOut, true);
  assert.equal(result.signal, 'SIGKILL');
  assert.deepEqual(await readSignalLog(signalLog), ['SIGINT', 'SIGTERM']);
});

test('runCodexExec treats SIGTERM abort reason as terminate phase, not graceful SIGINT', async () => {
  const ac = new AbortController();
  const signalLog = await tempSignalLog();

  const result = await runCodexExec({
    bin: join(FIXTURES, 'fake-codex-ignore-interrupt.mjs'),
    args: [],
    cwd: process.cwd(),
    env: { ...process.env, OPENP_FAKE_CODEX_SIGNAL_LOG: signalLog },
    timeoutMs: 30000,
    signal: ac.signal,
    interruptGraceMs: 10000,
    terminateGraceMs: 50,
    onStdoutLine: scheduleAbortAfterReady(ac, 0, 'SIGTERM'),
  });

  assert.equal(result.timedOut, false);
  assert.equal(result.signal, 'SIGKILL');
  assert.deepEqual(await readSignalLog(signalLog), ['SIGTERM']);
});

test('runCodexExec force kills a process that ignores graceful interruption on abort', async () => {
  const ac = new AbortController();
  const signalLog = await tempSignalLog();

  const result = await runCodexExec({
    bin: join(FIXTURES, 'fake-codex-ignore-interrupt.mjs'),
    args: [],
    cwd: process.cwd(),
    env: { ...process.env, OPENP_FAKE_CODEX_SIGNAL_LOG: signalLog },
    timeoutMs: 30000,
    signal: ac.signal,
    interruptGraceMs: 50,
    terminateGraceMs: 50,
    onStdoutLine: scheduleAbortAfterReady(ac, 0),
  });

  assert.equal(result.timedOut, false);
  assert.equal(result.signal, 'SIGKILL');
  assert.deepEqual(await readSignalLog(signalLog), ['SIGINT', 'SIGTERM']);
});

test('runCodexExec repeated abort signal escalates before interrupt grace expires', async () => {
  const ac = new AbortController();
  const force = new AbortController();
  const kill = new AbortController();
  const signalLog = await tempSignalLog();

  const result = await runCodexExec({
    bin: join(FIXTURES, 'fake-codex-ignore-interrupt.mjs'),
    args: [],
    cwd: process.cwd(),
    env: { ...process.env, OPENP_FAKE_CODEX_SIGNAL_LOG: signalLog },
    timeoutMs: 30000,
    signal: ac.signal,
    forceSignal: force.signal,
    killSignal: kill.signal,
    interruptGraceMs: 10000,
    terminateGraceMs: 10000,
    onStdoutLine: scheduleAbortAfterReady(ac, 0, undefined, [
      { controller: force, delayMs: 100 },
      { controller: kill, delayMs: 200 },
    ]),
  });

  assert.equal(result.timedOut, false);
  assert.equal(result.signal, 'SIGKILL');
  assert.deepEqual(await readSignalLog(signalLog), ['SIGINT', 'SIGTERM']);
});

test('runCodexExec passes arguments to the script', async () => {
  const lines: string[] = [];
  const result = await runCodexExec({
    bin: join(FIXTURES, 'fake-codex-success.sh'),
    args: ['--json', 'exec', 'hello'],
    cwd: process.cwd(),
    timeoutMs: 10000,
    onStdoutLine: (line) => lines.push(line),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(lines.length, 3);
});

test('runCodexExec survives callback errors', async () => {
  const result = await runCodexExec({
    bin: join(FIXTURES, 'fake-codex-success.sh'),
    args: [],
    cwd: process.cwd(),
    timeoutMs: 10000,
    onStdoutLine: () => { throw new Error('callback boom'); },
  });

  assert.equal(result.exitCode, 0);
  assert.ok(result.stdout.includes('turn.completed'));
});

async function tempSignalLog(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'openp-codex-signal-')), 'signals.log');
}

async function readSignalLog(path: string): Promise<string[]> {
  return (await readFile(path, 'utf8')).trimEnd().split('\n').filter(Boolean);
}

function scheduleAbortAfterReady(
  controller: AbortController,
  delayMs: number,
  reason?: unknown,
  extraAborts: ReadonlyArray<{ readonly controller: AbortController; readonly delayMs: number; readonly reason?: unknown }> = [],
): (line: string) => void {
  let scheduled = false;
  return (line: string): void => {
    if (scheduled || line !== READY_LINE) {
      return;
    }
    scheduled = true;
    setTimeout(() => abort(controller, reason), delayMs);
    for (const extra of extraAborts) {
      setTimeout(() => abort(extra.controller, extra.reason), extra.delayMs);
    }
  };
}

function abort(controller: AbortController, reason?: unknown): void {
  if (reason === undefined) {
    controller.abort();
    return;
  }
  controller.abort(reason);
}
