import { constants } from 'node:fs';
import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { access, mkdtemp, readFile, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveOpenPStateRoot } from '../src/core/state-root.js';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';

test('built cli.js has execute permission', async () => {
  const cliPath = join(process.cwd(), 'dist', 'src', 'cli.js');
  await access(cliPath, constants.X_OK);
  const mode = (await stat(cliPath)).mode;
  assert.ok(mode & 0o111, `dist/src/cli.js must be executable, got mode ${mode.toString(8)}`);
});

test('version exits without requiring a prompt or launching backend state', async () => {
  const repoRoot = process.cwd();
  const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'openp-cli-')));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-cli-state-'));
  const { version: packageVersion } = JSON.parse(
    await readFile(join(repoRoot, 'package.json'), 'utf8'),
  ) as { readonly version: string };

  const result = await runCommand(tsxBin, [
    join(repoRoot, 'src/cli.ts'),
    '--version',
  ], projectRoot, { OPENP_STATE_DIR: stateRoot });

  assert.equal(result.code, 0);
  assert.equal(result.stdout, `openp ${packageVersion}\n`);
  assert.equal(result.stderr, '');
  await assert.rejects(
    () => stat(join(projectRoot, '.openp')),
    (error) => typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT',
  );
});

test('help exposes partial message streaming opt-in', async () => {
  const repoRoot = process.cwd();
  const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'openp-cli-')));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-cli-state-'));

  const result = await runCommand(tsxBin, [
    join(repoRoot, 'src/cli.ts'),
    '--help',
  ], projectRoot, { OPENP_STATE_DIR: stateRoot });

  assert.equal(result.code, 0);
  assert.match(result.stdout, /--include-partial-messages/);
  assert.equal(result.stderr, '');
  await assert.rejects(
    () => stat(join(projectRoot, '.openp')),
    (error) => typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT',
  );
});

test('version does not hide unsupported options', async () => {
  const repoRoot = process.cwd();
  const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'openp-cli-')));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-cli-state-'));

  const result = await runCommand(tsxBin, [
    join(repoRoot, 'src/cli.ts'),
    '--bad',
    '--version',
  ], projectRoot, { OPENP_STATE_DIR: stateRoot });

  assert.equal(result.code, 3);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /unsupported option: --bad/);
  await assert.rejects(
    () => stat(join(projectRoot, '.openp')),
    (error) => typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT',
  );
});

test('version after prompt separator remains prompt text', async () => {
  const repoRoot = process.cwd();
  const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'openp-cli-')));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-cli-state-'));

  const result = await runCommand(tsxBin, [
    join(repoRoot, 'src/cli.ts'),
    '--backend', 'claude-code',
    '--resume',
    SESSION_ID,
    '--',
    '--version',
  ], projectRoot, { OPENP_STATE_DIR: stateRoot });

  assert.equal(result.code, 20);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /session state not found/);
  await assert.rejects(
    () => stat(join(projectRoot, '.openp')),
    (error) => typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT',
  );
});

test('resume without state fails before backend launch and releases the session lock', async () => {
  const repoRoot = process.cwd();
  const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'openp-cli-')));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-cli-state-'));
  const workspaceStateRoot = resolveOpenPStateRoot(projectRoot, { OPENP_STATE_DIR: stateRoot });

  const result = await runCommand(tsxBin, [
    join(repoRoot, 'src/cli.ts'),
    '--backend', 'claude-code',
    '--resume',
    SESSION_ID,
    'hello',
  ], projectRoot, { OPENP_STATE_DIR: stateRoot });

  assert.equal(result.code, 20);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /session state not found/);

  await assert.rejects(
    () => stat(join(workspaceStateRoot, 'locks', `${SESSION_ID}.lock`)),
    (error) => typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT',
  );
  await assert.rejects(
    () => stat(join(projectRoot, '.openp')),
    (error) => typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT',
  );
});

test('busy session lock fails before backend launch', async () => {
  const repoRoot = process.cwd();
  const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'openp-cli-')));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-cli-state-'));
  const holder = spawn(tsxBin, [
    join(repoRoot, 'test', 'helpers', 'hold-session-lock.ts'),
    projectRoot,
    SESSION_ID,
    '1500',
  ], {
    cwd: repoRoot,
    env: { ...process.env, OPENP_STATE_DIR: stateRoot },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let lockPath = '';
  holder.stdout?.setEncoding('utf8');
  holder.stdout?.on('data', (chunk: string) => {
    lockPath += chunk;
  });
  await waitForOutput(() => lockPath.trim().length > 0);
  lockPath = lockPath.trim();
  await waitForFile(lockPath);
  const result = await runCommand(tsxBin, [
    join(repoRoot, 'src/cli.ts'),
    '--backend', 'claude-code',
    '--resume',
    SESSION_ID,
    'hello',
  ], projectRoot, { OPENP_STATE_DIR: stateRoot });
  const holderResult = await collectChild(holder);

  assert.equal(result.code, 21);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /session .* is busy/);
  assert.equal(holderResult.code, 0);
  await assert.rejects(
    () => stat(lockPath),
    (error) => typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT',
  );
});

test('debug log records start and error events without stdout noise', async () => {
  const repoRoot = process.cwd();
  const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'openp-cli-')));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-cli-state-'));
  const debugLogPath = join(stateRoot, 'logs', 'debug.jsonl');

  const result = await runCommand(tsxBin, [
    join(repoRoot, 'src/cli.ts'),
    '--backend', 'claude-code',
    '--resume',
    SESSION_ID,
    '--debug-log',
    debugLogPath,
    'hello',
  ], projectRoot, { OPENP_STATE_DIR: stateRoot });
  const entries = (await readFile(debugLogPath, 'utf8'))
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line));
  const mode = (await stat(debugLogPath)).mode & 0o777;

  assert.equal(result.code, 20);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /session state not found/);
  assert.equal(mode, 0o600);
  assert.deepEqual(entries.map((entry) => entry.event), ['start', 'error']);
  assert.equal(entries[0].backendSessionId, SESSION_ID);
  assert.equal(entries[1].exitCode, 20);
  await assert.rejects(
    () => stat(join(projectRoot, '.openp')),
    (error) => typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT',
  );
});

test('stream-json input errors do not emit system init on stdout', async () => {
  const repoRoot = process.cwd();
  const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'openp-cli-')));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-cli-state-'));

  const result = await runCommand(tsxBin, [
    join(repoRoot, 'src/cli.ts'),
    '--backend', 'claude-code',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
  ], projectRoot, { OPENP_STATE_DIR: stateRoot }, 'not json\n');

  assert.equal(result.code, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /invalid stream-json input line 1/);
});

function runCommand(
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv = {},
  input = '',
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(command, [...args], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin?.end(input);
  return collectChild(child);
}

function collectChild(child: ChildProcess): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (!child.stdout || !child.stderr) {
      reject(new Error('child process stdio is not piped'));
      return;
    }
    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

async function waitForOutput(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('timed out waiting for output');
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      await stat(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`timed out waiting for ${path}`);
}
