import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { SessionStateStore } from '../src/core/session-state.js';
import { resolveOpenPStateRoot } from '../src/core/state-root.js';
import { buildOpenCodeHistoryEnv } from '../src/backends/opencode/env.js';
import { buildLocalhostOnlySandboxCommand } from '../src/backends/opencode/sandbox.js';
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
const OPENCODE_SESSION_ID = 'ses_openpseedtest0000000000';
const SEED_FIXTURES = join(process.cwd(), 'test/fixtures/seed');

// The opencode append path drives the real `opencode` CLI (offline: no model/server) wrapped in the
// production macOS sandbox. Skip when either the binary or sandbox-exec is unavailable.
const OPENCODE_SKIP = detectOpenCodeSeedable()
  ? false
  : 'requires the opencode CLI and /usr/bin/sandbox-exec (macOS local-private path)';

function detectOpenCodeSeedable(): boolean {
  if (!existsSync('/usr/bin/sandbox-exec')) {
    return false;
  }
  try {
    return spawnSync('opencode', ['--version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

// Runs the real opencode CLI with the same pure isolated env and sandbox wrapping openp uses, so a
// session injected here lands in the exact store `openp seed opencode` later reads.
function runOpenCodeIsolated(
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const command = buildLocalhostOnlySandboxCommand('opencode', args);
  const child = spawn(command.bin, [...command.args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  return collectChild(child);
}

// Imports the redacted golden export under a custom session id into openp's isolated opencode store
// and returns the isolated env for follow-up export assertions.
async function injectOpenCodeSession(
  projectRoot: string,
  stateRoot: string,
  sessionId: string,
): Promise<NodeJS.ProcessEnv> {
  const fixture = JSON.parse(await readFile(join(SEED_FIXTURES, 'redacted-opencode-golden-export.json'), 'utf8'));
  fixture.info.id = sessionId;
  for (const message of fixture.messages) {
    message.info.sessionID = sessionId;
    for (const part of message.parts) {
      if (typeof part.sessionID === 'string') {
        part.sessionID = sessionId;
      }
    }
  }
  const { env, cacheDir } = await buildOpenCodeHistoryEnv(projectRoot, {
    XDG_STATE_HOME: stateRoot,
    PATH: process.env.PATH,
  });
  const fixturePath = join(cacheDir, `seed-fixture-${randomBytes(8).toString('hex')}.json`);
  await writeFile(fixturePath, JSON.stringify(fixture));
  const result = await runOpenCodeIsolated(['import', fixturePath], projectRoot, env);
  assert.equal(result.code, 0, `fixture import failed: ${result.stderr}`);
  return env;
}

function opencodeTextParts(message: Record<string, any>): string[] {
  return message.parts.filter((p: any) => p.type === 'text').map((p: any) => p.text);
}

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

// opencode now supports seeding; create mode bootstraps a session via a turn, which requires a
// local model. Without --model that turn fails with the same usage exit code (2) as before.
test('seed opencode create mode requires a model and is a usage error (exit 2)', async () => {
  const projectRoot = await realpath(await scratch('openp-seed-'));
  const stateRoot = await scratch('openp-seed-state-');
  const historyPath = await writeHistory(await scratch('openp-seed-hist-'));
  const result = await seed(['opencode', '--history', historyPath], projectRoot, { XDG_STATE_HOME: stateRoot });
  assert.equal(result.code, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /requires --model/);
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

test('seed --resume opencode expands the session and preserves existing messages', { skip: OPENCODE_SKIP }, async () => {
  const projectRoot = await realpath(await scratch('openp-seed-'));
  const stateRoot = await scratch('openp-seed-state-');
  const historyPath = await writeHistory(await scratch('openp-seed-hist-'));

  const isolatedEnv = await injectOpenCodeSession(projectRoot, stateRoot, OPENCODE_SESSION_ID);
  const before = JSON.parse(
    (await runOpenCodeIsolated(['export', OPENCODE_SESSION_ID], projectRoot, isolatedEnv)).stdout,
  );

  const store = new SessionStateStore(projectRoot, resolveOpenPStateRoot(projectRoot, { XDG_STATE_HOME: stateRoot }));
  await store.save({
    backend: 'opencode',
    backendSessionId: OPENCODE_SESSION_ID,
    cwd: projectRoot,
    lastProviderSessionId: null,
    sessionLogPath: null,
    lastTurnId: 'previous-turn',
  });
  const statePath = store.pathForSession(OPENCODE_SESSION_ID);
  const stateSha = sha256(await readFile(statePath));

  const result = await seed(
    ['opencode', '--resume', OPENCODE_SESSION_ID, '--history', historyPath],
    projectRoot,
    { XDG_STATE_HOME: stateRoot },
  );

  assert.equal(result.code, 0, result.stderr);
  const seedResult = parseSeedLine(result.stdout);
  assert.deepEqual(seedResult, {
    backend: 'opencode',
    sessionId: OPENCODE_SESSION_ID,
    appendedTurns: 2,
    mode: 'append',
  });

  const after = JSON.parse(
    (await runOpenCodeIsolated(['export', OPENCODE_SESSION_ID], projectRoot, isolatedEnv)).stdout,
  );
  assert.equal(after.messages.length, before.messages.length + 2);
  assert.deepEqual(
    after.messages.slice(0, before.messages.length),
    before.messages,
    'existing opencode messages must be preserved verbatim',
  );
  const appended = after.messages.slice(before.messages.length);
  assert.equal(appended[0].info.role, 'user');
  assert.deepEqual(opencodeTextParts(appended[0]), ['codename REDMOON']);
  assert.equal(appended[1].info.role, 'assistant');
  assert.deepEqual(opencodeTextParts(appended[1]), ['noted']);

  assert.equal(sha256(await readFile(statePath)), stateSha, 'append mode must not rewrite openp state');
});

test('seed --resume opencode fails with exit 12 when the session was never imported', { skip: OPENCODE_SKIP }, async () => {
  const projectRoot = await realpath(await scratch('openp-seed-'));
  const stateRoot = await scratch('openp-seed-state-');
  const historyPath = await writeHistory(await scratch('openp-seed-hist-'));
  const missingId = 'ses_openpseedmissing0000000';

  const store = new SessionStateStore(projectRoot, resolveOpenPStateRoot(projectRoot, { XDG_STATE_HOME: stateRoot }));
  await store.save({
    backend: 'opencode',
    backendSessionId: missingId,
    cwd: projectRoot,
    lastProviderSessionId: null,
    sessionLogPath: null,
    lastTurnId: 'previous-turn',
  });

  const result = await seed(
    ['opencode', '--resume', missingId, '--history', historyPath],
    projectRoot,
    { XDG_STATE_HOME: stateRoot },
  );

  assert.equal(result.code, 12, result.stderr);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /export exited with code|Session not found/i);
});
