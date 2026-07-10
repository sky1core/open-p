import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { access, chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { CodexWorkerBridge } from '../src/backends/codex/worker-bridge.js';
import { isAbortError } from '../src/core/abort.js';
import { EXIT_CODES, OpenPError } from '../src/core/errors.js';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'codex');
const FAKE_CODEX_SESSION_ID = '22222222-2222-4222-8222-222222222222';

function codexUserTurn(message = 'prompt'): string {
  return JSON.stringify({
    type: 'event_msg',
    payload: { type: 'user_message', message },
  });
}

function withFakeBin(name: string, fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    const prevPath = process.env.PATH;
    const prevCodexHome = process.env.CODEX_HOME;
    const binDir = await mkdtemp(join(tmpdir(), 'openp-codex-bin-'));
    const codexHome = await mkdtemp(join(tmpdir(), 'openp-codex-home-'));
    await symlink(join(FIXTURES, name), join(binDir, 'codex'));
    process.env.PATH = `${binDir}:${prevPath ?? ''}`;
    process.env.CODEX_HOME = codexHome;
    try {
      await fn();
    } finally {
      if (prevPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = prevPath;
      }
      if (prevCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = prevCodexHome;
      }
    }
  };
}

async function writeCodexPreviousTurnLog(): Promise<void> {
  const codexHome = process.env.CODEX_HOME;
  assert.ok(codexHome);
  const sessionsDir = join(codexHome, 'sessions', '2026', '05', '23');
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(codexTestLogPath(codexHome), [
    JSON.stringify({ type: 'turn_context', payload: { model: 'codex-previous-model' } }),
    codexUserTurn('previous prompt'),
    JSON.stringify({
      type: 'response_item',
      payload: { type: 'reasoning', summary: [{ text: 'previous turn reasoning' }] },
    }),
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        phase: 'commentary',
        content: [{ type: 'output_text', text: 'previous turn commentary' }],
      },
    }),
    JSON.stringify({
      type: 'turn.completed',
      session_id: FAKE_CODEX_SESSION_ID,
      result: 'previous turn final answer',
      usage: { input_tokens: 100, output_tokens: 10, cached_input_tokens: 20 },
    }),
    '',
  ].join('\n'));
}

async function writeCodexIncompleteCurrentLog(): Promise<void> {
  const codexHome = process.env.CODEX_HOME;
  assert.ok(codexHome);
  const sessionsDir = join(codexHome, 'sessions', '2026', '05', '23');
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(codexTestLogPath(codexHome), [
    JSON.stringify({ type: 'turn_context', payload: { model: 'codex-incomplete-model' } }),
    codexUserTurn(),
    JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          model_context_window: 200000,
          last_token_usage: {
            input_tokens: 1500,
            cached_input_tokens: 800,
            output_tokens: 300,
          },
        },
      },
    }),
    '',
  ].join('\n'));
}

async function writeCodexTokenLogForSession(sessionId: string): Promise<void> {
  const codexHome = process.env.CODEX_HOME;
  assert.ok(codexHome);
  const sessionsDir = join(codexHome, 'sessions', '2026', '05', '23');
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(join(sessionsDir, `rollout-${sessionId}.jsonl`), [
    JSON.stringify({ type: 'turn_context', payload: { model: 'codex-existing-model' } }),
    codexUserTurn(),
    JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          model_context_window: 200000,
          last_token_usage: {
            input_tokens: 900,
            cached_input_tokens: 100,
            output_tokens: 50,
          },
        },
      },
    }),
    '',
  ].join('\n'));
}

function codexTestLogPath(codexHome: string): string {
  return join(codexHome, 'sessions', '2026', '05', '23', `rollout-${FAKE_CODEX_SESSION_ID}.jsonl`);
}

function assistantEventText(result: Awaited<ReturnType<CodexWorkerBridge['runTurn']>>, index: number): string | undefined {
  const content = result.assistantEvents?.[index]?.message.content;
  return Array.isArray(content) ? (content[0] as { readonly text?: string } | undefined)?.text : undefined;
}

const STRUCTURED_OUTPUT_SCHEMA = '{"type":"object","properties":{"ok":{"type":"boolean"}},"required":["ok"],"additionalProperties":false}';

test('CodexWorkerBridge.runTurn rejects missing first-turn intent', async () => {
  const bridge = new CodexWorkerBridge();

  await assert.rejects(
    () => bridge.runTurn({
      sessionId: null,
      projectRoot: process.cwd(),
      message: 'hello',
    } as Parameters<CodexWorkerBridge['runTurn']>[0]),
    (error) => error instanceof OpenPError &&
      error.exitCode === EXIT_CODES.usage &&
      error.message.includes('explicit isFirstTurn'),
  );
});

test('CodexWorkerBridge.runTurn succeeds with fake codex', withFakeBin('fake-codex-success.sh', async () => {
  const bridge = new CodexWorkerBridge();
  const result = await bridge.runTurn({
    sessionId: null,
    isFirstTurn: true,
    projectRoot: process.cwd(),
    message: 'hello',
    timeoutMs: 10000,
  });

  assert.equal(result.content, 'final answer here');
  assert.equal(result.reasoningContent, 'Thinking about it...');
  assert.equal(result.sessionId, FAKE_CODEX_SESSION_ID);
  assert.equal(result.diagnostics.inputTokens, 800);
  assert.equal(result.diagnostics.outputTokens, 340);
  assert.equal(result.diagnostics.cacheReadInputTokens, 900);
  assert.equal(result.diagnostics.model, 'codex-test-model');
  assert.equal(result.diagnostics.contextWindow, 200000);
  assert.deepEqual(result.diagnostics.lastSubturnUsage, {
    inputTokens: 700,
    outputTokens: 300,
    cacheReadInputTokens: 800,
  });
  assert.equal(result.diagnostics.lastSubturnContextTokens, 1500);
  assert.equal(result.diagnostics.stopReason, null);
}));

test('CodexWorkerBridge.runTurn reports actual Codex-selected model over requested model alias', withFakeBin('fake-codex-success.sh', async () => {
  const bridge = new CodexWorkerBridge();
  const result = await bridge.runTurn({
    sessionId: null,
    isFirstTurn: true,
    projectRoot: process.cwd(),
    message: 'hello',
    model: 'gpt-5.6',
    timeoutMs: 10000,
  });

  assert.equal(result.diagnostics.model, 'codex-test-model');
}));

test('CodexWorkerBridge.runTurn passes model and reasoning effort on resume and reports actual Codex-selected model', withFakeBin('fake-codex-success.sh', async () => {
  await writeCodexPreviousTurnLog();
  const prevArgsLog = process.env.OPENP_FAKE_CODEX_ARGS_LOG;
  const argsLog = join(await mkdtemp(join(tmpdir(), 'openp-codex-worker-resume-args-')), 'args.log');
  process.env.OPENP_FAKE_CODEX_ARGS_LOG = argsLog;
  try {
    const bridge = new CodexWorkerBridge();
    const result = await bridge.runTurn({
      sessionId: FAKE_CODEX_SESSION_ID,
      isFirstTurn: false,
      projectRoot: process.cwd(),
      message: 'follow up',
      model: 'gpt-5.6',
      reasoningEffort: 'max',
      timeoutMs: 10000,
    });

    const args = await readFile(argsLog, 'utf8');
    assert.match(args, /\texec\tresume\t/);
    assert.match(args, /\t--model\tgpt-5\.6/);
    assert.match(args, /\t-c\tmodel_reasoning_effort="max"/);
    assert.equal(result.diagnostics.model, 'codex-test-model');
  } finally {
    if (prevArgsLog === undefined) {
      delete process.env.OPENP_FAKE_CODEX_ARGS_LOG;
    } else {
      process.env.OPENP_FAKE_CODEX_ARGS_LOG = prevArgsLog;
    }
  }
}));

test('CodexWorkerBridge.runTurn rejects unsafe resume session ids before launching codex', async () => {
  const binDir = await mkdtemp(join(tmpdir(), 'openp-codex-injection-bin-'));
  const markerPath = join(binDir, 'spawned');
  const fakeCodex = join(binDir, 'codex');
  await writeFile(fakeCodex, [
    '#!/usr/bin/env node',
    'const { writeFileSync } = require("node:fs");',
    `writeFileSync(${JSON.stringify(markerPath)}, "spawned");`,
    'process.exit(0);',
    '',
  ].join('\n'));
  await chmod(fakeCodex, 0o755);

  const bridge = new CodexWorkerBridge();
  await assert.rejects(
    () => bridge.runTurn({
      bin: fakeCodex,
      sessionId: '-unsafe-session',
      isFirstTurn: false,
      projectRoot: process.cwd(),
      message: 'follow up',
      timeoutMs: 10000,
    }),
    (error) => error instanceof OpenPError &&
      error.exitCode === EXIT_CODES.usage &&
      error.message.includes('unsafe Codex resume session id'),
  );
  await assert.rejects(access(markerPath), { code: 'ENOENT' });
});

test('CodexWorkerBridge.runTurn passes request env to Codex child process', async () => {
  const binDir = await mkdtemp(join(tmpdir(), 'openp-codex-env-bin-'));
  const envDumpPath = join(binDir, 'env.txt');
  const fakeCodex = join(binDir, 'codex');
  const previousDumpPath = process.env.OPENP_FAKE_CODEX_ENV_DUMP;
  const previousCodexHome = process.env.CODEX_HOME;
  await writeFile(fakeCodex, [
    '#!/usr/bin/env node',
    'const { writeFileSync } = require("node:fs");',
    'writeFileSync(process.env.OPENP_FAKE_CODEX_ENV_DUMP, process.env.OPENP_CODEX_REQUEST_ENV ?? "<missing>");',
    'process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "22222222-2222-4222-8222-222222222222" }) + "\\n");',
    'process.stdout.write(JSON.stringify({ type: "turn.completed", session_id: "22222222-2222-4222-8222-222222222222", result: "env ok", usage: { input_tokens: 1, output_tokens: 1 } }) + "\\n");',
    '',
  ].join('\n'));
  await chmod(fakeCodex, 0o755);
  process.env.OPENP_FAKE_CODEX_ENV_DUMP = envDumpPath;
  process.env.CODEX_HOME = await mkdtemp(join(tmpdir(), 'openp-codex-env-home-'));
  try {
    const bridge = new CodexWorkerBridge();
    const result = await bridge.runTurn({
      bin: fakeCodex,
      sessionId: null,
      isFirstTurn: true,
      projectRoot: process.cwd(),
      message: 'hello',
      timeoutMs: 10000,
      env: { OPENP_CODEX_REQUEST_ENV: 'request-visible' },
    });

    assert.equal(result.content, 'env ok');
    assert.equal(await readFile(envDumpPath, 'utf8'), 'request-visible');
  } finally {
    if (previousDumpPath === undefined) {
      delete process.env.OPENP_FAKE_CODEX_ENV_DUMP;
    } else {
      process.env.OPENP_FAKE_CODEX_ENV_DUMP = previousDumpPath;
    }
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
  }
});

test('CodexWorkerBridge.runTurn rejects local worker mode before launching Codex', async () => {
  const binDir = await mkdtemp(join(tmpdir(), 'openp-codex-local-bin-'));
  const markerPath = join(binDir, 'spawned');
  const fakeCodex = join(binDir, 'codex');
  const previousCodexHome = process.env.CODEX_HOME;
  await writeFile(fakeCodex, [
    '#!/usr/bin/env node',
    'const { writeFileSync } = require("node:fs");',
    `writeFileSync(${JSON.stringify(markerPath)}, "spawned");`,
    'process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "22222222-2222-4222-8222-222222222222" }) + "\\n");',
    'process.stdout.write(JSON.stringify({ type: "turn.completed", session_id: "22222222-2222-4222-8222-222222222222", result: "local ignored", usage: { input_tokens: 1, output_tokens: 1 } }) + "\\n");',
    '',
  ].join('\n'));
  await chmod(fakeCodex, 0o755);
  process.env.CODEX_HOME = await mkdtemp(join(tmpdir(), 'openp-codex-local-home-'));

  try {
    const bridge = new CodexWorkerBridge();
    await assert.rejects(
      () => bridge.runTurn({
        bin: fakeCodex,
        sessionId: null,
        isFirstTurn: true,
        projectRoot: process.cwd(),
        message: 'hello',
        timeoutMs: 10000,
        local: true,
      }),
      (error) => error instanceof OpenPError &&
        error.exitCode === EXIT_CODES.unsupportedOption &&
        error.message.includes('Codex backend does not support local worker mode'),
    );
    await assert.rejects(access(markerPath), { code: 'ENOENT' });
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
  }
});

test('CodexWorkerBridge.runTurn streams intermediate text', withFakeBin('fake-codex-success.sh', async () => {
  const bridge = new CodexWorkerBridge();
  const intermediateTexts: string[] = [];
  const reasoningTexts: string[] = [];

  const result = await bridge.runTurn({
    sessionId: null,
    isFirstTurn: true,
    projectRoot: process.cwd(),
    message: 'hello',
    timeoutMs: 10000,
    onIntermediateText: (text) => intermediateTexts.push(text),
    onIntermediateReasoning: (text) => reasoningTexts.push(text),
  });

  assert.ok(intermediateTexts.length > 0);
  assert.ok(reasoningTexts.length > 0);
  assert.equal(result.content, 'final answer here');
}));

test('CodexWorkerBridge.runTurn keeps Codex session log out of streaming and uses it for result diagnostics', withFakeBin('fake-codex-session-log-stream.mjs', async () => {
  const bridge = new CodexWorkerBridge();
  const intermediateTexts: string[] = [];
  const snapshots: string[] = [];

  const result = await bridge.runTurn({
    sessionId: null,
    isFirstTurn: true,
    projectRoot: process.cwd(),
    message: 'hello',
    timeoutMs: 10000,
    onIntermediateText: (text) => intermediateTexts.push(text),
    onIntermediateAssistantSnapshot: (snapshot) => snapshots.push((snapshot.message.content as any[])[0]?.text),
  });

  assert.deepEqual(snapshots, []);
  assert.deepEqual(intermediateTexts, []);
  assert.equal(result.content, 'session log final answer');
  assert.equal(result.diagnostics.model, 'codex-log-model');
  assert.equal(result.diagnostics.inputTokens, 378);
  assert.equal(result.diagnostics.outputTokens, 8);
  assert.equal(result.diagnostics.cacheReadInputTokens, 66);
  assert.deepEqual(result.diagnostics.lastSubturnUsage, {
    inputTokens: 289,
    outputTokens: 5,
    cacheReadInputTokens: 44,
  });
  assert.equal(result.diagnostics.contextWindow, 258400);
  assert.equal(result.diagnostics.lastSubturnContextTokens, 333);
}));

test('CodexWorkerBridge.runTurn streams stdout only when the session log mirrors stdout items', withFakeBin('fake-codex-stdout-session-log-mirror.mjs', async () => {
  const bridge = new CodexWorkerBridge();
  const intermediateTexts: string[] = [];
  const snapshotTypes: string[] = [];

  const result = await bridge.runTurn({
    sessionId: null,
    isFirstTurn: true,
    projectRoot: process.cwd(),
    message: 'hello',
    timeoutMs: 10000,
    onIntermediateText: (text) => intermediateTexts.push(text),
    onIntermediateAssistantSnapshot: (snapshot) => {
      const block = (snapshot.message.content as any[])[0];
      snapshotTypes.push(block?.type);
    },
  });

  assert.deepEqual(intermediateTexts, [
    'stdout first answer',
    'stdout first answer\n\nstdout second answer',
    'stdout first answer\n\nstdout second answer\n\nstdout final answer',
  ]);
  assert.deepEqual(snapshotTypes, ['tool_use', 'tool_result']);
  assert.equal(result.content, 'stdout final answer');
  assert.deepEqual(
    result.assistantEvents?.flatMap((event) => {
      const content = event.message.content;
      return Array.isArray(content) ? content.filter((block) => (block as any).type === 'tool_use') : [];
    }),
    [{
      type: 'tool_use',
      id: 'call_mirror_tool',
      name: 'exec_command',
      input: { cmd: 'echo tool' },
      caller: { type: 'codex', nativeType: 'function_call' },
    }],
  );
  assert.deepEqual(
    result.assistantEvents?.flatMap((event) => {
      const content = event.message.content;
      return Array.isArray(content) ? content.filter((block) => (block as any).type === 'tool_result') : [];
    }),
    [{
      type: 'tool_result',
      tool_use_id: 'call_mirror_tool',
      content: 'tool output from stdout\n',
    }],
  );
  assert.equal(result.diagnostics.model, 'codex-mirror-model');
  assert.deepEqual(result.diagnostics.lastSubturnUsage, {
    inputTokens: 389,
    outputTokens: 6,
    cacheReadInputTokens: 55,
  });
  assert.equal(result.diagnostics.contextWindow, 258400);
}));

test('CodexWorkerBridge.runTurn parses json-schema result text as structured output', withFakeBin('fake-codex-structured-output.sh', async () => {
  const bridge = new CodexWorkerBridge();
  const intermediateTexts: string[] = [];
  const result = await bridge.runTurn({
    sessionId: null,
    isFirstTurn: true,
    projectRoot: process.cwd(),
    message: 'json',
    jsonSchema: STRUCTURED_OUTPUT_SCHEMA,
    onIntermediateText: (text) => intermediateTexts.push(text),
    timeoutMs: 10000,
  });

  assert.deepEqual(intermediateTexts, []);
  assert.equal(result.content, '{"ok":true}');
  assert.deepEqual(result.structuredOutput, { ok: true });
}));

test('CodexWorkerBridge.runTurn reports a stable worker turn label for structured output errors', withFakeBin('fake-codex-invalid-structured-output.sh', async () => {
  const bridge = new CodexWorkerBridge();

  await assert.rejects(
    bridge.runTurn({
      sessionId: 'caller-session-id',
      isFirstTurn: true,
      projectRoot: process.cwd(),
      message: 'json',
      jsonSchema: STRUCTURED_OUTPUT_SCHEMA,
      timeoutMs: 10000,
    }),
    (err: Error) => err.message.includes('structured output for turn codex-worker-turn was not valid JSON') &&
      !err.message.includes('caller-session-id'),
  );
}));

test('CodexWorkerBridge.runTurn throws on non-zero exit', withFakeBin('fake-codex-error.sh', async () => {
  const bridge = new CodexWorkerBridge();

  await assert.rejects(
    bridge.runTurn({
      sessionId: null,
      isFirstTurn: true,
      projectRoot: process.cwd(),
      message: 'hello',
      timeoutMs: 10000,
    }),
    (err: Error) => err.message.includes('exited with code 1'),
  );
}));

test('CodexWorkerBridge.runTurn preserves Codex unsupported model diagnostics from stdout JSON on non-zero exit', withFakeBin('fake-codex-model-unsupported.mjs', async () => {
  const prevArgsLog = process.env.OPENP_FAKE_CODEX_ARGS_LOG;
  const argsLog = join(await mkdtemp(join(tmpdir(), 'openp-codex-worker-bad-model-args-')), 'args.log');
  process.env.OPENP_FAKE_CODEX_ARGS_LOG = argsLog;
  const bridge = new CodexWorkerBridge();
  try {
    await assert.rejects(
      bridge.runTurn({
        sessionId: null,
        isFirstTurn: true,
        projectRoot: process.cwd(),
        message: 'hello',
        model: 'definitely-not-a-real-codex-model',
        reasoningEffort: 'low',
        timeoutMs: 10000,
      }),
      (error) => error instanceof OpenPError &&
        error.exitCode === EXIT_CODES.backendExited &&
        error.message.includes('Codex CLI exited with code 1') &&
        error.message.includes("The 'definitely-not-a-real-codex-model' model is not supported when using Codex with a ChatGPT account"),
    );

    const args = await readFile(argsLog, 'utf8');
    assert.match(args, /\t--model\tdefinitely-not-a-real-codex-model/);
    assert.match(args, /\t-c\tmodel_reasoning_effort="low"/);
  } finally {
    if (prevArgsLog === undefined) {
      delete process.env.OPENP_FAKE_CODEX_ARGS_LOG;
    } else {
      process.env.OPENP_FAKE_CODEX_ARGS_LOG = prevArgsLog;
    }
  }
}));

test('CodexWorkerBridge.runTurn preserves Codex unsupported reasoning effort diagnostics from stdout JSON on non-zero exit', withFakeBin('fake-codex-effort-unsupported.mjs', async () => {
  const prevArgsLog = process.env.OPENP_FAKE_CODEX_ARGS_LOG;
  const argsLog = join(await mkdtemp(join(tmpdir(), 'openp-codex-worker-bad-effort-args-')), 'args.log');
  process.env.OPENP_FAKE_CODEX_ARGS_LOG = argsLog;
  const bridge = new CodexWorkerBridge();
  try {
    await assert.rejects(
      bridge.runTurn({
        sessionId: null,
        isFirstTurn: true,
        projectRoot: process.cwd(),
        message: 'hello',
        model: 'gpt-5.5',
        reasoningEffort: 'bogus',
        timeoutMs: 10000,
      }),
      (error) => error instanceof OpenPError &&
        error.exitCode === EXIT_CODES.backendExited &&
        error.message.includes('Codex CLI exited with code 1') &&
        error.message.includes('[ReasoningEffortParam] [reasoning.effort] [invalid_enum_value]') &&
        error.message.includes("Invalid value: 'bogus'"),
    );

    const args = await readFile(argsLog, 'utf8');
    assert.match(args, /\t--model\tgpt-5\.5/);
    assert.match(args, /\t-c\tmodel_reasoning_effort="bogus"/);
  } finally {
    if (prevArgsLog === undefined) {
      delete process.env.OPENP_FAKE_CODEX_ARGS_LOG;
    } else {
      process.env.OPENP_FAKE_CODEX_ARGS_LOG = prevArgsLog;
    }
  }
}));

test('CodexWorkerBridge.runTurn reports a completed Codex turn with no final answer', withFakeBin('fake-codex-exit-no-final-session-log.mjs', async () => {
  await writeCodexPreviousTurnLog();
  const bridge = new CodexWorkerBridge();

  await assert.rejects(
    bridge.runTurn({
      sessionId: FAKE_CODEX_SESSION_ID,
      isFirstTurn: false,
      projectRoot: process.cwd(),
      message: 'hello',
      timeoutMs: 10000,
    }),
    (error) => error instanceof OpenPError &&
      error.exitCode === EXIT_CODES.backendExited &&
      error.message.includes('Codex CLI completed without a final answer') &&
      error.message.includes('exit code 1'),
  );
}));

test('CodexWorkerBridge.runTurn diagnoses a first-turn Codex completion with no final answer', withFakeBin('fake-codex-exit-no-final-session-log.mjs', async () => {
  const bridge = new CodexWorkerBridge();

  await assert.rejects(
    bridge.runTurn({
      sessionId: null,
      isFirstTurn: true,
      projectRoot: process.cwd(),
      message: 'hello',
      timeoutMs: 10000,
    }),
    (error) => error instanceof OpenPError &&
      error.exitCode === EXIT_CODES.backendExited &&
      error.message.includes('Codex CLI completed without a final answer') &&
      error.message.includes('exit code 1'),
  );
}));

test('CodexWorkerBridge.runTurn rejects incomplete readable session log with stable reason code', withFakeBin('fake-codex-tool-stdout.mjs', async () => {
  await writeCodexIncompleteCurrentLog();
  const bridge = new CodexWorkerBridge();

  await assert.rejects(
    bridge.runTurn({
      sessionId: null,
      isFirstTurn: true,
      projectRoot: process.cwd(),
      message: 'hello',
      timeoutMs: 10000,
    }),
    (error) => error instanceof OpenPError &&
      error.exitCode === EXIT_CODES.protocolViolation &&
      error.reasonCode === 'missing_completion',
  );
}));

test('CodexWorkerBridge.runTurn throws on timeout', withFakeBin('fake-codex-slow.sh', async () => {
  const bridge = new CodexWorkerBridge();

  await assert.rejects(
    bridge.runTurn({
      sessionId: null,
      isFirstTurn: true,
      projectRoot: process.cwd(),
      message: 'hello',
      timeoutMs: 500,
    }),
    (err: Error) => err.message.includes('did not respond within')
      && err.message.includes('slow backend diagnostic'),
  );
}));

test('CodexWorkerBridge.runTurn throws on empty response', withFakeBin('fake-codex-empty.sh', async () => {
  const bridge = new CodexWorkerBridge();

  await assert.rejects(
    bridge.runTurn({
      sessionId: null,
      isFirstTurn: true,
      projectRoot: process.cwd(),
      message: 'hello',
      timeoutMs: 10000,
    }),
    (error) => error instanceof OpenPError
      && error.exitCode === EXIT_CODES.protocolViolation
      && error.reasonCode === 'unsupported_artifact_shape'
      && error.message.includes('Codex CLI returned an empty response'),
  );
}));

test('CodexWorkerBridge.runTurn throws when first turn has no session id', withFakeBin('fake-codex-no-session.sh', async () => {
  const bridge = new CodexWorkerBridge();

  await assert.rejects(
    bridge.runTurn({
      sessionId: null,
      isFirstTurn: true,
      projectRoot: process.cwd(),
      message: 'hello',
      timeoutMs: 10000,
    }),
    (err: Error) => err.message.includes('did not return a session id'),
  );
}));

test('CodexWorkerBridge.runTurn allows missing session id on resume', withFakeBin('fake-codex-no-session.sh', async () => {
  await writeCodexTokenLogForSession('existing-session-id');
  const bridge = new CodexWorkerBridge();
  const result = await bridge.runTurn({
    sessionId: 'existing-session-id',
    isFirstTurn: false,
    projectRoot: process.cwd(),
    message: 'follow up',
    timeoutMs: 10000,
  });

  assert.equal(result.content, 'answer without session');
  assert.equal(result.sessionId, 'existing-session-id');
}));

test('CodexWorkerBridge.runTurn rejects a different returned session id on resume', withFakeBin('fake-codex-mismatch-session.sh', async () => {
  await writeCodexTokenLogForSession('existing-session-id');
  const bridge = new CodexWorkerBridge();

  await assert.rejects(
    bridge.runTurn({
      sessionId: 'existing-session-id',
      isFirstTurn: false,
      projectRoot: process.cwd(),
      message: 'follow up',
      timeoutMs: 10000,
    }),
    /different session id/,
  );
}));

test('CodexWorkerBridge.runTurn handles abort signal', withFakeBin('fake-codex-slow.sh', async () => {
  const bridge = new CodexWorkerBridge();
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

test('CodexWorkerBridge.runTurn treats isFirstTurn=true even when sessionId is provided', withFakeBin('fake-codex-success.sh', async () => {
  const bridge = new CodexWorkerBridge();
  const result = await bridge.runTurn({
    sessionId: 'open-p-session-uuid',
    isFirstTurn: true,
    projectRoot: process.cwd(),
    message: 'hello',
    timeoutMs: 10000,
  });

  assert.equal(result.content, 'final answer here');
  assert.equal(result.sessionId, FAKE_CODEX_SESSION_ID);
}));

test('CodexWorkerBridge.runTurn falls back to stdout when resume session log is absent before launch', withFakeBin('fake-codex-resume-stdout-only.mjs', async () => {
  const bridge = new CodexWorkerBridge();

  const result = await bridge.runTurn({
    sessionId: FAKE_CODEX_SESSION_ID,
    isFirstTurn: false,
    projectRoot: process.cwd(),
    message: 'follow up',
    timeoutMs: 10000,
  });

  assert.equal(result.content, 'stdout-only final answer');
  assert.equal(result.sessionId, FAKE_CODEX_SESSION_ID);
  assert.equal(result.reasoningContent, 'stdout-only reasoning');
  assert.equal(result.assistantEvents?.length, 1);
  assert.equal(assistantEventText(result, 0), 'stdout-only commentary');
  assert.equal(result.diagnostics.inputTokens, 90);
  assert.equal(result.diagnostics.outputTokens, 12);
  assert.equal(result.diagnostics.cacheReadInputTokens, 30);
  assert.equal(result.diagnostics.contextWindow, null);
  assert.equal(result.diagnostics.lastSubturnUsage, null);
}));

test('CodexWorkerBridge.runTurn rejects resume when the known session log disappears before result read', withFakeBin('fake-codex-remove-session-log.mjs', async () => {
  await writeCodexPreviousTurnLog();
  const bridge = new CodexWorkerBridge();

  await assert.rejects(
    bridge.runTurn({
      sessionId: FAKE_CODEX_SESSION_ID,
      isFirstTurn: false,
      projectRoot: process.cwd(),
      message: 'follow up',
      timeoutMs: 10000,
    }),
    (error) => error instanceof OpenPError
      && error.exitCode === EXIT_CODES.protocolViolation
      && error.reasonCode === undefined
      && error.message.includes('became unavailable'),
  );
}));

test('CodexWorkerBridge.runTurn rejects resume when the known session log is replaced by another matching log', withFakeBin('fake-codex-replace-session-log.mjs', async () => {
  await writeCodexPreviousTurnLog();
  const bridge = new CodexWorkerBridge();

  await assert.rejects(
    bridge.runTurn({
      sessionId: FAKE_CODEX_SESSION_ID,
      isFirstTurn: false,
      projectRoot: process.cwd(),
      message: 'follow up',
      timeoutMs: 10000,
    }),
    (error) => error instanceof OpenPError
      && error.exitCode === EXIT_CODES.protocolViolation
      && error.reasonCode === undefined
      && error.message.includes('became unavailable'),
  );
}));

test('CodexWorkerBridge.runTurn uses a newly created resume session log when none existed before launch', withFakeBin('fake-codex-resume-session-log.mjs', async () => {
  const bridge = new CodexWorkerBridge();
  const result = await bridge.runTurn({
    sessionId: FAKE_CODEX_SESSION_ID,
    isFirstTurn: false,
    projectRoot: process.cwd(),
    message: 'follow up',
    timeoutMs: 10000,
  });

  assert.equal(result.content, 'current turn final answer');
  assert.equal(result.reasoningContent, 'current turn reasoning');
  assert.equal(result.assistantEvents?.length, 2);
  assert.equal(assistantEventText(result, 0), 'current turn commentary');
  assert.equal(assistantEventText(result, 1), 'current turn final answer');
  assert.equal(result.diagnostics.model, 'codex-current-model');
  assert.equal(result.diagnostics.contextWindow, 200000);
  assert.equal(result.diagnostics.inputTokens, 1700);
  assert.equal(result.diagnostics.outputTokens, 40);
  assert.equal(result.diagnostics.cacheReadInputTokens, 300);
  assert.deepEqual(result.diagnostics.lastSubturnUsage, {
    inputTokens: 150,
    outputTokens: 10,
    cacheReadInputTokens: 50,
  });
}));

test('CodexWorkerBridge.runTurn rejects resume when a newly created session log is unreadable', withFakeBin('fake-codex-unreadable-session-log.mjs', async () => {
  const bridge = new CodexWorkerBridge();

  await assert.rejects(
    bridge.runTurn({
      sessionId: FAKE_CODEX_SESSION_ID,
      isFirstTurn: false,
      projectRoot: process.cwd(),
      message: 'follow up',
      timeoutMs: 10000,
    }),
    (error) => error instanceof OpenPError
      && error.exitCode === EXIT_CODES.protocolViolation
      && error.reasonCode === undefined
      && error.message.includes('became unavailable'),
  );
}));

test('CodexWorkerBridge.runTurn reads resumed turn result after the previous log offset', withFakeBin('fake-codex-resume-session-log.mjs', async () => {
  await writeCodexPreviousTurnLog();

  const bridge = new CodexWorkerBridge();
  const result = await bridge.runTurn({
    sessionId: FAKE_CODEX_SESSION_ID,
    isFirstTurn: false,
    projectRoot: process.cwd(),
    message: 'follow up',
    timeoutMs: 10000,
  });

  assert.equal(result.content, 'current turn final answer');
  assert.equal(result.reasoningContent, 'current turn reasoning');
  assert.equal(result.assistantEvents?.length, 2);
  assert.equal(assistantEventText(result, 0), 'current turn commentary');
  assert.equal(assistantEventText(result, 1), 'current turn final answer');
  // Aggregate usage sums the resumed turn's last_token_usage values only;
  // session-cumulative total_token_usage (2100/320/50) must not leak in.
  assert.equal(result.diagnostics.inputTokens, 1700);
  assert.equal(result.diagnostics.outputTokens, 40);
  assert.equal(result.diagnostics.cacheReadInputTokens, 300);
  assert.deepEqual(result.diagnostics.lastSubturnUsage, {
    inputTokens: 150,
    outputTokens: 10,
    cacheReadInputTokens: 50,
  });
  assert.equal(result.diagnostics.model, 'codex-current-model');
}));

test('CodexWorkerBridge.runTurn does not mix stdout aggregate usage when session log only has token count', withFakeBin('fake-codex-session-log-token-count-only.mjs', async () => {
  const bridge = new CodexWorkerBridge();

  const result = await bridge.runTurn({
    sessionId: null,
    isFirstTurn: true,
    projectRoot: process.cwd(),
    message: 'hello',
    timeoutMs: 10000,
  });

  assert.equal(result.content, 'session log final answer');
  assert.equal(result.diagnostics.model, 'codex-log-model');
  assert.equal(result.diagnostics.inputTokens, 289);
  assert.equal(result.diagnostics.outputTokens, 5);
  assert.equal(result.diagnostics.cacheReadInputTokens, 44);
  assert.deepEqual(result.diagnostics.lastSubturnUsage, {
    inputTokens: 289,
    outputTokens: 5,
    cacheReadInputTokens: 44,
  });
  assert.equal(result.diagnostics.contextWindow, 258400);
  assert.equal(result.diagnostics.lastSubturnContextTokens, 333);
}));

test('CodexWorkerBridge.runTurn parses json-schema resume result text as structured output', withFakeBin('fake-codex-resume-structured-output.mjs', async () => {
  await writeCodexPreviousTurnLog();

  const bridge = new CodexWorkerBridge();
  const intermediateTexts: string[] = [];

  const result = await bridge.runTurn({
    sessionId: FAKE_CODEX_SESSION_ID,
    isFirstTurn: false,
    projectRoot: process.cwd(),
    message: 'follow up',
    jsonSchema: STRUCTURED_OUTPUT_SCHEMA,
    onIntermediateText: (text) => intermediateTexts.push(text),
    timeoutMs: 10000,
  });

  assert.deepEqual(intermediateTexts, []);
  assert.equal(result.content, '{"ok":true}');
  assert.deepEqual(result.structuredOutput, { ok: true });
}));

test('CodexWorkerBridge.runTurn rejects unsupported binArgs', withFakeBin('fake-codex-success.sh', async () => {
  const bridge = new CodexWorkerBridge();

  await assert.rejects(
    bridge.runTurn({
      sessionId: null,
      isFirstTurn: true,
      projectRoot: process.cwd(),
      message: 'hello',
      timeoutMs: 10000,
      binArgs: ['--tools', 'Read,Grep,Glob'],
    }),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.unsupportedOption,
  );
  await assert.rejects(
    bridge.runTurn({
      sessionId: null,
      isFirstTurn: true,
      projectRoot: process.cwd(),
      message: 'hello',
      timeoutMs: 10000,
      binArgs: ['--effort', 'high'],
    }),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.unsupportedOption,
  );
}));

test('CodexWorkerBridge.runTurn rejects public tool allowlist because Codex has no verified tool surface', withFakeBin('fake-codex-success.sh', async () => {
  const bridge = new CodexWorkerBridge();

  await assert.rejects(
    bridge.runTurn({
      sessionId: null,
      isFirstTurn: true,
      projectRoot: process.cwd(),
      message: 'hello',
      timeoutMs: 10000,
      tools: 'Read,Grep',
    }),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.unsupportedOption,
  );
}));

test('CodexWorkerBridge.isChildAliveForSession always returns false', async () => {
  const bridge = new CodexWorkerBridge();
  assert.equal(await bridge.isChildAliveForSession('any-id'), false);
});

test('CodexWorkerBridge.shutdown is a no-op', async () => {
  const bridge = new CodexWorkerBridge();
  await bridge.shutdown();
});
