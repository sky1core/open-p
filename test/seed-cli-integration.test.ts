import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { SessionStateStore } from '../src/core/session-state.js';
import { resolveOpenPStateRoot } from '../src/core/state-root.js';
import {
  CODEX_SESSION_ID,
  KIRO_SESSION_ID,
  collectChild,
  runCommand,
  tsxLoaderArgs,
  waitForFile,
  waitForOutput,
} from './helpers/cli-integration.js';

const SEED_SESSION_ID = '55555555-5555-4555-8555-555555555555';
const SEED_FIXTURES = join(process.cwd(), 'test/fixtures/seed');

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

// Parses `openp seed` stdout: it must be exactly one `{"seed":{...}}` line and nothing else.
function parseSeedLine(stdout: string): Record<string, any> {
  const lines = stdout.trimEnd().split('\n').filter(Boolean);
  assert.equal(lines.length, 1, `expected exactly one stdout line, got ${lines.length}`);
  const event = JSON.parse(lines[0]!) as Record<string, any>;
  assert.deepEqual(Object.keys(event), ['seed']);
  return event.seed;
}

function seed(args: readonly string[], projectRoot: string, env: NodeJS.ProcessEnv) {
  const repoRoot = process.cwd();
  const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');
  return runCommand(tsxBin, [join(repoRoot, 'src/cli.ts'), 'seed', ...args], projectRoot, env);
}

async function scratch(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

async function writeHistory(dir: string): Promise<string> {
  const path = join(dir, 'history.json');
  await writeFile(path, JSON.stringify({
    turns: [{ role: 'user', text: 'codename REDMOON' }, { role: 'assistant', text: 'noted' }],
  }));
  return path;
}

test('seed without a backend is a usage error and prints nothing to stdout', async () => {
  const projectRoot = await realpath(await scratch('openp-seed-'));
  const result = await seed(['--history', '/tmp/none.json'], projectRoot, { XDG_STATE_HOME: await scratch('openp-seed-state-') });
  assert.equal(result.code, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /backend is required/);
});

test('seed with a known backend but no --history is a usage error', async () => {
  const projectRoot = await realpath(await scratch('openp-seed-'));
  const result = await seed(['claude'], projectRoot, { XDG_STATE_HOME: await scratch('openp-seed-state-') });
  assert.equal(result.code, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /--history/);
});

test('seed with an unknown backend is exit 3', async () => {
  const projectRoot = await realpath(await scratch('openp-seed-'));
  const result = await seed(['bogus', '--history', '/tmp/none.json'], projectRoot, { XDG_STATE_HOME: await scratch('openp-seed-state-') });
  assert.equal(result.code, 3);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /unknown backend/);
});

test('seed with an unsupported flag is exit 3', async () => {
  const projectRoot = await realpath(await scratch('openp-seed-'));
  const result = await seed(['claude', '--history', '/tmp/none.json', '--frob'], projectRoot, { XDG_STATE_HOME: await scratch('openp-seed-state-') });
  assert.equal(result.code, 3);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /unsupported option/);
});

test('seed opencode is rejected as unsupported (capability) with exit 2', async () => {
  const projectRoot = await realpath(await scratch('openp-seed-'));
  const stateRoot = await scratch('openp-seed-state-');
  const historyPath = await writeHistory(await scratch('openp-seed-hist-'));
  const result = await seed(['opencode', '--history', historyPath], projectRoot, { XDG_STATE_HOME: stateRoot });
  assert.equal(result.code, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /does not support seeding/);
});

test('seed --resume without existing session state is exit 20', async () => {
  const projectRoot = await realpath(await scratch('openp-seed-'));
  const stateRoot = await scratch('openp-seed-state-');
  const historyPath = await writeHistory(await scratch('openp-seed-hist-'));
  const result = await seed(
    ['claude', '--resume', SEED_SESSION_ID, '--history', historyPath],
    projectRoot,
    { XDG_STATE_HOME: stateRoot },
  );
  assert.equal(result.code, 20);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /session state not found/);
});

test('seed --resume against a held session lock is exit 21', async () => {
  const repoRoot = process.cwd();
  const projectRoot = await realpath(await scratch('openp-seed-'));
  const stateRoot = await scratch('openp-seed-state-');
  const historyPath = await writeHistory(await scratch('openp-seed-hist-'));
  await new SessionStateStore(projectRoot, resolveOpenPStateRoot(projectRoot, { XDG_STATE_HOME: stateRoot })).save({
    backend: 'claude',
    backendSessionId: SEED_SESSION_ID,
    cwd: projectRoot,
    lastProviderSessionId: null,
    sessionLogPath: null,
    lastTurnId: 'previous-turn',
  });

  const holder = spawn(process.execPath, tsxLoaderArgs(repoRoot, [
    join(repoRoot, 'test', 'helpers', 'hold-session-lock.ts'),
    projectRoot,
    SEED_SESSION_ID,
    '1500',
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

  const result = await seed(
    ['claude', '--resume', SEED_SESSION_ID, '--history', historyPath],
    projectRoot,
    { XDG_STATE_HOME: stateRoot },
  );
  const holderResult = await holderResultPromise;

  assert.equal(result.code, 21);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /session .* is busy/);
  assert.equal(holderResult.code, 0);
  await assert.rejects(
    () => stat(lockPath),
    (error) => typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT',
  );
});

test('seed --resume kiro appends turns to the log and leaves state and companion untouched', async () => {
  const projectRoot = await realpath(await scratch('openp-seed-'));
  const stateRoot = await scratch('openp-seed-state-');
  const home = await scratch('openp-seed-kiro-home-');
  const historyPath = await writeHistory(await scratch('openp-seed-hist-'));

  const logPath = join(home, '.kiro', 'sessions', 'cli', `${KIRO_SESSION_ID}.jsonl`);
  const companionPath = join(home, '.kiro', 'sessions', 'cli', `${KIRO_SESSION_ID}.json`);
  await mkdir(dirname(logPath), { recursive: true });
  const goldenLog = await readFile(join(SEED_FIXTURES, 'redacted-kiro-golden.jsonl'));
  const goldenCompanion = await readFile(join(SEED_FIXTURES, 'redacted-kiro-golden.json'));
  await writeFile(logPath, goldenLog);
  await writeFile(companionPath, goldenCompanion);
  const companionSha = sha256(goldenCompanion);
  const originalLogLineCount = goldenLog.toString('utf8').trimEnd().split('\n').length;

  const store = new SessionStateStore(projectRoot, resolveOpenPStateRoot(projectRoot, { XDG_STATE_HOME: stateRoot }));
  await store.save({
    backend: 'kiro',
    backendSessionId: KIRO_SESSION_ID,
    cwd: projectRoot,
    lastProviderSessionId: null,
    sessionLogPath: logPath,
    lastTurnId: 'previous-turn',
  });
  const statePath = store.pathForSession(KIRO_SESSION_ID);
  const stateSha = sha256(await readFile(statePath));

  const result = await seed(
    ['kiro', '--resume', KIRO_SESSION_ID, '--history', historyPath],
    projectRoot,
    { XDG_STATE_HOME: stateRoot, HOME: home },
  );

  assert.equal(result.code, 0, result.stderr);
  const seedResult = parseSeedLine(result.stdout);
  assert.deepEqual(seedResult, {
    backend: 'kiro',
    sessionId: KIRO_SESSION_ID,
    appendedTurns: 2,
    mode: 'append',
  });

  const afterLines = (await readFile(logPath, 'utf8')).trimEnd().split('\n');
  assert.equal(afterLines.length, originalLogLineCount + 2);
  const appended = afterLines.slice(originalLogLineCount).map((l) => JSON.parse(l) as Record<string, any>);
  assert.equal(appended[0]!.kind, 'Prompt');
  assert.equal(appended[0]!.data.content[0].data, 'codename REDMOON');
  assert.equal(appended[1]!.kind, 'AssistantMessage');
  assert.equal(appended[1]!.data.content[0].data, 'noted');

  assert.equal(sha256(await readFile(statePath)), stateSha, 'append mode must not rewrite openp state');
  assert.equal(sha256(await readFile(companionPath)), companionSha, '.json companion must be untouched');
});

test('seed --resume codex appends turns to the rollout log and leaves state untouched', async () => {
  const projectRoot = await realpath(await scratch('openp-seed-'));
  const stateRoot = await scratch('openp-seed-state-');
  const codexHome = await scratch('openp-seed-codex-home-');
  const historyPath = await writeHistory(await scratch('openp-seed-hist-'));

  const logPath = join(codexHome, 'sessions', '2026', '07', '14', `rollout-2026-07-14T00-00-00-${CODEX_SESSION_ID}.jsonl`);
  await mkdir(dirname(logPath), { recursive: true });
  const goldenLog = await readFile(join(SEED_FIXTURES, 'redacted-codex-golden.jsonl'));
  await writeFile(logPath, goldenLog);
  const originalLogLineCount = goldenLog.toString('utf8').trimEnd().split('\n').length;

  const store = new SessionStateStore(projectRoot, resolveOpenPStateRoot(projectRoot, { XDG_STATE_HOME: stateRoot }));
  await store.save({
    backend: 'codex',
    backendSessionId: CODEX_SESSION_ID,
    cwd: projectRoot,
    lastProviderSessionId: null,
    sessionLogPath: logPath,
    lastTurnId: 'previous-turn',
  });
  const statePath = store.pathForSession(CODEX_SESSION_ID);
  const stateSha = sha256(await readFile(statePath));

  const result = await seed(
    ['codex', '--resume', CODEX_SESSION_ID, '--history', historyPath],
    projectRoot,
    { XDG_STATE_HOME: stateRoot, CODEX_HOME: codexHome },
  );

  assert.equal(result.code, 0, result.stderr);
  const seedResult = parseSeedLine(result.stdout);
  assert.deepEqual(seedResult, {
    backend: 'codex',
    sessionId: CODEX_SESSION_ID,
    appendedTurns: 2,
    mode: 'append',
  });

  const afterLines = (await readFile(logPath, 'utf8')).trimEnd().split('\n');
  assert.equal(afterLines.length, originalLogLineCount + 2);
  const appended = afterLines.slice(originalLogLineCount).map((l) => JSON.parse(l) as Record<string, any>);
  assert.equal(appended[0]!.payload.role, 'user');
  assert.equal(appended[0]!.payload.content[0].text, 'codename REDMOON');
  assert.equal(appended[1]!.payload.role, 'assistant');
  assert.equal(appended[1]!.payload.content[0].text, 'noted');
  assert.equal(
    appended[0]!.payload.internal_chat_message_metadata_passthrough.turn_id,
    appended[1]!.payload.internal_chat_message_metadata_passthrough.turn_id,
    'user and following assistant share one turn id',
  );

  assert.equal(sha256(await readFile(statePath)), stateSha, 'append mode must not rewrite openp state');
});
