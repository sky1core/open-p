import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtemp, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { KiroBackend } from '../src/backends/kiro/backend.js';
import { SessionLockStore } from '../src/core/session-lock.js';
import { EXIT_CODES, OpenPError } from '../src/core/errors.js';
import { isAbortError } from '../src/core/abort.js';

const FIXTURE = join(import.meta.dirname, 'fixtures', 'kiro', 'fake-kiro-acp.mjs');
const FAKE_KIRO_SESSION_ID = '33333333-3333-4333-8333-333333333333';

const BASE_OPTIONS = {
  cwd: process.cwd(),
  backendSessionId: 'openp-first-turn-id',
  resume: false,
  timeoutMs: 5000,
  model: null,
  reasoningEffort: null,
  permissionMode: null,
  tools: null,
  jsonSchema: null,
  backendArgs: [] as string[],
  debugLog: null,
};

function withFakeKiro(behavior: string, fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    const prevPath = process.env.PATH;
    const prevBehavior = process.env.OPENP_FAKE_KIRO_BEHAVIOR;
    const prevHome = process.env.HOME;
    const prevWriteSessionLog = process.env.OPENP_FAKE_KIRO_WRITE_SESSION_LOG;
    const prevStateDir = process.env.XDG_STATE_HOME;
    const binDir = await mkdtemp(join(tmpdir(), 'openp-kiro-bin-'));
    await symlink(FIXTURE, join(binDir, 'kiro-cli'));
    process.env.PATH = `${binDir}:${prevPath ?? ''}`;
    process.env.OPENP_FAKE_KIRO_BEHAVIOR = behavior;
    process.env.HOME = await mkdtemp(join(tmpdir(), 'openp-kiro-home-'));
    process.env.OPENP_FAKE_KIRO_WRITE_SESSION_LOG = '1';
    process.env.XDG_STATE_HOME = await mkdtemp(join(tmpdir(), 'openp-kiro-backend-'));
    try {
      await fn();
    } finally {
      restoreEnv('PATH', prevPath);
      restoreEnv('OPENP_FAKE_KIRO_BEHAVIOR', prevBehavior);
      restoreEnv('HOME', prevHome);
      restoreEnv('OPENP_FAKE_KIRO_WRITE_SESSION_LOG', prevWriteSessionLog);
      restoreEnv('XDG_STATE_HOME', prevStateDir);
    }
  };
}

test('KiroBackend.runTurn succeeds on first turn', withFakeKiro('success', async () => {
  const backend = new KiroBackend();
  const result = await backend.runTurn({ turnId: 'turn-1', prompt: 'hello' }, BASE_OPTIONS);

  assert.equal(result.text, 'partial answer');
  assert.equal(result.reasoningContent, null);
  assert.equal(result.sessionId, FAKE_KIRO_SESSION_ID);
  assert.equal(result.diagnostics.stopReason, 'end_turn');
  assert.equal(result.diagnostics.usage.inputTokens, null);
  assert.equal(result.diagnostics.rawUsage?.contextUsagePercentage, 2.5);
}));

test('KiroBackend.runTurn resumes with canonical backend session id', withFakeKiro('success', async () => {
  const backend = new KiroBackend();
  const result = await backend.runTurn(
    { turnId: 'turn-2', prompt: 'follow up' },
    { ...BASE_OPTIONS, resume: true, backendSessionId: FAKE_KIRO_SESSION_ID },
  );

  assert.equal(result.text, 'fresh answer');
  assert.equal(result.sessionId, FAKE_KIRO_SESSION_ID);
}));

test('KiroBackend.runTurn rejects a different loaded session id on resume', withFakeKiro('load-mismatch', async () => {
  const backend = new KiroBackend();

  await assert.rejects(
    backend.runTurn(
      { turnId: 'turn-2', prompt: 'follow up' },
      { ...BASE_OPTIONS, resume: true, backendSessionId: FAKE_KIRO_SESSION_ID },
    ),
    /different session id/,
  );
}));

test('KiroBackend.runTurn streams intermediate text', withFakeKiro('success', async () => {
  const backend = new KiroBackend();
  const intermediateTexts: string[] = [];
  const result = await backend.runTurn(
    { turnId: 'turn-1', prompt: 'hello' },
    { ...BASE_OPTIONS, onIntermediateText: (text) => intermediateTexts.push(text) },
  );

  assert.deepEqual(intermediateTexts, ['partial ', 'partial answer']);
  assert.equal(result.text, 'partial answer');
}));

test('KiroBackend.runTurn rejects unsupported json schema', withFakeKiro('success', async () => {
  const backend = new KiroBackend();
  await assert.rejects(
    backend.runTurn(
      { turnId: 'turn-1', prompt: 'hello' },
      { ...BASE_OPTIONS, jsonSchema: '{"type":"object"}' },
    ),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.unsupportedOption,
  );
}));

test('KiroBackend.runTurn accepts public effort option', withFakeKiro('success', async () => {
  const backend = new KiroBackend();
  const result = await backend.runTurn(
    { turnId: 'turn-1', prompt: 'hello' },
    { ...BASE_OPTIONS, reasoningEffort: 'high' },
  );

  assert.equal(result.text, 'partial answer');
}));

test('KiroBackend.runTurn rejects invalid public effort before launch', withFakeKiro('error', async () => {
  const backend = new KiroBackend();
  await assert.rejects(
    backend.runTurn(
      { turnId: 'turn-1', prompt: 'hello' },
      { ...BASE_OPTIONS, reasoningEffort: 'bogus' },
    ),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.unsupportedOption,
  );
}));

test('KiroBackend.runTurn rejects busy sessions before launch', withFakeKiro('success', async () => {
  const lock = await new SessionLockStore(BASE_OPTIONS.cwd).acquire(BASE_OPTIONS.backendSessionId);
  try {
    const backend = new KiroBackend();
    await assert.rejects(
      backend.runTurn({ turnId: 'turn-busy', prompt: 'hello' }, BASE_OPTIONS),
      (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionBusy,
    );
  } finally {
    await lock.release();
  }
}));

test('KiroBackend.runTurn handles abort signal', withFakeKiro('slow', async () => {
  const backend = new KiroBackend();
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 300);

  await assert.rejects(
    backend.runTurn(
      { turnId: 'turn-1', prompt: 'hello' },
      { ...BASE_OPTIONS, timeoutMs: 30000, signal: ac.signal },
    ),
    isAbortError,
  );
}));

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
