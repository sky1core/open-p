import assert from 'node:assert/strict';
import test from 'node:test';
import { runOpenCodeExec } from '../src/backends/opencode/exec-runner.js';
import { isAbortError } from '../src/core/abort.js';
import { OpenPError } from '../src/core/errors.js';

const BASE = {
  bin: process.execPath,
  cwd: process.cwd(),
  env: process.env,
  timeoutMs: 0,
} as const;

test('OpenCode exec rejects invalid UTF-8 stdout before it can become native state evidence', async () => {
  await assert.rejects(
    () => runOpenCodeExec({
      ...BASE,
      args: ['-e', 'process.stdout.write(Buffer.from([0x22, 0x80, 0x22]))'],
    }),
    (error) => error instanceof OpenPError && error.exitCode === 40,
  );
});

test('OpenCode exec accepts a valid UTF-8 character split across stdout chunks', async () => {
  const result = await runOpenCodeExec({
    ...BASE,
    args: ['-e', [
      'process.stdout.write(Buffer.from([0xe2]))',
      'setTimeout(() => process.stdout.write(Buffer.from([0x82, 0xac])), 5)',
    ].join(';')],
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, '€\n');
});

test('OpenCode exec preserves abort classification over malformed stdout', async () => {
  const controller = new AbortController();
  const pending = runOpenCodeExec({
    ...BASE,
    args: ['-e', 'process.stdout.write(Buffer.from([0x80]), () => setInterval(() => {}, 1000))'],
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 300);

  await assert.rejects(pending, isAbortError);
});

test('OpenCode exec preserves timeout classification over malformed stdout', async () => {
  const result = await runOpenCodeExec({
    ...BASE,
    args: ['-e', 'process.stdout.write(Buffer.from([0x80]), () => setInterval(() => {}, 1000))'],
    timeoutMs: 300,
  });

  assert.equal(result.timedOut, true);
});

test('OpenCode exec preserves a non-zero exit over malformed stdout', async () => {
  const result = await runOpenCodeExec({
    ...BASE,
    args: ['-e', 'process.stdout.write(Buffer.from([0x80])); process.exitCode = 9'],
  });

  assert.equal(result.exitCode, 9);
  assert.equal(result.timedOut, false);
});
