import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { SessionStateStore } from '../src/core/session-state.js';
import { resolveOpenPStateRoot } from '../src/core/state-root.js';
import {
  createInitialProvenanceState,
  SeedProvenanceStore,
} from '../src/core/seed-provenance.js';
import { SeedAppendJournalStore } from '../src/core/seed-append-journal.js';
import {
  SeedOperationLockStore,
  SeedOperationReceiptStore,
  createPreparedSeedOperationReceipt,
} from '../src/core/seed-operation-receipt.js';
import { extractClaudeNativeTurns } from '../src/backends/claude/native-reader.js';
import { resolveClaudeCodeSessionLogPath } from '../src/backends/claude/session-log.js';
import { extractCodexNativeTurns } from '../src/backends/codex/native-reader.js';
import { buildOpenCodeHistoryEnv } from '../src/backends/opencode/env.js';
import { buildLocalhostOnlySandboxCommand } from '../src/backends/opencode/sandbox.js';
import {
  CODEX_SESSION_ID,
  KIRO_SESSION_ID,
  collectChild,
  runCommand,
  tsxLoaderArgs,
  waitForFile,
  withFakeCommandEnv,
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

function seedStatus(args: readonly string[], projectRoot: string, env: NodeJS.ProcessEnv) {
  const repoRoot = process.cwd();
  const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');
  return runCommand(tsxBin, [join(repoRoot, 'src/cli.ts'), 'seed-status', ...args], projectRoot, env);
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
  companion.session_id = sessionId;
  companion.session_state.rts_model_state.conversation_id = sessionId;
  await writeFile(logPath, logText);
  await writeFile(companionPath, `${JSON.stringify(companion, null, 2)}\n`);
  return { logPath, companionPath };
}

async function installCodexFixture(
  home: string,
  sessionId: string,
  fixture = 'redacted-codex-golden.jsonl',
): Promise<string> {
  const logPath = join(home, 'sessions', '2026', '07', '14', `rollout-2026-07-14T00-00-00-${sessionId}.jsonl`);
  await mkdir(dirname(logPath), { recursive: true });
  const entries = (await readFile(join(SEED_FIXTURES, fixture), 'utf8'))
    .trimEnd().split('\n').map((line) => JSON.parse(line));
  const sessionMeta = entries.find((entry) => entry.type === 'session_meta');
  sessionMeta.payload.id = sessionId;
  sessionMeta.payload.session_id = sessionId;
  await writeFile(logPath, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
  return logPath;
}

async function installClaudeFixture(
  configDir: string,
  sessionId: string,
  cwd: string,
  fixture = 'redacted-claude-golden.jsonl',
): Promise<string> {
  const logPath = resolveClaudeCodeSessionLogPath(sessionId, cwd, configDir);
  await mkdir(dirname(logPath), { recursive: true });
  const entries = (await readFile(join(SEED_FIXTURES, fixture), 'utf8'))
    .trimEnd().split('\n').map((line) => JSON.parse(line));
  for (const entry of entries) {
    if (Object.prototype.hasOwnProperty.call(entry, 'sessionId')) entry.sessionId = sessionId;
    if (Object.prototype.hasOwnProperty.call(entry, 'session_id')) entry.session_id = sessionId;
    if (Object.prototype.hasOwnProperty.call(entry, 'cwd')) entry.cwd = cwd;
  }
  await writeFile(logPath, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
  return logPath;
}

async function installConfiguredInstances(
  configRoot: string,
  claudeConfigDir: string,
  codexHomeDir: string,
): Promise<void> {
  const path = join(configRoot, 'open-p', 'instances.yaml');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, [
    'instances:',
    '  claude-seed-alt:',
    '    backend: claude',
    `    configDir: ${JSON.stringify(claudeConfigDir)}`,
    '  codex-seed-alt:',
    '    backend: codex',
    `    homeDir: ${JSON.stringify(codexHomeDir)}`,
    '',
  ].join('\n'));
}

async function saveSeedableTargetState(input: {
  readonly projectRoot: string;
  readonly stateRoot: string;
  readonly backend: string;
  readonly sessionId: string;
  readonly logPath: string;
  readonly bootstrapIds: readonly {
    readonly userId: string;
    readonly assistantIds: readonly string[];
    readonly completionId: string;
  }[];
}): Promise<void> {
  const resolvedStateRoot = resolveOpenPStateRoot(input.projectRoot, { XDG_STATE_HOME: input.stateRoot });
  await new SessionStateStore(input.projectRoot, resolvedStateRoot).save({
    backend: input.backend,
    backendSessionId: input.sessionId,
    cwd: input.projectRoot,
    lastProviderSessionId: null,
    sessionLogPath: input.logPath,
    lastTurnId: 'bootstrap-turn',
  });
  await new SeedProvenanceStore(input.projectRoot, resolvedStateRoot).save(createInitialProvenanceState({
    backend: input.backend,
    sessionId: input.sessionId,
    bootstrap: input.bootstrapIds,
  }));
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

test('seed-status prints one seedOperation JSON line and fails closed for unknown or corrupt receipts', async () => {
  const projectRoot = await realpath(await scratch('openp-seed-status-'));
  const stateRoot = await scratch('openp-seed-status-state-');
  const operationId = randomUUID();
  const workspaceStateRoot = resolveOpenPStateRoot(projectRoot, { XDG_STATE_HOME: stateRoot });
  const receiptStore = new SeedOperationReceiptStore(projectRoot, workspaceStateRoot);
  await receiptStore.create(createPreparedSeedOperationReceipt({
    operationId,
    binding: {
      schemaVersion: 1,
      operationDomainDigest: 'f'.repeat(64),
      source: { kind: 'external-ir' },
      target: { storageIdentityDigest: 'e'.repeat(64) },
    },
    request: {
      targetBackend: 'codex',
      source: { kind: 'external-ir', documentDigest: 'd'.repeat(64) },
      model: null,
      reasoningEffort: null,
      timeoutMs: 0,
      cwd: projectRoot,
    },
    source: {
      output: { kind: 'external-ir', documentDigest: 'd'.repeat(64) },
      turnCount: 1,
      turnDigest: 'a'.repeat(64),
    },
  }));

  const found = await seedStatus([operationId], projectRoot, { XDG_STATE_HOME: stateRoot });
  assert.equal(found.code, 0, found.stderr);
  assert.equal(found.stderr, '');
  const lines = found.stdout.trimEnd().split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]!);
  assert.deepEqual(Object.keys(parsed), ['seedOperation']);
  assert.equal(parsed.seedOperation.operationId, operationId);
  assert.equal(parsed.seedOperation.phase, 'prepared');
  assert.equal(parsed.seedOperation.schemaVersion, 2);
  assert.equal(parsed.seedOperation.identityEvidence, 'recorded');

  const configHome = await scratch('openp-seed-status-config-');
  await mkdir(join(configHome, 'open-p'), { recursive: true });
  await writeFile(join(configHome, 'open-p', 'instances.yaml'), 'instances: [malformed');
  const independentOfBackendConfig = await seedStatus([operationId], projectRoot, {
    XDG_STATE_HOME: stateRoot,
    XDG_CONFIG_HOME: configHome,
  });
  assert.equal(independentOfBackendConfig.code, 0, independentOfBackendConfig.stderr);
  assert.equal(independentOfBackendConfig.stderr, '');
  assert.equal(independentOfBackendConfig.stdout, found.stdout);

  const legacyOperationId = randomUUID();
  const legacyReceipt = JSON.parse(
    await readFile(receiptStore.pathForOperation(operationId), 'utf8'),
  ) as Record<string, unknown>;
  delete legacyReceipt.binding;
  legacyReceipt.schemaVersion = 1;
  legacyReceipt.operationId = legacyOperationId;
  await writeFile(
    receiptStore.pathForOperation(legacyOperationId),
    JSON.stringify(legacyReceipt),
    { mode: 0o600 },
  );
  const legacyStatus = await seedStatus([legacyOperationId], projectRoot, {
    XDG_STATE_HOME: stateRoot,
  });
  assert.equal(legacyStatus.code, 0, legacyStatus.stderr);
  assert.equal(legacyStatus.stderr, '');
  const legacyOperation = JSON.parse(legacyStatus.stdout).seedOperation;
  assert.equal(legacyOperation.schemaVersion, 1);
  assert.equal(legacyOperation.identityEvidence, 'legacy-unbound');
  assert.equal(legacyStatus.stdout.includes('binding'), false);
  assert.equal(legacyStatus.stdout.includes('storageIdentityDigest'), false);
  assert.equal(legacyStatus.stdout.includes('operationDomainDigest'), false);

  const unknown = await seedStatus([randomUUID()], projectRoot, { XDG_STATE_HOME: stateRoot });
  assert.equal(unknown.code, 20);
  assert.equal(unknown.stdout, '');
  assert.match(unknown.stderr, /seed operation not found/);

  await writeFile(receiptStore.pathForOperation(operationId), '{broken', { mode: 0o600 });
  const corrupt = await seedStatus([operationId], projectRoot, { XDG_STATE_HOME: stateRoot });
  assert.equal(corrupt.code, 20);
  assert.equal(corrupt.stdout, '');
  assert.match(corrupt.stderr, /invalid seed operation receipt/);

  const invalid = await seedStatus(['not-a-uuid'], projectRoot, { XDG_STATE_HOME: stateRoot });
  assert.equal(invalid.code, 2);
  assert.equal(invalid.stdout, '');
});

test('seed operation create replay returns identical CLI stdout without launching a second target', async () => {
  const repoRoot = process.cwd();
  const projectRoot = await realpath(await scratch('openp-seed-operation-cli-'));
  const stateRoot = await scratch('openp-seed-operation-cli-state-');
  const codexHome = await scratch('openp-seed-operation-cli-codex-home-');
  const irPath = await writeExternalIr(projectRoot);
  const operationId = randomUUID();
  const argsLog = join(stateRoot, 'codex-args.log');
  const env = await withFakeCommandEnv(
    'codex',
    join(repoRoot, 'test', 'fixtures', 'seed', 'fake-codex-seed-bootstrap.mjs'),
    {
      XDG_STATE_HOME: stateRoot,
      CODEX_HOME: codexHome,
      OPENP_FAKE_CODEX_ARGS_LOG: argsLog,
    },
  );
  const args = ['codex', '--input-ir', irPath, '--operation-id', operationId];

  const first = await seed(args, projectRoot, env);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(first.stderr, '');
  const firstResult = parseSeedLine(first.stdout);
  assert.equal(firstResult.target.sessionId, CODEX_SESSION_ID);
  assert.equal(firstResult.mode, 'create');
  assert.equal(firstResult.status, 'created');
  const targetPath = join(codexHome, 'sessions', '2026', '05', '23', `rollout-${CODEX_SESSION_ID}.jsonl`);
  const targetAfterFirst = await readFile(targetPath);

  const replay = await seed(args, projectRoot, env);
  assert.equal(replay.code, 0, replay.stderr);
  assert.equal(replay.stderr, '');
  assert.equal(replay.stdout, first.stdout);
  assert.deepEqual(await readFile(targetPath), targetAfterFirst);
  assert.equal((await readFile(argsLog, 'utf8')).trimEnd().split('\n').length, 1);

  const status = await seedStatus([operationId], projectRoot, env);
  assert.equal(status.code, 0, status.stderr);
  assert.equal(status.stderr, '');
  const operation = JSON.parse(status.stdout).seedOperation;
  assert.equal(operation.phase, 'succeeded');
  assert.deepEqual(operation.seed, firstResult);
});

test('seed operation replay rejects a configured Codex alias remapped to another home before launch', async () => {
  const repoRoot = process.cwd();
  const projectRoot = await realpath(await scratch('openp-seed-operation-configured-'));
  const stateRoot = await scratch('openp-seed-operation-configured-state-');
  const configHome = await scratch('openp-seed-operation-configured-config-');
  const claudeConfigDir = await scratch('openp-seed-operation-configured-claude-');
  const firstCodexHome = await scratch('openp-seed-operation-configured-codex-a-');
  const secondCodexHome = await scratch('openp-seed-operation-configured-codex-b-');
  const irPath = await writeExternalIr(projectRoot);
  const operationId = randomUUID();
  const argsLog = join(stateRoot, 'codex-args.log');
  await installConfiguredInstances(configHome, claudeConfigDir, firstCodexHome);
  const env = await withFakeCommandEnv(
    'codex',
    join(repoRoot, 'test', 'fixtures', 'seed', 'fake-codex-seed-bootstrap.mjs'),
    {
      XDG_STATE_HOME: stateRoot,
      XDG_CONFIG_HOME: configHome,
      OPENP_FAKE_CODEX_ARGS_LOG: argsLog,
    },
  );
  const args = ['codex-seed-alt', '--input-ir', irPath, '--operation-id', operationId];

  const first = await seed(args, projectRoot, env);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(first.stderr, '');
  assert.equal(parseSeedLine(first.stdout).target.sessionId, CODEX_SESSION_ID);
  const workspaceStateRoot = resolveOpenPStateRoot(projectRoot, { XDG_STATE_HOME: stateRoot });
  const receiptStore = new SeedOperationReceiptStore(projectRoot, workspaceStateRoot);
  const receiptText = await readFile(receiptStore.pathForOperation(operationId), 'utf8');
  assert.equal(receiptText.includes(firstCodexHome), false);
  assert.equal(receiptText.includes(configHome), false);
  const statusBeforeRemap = await seedStatus([operationId], projectRoot, env);
  assert.equal(statusBeforeRemap.code, 0, statusBeforeRemap.stderr);
  assert.equal(statusBeforeRemap.stdout.includes(firstCodexHome), false);
  assert.equal(statusBeforeRemap.stdout.includes('storageIdentityDigest'), false);
  assert.equal(statusBeforeRemap.stdout.includes('operationDomainDigest'), false);
  await installConfiguredInstances(configHome, claudeConfigDir, secondCodexHome);
  await writeFile(irPath, '{source must not be read');

  const replay = await seed(args, projectRoot, env);
  assert.equal(replay.code, 20);
  assert.equal(replay.stdout, '');
  assert.match(replay.stderr, /conflicts with a different execution identity/);
  assert.equal((await readFile(argsLog, 'utf8')).trimEnd().split('\n').length, 1);
  await assert.rejects(
    () => readFile(join(secondCodexHome, 'sessions', '2026', '05', '23', `rollout-${CODEX_SESSION_ID}.jsonl`)),
    (error) => typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT',
  );
});

test('seed operation recovers a SIGKILL-stale creating lock as indeterminate without another target launch', {
  skip: process.platform === 'win32' ? 'requires POSIX process-group signals' : false,
  timeout: 15_000,
}, async () => {
  const repoRoot = process.cwd();
  const projectRoot = await realpath(await scratch('openp-seed-operation-kill-'));
  const stateRoot = await scratch('openp-seed-operation-kill-state-');
  const irPath = await writeExternalIr(projectRoot);
  const operationId = randomUUID();
  const argsLog = join(stateRoot, 'codex-args.log');
  const readyFile = join(stateRoot, 'codex-ready.json');
  const env = await withFakeCommandEnv(
    'codex',
    join(repoRoot, 'test', 'fixtures', 'seed', 'fake-codex-seed-hang.mjs'),
    {
      XDG_STATE_HOME: stateRoot,
      OPENP_FAKE_CODEX_ARGS_LOG: argsLog,
      OPENP_FAKE_CODEX_READY_FILE: readyFile,
    },
  );
  const args = ['codex', '--input-ir', irPath, '--operation-id', operationId];
  const child = spawn(process.execPath, tsxLoaderArgs(repoRoot, [
    join(repoRoot, 'src/cli.ts'),
    'seed',
    ...args,
  ]), {
    cwd: projectRoot,
    env: { ...process.env, ...env },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const childResult = collectChild(child);
  const childPid = child.pid;
  assert.notEqual(childPid, undefined);

  try {
    await waitForFile(readyFile, 10_000);
    const workspaceStateRoot = resolveOpenPStateRoot(projectRoot, { XDG_STATE_HOME: stateRoot });
    const receiptStore = new SeedOperationReceiptStore(projectRoot, workspaceStateRoot);
    assert.equal((await receiptStore.load(operationId))?.phase, 'creating');
    const operationLock = new SeedOperationLockStore(projectRoot, workspaceStateRoot);
    const activeDir = join(operationLock.pathForOperation(operationId), 'active');
    const ownerNames = await readdir(activeDir);
    assert.equal(ownerNames.length, 1);
    const ownerPath = join(activeDir, ownerNames[0]!);
    assert.equal(JSON.parse(await readFile(ownerPath, 'utf8')).pid, childPid);

    process.kill(-childPid!, 'SIGKILL');
    const killed = await childResult;
    assert.equal(killed.code, null);
    assert.equal(killed.stdout, '');
    assert.equal(child.signalCode, 'SIGKILL');
    assert.equal((await receiptStore.load(operationId))?.phase, 'creating');
    assert.equal(JSON.parse(await readFile(ownerPath, 'utf8')).pid, childPid);

    const replay = await seed(args, projectRoot, env);
    assert.equal(replay.code, 20);
    assert.equal(replay.stdout, '');
    assert.match(replay.stderr, /indeterminate/);
    assert.equal((await readFile(argsLog, 'utf8')).trimEnd().split('\n').length, 1);

    const status = await seedStatus([operationId], projectRoot, env);
    assert.equal(status.code, 0, status.stderr);
    const operation = JSON.parse(status.stdout).seedOperation;
    assert.equal(operation.phase, 'indeterminate');
    assert.equal(operation.indeterminateReason, 'creating-owner-ended-before-target-id');
    assert.equal(operation.target, undefined);
    assert.equal(operation.seed, undefined);
    await assert.rejects(
      () => readdir(activeDir),
      (error) => typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT',
    );
  } finally {
    if (childPid !== undefined && child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-childPid, 'SIGKILL');
      } catch {
        // The test-owned process group may already have exited.
      }
    }
    await childResult.catch(() => undefined);
  }
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

test('configured Claude source seeds a configured Codex target through instance-owned roots', async () => {
  const projectRoot = await realpath(await scratch('openp-configured-seed-'));
  const stateRoot = await scratch('openp-configured-seed-state-');
  const configRoot = await scratch('openp-configured-seed-config-');
  const claudeConfigDir = await scratch('openp-configured-claude-');
  const codexHomeDir = await scratch('openp-configured-codex-');
  await installConfiguredInstances(configRoot, claudeConfigDir, codexHomeDir);
  const sourceSessionId = randomUUID();
  const targetSessionId = randomUUID();
  const sourcePath = await installClaudeFixture(claudeConfigDir, sourceSessionId, projectRoot);
  const targetPath = await installCodexFixture(codexHomeDir, targetSessionId, 'redacted-codex-bootstrap.jsonl');
  const sourceBytes = await readFile(sourcePath);
  const sourceTurns = extractClaudeNativeTurns(sourceBytes.toString('utf8'));
  const targetBefore = await readFile(targetPath);
  const targetBootstrap = extractCodexNativeTurns(targetBefore.toString('utf8'));
  assert.equal(sourceTurns.length, 2);
  assert.equal(targetBootstrap.length, 1);
  await saveSeedableTargetState({
    projectRoot,
    stateRoot,
    backend: 'codex-seed-alt',
    sessionId: targetSessionId,
    logPath: targetPath,
    bootstrapIds: targetBootstrap.map((turn) => turn.nativeIds),
  });

  const result = await seed([
    'codex-seed-alt',
    '--resume', targetSessionId,
    '--source-backend', 'claude-seed-alt',
    '--source-session', sourceSessionId,
  ], projectRoot, {
    XDG_CONFIG_HOME: configRoot,
    XDG_STATE_HOME: stateRoot,
    CLAUDE_CONFIG_DIR: await scratch('openp-decoy-claude-'),
    CODEX_HOME: await scratch('openp-decoy-codex-'),
  });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(parseSeedLine(result.stdout), {
    source: { kind: 'native', backend: 'claude-seed-alt', sessionId: sourceSessionId },
    target: { backend: 'codex-seed-alt', sessionId: targetSessionId },
    appendedTurns: 2,
    mode: 'append',
    status: 'updated',
  });
  assert.deepEqual(await readFile(sourcePath), sourceBytes, 'configured source must remain read-only');
  const targetAfter = await readFile(targetPath);
  assert.deepEqual(targetAfter.subarray(0, targetBefore.length), targetBefore, 'configured target prefix must remain immutable');
  const targetTurns = extractCodexNativeTurns(targetAfter.toString('utf8'));
  const targetSuffix = targetTurns.slice(targetBootstrap.length);
  assert.deepEqual(
    targetSuffix.map((turn) => [turn.userText, turn.assistantText]),
    sourceTurns.map((turn) => [turn.userText, turn.assistantText]),
  );
  const workspaceStateRoot = resolveOpenPStateRoot(projectRoot, { XDG_STATE_HOME: stateRoot });
  const provenance = await new SeedProvenanceStore(projectRoot, workspaceStateRoot)
    .load('codex-seed-alt', targetSessionId);
  assert.equal(provenance?.bootstrap.length, 1);
  assert.equal(provenance?.entries.length, 2);
  assert.deepEqual(
    provenance?.entries.map((entry) => entry.source),
    sourceTurns.map((turn) => ({
      kind: 'native', backend: 'claude-seed-alt', sessionId: sourceSessionId, nativeIds: turn.nativeIds,
    })),
  );
  assert.deepEqual(provenance?.entries.map((entry) => entry.target.nativeIds), targetSuffix.map((turn) => turn.nativeIds));
  assert.equal((await new SessionStateStore(projectRoot, workspaceStateRoot).load(targetSessionId))?.backend, 'codex-seed-alt');
  assert.equal(await new SessionStateStore(projectRoot, workspaceStateRoot).loadPendingSeedAppendMarker(targetSessionId), null);
  assert.equal(await new SeedAppendJournalStore(projectRoot, workspaceStateRoot)
    .load('codex-seed-alt', targetSessionId), null);
});

test('configured Codex source seeds a configured Claude target through instance-owned roots', async () => {
  const projectRoot = await realpath(await scratch('openp-configured-seed-'));
  const stateRoot = await scratch('openp-configured-seed-state-');
  const configRoot = await scratch('openp-configured-seed-config-');
  const claudeConfigDir = await scratch('openp-configured-claude-');
  const codexHomeDir = await scratch('openp-configured-codex-');
  await installConfiguredInstances(configRoot, claudeConfigDir, codexHomeDir);
  const sourceSessionId = randomUUID();
  const targetSessionId = randomUUID();
  const sourcePath = await installCodexFixture(codexHomeDir, sourceSessionId);
  const targetPath = await installClaudeFixture(
    claudeConfigDir,
    targetSessionId,
    projectRoot,
    'redacted-claude-bootstrap.jsonl',
  );
  const sourceBytes = await readFile(sourcePath);
  const sourceTurns = extractCodexNativeTurns(sourceBytes.toString('utf8'));
  const targetBefore = await readFile(targetPath);
  const targetBootstrap = extractClaudeNativeTurns(targetBefore.toString('utf8'));
  assert.equal(sourceTurns.length, 2);
  assert.equal(targetBootstrap.length, 1);
  await saveSeedableTargetState({
    projectRoot,
    stateRoot,
    backend: 'claude-seed-alt',
    sessionId: targetSessionId,
    logPath: targetPath,
    bootstrapIds: targetBootstrap.map((turn) => turn.nativeIds),
  });

  const result = await seed([
    'claude-seed-alt',
    '--resume', targetSessionId,
    '--source-backend', 'codex-seed-alt',
    '--source-session', sourceSessionId,
  ], projectRoot, {
    XDG_CONFIG_HOME: configRoot,
    XDG_STATE_HOME: stateRoot,
    CLAUDE_CONFIG_DIR: await scratch('openp-decoy-claude-'),
    CODEX_HOME: await scratch('openp-decoy-codex-'),
  });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(parseSeedLine(result.stdout), {
    source: { kind: 'native', backend: 'codex-seed-alt', sessionId: sourceSessionId },
    target: { backend: 'claude-seed-alt', sessionId: targetSessionId },
    appendedTurns: 2,
    mode: 'append',
    status: 'updated',
  });
  assert.deepEqual(await readFile(sourcePath), sourceBytes, 'configured source must remain read-only');
  const targetAfter = await readFile(targetPath);
  assert.deepEqual(targetAfter.subarray(0, targetBefore.length), targetBefore, 'configured target prefix must remain immutable');
  const targetTurns = extractClaudeNativeTurns(targetAfter.toString('utf8'));
  const targetSuffix = targetTurns.slice(targetBootstrap.length);
  assert.deepEqual(
    targetSuffix.map((turn) => [turn.userText, turn.assistantText]),
    sourceTurns.map((turn) => [turn.userText, turn.assistantText]),
  );
  const workspaceStateRoot = resolveOpenPStateRoot(projectRoot, { XDG_STATE_HOME: stateRoot });
  const provenance = await new SeedProvenanceStore(projectRoot, workspaceStateRoot)
    .load('claude-seed-alt', targetSessionId);
  assert.equal(provenance?.bootstrap.length, 1);
  assert.equal(provenance?.entries.length, 2);
  assert.deepEqual(
    provenance?.entries.map((entry) => entry.source),
    sourceTurns.map((turn) => ({
      kind: 'native', backend: 'codex-seed-alt', sessionId: sourceSessionId, nativeIds: turn.nativeIds,
    })),
  );
  assert.deepEqual(provenance?.entries.map((entry) => entry.target.nativeIds), targetSuffix.map((turn) => turn.nativeIds));
  assert.equal((await new SessionStateStore(projectRoot, workspaceStateRoot).load(targetSessionId))?.backend, 'claude-seed-alt');
  assert.equal(await new SessionStateStore(projectRoot, workspaceStateRoot).loadPendingSeedAppendMarker(targetSessionId), null);
  assert.equal(await new SeedAppendJournalStore(projectRoot, workspaceStateRoot)
    .load('claude-seed-alt', targetSessionId), null);
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
