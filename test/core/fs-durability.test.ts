import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  confirmStableNativeFileSnapshots,
  ensureDurableDirectory,
  NativeFileSnapshotChangedError,
} from '../../src/core/fs-durability.js';

test('ensureDurableDirectory creates every missing component with private permissions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openp-durable-directory-'));
  const first = join(root, 'state');
  const second = join(first, 'nested');

  await ensureDurableDirectory(second);

  assert.equal((await stat(first)).mode & 0o777, 0o700);
  assert.equal((await stat(second)).mode & 0o777, 0o700);
});

test('ensureDurableDirectory preserves an existing caller-owned directory mode when requested', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openp-shared-debug-directory-'));
  const shared = join(root, 'shared');
  await mkdir(shared, { mode: 0o755 });
  await chmod(shared, 0o755);

  await ensureDurableDirectory(shared, 0o700, false);

  assert.equal((await stat(shared)).mode & 0o777, 0o755);
});

test('confirmStableNativeFileSnapshots returns the post-sync bytes for every stable component', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openp-stable-native-files-'));
  const logPath = join(root, 'session.jsonl');
  const companionPath = join(root, 'session.json');
  const logBytes = Buffer.from('{"log":true}\n');
  const companionBytes = Buffer.from('{"companion":true}\n');
  await writeFile(logPath, logBytes);
  await writeFile(companionPath, companionBytes);

  const confirmed = await confirmStableNativeFileSnapshots([
    { path: logPath, bytes: logBytes },
    { path: companionPath, bytes: companionBytes },
  ]);

  assert.deepEqual(confirmed, [logBytes, companionBytes]);
});

test('confirmStableNativeFileSnapshots rejects drift in either component after the caller snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openp-drifting-native-files-'));
  const logPath = join(root, 'session.jsonl');
  const companionPath = join(root, 'session.json');
  const logBytes = Buffer.from('log-before');
  const companionBytes = Buffer.from('companion-before');
  await writeFile(logPath, logBytes);
  await writeFile(companionPath, companionBytes);

  await writeFile(logPath, 'log-after');
  await assert.rejects(
    () => confirmStableNativeFileSnapshots([
      { path: logPath, bytes: logBytes },
      { path: companionPath, bytes: companionBytes },
    ]),
    (error) => error instanceof NativeFileSnapshotChangedError && error.path === logPath,
  );

  await writeFile(logPath, logBytes);
  await writeFile(companionPath, 'companion-after');
  await assert.rejects(
    () => confirmStableNativeFileSnapshots([
      { path: logPath, bytes: logBytes },
      { path: companionPath, bytes: companionBytes },
    ]),
    (error) => error instanceof NativeFileSnapshotChangedError && error.path === companionPath,
  );
});
