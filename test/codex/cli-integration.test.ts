import { constants } from 'node:fs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveOpenPStateRoot } from '../../src/core/state-root.js';
import { SessionStateStore } from '../../src/core/session-state.js';
import {
  CODEX_SESSION_ID,
  SESSION_ID,
  collectChild,
  escapeRegExp,
  parseOutputLine,
  readDebugEntries,
  runCommand,
  tsxLoaderArgs,
  waitForFile,
  waitForOutput,
  withFakeCommandEnv,
} from '../helpers/cli-integration.js';

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
  assert.match(result.stdout, /--run-id <id>/);
  assert.match(result.stdout, /--event-log <path>/);
  assert.match(result.stdout, /--verbose/);
  assert.match(result.stdout, /--debug-log\s+Write runner diagnostics/);
  assert.doesNotMatch(result.stdout, /--debug-log\s+\[path\]/);
  assert.match(result.stdout, /Configured backend instances from \$\{XDG_CONFIG_HOME:-~\/\.config\}\/open-p\/instances\.yaml are selectable like built-in backends/);
  assert.match(result.stdout, /Top-level commands/);
  assert.match(result.stdout, /openp auth-status/);
  assert.match(result.stdout, /--operation-id <uuid>/);
  assert.match(result.stdout, /openp seed-status <operation-id>/);
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
    ['claude', '--brief', 'hello'],
  ]) {
    const result = await runCommand(tsxBin, [
      join(repoRoot, 'src/cli.ts'),
      ...args,
    ], projectRoot, { XDG_STATE_HOME: stateRoot });

    assert.equal(result.code, 3);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /unsupported option: --brief/);
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

test('configured Codex instance id is accepted by text CLI dispatch', async () => {
  const repoRoot = process.cwd();
  const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'openp-cli-')));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-cli-state-'));
  const configuredHome = await mkdtemp(join(tmpdir(), 'openp-cli-codex-configured-home-'));
  const ambientHome = await mkdtemp(join(tmpdir(), 'openp-cli-codex-ambient-home-'));
  const argsLog = join(stateRoot, 'codex-alt-args.log');
  const configHome = await writeCodexInstanceConfig('codex-alt', configuredHome);
  const env = await withFakeCommandEnv('codex', join(repoRoot, 'test', 'codex', 'fake-codex-success.sh'), {
    XDG_CONFIG_HOME: configHome,
    XDG_STATE_HOME: stateRoot,
    CODEX_HOME: ambientHome,
    OPENP_FAKE_CODEX_ARGS_LOG: argsLog,
  });

  const result = await runCommand(tsxBin, [
    join(repoRoot, 'src/cli.ts'),
    'codex-alt',
    'hello',
  ], projectRoot, env);

  assert.equal(result.code, 0);
  assert.equal(result.stdout, 'final answer here\n');
  assert.equal(result.stderr, '');
  assert.match(await readFile(join(configuredHome, 'sessions', '2026', '05', '23', `rollout-${CODEX_SESSION_ID}.jsonl`), 'utf8'), /final answer here/);
  await assert.rejects(
    () => readFile(join(ambientHome, 'sessions', '2026', '05', '23', `rollout-${CODEX_SESSION_ID}.jsonl`), 'utf8'),
    (error) => typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT',
  );

  const resume = await runCommand(tsxBin, [
    join(repoRoot, 'src/cli.ts'),
    'codex-alt',
    '--resume',
    CODEX_SESSION_ID,
    'follow up',
  ], projectRoot, env);

  assert.equal(resume.code, 0);
  assert.equal(resume.stdout, 'final answer here\n');
  assert.equal(resume.stderr, '');
  const argLines = (await readFile(argsLog, 'utf8')).trimEnd().split('\n');
  assert.match(argLines[0]!, /\texec\t/);
  assert.doesNotMatch(argLines[0]!, /\tresume\t/);
  assert.match(argLines[1]!, new RegExp(`\\texec\\tresume\\t.*\\t${CODEX_SESSION_ID}\\t-$`));
  assert.ok(!argLines[1]!.includes('follow up'));
  const resumeLog = await readFile(join(configuredHome, 'sessions', '2026', '05', '23', `rollout-${CODEX_SESSION_ID}.jsonl`), 'utf8');
  assert.match(resumeLog, /"text":"follow up"/);
});

test('configured Codex instance id is accepted by stream-json worker dispatch', async () => {
  const repoRoot = process.cwd();
  const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'openp-cli-')));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-cli-state-'));
  const configuredHome = await mkdtemp(join(tmpdir(), 'openp-cli-codex-configured-home-'));
  const ambientHome = await mkdtemp(join(tmpdir(), 'openp-cli-codex-ambient-home-'));
  const configHome = await writeCodexInstanceConfig('codex-alt', configuredHome);
  const env = await withFakeCommandEnv('codex', join(repoRoot, 'test', 'codex', 'fake-codex-success.sh'), {
    XDG_CONFIG_HOME: configHome,
    XDG_STATE_HOME: stateRoot,
    CODEX_HOME: ambientHome,
  });

  const result = await runCommand(tsxBin, [
    join(repoRoot, 'src/cli.ts'),
    'codex-alt',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
  ], projectRoot, env, `${JSON.stringify({ type: 'user', message: { content: 'hello' } })}\n`);
  const events = result.stdout.trimEnd().split('\n').filter(Boolean).map(parseOutputLine);
  const terminal = events.at(-1)?.openp;

  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.equal(terminal.form, 'result');
  assert.equal(terminal.metadata.backend, 'codex-alt');
  assert.equal(terminal.sessionId, CODEX_SESSION_ID);
  assert.match(await readFile(join(configuredHome, 'sessions', '2026', '05', '23', `rollout-${CODEX_SESSION_ID}.jsonl`), 'utf8'), /final answer here/);
});

test('configured Codex instances block cross-instance resume through session state backend id', async () => {
  const repoRoot = process.cwd();
  const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'openp-cli-')));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-cli-state-'));
  const firstHome = await mkdtemp(join(tmpdir(), 'openp-cli-codex-a-home-'));
  const secondHome = await mkdtemp(join(tmpdir(), 'openp-cli-codex-b-home-'));
  const configHome = await writeTwoCodexInstanceConfig('codex-a', firstHome, 'codex-b', secondHome);
  await new SessionStateStore(projectRoot, resolveOpenPStateRoot(projectRoot, { XDG_STATE_HOME: stateRoot })).save({
    backend: 'codex-a',
    backendSessionId: CODEX_SESSION_ID,
    cwd: projectRoot,
    lastProviderSessionId: null,
    sessionLogPath: null,
    lastTurnId: 'previous-turn',
  });

  const result = await runCommand(tsxBin, [
    join(repoRoot, 'src/cli.ts'),
    'codex-b',
    '--resume',
    CODEX_SESSION_ID,
    'follow up',
  ], projectRoot, {
    XDG_CONFIG_HOME: configHome,
    XDG_STATE_HOME: stateRoot,
  });

  assert.equal(result.code, 20);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /belongs to backend codex-a/);
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
  const holder = spawn(process.execPath, tsxLoaderArgs(repoRoot, [
    join(repoRoot, 'test', 'helpers', 'hold-session-lock.ts'),
    projectRoot,
    SESSION_ID,
    '60000',
  ]), {
    cwd: repoRoot,
    env: { ...process.env, XDG_STATE_HOME: stateRoot },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const holderResultPromise = collectChild(holder);

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

  assert.equal(result.code, 21);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /session .* is busy/);
  holder.kill('SIGTERM');
  const holderResult = await holderResultPromise;
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

test('event log mirrors stream-json stdout lines and records lifecycle events', async () => {
  const repoRoot = process.cwd();
  const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'openp-cli-')));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-cli-state-'));
  const eventLogPath = join(stateRoot, 'openp-events.jsonl');
  const env = await withFakeCommandEnv('codex', join(repoRoot, 'test', 'codex', 'fake-codex-item-progress-final.mjs'), {
    XDG_STATE_HOME: stateRoot,
  });

  const result = await runCommand(tsxBin, [
    join(repoRoot, 'src/cli.ts'),
    'codex',
    '--output-format',
    'stream-json',
    '--streaming',
    '--run-id',
    'mirror-run.1',
    '--event-log',
    eventLogPath,
    'hello',
  ], projectRoot, env);
  const stdoutLines = nonEmptyLines(result.stdout);
  const eventLogLines = nonEmptyLines(await readFile(eventLogPath, 'utf8'));
  const lifecycleRecords = eventLogLines
    .filter((line) => Object.prototype.hasOwnProperty.call(JSON.parse(line), 'openpRun'))
    .map((line) => JSON.parse(line));
  const mirrorLines = eventLogLines.filter((line) => Object.prototype.hasOwnProperty.call(JSON.parse(line), 'openp'));

  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.ok(stdoutLines.length >= 2);
  assert.deepEqual(mirrorLines, stdoutLines);
  assert.equal(result.stdout.includes('openpRun'), false);
  assert.deepEqual(Object.keys(JSON.parse(eventLogLines[0]!)), ['openpRun']);
  assert.deepEqual(Object.keys(JSON.parse(eventLogLines.at(-1)!)), ['openpRun']);
  assert.equal(lifecycleRecords.length, 2);
  assert.equal(lifecycleRecords[0].openpRun.schemaVersion, 1);
  assert.deepEqual(Object.keys(lifecycleRecords[0].openpRun).sort(), ['header', 'schemaVersion'].sort());
  assert.equal(lifecycleRecords[0].openpRun.header.runId, 'mirror-run.1');
  assert.equal(lifecycleRecords[0].openpRun.header.backend, 'codex');
  assert.equal(lifecycleRecords[0].openpRun.header.resume, null);
  assert.equal(typeof lifecycleRecords[0].openpRun.header.pid, 'number');
  assert.match(lifecycleRecords[0].openpRun.header.startedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(lifecycleRecords[1].openpRun.schemaVersion, 1);
  assert.deepEqual(Object.keys(lifecycleRecords[1].openpRun).sort(), ['schemaVersion', 'terminal'].sort());
  assert.deepEqual(lifecycleRecords[1].openpRun.terminal, {
    status: 'succeeded',
    exitCode: 0,
    reasonCode: null,
    message: null,
    endedAt: lifecycleRecords[1].openpRun.terminal.endedAt,
  });
  assert.match(lifecycleRecords[1].openpRun.terminal.endedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('event log keeps detached codex turn alive after stdout reader exits', async () => {
  const repoRoot = process.cwd();
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'openp-cli-')));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-cli-state-'));
  const releaseFile = join(stateRoot, 'release-codex-turn');
  const readyFile = join(stateRoot, 'ready-codex-turn');
  const eventLogPath = join(stateRoot, 'detached-events.jsonl');
  const pidFile = join(stateRoot, 'openp-child.pid');
  const wrapperPath = join(stateRoot, 'spawn-detached-openp.mjs');
  const env = await withFakeCommandEnv('codex', join(repoRoot, 'test', 'codex', 'fake-codex-gated-stream.mjs'), {
    ...process.env,
    XDG_STATE_HOME: stateRoot,
    OPENP_FAKE_CODEX_RELEASE_FILE: releaseFile,
    OPENP_FAKE_CODEX_READY_FILE: readyFile,
    // Forces a streaming stdout write after the reader is dead, while the turn is still running.
    // Without the EPIPE tolerance this crashes openp mid-turn and the terminal never records
    // "succeeded", so the assertions below discriminate the safe-stdio mechanism.
    OPENP_FAKE_CODEX_POST_RELEASE_ITEM: 'post release answer',
  });

  await writeFile(wrapperPath, `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const child = spawn(process.execPath, [
  '--import',
  ${JSON.stringify(join(repoRoot, 'node_modules', 'tsx', 'dist', 'loader.mjs'))},
  ${JSON.stringify(join(repoRoot, 'src/cli.ts'))},
  'codex',
  '--output-format',
  'stream-json',
  '--streaming',
  '--run-id',
  'detached-run',
  '--event-log',
  ${JSON.stringify(eventLogPath)},
  'hello',
], {
  cwd: ${JSON.stringify(projectRoot)},
  detached: true,
  env: { ...process.env, ...${JSON.stringify(env)} },
  stdio: ['ignore', 'pipe', 'pipe'],
});

if (!child.pid) {
  throw new Error('missing child pid');
}
child.stdout.on('data', () => {});
child.stderr.on('data', () => {});
child.unref();
writeFileSync(${JSON.stringify(pidFile)}, String(child.pid), 'utf8');
setInterval(() => {}, 1000);
`, 'utf8');
  const wrapper = spawn(process.execPath, [wrapperPath], {
    cwd: repoRoot,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const wrapperResultPromise = collectChild(wrapper);

  try {
    await waitForFile(pidFile);
    await waitForFile(readyFile);
    wrapper.kill('SIGTERM');
    await wrapperResultPromise;
    await writeFile(releaseFile, 'go', 'utf8');
    const eventLogLines = await waitForEventLogTerminal(eventLogPath);
    const lifecycleRecords = eventLogLines
      .filter((line) => Object.prototype.hasOwnProperty.call(JSON.parse(line), 'openpRun'))
      .map((line) => JSON.parse(line));
    const mirrorRecords = eventLogLines
      .filter((line) => Object.prototype.hasOwnProperty.call(JSON.parse(line), 'openp'))
      .map((line) => JSON.parse(line));

    assert.equal(lifecycleRecords[0].openpRun.header.runId, 'detached-run');
    assert.equal(lifecycleRecords[0].openpRun.header.backend, 'codex');
    assert.equal(lifecycleRecords.at(-1).openpRun.terminal.status, 'succeeded');
    assert.equal(lifecycleRecords.at(-1).openpRun.terminal.exitCode, 0);
    assert.equal(mirrorRecords.some((record) => record.openp?.form === 'streaming'), true);
    assert.equal(
      mirrorRecords.some((record) =>
        record.openp?.form === 'streaming' &&
        typeof record.openp.output?.answer === 'string' &&
        record.openp.output.answer.includes('post release answer')),
      true,
      'expected a streaming record written after the stdout reader died to reach the event log',
    );
    assert.equal(mirrorRecords.some((record) => record.openp?.form === 'result'), true);
    assert.equal(mirrorRecords.find((record) => record.openp?.form === 'result')?.openp.sessionId, CODEX_SESSION_ID);
  } catch (error) {
    wrapper.kill('SIGTERM');
    await wrapperResultPromise.catch(() => undefined);
    throw error;
  }
});

test('event log records interrupted terminal while preserving exit 130', async () => {
  const repoRoot = process.cwd();
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'openp-cli-')));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-cli-state-'));
  const eventLogPath = join(stateRoot, 'interrupt-events.jsonl');
  const readyFile = join(stateRoot, 'ready-interrupt-turn');
  const releaseFile = join(stateRoot, 'release-interrupt-turn');
  // The gated fixture writes the ready file only from inside the running turn, so the SIGINT
  // below deterministically lands mid-turn (graceful interrupt path with "operation aborted"
  // stderr). Sending it earlier can legitimately hit the pre-turn guard path instead, which
  // exits 130 with an interrupted terminal but an empty stderr. The release file is never
  // written; the abort escalation stops the gated backend child.
  const env = await withFakeCommandEnv('codex', join(repoRoot, 'test', 'codex', 'fake-codex-gated-stream.mjs'), {
    XDG_STATE_HOME: stateRoot,
    OPENP_FAKE_CODEX_READY_FILE: readyFile,
    OPENP_FAKE_CODEX_RELEASE_FILE: releaseFile,
  });
  const child = spawn(process.execPath, tsxLoaderArgs(repoRoot, [
    join(repoRoot, 'src/cli.ts'),
    'codex',
    '--output-format',
    'stream-json',
    '--event-log',
    eventLogPath,
    'hello',
  ]), {
    cwd: projectRoot,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const childResultPromise = collectChild(child);

  await waitForFile(readyFile);
  child.kill('SIGINT');
  const result = await childResultPromise;
  const terminal = JSON.parse(nonEmptyLines(await readFile(eventLogPath, 'utf8')).at(-1)!).openpRun.terminal;

  assert.equal(result.code, 130);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /operation aborted/);
  assert.equal(terminal.status, 'interrupted');
  assert.equal(terminal.exitCode, 130);
  assert.equal(terminal.reasonCode, null);
  assert.equal(terminal.message, 'operation aborted');
});

test('event log and run id CLI validation rejects invalid combinations', async () => {
  const repoRoot = process.cwd();
  const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'openp-cli-')));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-cli-state-'));

  for (const args of [
    ['codex', '--run-id', '', 'hello'],
    ['codex', '--run-id', 'bad/value', 'hello'],
    ['codex', '--run-id', 'x'.repeat(129), 'hello'],
    ['codex', '--event-log', join(stateRoot, 'text-events.jsonl'), '--output-format', 'text', 'hello'],
    ['codex', '--event-log', join(stateRoot, 'json-events.jsonl'), '--output-format', 'json', 'hello'],
    ['codex', '--event-log', join(stateRoot, 'worker-events.jsonl'), '--input-format', 'stream-json', '--output-format', 'stream-json'],
  ]) {
    const result = await runCommand(tsxBin, [
      join(repoRoot, 'src/cli.ts'),
      ...args,
    ], projectRoot, { XDG_STATE_HOME: stateRoot }, `${JSON.stringify({ type: 'user', message: { content: 'hello' } })}\n`);
    assert.equal(result.code, 2);
    assert.equal(result.stdout, '');
  }
});

test('run id without event log does not change normal codex turn output', async () => {
  const repoRoot = process.cwd();
  const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'openp-cli-')));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-cli-state-'));
  const env = await withFakeCommandEnv('codex', join(repoRoot, 'test', 'codex', 'fake-codex-success.sh'), {
    XDG_STATE_HOME: stateRoot,
  });

  const result = await runCommand(tsxBin, [
    join(repoRoot, 'src/cli.ts'),
    'codex',
    '--run-id',
    'argv-marker-1',
    'hello',
  ], projectRoot, env);

  assert.equal(result.code, 0);
  assert.equal(result.stdout, 'final answer here\n');
  assert.equal(result.stderr, '');
});

test('event log records failed terminal for backend executable not found after header', async () => {
  const repoRoot = process.cwd();
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'openp-cli-')));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-cli-state-'));
  const missingBinDir = await mkdtemp(join(tmpdir(), 'openp-empty-bin-'));
  const eventLogPath = join(stateRoot, 'backend-not-found-events.jsonl');

  const result = await runCommand(process.execPath, [
    '--import',
    join(repoRoot, 'node_modules', 'tsx', 'dist', 'loader.mjs'),
    join(repoRoot, 'src/cli.ts'),
    'codex',
    '--output-format',
    'stream-json',
    '--event-log',
    eventLogPath,
    'hello',
  ], projectRoot, {
    PATH: missingBinDir,
    XDG_STATE_HOME: stateRoot,
  });
  const eventLogLines = nonEmptyLines(await readFile(eventLogPath, 'utf8'));
  const terminal = JSON.parse(eventLogLines.at(-1)!).openpRun.terminal;

  assert.equal(result.code, 10);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /backend executable not found: codex/);
  assert.equal(JSON.parse(eventLogLines[0]!).openpRun.header.backend, 'codex');
  assert.equal(terminal.status, 'failed');
  assert.equal(terminal.exitCode, 10);
  assert.equal(terminal.reasonCode, null);
  assert.equal(terminal.message, 'backend executable not found: codex');
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

async function writeCodexInstanceConfig(instanceId: string, homeDir: string): Promise<string> {
  const configHome = await mkdtemp(join(tmpdir(), 'openp-cli-config-'));
  await mkdir(join(configHome, 'open-p'), { recursive: true });
  await writeFile(join(configHome, 'open-p', 'instances.yaml'), `
instances:
  ${instanceId}:
    backend: codex
    homeDir: ${homeDir}
`);
  return configHome;
}

async function writeTwoCodexInstanceConfig(
  firstId: string,
  firstHomeDir: string,
  secondId: string,
  secondHomeDir: string,
): Promise<string> {
  const configHome = await mkdtemp(join(tmpdir(), 'openp-cli-config-'));
  await mkdir(join(configHome, 'open-p'), { recursive: true });
  await writeFile(join(configHome, 'open-p', 'instances.yaml'), `
instances:
  ${firstId}:
    backend: codex
    homeDir: ${firstHomeDir}
  ${secondId}:
    backend: codex
    homeDir: ${secondHomeDir}
`);
  return configHome;
}

function nonEmptyLines(text: string): string[] {
  return text.trimEnd().split('\n').filter(Boolean);
}

async function waitForEventLogTerminal(path: string): Promise<string[]> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const lines = nonEmptyLines(await readFile(path, 'utf8'));
      const last = lines.at(-1);
      if (last) {
        const parsed = JSON.parse(last);
        if (parsed.openpRun?.terminal) {
          return lines;
        }
      }
    } catch {
      // Keep polling until the detached child writes the terminal record.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for terminal record in ${path}`);
}

test('reports the effort and permission mode Codex ran with, not the ones it was asked for', async () => {
  // The whole point of the actual* fields is to show a turn that ran differently from the request,
  // so this backend reports values that differ from both. Anything echoing the request fails here.
  const repoRoot = process.cwd();
  const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'openp-cli-')));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-cli-state-'));
  const codexHome = await mkdtemp(join(tmpdir(), 'openp-cli-codex-home-'));
  const env = await withFakeCommandEnv('codex', join(repoRoot, 'test', 'codex', 'fake-codex-success.sh'), {
    XDG_STATE_HOME: stateRoot,
    CODEX_HOME: codexHome,
    OPENP_FAKE_CODEX_REPORTED_EFFORT: 'fixture-effort-actual',
    OPENP_FAKE_CODEX_REPORTED_SANDBOX: 'fixture-mode-actual',
  });

  const result = await runCommand(tsxBin, [
    join(repoRoot, 'src/cli.ts'),
    'codex',
    '--effort',
    'fixture-effort-requested',
    '--permission-mode',
    'fixture-mode-requested',
    '--output-format',
    'json',
    'hello',
  ], projectRoot, env);

  assert.equal(result.code, 0);
  const openp = parseOutputLine(result.stdout.trimEnd().split('\n').filter(Boolean).at(-1)!).openp;
  assert.equal(openp.metadata.requestedEffort, 'fixture-effort-requested');
  assert.equal(openp.metadata.actualEffort, 'fixture-effort-actual');
  assert.equal(openp.metadata.requestedPermissionMode, 'fixture-mode-requested');
  assert.equal(openp.metadata.actualPermissionMode, 'fixture-mode-actual');
});

test('leaves the actual effort and permission mode null when Codex reports neither', async () => {
  // The fallback this guards against only shows when the backend states nothing: a request-filled
  // field would look identical to a reported one on every turn where the backend does report.
  const repoRoot = process.cwd();
  const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'openp-cli-')));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-cli-state-'));
  const codexHome = await mkdtemp(join(tmpdir(), 'openp-cli-codex-home-'));
  const env = await withFakeCommandEnv('codex', join(repoRoot, 'test', 'codex', 'fake-codex-success.sh'), {
    XDG_STATE_HOME: stateRoot,
    CODEX_HOME: codexHome,
  });

  const result = await runCommand(tsxBin, [
    join(repoRoot, 'src/cli.ts'),
    'codex',
    '--effort',
    'fixture-effort-requested',
    '--permission-mode',
    'fixture-mode-requested',
    '--output-format',
    'json',
    'hello',
  ], projectRoot, env);

  assert.equal(result.code, 0);
  const openp = parseOutputLine(result.stdout.trimEnd().split('\n').filter(Boolean).at(-1)!).openp;
  assert.equal(openp.metadata.requestedEffort, 'fixture-effort-requested');
  assert.equal(openp.metadata.actualEffort, null);
  assert.equal(openp.metadata.requestedPermissionMode, 'fixture-mode-requested');
  assert.equal(openp.metadata.actualPermissionMode, null);
});

test('reports the effort and permission mode Codex ran with through the stream-json worker too', async () => {
  // The worker path builds its result separately from the direct one, so passing there is not
  // evidence about here: a caller driving turns over stdin saw all four fields empty.
  const repoRoot = process.cwd();
  const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'openp-cli-')));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-cli-state-'));
  const codexHome = await mkdtemp(join(tmpdir(), 'openp-cli-codex-home-'));
  const env = await withFakeCommandEnv('codex', join(repoRoot, 'test', 'codex', 'fake-codex-success.sh'), {
    XDG_STATE_HOME: stateRoot,
    CODEX_HOME: codexHome,
    OPENP_FAKE_CODEX_REPORTED_EFFORT: 'fixture-effort-actual',
    OPENP_FAKE_CODEX_REPORTED_SANDBOX: 'fixture-mode-actual',
  });

  const result = await runCommand(tsxBin, [
    join(repoRoot, 'src/cli.ts'),
    'codex',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--effort',
    'fixture-effort-requested',
    '--permission-mode',
    'fixture-mode-requested',
  ], projectRoot, env, `${JSON.stringify({ type: 'user', message: { content: 'hello' } })}\n`);

  assert.equal(result.code, 0);
  const terminal = result.stdout.trimEnd().split('\n').filter(Boolean).map(parseOutputLine).at(-1)!.openp;
  assert.equal(terminal.form, 'result');
  assert.equal(terminal.metadata.requestedEffort, 'fixture-effort-requested');
  assert.equal(terminal.metadata.actualEffort, 'fixture-effort-actual');
  assert.equal(terminal.metadata.requestedPermissionMode, 'fixture-mode-requested');
  assert.equal(terminal.metadata.actualPermissionMode, 'fixture-mode-actual');
});
