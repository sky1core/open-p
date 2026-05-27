import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KiroWorkerBridge } from '../src/backends/kiro/worker-bridge.js';
import { isAbortError } from '../src/core/abort.js';
import { EXIT_CODES, OpenPError } from '../src/core/errors.js';

const FIXTURE = join(import.meta.dirname, 'fixtures', 'kiro', 'fake-kiro-acp.mjs');
const FAKE_KIRO_SESSION_ID = '33333333-3333-4333-8333-333333333333';

function withFakeKiro(behavior: string, fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    const prevPath = process.env.PATH;
    const prevBehavior = process.env.OPENP_FAKE_KIRO_BEHAVIOR;
    const prevHome = process.env.HOME;
    const prevWriteSessionLog = process.env.OPENP_FAKE_KIRO_WRITE_SESSION_LOG;
    const binDir = await mkdtemp(join(tmpdir(), 'openp-kiro-bin-'));
    await symlink(FIXTURE, join(binDir, 'kiro-cli'));
    process.env.PATH = `${binDir}:${prevPath ?? ''}`;
    process.env.OPENP_FAKE_KIRO_BEHAVIOR = behavior;
    process.env.HOME = await mkdtemp(join(tmpdir(), 'openp-kiro-home-'));
    process.env.OPENP_FAKE_KIRO_WRITE_SESSION_LOG = '1';
    try {
      await fn();
    } finally {
      restoreEnv('PATH', prevPath);
      restoreEnv('OPENP_FAKE_KIRO_BEHAVIOR', prevBehavior);
      restoreEnv('HOME', prevHome);
      restoreEnv('OPENP_FAKE_KIRO_WRITE_SESSION_LOG', prevWriteSessionLog);
    }
  };
}

test('KiroWorkerBridge.runTurn succeeds on first turn', withFakeKiro('success', async () => {
  const bridge = new KiroWorkerBridge();
  const result = await bridge.runTurn({
    sessionId: null,
    isFirstTurn: true,
    projectRoot: process.cwd(),
    message: 'hello',
    timeoutMs: 5000,
  });

  assert.equal(result.content, 'partial answer');
  assert.equal(result.reasoningContent, null);
  assert.equal(result.sessionId, FAKE_KIRO_SESSION_ID);
  assert.equal(result.diagnostics.inputTokens, null);
  assert.equal(result.diagnostics.stopReason, 'end_turn');
  assert.equal(result.diagnostics.intermediateTextCount, 2);
}));

test('KiroWorkerBridge.runTurn treats isFirstTurn=true as new session even when sessionId is provided', withFakeKiro('success', async () => {
  const bridge = new KiroWorkerBridge();
  const result = await bridge.runTurn({
    sessionId: 'caller-selected-id',
    isFirstTurn: true,
    projectRoot: process.cwd(),
    message: 'hello',
    timeoutMs: 5000,
  });

  assert.equal(result.sessionId, FAKE_KIRO_SESSION_ID);
}));

test('KiroWorkerBridge.runTurn resumes with provided session id', withFakeKiro('success', async () => {
  const bridge = new KiroWorkerBridge();
  const result = await bridge.runTurn({
    sessionId: FAKE_KIRO_SESSION_ID,
    isFirstTurn: false,
    projectRoot: process.cwd(),
    message: 'follow up',
    timeoutMs: 5000,
  });

  assert.equal(result.content, 'fresh answer');
  assert.equal(result.sessionId, FAKE_KIRO_SESSION_ID);
}));

test('KiroWorkerBridge.runTurn rejects a different loaded session id on resume', withFakeKiro('load-mismatch', async () => {
  const bridge = new KiroWorkerBridge();

  await assert.rejects(
    bridge.runTurn({
      sessionId: FAKE_KIRO_SESSION_ID,
      isFirstTurn: false,
      projectRoot: process.cwd(),
      message: 'follow up',
      timeoutMs: 5000,
    }),
    /different session id/,
  );
}));

test('KiroWorkerBridge.runTurn streams intermediate text', withFakeKiro('success', async () => {
  const bridge = new KiroWorkerBridge();
  const intermediateTexts: string[] = [];
  const result = await bridge.runTurn({
    sessionId: null,
    isFirstTurn: true,
    projectRoot: process.cwd(),
    message: 'hello',
    timeoutMs: 5000,
    onIntermediateText: (text) => intermediateTexts.push(text),
  });

  assert.deepEqual(intermediateTexts, ['partial ', 'partial answer']);
  assert.equal(result.content, 'partial answer');
}));

test('KiroWorkerBridge.runTurn accepts public effort option', withFakeKiro('success', async () => {
  const bridge = new KiroWorkerBridge();
  const result = await bridge.runTurn({
    sessionId: null,
    isFirstTurn: true,
    projectRoot: process.cwd(),
    message: 'hello',
    timeoutMs: 5000,
    reasoningEffort: 'high',
  });

  assert.equal(result.content, 'partial answer');
}));

test('KiroWorkerBridge.runTurn rejects invalid public effort before launch', withFakeKiro('error', async () => {
  const bridge = new KiroWorkerBridge();
  await assert.rejects(
    bridge.runTurn({
      sessionId: null,
      isFirstTurn: true,
      projectRoot: process.cwd(),
      message: 'hello',
      timeoutMs: 5000,
      reasoningEffort: 'bogus',
    }),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.unsupportedOption,
  );
}));

test('KiroWorkerBridge.runTurn handles abort signal', withFakeKiro('slow', async () => {
  const bridge = new KiroWorkerBridge();
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 300);

  await assert.rejects(
    bridge.runTurn({
      sessionId: null,
      isFirstTurn: true,
      projectRoot: process.cwd(),
      message: 'hello',
      timeoutMs: 30000,
      signal: ac.signal,
    }),
    isAbortError,
  );
}));

test('KiroWorkerBridge.isChildAliveForSession always returns false', async () => {
  const bridge = new KiroWorkerBridge();
  assert.equal(await bridge.isChildAliveForSession('any-id'), false);
});

test('KiroWorkerBridge.shutdown is a no-op', async () => {
  const bridge = new KiroWorkerBridge();
  await bridge.shutdown();
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
