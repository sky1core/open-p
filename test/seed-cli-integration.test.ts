import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
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
} from './helpers/cli-integration.js';

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
    const sandbox = spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)', '/usr/bin/true'], { stdio: 'ignore' });
    return sandbox.status === 0 && spawnSync('opencode', ['--version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

// Runs the real opencode CLI with the same pure isolated env and sandbox wrapping openp uses, so a
// session created here lands in the exact store `openp seed opencode` later reads.
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
async function importOpenCodeSession(
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

async function writeExternalIr(dir: string): Promise<string> {
  const path = join(dir, 'ir.json');
  await writeFile(path, JSON.stringify({
    schemaVersion: 1,
    turns: [{ id: 'one', user: { text: 'codename REDMOON' }, assistant: { text: 'noted' } }],
  }));
  return path;
}

async function installKiroFixture(home: string, sessionId: string): Promise<{ readonly logPath: string; readonly companionPath: string }> {
  const logPath = join(home, '.kiro', 'sessions', 'cli', `${sessionId}.jsonl`);
  const companionPath = join(home, '.kiro', 'sessions', 'cli', `${sessionId}.json`);
  await mkdir(dirname(logPath), { recursive: true });
  const logText = await readFile(join(SEED_FIXTURES, 'redacted-kiro-golden.jsonl'), 'utf8');
  const companion = JSON.parse(await readFile(join(SEED_FIXTURES, 'redacted-kiro-golden.json'), 'utf8'));
  const logIds = new Set(logText.trimEnd().split('\n').map((line) => JSON.parse(line).data?.message_id).filter(Boolean));
  companion.session_state.conversation_metadata.user_turn_metadatas =
    companion.session_state.conversation_metadata.user_turn_metadatas.filter((metadata: any) =>
      Array.isArray(metadata.message_ids) && metadata.message_ids.every((id: string) => logIds.has(id)),
    );
  await writeFile(logPath, logText);
  await writeFile(companionPath, `${JSON.stringify(companion, null, 2)}\n`);
  return { logPath, companionPath };
}

async function installCodexFixture(home: string, sessionId: string): Promise<string> {
  const logPath = join(home, 'sessions', '2026', '07', '14', `rollout-2026-07-14T00-00-00-${sessionId}.jsonl`);
  await mkdir(dirname(logPath), { recursive: true });
  await writeFile(logPath, await readFile(join(SEED_FIXTURES, 'redacted-codex-golden.jsonl')));
  return logPath;
}

test('seed without a backend is a usage error and prints nothing to stdout', async () => {
  const projectRoot = await realpath(await scratch('openp-seed-'));
  const result = await seed(['--input-ir', '/tmp/none.json'], projectRoot, { XDG_STATE_HOME: await scratch('openp-seed-state-') });
  assert.equal(result.code, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /backend is required/);
});

test('seed with a known backend but no source is a usage error', async () => {
  const projectRoot = await realpath(await scratch('openp-seed-'));
  const result = await seed(['claude'], projectRoot, { XDG_STATE_HOME: await scratch('openp-seed-state-') });
  assert.equal(result.code, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /exactly one source/);
});

test('seed with an unknown backend is exit 3', async () => {
  const projectRoot = await realpath(await scratch('openp-seed-'));
  const result = await seed(['bogus', '--input-ir', '/tmp/none.json'], projectRoot, { XDG_STATE_HOME: await scratch('openp-seed-state-') });
  assert.equal(result.code, 3);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /unknown backend/);
});

test('seed with an unsupported flag is exit 3', async () => {
  const projectRoot = await realpath(await scratch('openp-seed-'));
  const result = await seed(['claude', '--input-ir', '/tmp/none.json', '--frob'], projectRoot, { XDG_STATE_HOME: await scratch('openp-seed-state-') });
  assert.equal(result.code, 3);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /unsupported option/);
});

test('seed --history is no longer supported', async () => {
  const projectRoot = await realpath(await scratch('openp-seed-'));
  const result = await seed(['claude', '--history', '/tmp/none.json'], projectRoot, { XDG_STATE_HOME: await scratch('openp-seed-state-') });
  assert.equal(result.code, 3);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /unsupported option: --history/);
});

// opencode now supports seeding; create mode bootstraps a session via a turn, which requires a
// local model. Without --model that turn fails with the same usage exit code (2) as before.
test('seed opencode create mode requires a model and is a usage error (exit 2)', async () => {
  const projectRoot = await realpath(await scratch('openp-seed-'));
  const stateRoot = await scratch('openp-seed-state-');
  const irPath = await writeExternalIr(await scratch('openp-seed-ir-'));
  const result = await seed(['opencode', '--input-ir', irPath], projectRoot, { XDG_STATE_HOME: stateRoot });
  assert.equal(result.code, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /requires --model/);
});

test('seed --resume without existing session state is exit 20', async () => {
  const projectRoot = await realpath(await scratch('openp-seed-'));
  const stateRoot = await scratch('openp-seed-state-');
  const home = await scratch('openp-seed-kiro-home-');
  await installKiroFixture(home, KIRO_SESSION_ID);
  const result = await seed(
    ['kiro', '--resume', KIRO_SESSION_ID, '--source-backend', 'kiro', '--source-session', KIRO_SESSION_ID],
    projectRoot,
    { XDG_STATE_HOME: stateRoot, HOME: home },
  );
  assert.equal(result.code, 20);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /session state not found/);
});

test('seed --resume kiro treats the same native source and target as no-op', async () => {
  const projectRoot = await realpath(await scratch('openp-seed-'));
  const stateRoot = await scratch('openp-seed-state-');
  const home = await scratch('openp-seed-kiro-home-');
  const { logPath, companionPath } = await installKiroFixture(home, KIRO_SESSION_ID);
  const logSha = sha256(await readFile(logPath));
  const companionSha = sha256(await readFile(companionPath));

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
    ['kiro', '--resume', KIRO_SESSION_ID, '--source-backend', 'kiro', '--source-session', KIRO_SESSION_ID],
    projectRoot,
    { XDG_STATE_HOME: stateRoot, HOME: home },
  );

  assert.equal(result.code, 0, result.stderr);
  const seedResult = parseSeedLine(result.stdout);
  assert.deepEqual(seedResult, {
    source: { kind: 'native', backend: 'kiro', sessionId: KIRO_SESSION_ID },
    target: { backend: 'kiro', sessionId: KIRO_SESSION_ID },
    appendedTurns: 0,
    mode: 'append',
    status: 'noop',
  });

  assert.equal(sha256(await readFile(logPath)), logSha, 'same-session no-op must not rewrite jsonl');
  assert.equal(sha256(await readFile(statePath)), stateSha, 'append mode must not rewrite openp state');
  assert.equal(sha256(await readFile(companionPath)), companionSha, 'same-session no-op must not rewrite companion');
});

test('seed --resume codex treats the same native source and target as no-op', async () => {
  const projectRoot = await realpath(await scratch('openp-seed-'));
  const stateRoot = await scratch('openp-seed-state-');
  const codexHome = await scratch('openp-seed-codex-home-');
  const logPath = await installCodexFixture(codexHome, CODEX_SESSION_ID);
  const logSha = sha256(await readFile(logPath));

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
    ['codex', '--resume', CODEX_SESSION_ID, '--source-backend', 'codex', '--source-session', CODEX_SESSION_ID],
    projectRoot,
    { XDG_STATE_HOME: stateRoot, CODEX_HOME: codexHome },
  );

  assert.equal(result.code, 0, result.stderr);
  const seedResult = parseSeedLine(result.stdout);
  assert.deepEqual(seedResult, {
    source: { kind: 'native', backend: 'codex', sessionId: CODEX_SESSION_ID },
    target: { backend: 'codex', sessionId: CODEX_SESSION_ID },
    appendedTurns: 0,
    mode: 'append',
    status: 'noop',
  });

  assert.equal(sha256(await readFile(logPath)), logSha, 'same-session no-op must not rewrite rollout');
  assert.equal(sha256(await readFile(statePath)), stateSha, 'append mode must not rewrite openp state');
});

test('seed --resume opencode treats the same native source and target as no-op', { skip: OPENCODE_SKIP }, async () => {
  const projectRoot = await realpath(await scratch('openp-seed-'));
  const stateRoot = await scratch('openp-seed-state-');

  const isolatedEnv = await importOpenCodeSession(projectRoot, stateRoot, OPENCODE_SESSION_ID);
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
    ['opencode', '--resume', OPENCODE_SESSION_ID, '--source-backend', 'opencode', '--source-session', OPENCODE_SESSION_ID],
    projectRoot,
    { XDG_STATE_HOME: stateRoot },
  );

  assert.equal(result.code, 0, result.stderr);
  const seedResult = parseSeedLine(result.stdout);
  assert.deepEqual(seedResult, {
    source: { kind: 'native', backend: 'opencode', sessionId: OPENCODE_SESSION_ID },
    target: { backend: 'opencode', sessionId: OPENCODE_SESSION_ID },
    appendedTurns: 0,
    mode: 'append',
    status: 'noop',
  });

  const after = JSON.parse(
    (await runOpenCodeIsolated(['export', OPENCODE_SESSION_ID], projectRoot, isolatedEnv)).stdout,
  );
  assert.deepEqual(after, before, 'same-session no-op must not rewrite the opencode export');

  assert.equal(sha256(await readFile(statePath)), stateSha, 'append mode must not rewrite openp state');
});

test('seed --resume opencode fails with exit 12 when the source session was never imported', { skip: OPENCODE_SKIP }, async () => {
  const projectRoot = await realpath(await scratch('openp-seed-'));
  const stateRoot = await scratch('openp-seed-state-');
  const missingId = 'ses_openpseedmissing0000000';

  const store = new SessionStateStore(projectRoot, resolveOpenPStateRoot(projectRoot, { XDG_STATE_HOME: stateRoot }));
  await store.save({
    backend: 'opencode',
    backendSessionId: OPENCODE_SESSION_ID,
    cwd: projectRoot,
    lastProviderSessionId: null,
    sessionLogPath: null,
    lastTurnId: 'previous-turn',
  });

  const result = await seed(
    ['opencode', '--resume', OPENCODE_SESSION_ID, '--source-backend', 'opencode', '--source-session', missingId],
    projectRoot,
    { XDG_STATE_HOME: stateRoot },
  );

  assert.equal(result.code, 12, result.stderr);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /export exited with code|Session not found/i);
});
