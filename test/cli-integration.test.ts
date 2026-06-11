import { constants } from 'node:fs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveOpenPStateRoot } from '../src/core/state-root.js';
import { SessionStateStore } from '../src/core/session-state.js';
import {
  SESSION_ID,
  collectChild,
  escapeRegExp,
  parseOutputLine,
  readDebugEntries,
  runCommand,
  waitForFile,
  waitForOutput,
} from './helpers/cli-integration.js';

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
  ], projectRoot, { XDG_STATE_HOME: stateRoot });

  assert.equal(result.code, 0);
  assert.equal(result.stdout, `openp ${packageVersion}\n`);
  assert.equal(result.stderr, '');
  await assert.rejects(
    () => stat(join(projectRoot, '.openp')),
    (error) => typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT',
  );
});

test('help exposes public streaming and reasoning effort options', async () => {
  const repoRoot = process.cwd();
  const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'openp-cli-')));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-cli-state-'));

  const result = await runCommand(tsxBin, [
    join(repoRoot, 'src/cli.ts'),
    '--help',
  ], projectRoot, { XDG_STATE_HOME: stateRoot });

  assert.equal(result.code, 0);
  assert.match(result.stdout, /openp \[options\] <backend> \[options\] \[prompt\]/);
  assert.match(result.stdout, /Backend selection is the first non-option positional argument/);
  assert.match(result.stdout, /Public options may appear before or after the backend/);
  assert.match(result.stdout, /--streaming/);
  assert.doesNotMatch(result.stdout, /--include-partial-messages/);
  assert.match(result.stdout, /--effort <level>/);
  assert.match(result.stdout, /--tools <tools>/);
  assert.match(result.stdout, /--verbose/);
  assert.match(result.stdout, /--debug-log\s+Write runner diagnostics/);
  assert.doesNotMatch(result.stdout, /--debug-log\s+\[path\]/);
  assert.match(result.stdout, /Configured backend instances from \$\{XDG_CONFIG_HOME:-~\/\.config\}\/open-p\/instances\.yaml are selectable like built-in backends/);
  assert.match(result.stdout, /Top-level commands/);
  assert.match(result.stdout, /Only the options listed above are public openp options/);
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
  ], projectRoot, { XDG_STATE_HOME: stateRoot });

  assert.equal(result.code, 3);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /unsupported option: --bad/);
  await assert.rejects(
    () => stat(join(projectRoot, '.openp')),
    (error) => typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT',
  );
});

test('public CLI rejects Claude-native compatibility flags instead of ignoring them', async () => {
  const repoRoot = process.cwd();
  const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'openp-cli-')));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-cli-state-'));

  for (const args of [
    ['claude', '--permission-mode', 'bypassPermissions', 'hello'],
    ['claude', '--brief', 'hello'],
  ]) {
    const result = await runCommand(tsxBin, [
      join(repoRoot, 'src/cli.ts'),
      ...args,
    ], projectRoot, { XDG_STATE_HOME: stateRoot });

    assert.equal(result.code, 3);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /unsupported option: --(?:permission-mode|brief)/);
  }
  await assert.rejects(
    () => stat(join(projectRoot, '.openp')),
    (error) => typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT',
  );
});

test('configured backend instance id is accepted by text CLI dispatch', async () => {
  const repoRoot = process.cwd();
  const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'openp-cli-')));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-cli-state-'));
  const configHome = await writeInstanceConfig('claude-alt');

  const result = await runCommand(tsxBin, [
    join(repoRoot, 'src/cli.ts'),
    'claude-alt',
    '--resume',
    SESSION_ID,
    'hello',
  ], projectRoot, {
    XDG_CONFIG_HOME: configHome,
    XDG_STATE_HOME: stateRoot,
  });

  assert.equal(result.code, 20);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /session state not found/);
  assert.doesNotMatch(result.stderr, /unknown backend/);
});

test('configured backend instance id is accepted by stream-json worker dispatch', async () => {
  const repoRoot = process.cwd();
  const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'openp-cli-')));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-cli-state-'));
  const configHome = await writeInstanceConfig('claude-alt');

  const result = await runCommand(tsxBin, [
    join(repoRoot, 'src/cli.ts'),
    'claude-alt',
    '--resume',
    SESSION_ID,
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
  ], projectRoot, {
    XDG_CONFIG_HOME: configHome,
    XDG_STATE_HOME: stateRoot,
  }, `${JSON.stringify({ type: 'user', message: { content: 'hello' } })}\n`);

  assert.equal(result.code, 20);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /session state not found/);
  assert.doesNotMatch(result.stderr, /unknown backend/);
});

test('version after prompt separator remains prompt text', async () => {
  const repoRoot = process.cwd();
  const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'openp-cli-')));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-cli-state-'));

  const result = await runCommand(tsxBin, [
    join(repoRoot, 'src/cli.ts'),
    'claude',
    '--resume',
    SESSION_ID,
    '--',
    '--version',
  ], projectRoot, { XDG_STATE_HOME: stateRoot });

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
  const workspaceStateRoot = resolveOpenPStateRoot(projectRoot, { XDG_STATE_HOME: stateRoot });

  const result = await runCommand(tsxBin, [
    join(repoRoot, 'src/cli.ts'),
    'claude',
    '--resume',
    SESSION_ID,
    'hello',
  ], projectRoot, { XDG_STATE_HOME: stateRoot });

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
  await new SessionStateStore(projectRoot, resolveOpenPStateRoot(projectRoot, { XDG_STATE_HOME: stateRoot })).save({
    backend: 'claude',
    backendSessionId: SESSION_ID,
    cwd: projectRoot,
    lastProviderSessionId: null,
    sessionLogPath: null,
    lastTurnId: 'previous-turn',
  });
  const holder = spawn(tsxBin, [
    join(repoRoot, 'test', 'helpers', 'hold-session-lock.ts'),
    projectRoot,
    SESSION_ID,
    '1500',
  ], {
    cwd: repoRoot,
    env: { ...process.env, XDG_STATE_HOME: stateRoot },
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
    'claude',
    '--resume',
    SESSION_ID,
    'hello',
  ], projectRoot, { XDG_STATE_HOME: stateRoot });
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
  const debugLogPath = join(
    resolveOpenPStateRoot(projectRoot, { XDG_STATE_HOME: stateRoot }),
    'logs',
    'debug.jsonl',
  );
  const { version: packageVersion } = JSON.parse(
    await readFile(join(repoRoot, 'package.json'), 'utf8'),
  ) as { readonly version: string };

  const result = await runCommand(tsxBin, [
    join(repoRoot, 'src/cli.ts'),
    'claude',
    '--resume',
    SESSION_ID,
    '--debug-log',
    'hello',
  ], projectRoot, { XDG_STATE_HOME: stateRoot });
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
  assert.equal(entries[0].openpVersion, packageVersion);
  assert.equal(entries[1].openpVersion, packageVersion);
  assert.equal(entries[0].backendSessionId, SESSION_ID);
  assert.equal(entries[1].exitCode, 20);
  await assert.rejects(
    () => stat(join(projectRoot, '.openp')),
    (error) => typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT',
  );
});

test('debug log without explicit path writes to the workspace default log', async () => {
  const repoRoot = process.cwd();
  const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'openp-cli-')));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-cli-state-'));
  const debugLogPath = join(
    resolveOpenPStateRoot(projectRoot, { XDG_STATE_HOME: stateRoot }),
    'logs',
    'debug.jsonl',
  );

  const result = await runCommand(tsxBin, [
    join(repoRoot, 'src/cli.ts'),
    'claude',
    '--resume',
    SESSION_ID,
    '--debug-log',
    '--',
    'hello',
  ], projectRoot, { XDG_STATE_HOME: stateRoot });
  const entries = await readDebugEntries(debugLogPath);

  assert.equal(result.code, 20);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /session state not found/);
  assert.deepEqual(entries.map((entry) => entry.event), ['start', 'error']);
  assert.equal(entries[0].backendSessionId, SESSION_ID);
  assert.equal(entries[1].exitCode, 20);
});

test('debug log path form is unsupported', async () => {
  const repoRoot = process.cwd();
  const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'openp-cli-')));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-cli-state-'));
  const debugLogPath = join(
    resolveOpenPStateRoot(projectRoot, { XDG_STATE_HOME: stateRoot }),
    'logs',
    'debug.jsonl',
  );

  const result = await runCommand(tsxBin, [
    join(repoRoot, 'src/cli.ts'),
    'claude',
    `--debug-log=${join(stateRoot, 'debug.jsonl')}`,
    'hello',
  ], projectRoot, { XDG_STATE_HOME: stateRoot });

  assert.equal(result.code, 3);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /unsupported option: --debug-log=/);
  await assert.rejects(
    () => stat(debugLogPath),
    (error) => typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT',
  );
});

test('debug log without prompt records pre-launch usage error in default log', async () => {
  const repoRoot = process.cwd();
  const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'openp-cli-')));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-cli-state-'));
  const debugLogPath = join(
    resolveOpenPStateRoot(projectRoot, { XDG_STATE_HOME: stateRoot }),
    'logs',
    'debug.jsonl',
  );

  const result = await runCommand(tsxBin, [
    join(repoRoot, 'src/cli.ts'),
    'claude',
    '--debug-log',
  ], projectRoot, { XDG_STATE_HOME: stateRoot });
  const entries = await readDebugEntries(debugLogPath);

  assert.equal(result.code, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /prompt is required/);
  assert.deepEqual(entries.map((entry) => entry.event), ['error']);
  assert.equal(entries[0].exitCode, 2);
});

test('debug log records option parse errors in default log', async () => {
  const repoRoot = process.cwd();
  const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'openp-cli-')));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-cli-state-'));
  const debugLogPath = join(
    resolveOpenPStateRoot(projectRoot, { XDG_STATE_HOME: stateRoot }),
    'logs',
    'debug.jsonl',
  );

  const result = await runCommand(tsxBin, [
    join(repoRoot, 'src/cli.ts'),
    'claude',
    '--debug-log',
    '--badopt',
  ], projectRoot, { XDG_STATE_HOME: stateRoot });
  const entries = await readDebugEntries(debugLogPath);

  assert.equal(result.code, 3);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /unsupported option: --badopt/);
  assert.deepEqual(entries.map((entry) => entry.event), ['error']);
  assert.equal(entries[0].exitCode, 3);
});

test('verbose parse error reports exit code and default debug log path on stderr', async () => {
  const repoRoot = process.cwd();
  const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'openp-cli-')));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-cli-state-'));
  const debugLogPath = join(
    resolveOpenPStateRoot(projectRoot, { XDG_STATE_HOME: stateRoot }),
    'logs',
    'debug.jsonl',
  );

  const result = await runCommand(tsxBin, [
    join(repoRoot, 'src/cli.ts'),
    'claude',
    '--verbose',
    '--debug-log',
    '--badopt',
  ], projectRoot, { XDG_STATE_HOME: stateRoot });
  const entries = await readDebugEntries(debugLogPath);

  assert.equal(result.code, 3);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /unsupported option: --badopt/);
  assert.match(result.stderr, /\[openp error\] exit_code: 3/);
  assert.match(result.stderr, new RegExp(escapeRegExp(`[openp error] debug_log: ${debugLogPath}`)));
  assert.deepEqual(entries.map((entry) => entry.event), ['error']);
  assert.equal(entries[0].exitCode, 3);
});

test('stream-json input errors do not emit system init on stdout', async () => {
  const repoRoot = process.cwd();
  const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'openp-cli-')));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-cli-state-'));

  const result = await runCommand(tsxBin, [
    join(repoRoot, 'src/cli.ts'),
    'claude',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
  ], projectRoot, { XDG_STATE_HOME: stateRoot }, 'not json\n');

  assert.equal(result.code, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /invalid stream-json input line 1/);
});

async function writeInstanceConfig(instanceId: string): Promise<string> {
  const configHome = await mkdtemp(join(tmpdir(), 'openp-cli-config-'));
  await mkdir(join(configHome, 'open-p'), { recursive: true });
  await writeFile(join(configHome, 'open-p', 'instances.yaml'), `
instances:
  ${instanceId}:
    backend: claude
    configDir: ${join(configHome, `${instanceId}-config`)}
`);
  return configHome;
}
