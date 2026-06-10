import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runKiroAcp } from '../src/backends/kiro/acp-runner.js';
import { isAbortError } from '../src/core/abort.js';
import { EXIT_CODES, OpenPError } from '../src/core/errors.js';

const FIXTURE = join(import.meta.dirname, 'fixtures', 'kiro', 'fake-kiro-acp.mjs');
const FAKE_KIRO_SESSION_ID = '33333333-3333-4333-8333-333333333333';

function env(behavior = 'success'): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: mkdtempSync(join(tmpdir(), 'openp-kiro-home-')),
    OPENP_FAKE_KIRO_BEHAVIOR: behavior,
    OPENP_FAKE_KIRO_WRITE_SESSION_LOG: '1',
  };
}

test('runKiroAcp completes first turn and streams cumulative assistant text', async () => {
  const intermediateTexts: string[] = [];
  const result = await runKiroAcp({
    bin: FIXTURE,
    args: ['acp'],
    cwd: process.cwd(),
    prompt: 'hello',
    sessionId: null,
    isFirstTurn: true,
    timeoutMs: 5000,
    trustAllTools: false,
    env: env(),
    onAssistantText: (text) => intermediateTexts.push(text),
  });

  assert.equal(result.content, 'partial answer');
  assert.equal(result.sessionId, FAKE_KIRO_SESSION_ID);
  assert.equal(result.stopReason, 'end_turn');
  assert.deepEqual(intermediateTexts, ['partial ', 'partial answer']);
  assert.equal(result.durationMs, 123);
  assert.equal(result.rawUsage?.contextUsagePercentage, 2.5);
  assert.ok(result.rawEventCount >= 5);
});

test('runKiroAcp resumes with session/load and ignores pre-prompt assistant notifications', async () => {
  const result = await runKiroAcp({
    bin: FIXTURE,
    args: ['acp'],
    cwd: process.cwd(),
    prompt: 'follow up',
    sessionId: FAKE_KIRO_SESSION_ID,
    isFirstTurn: false,
    timeoutMs: 5000,
    trustAllTools: false,
    env: env(),
  });

  assert.equal(result.content, 'fresh answer');
  assert.equal(result.sessionId, FAKE_KIRO_SESSION_ID);
  assert.doesNotMatch(result.content, /previous stale/);
});

test('runKiroAcp rejects a different loaded session id on resume', async () => {
  await assert.rejects(
    runKiroAcp({
      bin: FIXTURE,
      args: ['acp'],
      cwd: process.cwd(),
      prompt: 'follow up',
      sessionId: FAKE_KIRO_SESSION_ID,
      isFirstTurn: false,
      timeoutMs: 5000,
      trustAllTools: false,
      env: env('load-mismatch'),
    }),
    /different session id/,
  );
});

test('runKiroAcp ignores assistant notifications after the prompt response', async () => {
  const result = await runKiroAcp({
    bin: FIXTURE,
    args: ['acp'],
    cwd: process.cwd(),
    prompt: 'hello',
    sessionId: null,
    isFirstTurn: true,
    timeoutMs: 5000,
    trustAllTools: false,
    env: env('post-response-update'),
  });

  assert.equal(result.content, 'partial answer');
  assert.doesNotMatch(result.content, /post-response/);
});

test('runKiroAcp returns result content from Kiro session log, not live streaming chunks', async () => {
  const intermediateTexts: string[] = [];
  const result = await runKiroAcp({
    bin: FIXTURE,
    args: ['acp'],
    cwd: process.cwd(),
    prompt: 'hello',
    sessionId: null,
    isFirstTurn: true,
    timeoutMs: 5000,
    trustAllTools: false,
    env: env('log-final-diff'),
    onAssistantText: (text) => intermediateTexts.push(text),
  });

  assert.deepEqual(intermediateTexts, ['draft ']);
  assert.equal(result.content, 'authoritative final');
});

test('runKiroAcp waits for delayed Kiro session log within the turn timeout', async () => {
  const result = await runKiroAcp({
    bin: FIXTURE,
    args: ['acp'],
    cwd: process.cwd(),
    prompt: 'hello',
    sessionId: null,
    isFirstTurn: true,
    timeoutMs: 2000,
    trustAllTools: false,
    env: env('delayed-log'),
  });

  assert.equal(result.content, 'partial answer');
});

test('runKiroAcp waits for Kiro session log to settle before returning result content', async () => {
  const result = await runKiroAcp({
    bin: FIXTURE,
    args: ['acp'],
    cwd: process.cwd(),
    prompt: 'hello',
    sessionId: null,
    isFirstTurn: true,
    timeoutMs: 2000,
    trustAllTools: false,
    env: env('multi-log-delayed'),
  });

  assert.equal(result.content, 'A\n\nB');
});

test('runKiroAcp honors abort while waiting for delayed Kiro session log', async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 50);

  await assert.rejects(
    runKiroAcp({
      bin: FIXTURE,
      args: ['acp'],
      cwd: process.cwd(),
      prompt: 'hello',
      sessionId: null,
      isFirstTurn: true,
      timeoutMs: 5000,
      trustAllTools: false,
      env: env('delayed-log'),
      signal: ac.signal,
    }),
    isAbortError,
  );
});

test('runKiroAcp rejects missing first-turn session id', async () => {
  await assert.rejects(
    runKiroAcp({
      bin: FIXTURE,
      args: ['acp'],
      cwd: process.cwd(),
      prompt: 'hello',
      sessionId: null,
      isFirstTurn: true,
      timeoutMs: 5000,
      trustAllTools: false,
      env: env('no-session'),
    }),
    /session\/new did not return a session id/,
  );
});

test('runKiroAcp rejects empty response', async () => {
  await assert.rejects(
    runKiroAcp({
      bin: FIXTURE,
      args: ['acp'],
      cwd: process.cwd(),
      prompt: 'hello',
      sessionId: null,
      isFirstTurn: true,
      timeoutMs: 5000,
      trustAllTools: false,
      env: env('empty'),
    }),
    (error) => error instanceof OpenPError &&
      error.exitCode === EXIT_CODES.protocolViolation &&
      error.reasonCode === 'missing_completion' &&
      error.message.includes('session log did not contain a scoped turn result'),
  );
});

test('runKiroAcp succeeds when scoped result has tool artifacts but no answer text', async () => {
  const result = await runKiroAcp({
    bin: FIXTURE,
    args: ['acp'],
    cwd: process.cwd(),
    prompt: 'use a tool without prose',
    sessionId: null,
    isFirstTurn: true,
    timeoutMs: 5000,
    trustAllTools: false,
    env: env('tool-only'),
  });

  assert.equal(result.content, '');
  assert.equal(result.assistantEvents.length, 2);
  const toolUse = (result.assistantEvents[0]?.message.content as any[])[0];
  const toolResult = (result.assistantEvents[1]?.message.content as any[])[0];
  assert.equal(toolUse.type, 'tool_use');
  assert.equal(toolUse.id, 'tooluse_only');
  assert.equal(toolUse.name, 'readFile');
  assert.deepEqual(toolUse.input, { path: 'README.md' });
  assert.equal(toolResult.type, 'tool_result');
  assert.equal(toolResult.tool_use_id, 'tooluse_only');
  assert.equal(toolResult.content, 'file text');
});

test('runKiroAcp reports toolsUsed from session-log toolUse names, not live update labels', async () => {
  const result = await runKiroAcp({
    bin: FIXTURE,
    args: ['acp'],
    cwd: process.cwd(),
    prompt: 'use tools',
    sessionId: null,
    isFirstTurn: true,
    timeoutMs: 5000,
    trustAllTools: false,
    env: env('tool-live-labels'),
  });

  assert.deepEqual(result.toolsUsed, ['read', 'write']);
});

test('runKiroAcp reports missing Kiro session log with the session-log exit code', async () => {
  await assert.rejects(
    runKiroAcp({
      bin: FIXTURE,
      args: ['acp'],
      cwd: process.cwd(),
      prompt: 'hello',
      sessionId: null,
      isFirstTurn: true,
      timeoutMs: 5000,
      trustAllTools: false,
      env: { ...env('success'), OPENP_FAKE_KIRO_WRITE_SESSION_LOG: '0' },
    }),
    (error) => error instanceof OpenPError &&
      error.exitCode === EXIT_CODES.sessionLogNotFound &&
      error.reasonCode === 'no_candidate',
  );
});

test('runKiroAcp fails closed on ACP permission requests', async () => {
  await assert.rejects(
    runKiroAcp({
      bin: FIXTURE,
      args: ['acp'],
      cwd: process.cwd(),
      prompt: 'write a file',
      sessionId: null,
      isFirstTurn: true,
      timeoutMs: 5000,
      trustAllTools: false,
      env: env('permission'),
    }),
    /requested tool permission/,
  );
});

test('runKiroAcp throws on non-zero exit', async () => {
  await assert.rejects(
    runKiroAcp({
      bin: FIXTURE,
      args: ['acp'],
      cwd: process.cwd(),
      prompt: 'hello',
      sessionId: null,
      isFirstTurn: true,
      timeoutMs: 5000,
      trustAllTools: false,
      env: env('error'),
    }),
    /exited with code 1: fake kiro failed/,
  );
});

test('runKiroAcp maps missing backend executable to backendNotFound', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openp-kiro-missing-bin-'));
  const missingBin = join(dir, 'missing-kiro-cli');

  await assert.rejects(
    runKiroAcp({
      bin: missingBin,
      args: ['acp'],
      cwd: process.cwd(),
      prompt: 'hello',
      sessionId: null,
      isFirstTurn: true,
      timeoutMs: 5000,
      trustAllTools: false,
      env: env(),
    }),
    (error) => (
      error instanceof OpenPError &&
      error.exitCode === EXIT_CODES.backendNotFound &&
      error.message === `backend executable not found: ${missingBin}`
    ),
  );
});

test('runKiroAcp throws on timeout', async () => {
  const signalLog = await tempSignalLog();
  await assert.rejects(
    runKiroAcp({
      bin: FIXTURE,
      args: ['acp'],
      cwd: process.cwd(),
      prompt: 'hello',
      sessionId: null,
      isFirstTurn: true,
      timeoutMs: 300,
      trustAllTools: false,
      env: { ...env('slow'), OPENP_FAKE_KIRO_SIGNAL_LOG: signalLog },
    }),
    /did not respond within/,
  );
  assert.deepEqual(await readSignalLog(signalLog), ['SIGINT']);
});

test('runKiroAcp handles abort signal', async () => {
  const ac = new AbortController();
  const signalLog = await tempSignalLog();
  setTimeout(() => ac.abort(), 300);

  await assert.rejects(
    runKiroAcp({
      bin: FIXTURE,
      args: ['acp'],
      cwd: process.cwd(),
      prompt: 'hello',
      sessionId: null,
      isFirstTurn: true,
      timeoutMs: 30000,
      trustAllTools: false,
      env: { ...env('slow'), OPENP_FAKE_KIRO_SIGNAL_LOG: signalLog },
      signal: ac.signal,
    }),
    isAbortError,
  );
  assert.deepEqual(await readSignalLog(signalLog), ['SIGINT']);
});

test('runKiroAcp keeps abort classified when backend returns an error after interrupt', async () => {
  const ac = new AbortController();
  const signalLog = await tempSignalLog();
  const rpcLog = await tempSignalLog();

  const running = runKiroAcp({
    bin: FIXTURE,
    args: ['acp'],
    cwd: process.cwd(),
    prompt: 'hello',
    sessionId: null,
    isFirstTurn: true,
    timeoutMs: 30000,
    trustAllTools: false,
    env: {
      ...env('error-after-interrupt'),
      OPENP_FAKE_KIRO_SIGNAL_LOG: signalLog,
      OPENP_FAKE_KIRO_RPC_LOG: rpcLog,
    },
    signal: ac.signal,
  });

  await waitForRpcMethod(rpcLog, 'session/prompt');
  ac.abort();

  await assert.rejects(running, isAbortError);
  assert.deepEqual(await readSignalLog(signalLog, 2), ['SIGINT', 'SIGTERM']);
});

test('runKiroAcp keeps user abort classified as abort even when timeout is near', async () => {
  const ac = new AbortController();
  const signalLog = await tempSignalLog();
  const rpcLog = await tempSignalLog();
  const timeoutMs = 2000;
  const abortBeforeTimeoutMs = 150;
  const startedAt = Date.now();

  const running = runKiroAcp({
    bin: FIXTURE,
    args: ['acp'],
    cwd: process.cwd(),
    prompt: 'hello',
    sessionId: null,
    isFirstTurn: true,
    timeoutMs,
    trustAllTools: false,
    env: {
      ...env('ignore-interrupt'),
      OPENP_FAKE_KIRO_SIGNAL_LOG: signalLog,
      OPENP_FAKE_KIRO_RPC_LOG: rpcLog,
    },
    signal: ac.signal,
    interruptGraceMs: 100,
    terminateGraceMs: 50,
  });

  await waitForRpcMethod(rpcLog, 'session/prompt');
  const elapsedMs = Date.now() - startedAt;
  setTimeout(() => ac.abort(), Math.max(0, timeoutMs - elapsedMs - abortBeforeTimeoutMs));

  await assert.rejects(
    running,
    isAbortError,
  );
  assert.deepEqual(await readSignalLog(signalLog, 2), ['SIGINT', 'SIGTERM']);
});

test('runKiroAcp keeps timeout classified as timeout when abort arrives after timeout', async () => {
  const ac = new AbortController();
  const signalLog = await tempSignalLog();
  setTimeout(() => ac.abort(), 450);

  await assert.rejects(
    runKiroAcp({
      bin: FIXTURE,
      args: ['acp'],
      cwd: process.cwd(),
      prompt: 'hello',
      sessionId: null,
      isFirstTurn: true,
      timeoutMs: 300,
      trustAllTools: false,
      env: { ...env('ignore-interrupt'), OPENP_FAKE_KIRO_SIGNAL_LOG: signalLog },
      signal: ac.signal,
      interruptGraceMs: 10000,
      terminateGraceMs: 50,
    }),
    /did not respond within/,
  );
  assert.equal((await readSignalLog(signalLog))[0], 'SIGINT');
});

test('runKiroAcp keeps timeout classified when backend returns an error after timeout interrupt', async () => {
  const signalLog = await tempSignalLog();

  await assert.rejects(
    runKiroAcp({
      bin: FIXTURE,
      args: ['acp'],
      cwd: process.cwd(),
      prompt: 'hello',
      sessionId: null,
      isFirstTurn: true,
      timeoutMs: 300,
      trustAllTools: false,
      env: { ...env('error-after-interrupt'), OPENP_FAKE_KIRO_SIGNAL_LOG: signalLog },
    }),
    /did not respond within/,
  );
  assert.deepEqual(await readSignalLog(signalLog, 2), ['SIGINT', 'SIGTERM']);
});

test('runKiroAcp treats SIGTERM abort reason as terminate phase, not graceful SIGINT', async () => {
  const ac = new AbortController();
  const signalLog = await tempSignalLog();
  const rpcLog = await tempSignalLog();

  const running = runKiroAcp({
    bin: FIXTURE,
    args: ['acp'],
    cwd: process.cwd(),
    prompt: 'hello',
    sessionId: null,
    isFirstTurn: true,
    timeoutMs: 30000,
    trustAllTools: false,
    env: {
      ...env('ignore-interrupt'),
      OPENP_FAKE_KIRO_SIGNAL_LOG: signalLog,
      OPENP_FAKE_KIRO_RPC_LOG: rpcLog,
    },
    signal: ac.signal,
    interruptGraceMs: 10000,
    terminateGraceMs: 50,
  });

  await waitForRpcMethod(rpcLog, 'session/prompt');
  ac.abort('SIGTERM');

  await assert.rejects(running, isAbortError);
  assert.deepEqual(await readSignalLog(signalLog), ['SIGTERM']);
});

test('runKiroAcp does not send duplicate SIGTERM when terminate abort rejects before child closes', async () => {
  const ac = new AbortController();
  const signalLog = await tempSignalLog();
  const rpcLog = await tempSignalLog();

  const running = runKiroAcp({
    bin: FIXTURE,
    args: ['acp'],
    cwd: process.cwd(),
    prompt: 'hello',
    sessionId: null,
    isFirstTurn: true,
    timeoutMs: 30000,
    trustAllTools: false,
    env: {
      ...env('error-after-terminate'),
      OPENP_FAKE_KIRO_SIGNAL_LOG: signalLog,
      OPENP_FAKE_KIRO_RPC_LOG: rpcLog,
    },
    signal: ac.signal,
    terminateGraceMs: 50,
  });

  await waitForRpcMethod(rpcLog, 'session/prompt');
  const startedAt = Date.now();
  ac.abort('SIGTERM');

  await assert.rejects(running, isAbortError);
  assert.ok(Date.now() - startedAt < 500);
  assert.deepEqual(await readSignalLog(signalLog), ['SIGTERM']);
});

test('runKiroAcp repeated abort signal escalates before interrupt grace expires', async () => {
  const ac = new AbortController();
  const force = new AbortController();
  const kill = new AbortController();
  const signalLog = await tempSignalLog();
  const rpcLog = await tempSignalLog();

  const running = runKiroAcp({
    bin: FIXTURE,
    args: ['acp'],
    cwd: process.cwd(),
    prompt: 'hello',
    sessionId: null,
    isFirstTurn: true,
    timeoutMs: 30000,
    trustAllTools: false,
    env: {
      ...env('ignore-interrupt'),
      OPENP_FAKE_KIRO_SIGNAL_LOG: signalLog,
      OPENP_FAKE_KIRO_RPC_LOG: rpcLog,
    },
    signal: ac.signal,
    forceSignal: force.signal,
    killSignal: kill.signal,
    interruptGraceMs: 10000,
    terminateGraceMs: 10000,
  });

  await waitForRpcMethod(rpcLog, 'session/prompt');
  ac.abort();
  assert.deepEqual(await readSignalLog(signalLog), ['SIGINT']);
  force.abort();
  assert.deepEqual(await readSignalLog(signalLog, 2), ['SIGINT', 'SIGTERM']);
  kill.abort();

  await assert.rejects(
    running,
    isAbortError,
  );
  assert.deepEqual(await readSignalLog(signalLog, 2), ['SIGINT', 'SIGTERM']);
});

async function tempSignalLog(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'openp-kiro-signal-')), 'signals.log');
}

async function readSignalLog(path: string, minLines = 1): Promise<string[]> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const lines = (await readFile(path, 'utf8')).trimEnd().split('\n').filter(Boolean);
      if (lines.length >= minLines || attempt === 49) {
        return lines;
      }
    } catch (error) {
      if (!isNotFoundError(error) || attempt === 49) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  return [];
}

async function waitForRpcMethod(path: string, method: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const text = await readFile(path, 'utf8');
      if (text.split('\n').some((line) => line.startsWith(`${method}\t`))) {
        return;
      }
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for fake Kiro RPC method: ${method}`);
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
