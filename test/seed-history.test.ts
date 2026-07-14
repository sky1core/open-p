import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { OpenPError } from '../src/core/errors.js';
import { loadSeedHistoryFile, parseSeedHistoryJson } from '../src/core/seed-history.js';

function rejects(text: string): void {
  try {
    parseSeedHistoryJson(text, '/tmp/history.json');
  } catch (error) {
    assert.ok(error instanceof OpenPError, `expected OpenPError, got ${String(error)}`);
    assert.equal(error.exitCode, 2);
    return;
  }
  throw new Error(`expected parseSeedHistoryJson to reject: ${text}`);
}

test('parses a valid two-turn history', () => {
  assert.deepEqual(
    parseSeedHistoryJson('{"turns":[{"role":"user","text":"hi"},{"role":"assistant","text":"yo"}]}', '/x.json'),
    [{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'yo' }],
  );
});

test('preserves whitespace-only text without trimming', () => {
  assert.deepEqual(
    parseSeedHistoryJson('{"turns":[{"role":"user","text":"  "}]}', '/x.json'),
    [{ role: 'user', text: '  ' }],
  );
});

test('rejects malformed history documents', () => {
  rejects('not json');
  rejects('[1,2,3]');
  rejects('{"turns":[{"role":"user","text":"hi"}],"extra":1}');
  rejects('{"messages":[]}');
  rejects('{"turns":{}}');
  rejects('{"turns":[]}');
});

test('rejects malformed turns', () => {
  rejects('{"turns":["hi"]}');
  rejects('{"turns":[{"role":"user","text":"hi","extra":1}]}');
  rejects('{"turns":[{"role":"user"}]}');
  rejects('{"turns":[{"role":"system","text":"hi"}]}');
  rejects('{"turns":[{"role":"user","text":""}]}');
  rejects('{"turns":[{"role":"user","text":5}]}');
});

test('loadSeedHistoryFile reads and validates a file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openp-seed-history-'));
  const path = join(dir, 'history.json');
  await writeFile(path, '{"turns":[{"role":"assistant","text":"remembered"}]}');
  assert.deepEqual(await loadSeedHistoryFile(path), [{ role: 'assistant', text: 'remembered' }]);
});

test('loadSeedHistoryFile rejects a missing file as usage', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openp-seed-history-'));
  await assert.rejects(
    () => loadSeedHistoryFile(join(dir, 'absent.json')),
    (error) => error instanceof OpenPError && error.exitCode === 2,
  );
});

test('loadSeedHistoryFile rejects an invalid file as usage', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openp-seed-history-'));
  const path = join(dir, 'bad.json');
  await writeFile(path, '{"turns":[]}');
  await assert.rejects(
    () => loadSeedHistoryFile(path),
    (error) => error instanceof OpenPError && error.exitCode === 2,
  );
});
