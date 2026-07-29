import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runKiroAcp } from '../../src/backends/kiro/acp-runner.js';
import { isAbortError } from '../../src/core/abort.js';
import { EXIT_CODES, OpenPError } from '../../src/core/errors.js';

const FIXTURE = join(import.meta.dirname, 'fake-kiro-acp.mjs');
const FAKE_KIRO_SESSION_ID = '33333333-3333-4333-8333-333333333333';

function env(behavior = 'success'): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: mkdtempSync(join(tmpdir(), 'openp-kiro-home-')),
    OPENP_FAKE_KIRO_BEHAVIOR: behavior,
    OPENP_FAKE_KIRO_WRITE_SESSION_LOG: '1',
  };
}

async function writeExistingKiroSessionLog(testEnv: NodeJS.ProcessEnv): Promise<string> {
  const home = testEnv.HOME;
  if (!home) {
    throw new Error('test HOME is required');
  }
  const logPath = join(home, '.kiro', 'sessions', 'cli', `${FAKE_KIRO_SESSION_ID}.jsonl`);
  await mkdir(dirname(logPath), { recursive: true });
  await writeFile(logPath, [
    JSON.stringify({
      version: 'v1',
      kind: 'Prompt',
      data: {
        message_id: 'prompt-existing',
        content: [{ kind: 'text', data: 'existing turn' }],
        meta: { timestamp: 1 },
      },
    }),
    JSON.stringify({
      version: 'v1',
      kind: 'AssistantMessage',
      data: {
        message_id: 'assistant-existing',
        content: [{ kind: 'text', data: 'existing answer' }],
      },
    }),
    '',
  ].join('\n'));
  return logPath;
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

test('runKiroAcp returns slash-command chunk result when Kiro writes no session log record', async () => {
  const intermediateTexts: string[] = [];
  const result = await runKiroAcp({
    bin: FIXTURE,
    args: ['acp'],
    cwd: process.cwd(),
    prompt: '  /compact now',
    sessionId: null,
    isFirstTurn: true,
    timeoutMs: 5000,
    trustAllTools: false,
    env: env('slash-command'),
    onAssistantText: (text) => intermediateTexts.push(text),
  });

  assert.equal(result.content, 'Conversation too short to compact.');
  assert.equal(result.sessionId, FAKE_KIRO_SESSION_ID);
  assert.equal(result.stopReason, 'end_turn');
  assert.deepEqual(result.toolsUsed, []);
  assert.equal(result.durationMs, null);
  assert.equal(result.rawUsage, null);
  assert.deepEqual(result.assistantEvents, []);
  assert.deepEqual(intermediateTexts, ['Conversation too short to compact.']);
});

test('runKiroAcp returns resume slash-command chunk result when existing session log is unchanged', async () => {
  const testEnv = env('slash-resume-command');
  const logPath = await writeExistingKiroSessionLog(testEnv);
  const beforeLog = await readFile(logPath, 'utf8');

  const result = await runKiroAcp({
    bin: FIXTURE,
    args: ['acp'],
    cwd: process.cwd(),
    prompt: '/compact',
    sessionId: FAKE_KIRO_SESSION_ID,
    isFirstTurn: false,
    timeoutMs: 5000,
    trustAllTools: false,
    env: testEnv,
  });
  const afterLog = await readFile(logPath, 'utf8');

  assert.equal(result.content, 'Compacting conversation...');
  assert.equal(result.sessionId, FAKE_KIRO_SESSION_ID);
  assert.equal(afterLog, beforeLog);
});

test('runKiroAcp rejects resume slash-command chunk when no session log file exists', async () => {
  await assert.rejects(
    runKiroAcp({
      bin: FIXTURE,
      args: ['acp'],
      cwd: process.cwd(),
      prompt: '/compact',
      sessionId: FAKE_KIRO_SESSION_ID,
      isFirstTurn: false,
      timeoutMs: 5000,
      trustAllTools: false,
      env: env('slash-resume-command'),
    }),
    (error) => error instanceof OpenPError &&
      error.exitCode === EXIT_CODES.sessionLogNotFound &&
      error.reasonCode === 'no_candidate',
  );
});

test('runKiroAcp does not promote non-slash chunks when session log exists but has no scoped result', async () => {
  await assert.rejects(
    runKiroAcp({
      bin: FIXTURE,
      args: ['acp'],
      cwd: process.cwd(),
      prompt: 'compact now',
      sessionId: null,
      isFirstTurn: true,
      timeoutMs: 5000,
      trustAllTools: false,
      env: env('chunk-without-log-result'),
    }),
    (error) => error instanceof OpenPError &&
      error.exitCode === EXIT_CODES.protocolViolation &&
      error.reasonCode === 'missing_completion',
  );
});

test('runKiroAcp uses session-log result before slash-command chunk result', async () => {
  const result = await runKiroAcp({
    bin: FIXTURE,
    args: ['acp'],
    cwd: process.cwd(),
    prompt: '/compact',
    sessionId: null,
    isFirstTurn: true,
    timeoutMs: 5000,
    trustAllTools: false,
    env: env('slash-log-result'),
  });

  assert.equal(result.content, 'log sourced slash result');
});

test('runKiroAcp rejects slash-command chunk when scoped log has a record without a usable result', async () => {
  await assert.rejects(
    runKiroAcp({
      bin: FIXTURE,
      args: ['acp'],
      cwd: process.cwd(),
      prompt: '/compact',
      sessionId: null,
      isFirstTurn: true,
      timeoutMs: 5000,
      trustAllTools: false,
      env: env('slash-record-no-result'),
    }),
    (error) => error instanceof OpenPError &&
      error.exitCode === EXIT_CODES.protocolViolation &&
      error.reasonCode === 'missing_completion',
  );
});

test('runKiroAcp rejects slash-command turn when Kiro writes no log and no chunk', async () => {
  await assert.rejects(
    runKiroAcp({
      bin: FIXTURE,
      args: ['acp'],
      cwd: process.cwd(),
      prompt: '/compact',
      sessionId: null,
      isFirstTurn: true,
      timeoutMs: 5000,
      trustAllTools: false,
      env: env('slash-empty-chunk'),
    }),
    (error) => error instanceof OpenPError &&
      error.exitCode === EXIT_CODES.protocolViolation &&
      error.reasonCode === 'missing_completion',
  );
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

// Pre-fix this only failed when the flush-window deadline coincided with the timeout timer (the
// deadline can never fall after the timer), which needs slow startup relative to timeoutMs, so a
// reintroduced race is not reliably detected here; the assertion pins the required behavior:
// a completed turn must not be reported as a timeout.
// Named for what it checks: a prompt that finishes inside the caller's budget returns its scoped
// result. It does not cover the post-completion timer clear -- that only matters when the deadline
// falls inside the flush window, which is at most KIRO_SESSION_LOG_FLUSH_GRACE_MS (1s) wide and
// starts at backend boot, so no fixed budget can place the deadline inside it reliably.
test('runKiroAcp returns the scoped result for a prompt that completes inside the turn budget', async () => {
  const result = await runKiroAcp({
    bin: await writePromptCompleteBeforeTimeoutKiroBin(),
    args: ['acp'],
    cwd: process.cwd(),
    prompt: 'hello',
    sessionId: null,
    isFirstTurn: true,
    // Wide enough that backend boot on a loaded machine cannot spend the budget before the prompt
    // is even sent; the assertion is about the result, not about racing the deadline.
    timeoutMs: 30_000,
    trustAllTools: false,
    env: env(),
  });

  assert.equal(result.content, 'completed before timeout');
  assert.equal(result.sessionId, FAKE_KIRO_SESSION_ID);
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
      timeoutMs: 3000,
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
      ...env('slow'),
      OPENP_FAKE_KIRO_SIGNAL_LOG: signalLog,
      OPENP_FAKE_KIRO_RPC_LOG: rpcLog,
    },
    signal: ac.signal,
  });

  await waitForRpcMethod(rpcLog, 'session/prompt');
  ac.abort();

  await assert.rejects(running, isAbortError);
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
  // Boot margin: the abort is scheduled only after the prompt RPC is observed, so the fixture's
  // boot and handshake must fit inside the timeout or the timeout fires first and flips the
  // classification under test. The 150ms gap itself is safe: both timers live in this process and
  // fire in deadline order.
  const timeoutMs = 5000;
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
    // The fixture only dies by the final SIGKILL, and the log entries asserted below are written
    // by its SIGINT/SIGTERM handlers. Each grace is the scheduling window the loaded machine gets
    // to run those handlers before the next signal; a tight fuse SIGKILLs the fixture before it
    // ever logs.
    interruptGraceMs: 250,
    terminateGraceMs: 2000,
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
  // Both timers live in this process and fire in deadline order, so the timeout always precedes
  // the abort. The timeout itself must leave the fixture enough loaded-machine boot time to
  // install its signal handlers before the timeout's SIGINT lands.
  setTimeout(() => ac.abort(), 5150);

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
      env: { ...env('ignore-interrupt'), OPENP_FAKE_KIRO_SIGNAL_LOG: signalLog },
      signal: ac.signal,
      interruptGraceMs: 10000,
      terminateGraceMs: 2000,
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
      timeoutMs: 3000,
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
    terminateGraceMs: 2000,
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
    // The fixture answers the in-flight RPC with an error on SIGTERM but stays alive, so the run
    // always ends at this SIGKILL fuse. Wide enough that a loaded machine can run the fixture's
    // SIGTERM handler (RPC error + signal log) before the kill; the duration bound below only
    // guards against a hang.
    terminateGraceMs: 2000,
  });

  await waitForRpcMethod(rpcLog, 'session/prompt');
  const startedAt = Date.now();
  ac.abort('SIGTERM');

  await assert.rejects(running, isAbortError);
  assert.ok(Date.now() - startedAt < 15000);
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

async function writePromptCompleteBeforeTimeoutKiroBin(): Promise<string> {
  const binPath = join(await mkdtemp(join(tmpdir(), 'openp-kiro-timeout-bin-')), 'kiro.cjs');
  await writeFile(binPath, [
    '#!/usr/bin/env node',
    'const { appendFileSync, mkdirSync } = require("node:fs");',
    'const { join } = require("node:path");',
    'const { createInterface } = require("node:readline");',
    `const SESSION_ID = ${JSON.stringify(FAKE_KIRO_SESSION_ID)};`,
    'const input = createInterface({ input: process.stdin, crlfDelay: Infinity });',
    'main().catch((error) => { console.error(error); process.exit(1); });',
    'async function main() {',
    'for await (const line of input) {',
    '  if (!line.trim()) continue;',
    '  const message = JSON.parse(line);',
    '  if (message.method === "initialize") {',
    '    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true, audio: false, embeddedContext: false } }, authMethods: [], agentInfo: { name: "Fake Kiro", version: "0.0.0" } } });',
    '    continue;',
    '  }',
    '  if (message.method === "session/new") {',
    '    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: SESSION_ID } });',
    '    continue;',
    '  }',
    '  if (message.method === "session/prompt") {',
    '    appendLog(SESSION_ID, { version: "v1", kind: "Prompt", data: { message_id: "prompt-timeout-race", content: [{ kind: "text", data: message.params.prompt[0].text }], meta: { timestamp: 1 } } });',
    '    appendLog(SESSION_ID, { version: "v1", kind: "AssistantMessage", data: { message_id: "assistant-timeout-race", content: [{ kind: "text", data: "completed before timeout" }] } });',
    '    send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });',
    '  }',
    '}',
    '}',
    'function send(message) { process.stdout.write(`${JSON.stringify(message)}\\n`); }',
    'function appendLog(sessionId, event) {',
    '  const sessionDir = join(process.env.HOME, ".kiro", "sessions", "cli");',
    '  mkdirSync(sessionDir, { recursive: true });',
    '  appendFileSync(join(sessionDir, `${sessionId}.jsonl`), `${JSON.stringify(event)}\\n`);',
    '}',
    '',
  ].join('\n'));
  await chmod(binPath, 0o755);
  return binPath;
}

// The signal arrives on the child before the fake bin appends it, so every attempt has to wait,
// not just the ones where the file does not exist yet. Sleeping only on ENOENT spun this loop to
// exhaustion in microseconds once the file was created and returned a log that was merely early.
async function readSignalLog(path: string, minLines = 1): Promise<string[]> {
  let lines: string[] = [];
  for (let attempt = 0; attempt < 250; attempt += 1) {
    try {
      lines = (await readFile(path, 'utf8')).trimEnd().split('\n').filter(Boolean);
      if (lines.length >= minLines) {
        return lines;
      }
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
      lines = [];
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return lines;
}

async function waitForRpcMethod(path: string, method: string): Promise<void> {
  // Covers the fixture's full boot and ACP handshake, which a loaded machine has pushed past
  // several seconds; the poll returns on the first hit, so the happy path pays nothing.
  for (let attempt = 0; attempt < 750; attempt += 1) {
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
