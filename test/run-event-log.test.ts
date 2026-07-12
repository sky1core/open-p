import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openRunEventLog } from '../src/core/run-event-log.js';

test('run event log writes activity lifecycle records', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openp-run-event-log-'));
  const eventLogPath = join(dir, 'events.jsonl');
  const warnings: string[] = [];
  const eventLog = openRunEventLog(eventLogPath, {
    runId: 'run-1',
    pid: 123,
    startedAt: '2026-07-06T00:00:00.000Z',
    backend: 'claude',
    resume: 'session-1',
  }, (warning) => warnings.push(warning));

  eventLog.writeActivity({
    kind: 'backend_wait',
    observedAt: '2026-07-06T00:00:30.000Z',
    backend: 'claude',
    backendSessionId: 'session-1',
    nativeSessionId: 'native-session-1',
    ptySessionId: 'pty-1',
    turnId: 'turn-1',
    stage: 'waiting_for_completion',
    idleMs: 30_000,
    observedLogFile: true,
    sawCallerUserTurn: true,
  });
  eventLog.close();

  assert.deepEqual(warnings, []);
  const records = (await readFile(eventLogPath, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, { schemaVersion: number; activity?: Record<string, unknown>; header?: unknown }>);

  assert.equal(records.length, 2);
  assert.equal(records[0]!.openpRun.schemaVersion, 1);
  assert.ok(records[0]!.openpRun.header);
  assert.deepEqual(records[1]!.openpRun, {
    schemaVersion: 1,
    activity: {
      kind: 'backend_wait',
      observedAt: '2026-07-06T00:00:30.000Z',
      backend: 'claude',
      backendSessionId: 'session-1',
      nativeSessionId: 'native-session-1',
      ptySessionId: 'pty-1',
      turnId: 'turn-1',
      stage: 'waiting_for_completion',
      idleMs: 30_000,
      observedLogFile: true,
      sawCallerUserTurn: true,
    },
  });
  assert.equal((await stat(eventLogPath)).mode & 0o777, 0o666 & ~process.umask());
});

test('run event log creates files with caller umask instead of forcing owner-only access', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openp-run-event-log-'));
  const eventLogPath = join(dir, 'events.jsonl');
  const previousUmask = process.umask(0o027);
  try {
    const eventLog = openRunEventLog(eventLogPath, {
      runId: 'run-created',
      pid: process.pid,
      startedAt: new Date().toISOString(),
      backend: 'codex',
      resume: null,
    }, () => undefined);
    eventLog.close();
  } finally {
    process.umask(previousUmask);
  }

  assert.equal((await stat(eventLogPath)).mode & 0o777, 0o640);
});

test('run event log preserves an existing caller-owned file mode', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openp-run-event-log-'));
  const eventLogPath = join(dir, 'events.jsonl');
  await writeFile(eventLogPath, '');
  await chmod(eventLogPath, 0o644);

  const eventLog = openRunEventLog(eventLogPath, {
    runId: 'run-existing',
    pid: process.pid,
    startedAt: new Date().toISOString(),
    backend: 'codex',
    resume: null,
  }, () => undefined);
  eventLog.close();

  assert.equal((await stat(eventLogPath)).mode & 0o777, 0o644);
});
