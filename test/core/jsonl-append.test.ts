import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, mkdtemp, readFile, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { isAbortError } from '../../src/core/abort.js';
import { appendJsonlLines, commitAppendTransaction } from '../../src/core/jsonl-append.js';

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

async function scratchFile(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'openp-jsonl-append-'));
  return join(dir, name);
}

test('inserts a separating newline when the file lacks a trailing newline', async () => {
  const path = await scratchFile('log.jsonl');
  const original = Buffer.from('{"a":1}\n{"b":2}', 'utf8'); // no trailing newline
  await writeFile(path, original);
  const beforeSha = sha256(original);

  await appendJsonlLines(path, ['{"c":3}']);

  const after = await readFile(path);
  assert.equal(sha256(after.subarray(0, original.length)), beforeSha, 'prefix bytes must be immutable');
  assert.equal(after[original.length], 0x0a, 'a separating newline must be inserted');
  assert.equal(after.toString('utf8'), '{"a":1}\n{"b":2}\n{"c":3}\n');
});

test('does not add a second newline when the file already ends with one', async () => {
  const path = await scratchFile('log.jsonl');
  const original = Buffer.from('{"a":1}\n', 'utf8');
  await writeFile(path, original);
  const beforeSha = sha256(original);

  await appendJsonlLines(path, ['{"b":2}', '{"c":3}']);

  const after = await readFile(path);
  assert.equal(sha256(after.subarray(0, original.length)), beforeSha, 'prefix bytes must be immutable');
  assert.equal(after.toString('utf8'), '{"a":1}\n{"b":2}\n{"c":3}\n');
  for (const line of after.toString('utf8').trimEnd().split('\n')) {
    JSON.parse(line); // every line must remain independently parseable
  }
});

test('writes a bare line into an empty file without a leading newline', async () => {
  const path = await scratchFile('log.jsonl');
  await writeFile(path, '');

  await appendJsonlLines(path, ['{"only":true}']);

  assert.equal((await readFile(path)).toString('utf8'), '{"only":true}\n');
});

test('an empty append leaves the file untouched', async () => {
  const path = await scratchFile('log.jsonl');
  const original = Buffer.from('{"a":1}', 'utf8');
  await writeFile(path, original);

  await appendJsonlLines(path, []);

  assert.equal(sha256(await readFile(path)), sha256(original));
});

test('an aborted signal rejects after the newline probe and before the write', async () => {
  const path = await scratchFile('log.jsonl');
  const original = Buffer.from('{"a":1}\n', 'utf8');
  await writeFile(path, original);
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () => appendJsonlLines(path, ['{"b":2}'], controller.signal),
    isAbortError,
  );

  assert.equal(sha256(await readFile(path)), sha256(original), 'file must be untouched after an aborted append');
});

test('an abort observed after opening the file rejects before the write', async () => {
  const path = await scratchFile('log.jsonl');
  const original = Buffer.from('{"a":1}\n', 'utf8');
  await writeFile(path, original);
  let checks = 0;
  const signal = {
    get aborted() {
      checks += 1;
      return checks >= 2;
    },
  } as AbortSignal;

  await assert.rejects(
    () => appendJsonlLines(path, ['{"b":2}'], signal),
    isAbortError,
  );

  assert.equal(checks >= 2, true);
  assert.equal(sha256(await readFile(path)), sha256(original), 'file must be untouched after a pre-write abort');
});

test('a partial append failure truncates the file back to its exact original bytes', async () => {
  const path = await scratchFile('log.jsonl');
  const original = Buffer.from('{"a":1}\n', 'utf8');
  await writeFile(path, original);
  const injected = new Error('injected partial write failure');

  await assert.rejects(
    () => commitAppendTransaction({
      write: async () => {
        await appendFile(path, '{"partial"');
        throw injected;
      },
      close: async () => undefined,
      rollback: () => truncate(path, original.length),
    }),
    (error) => error === injected,
  );

  assert.equal(sha256(await readFile(path)), sha256(original));
});

test('a close failure rolls back any written suffix and surfaces the close error', async () => {
  const path = await scratchFile('log.jsonl');
  const original = Buffer.from('{"a":1}\n', 'utf8');
  await writeFile(path, original);
  const injected = new Error('injected close failure');

  await assert.rejects(
    () => commitAppendTransaction({
      write: () => appendFile(path, '{"closed":false}\n'),
      close: async () => {
        throw injected;
      },
      rollback: () => truncate(path, original.length),
    }),
    (error) => error === injected,
  );

  assert.equal(sha256(await readFile(path)), sha256(original));
});

test('a rollback failure after append failure is reported as protocol violation', async () => {
  const path = await scratchFile('log.jsonl');
  await writeFile(path, '{"a":1}\n');

  await assert.rejects(
    () => commitAppendTransaction({
      write: async () => {
        await appendFile(path, '{"partial":true}');
        throw new Error('write failed');
      },
      close: async () => undefined,
      rollback: async () => {
        throw new Error('rollback failed');
      },
    }),
    (error) => error instanceof Error && 'exitCode' in error && error.exitCode === 40,
  );
});
