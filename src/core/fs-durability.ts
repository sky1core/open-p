import { chmod, mkdir, open, readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

// Persists directory-entry changes (create/rename/link/unlink) after the file itself has been
// synced. Callers translate platform/filesystem errors into their own state-domain error.
export async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export async function syncFile(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export interface NativeFileSnapshot {
  readonly path: string;
  readonly bytes: Buffer;
}

export class NativeFileSnapshotChangedError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(`native file snapshot changed: ${path}`);
    this.name = 'NativeFileSnapshotChangedError';
    this.path = path;
  }
}

// Settlement readers call this after their first complete read. The function makes each file and
// its directory entry durable, then proves that the bytes used by the reader still describe the
// same native state. The returned buffers are the post-sync reads and must be parsed/digested by
// the caller instead of the earlier snapshots.
export async function confirmStableNativeFileSnapshots(
  snapshots: readonly NativeFileSnapshot[],
): Promise<readonly Buffer[]> {
  if (snapshots.length === 0) {
    throw new Error('native file snapshot set must not be empty');
  }
  const paths = new Set<string>();
  for (const snapshot of snapshots) {
    if (paths.has(snapshot.path)) {
      throw new Error(`native file snapshot path is duplicated: ${snapshot.path}`);
    }
    paths.add(snapshot.path);
    await syncFile(snapshot.path);
  }
  for (const directory of new Set(snapshots.map((snapshot) => dirname(snapshot.path)))) {
    await syncDirectory(directory);
  }
  const confirmed = await Promise.all(snapshots.map((snapshot) => readFile(snapshot.path)));
  for (let index = 0; index < snapshots.length; index += 1) {
    if (!confirmed[index]!.equals(snapshots[index]!.bytes)) {
      throw new NativeFileSnapshotChangedError(snapshots[index]!.path);
    }
  }
  return confirmed;
}

// Creates every missing directory one level at a time and fsyncs both the new directory and its
// parent before descending. This makes the complete path reachable after a crash, not merely the
// final file contents. Existing ancestors keep their permissions; the requested directory is
// tightened to the supplied mode.
export async function ensureDurableDirectory(
  path: string,
  mode: number = 0o700,
  chmodExisting: boolean = true,
): Promise<void> {
  const target = resolve(path);
  const missing: string[] = [];
  let cursor = target;
  while (!(await isDirectory(cursor))) {
    missing.push(cursor);
    const parent = dirname(cursor);
    if (parent === cursor) {
      throw new Error(`cannot find an existing parent directory for ${target}`);
    }
    cursor = parent;
  }
  for (const directory of missing.reverse()) {
    try {
      await mkdir(directory, { mode });
    } catch (error) {
      if (!isErrorCode(error, 'EEXIST') || !(await isDirectory(directory))) {
        throw error;
      }
    }
    await chmod(directory, mode);
    await syncDirectory(directory);
    await syncDirectory(dirname(directory));
  }
  if (chmodExisting) {
    await chmod(target, mode);
  }
  await syncDirectory(target);
  await syncDirectory(dirname(target));
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}
