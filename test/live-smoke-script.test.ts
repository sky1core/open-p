import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const scriptPath = join(rootDir, 'scripts', 'live-smoke.mjs');

function runLiveSmokeScript(args: readonly string[]) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: rootDir,
    encoding: 'utf8',
  });
}

test('live smoke script accepts inline backend option without running smoke by default', () => {
  const result = runLiveSmokeScript(['--backend=claude']);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Skipping live smoke/);
  assert.equal(result.stderr, '');
});

test('live smoke script rejects missing backend option value', () => {
  const result = runLiveSmokeScript(['--backend']);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--backend requires a value/);
});

test('live smoke script rejects malformed timeout values', () => {
  for (const value of ['90000junk', '1e5', '12.5', '0', '-1']) {
    const result = runLiveSmokeScript([`--timeout-ms=${value}`]);

    assert.notEqual(result.status, 0, value);
    assert.match(result.stderr, /--timeout-ms must be a positive integer/, value);
  }
});
