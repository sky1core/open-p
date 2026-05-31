import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
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
  assert.equal(result.diagnostics.inputTokens, 200);
  assert.equal(result.diagnostics.outputTokens, 40);
  assert.equal(result.diagnostics.cacheReadInputTokens, 100);
  assert.equal(result.diagnostics.model, 'codex-test-model');
  assert.equal(result.diagnostics.contextWindow, 200000);
  assert.deepEqual(result.diagnostics.lastSubturnUsage, {
    inputTokens: 1500,
    outputTokens: 300,
    cacheReadInputTokens: 800,
  });
  assert.equal(result.diagnostics.lastSubturnContextTokens, 2300);
  assert.equal(result.diagnostics.stopReason, 'end_turn');
}));

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
  assert.equal(result.diagnostics.inputTokens, 999);
  assert.equal(result.diagnostics.outputTokens, 11);
  assert.equal(result.diagnostics.cacheReadInputTokens, 222);
  assert.deepEqual(result.diagnostics.lastSubturnUsage, {
    inputTokens: 333,
    outputTokens: 5,
    cacheReadInputTokens: 44,
  });
  assert.equal(result.diagnostics.contextWindow, 258400);
  assert.equal(result.diagnostics.lastSubturnContextTokens, 377);
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
    inputTokens: 444,
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
    (err: Error) => err.message.includes('did not respond within'),
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
    (err: Error) => err.message.includes('did not return a session id'),
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

test('CodexWorkerBridge.runTurn rejects resume when the session log offset is unavailable', withFakeBin('fake-codex-success.sh', async () => {
  const bridge = new CodexWorkerBridge();

  await assert.rejects(
    bridge.runTurn({
      sessionId: 'missing-codex-session',
      isFirstTurn: false,
      projectRoot: process.cwd(),
      message: 'follow up',
      timeoutMs: 10000,
    }),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.protocolViolation,
  );
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
  assert.equal(result.assistantEvents?.length, 1);
  assert.equal(assistantEventText(result, 0), 'current turn commentary');
  assert.equal(result.diagnostics.inputTokens, 2200);
  assert.equal(result.diagnostics.outputTokens, 45);
  assert.equal(result.diagnostics.cacheReadInputTokens, 350);
  assert.deepEqual(result.diagnostics.lastSubturnUsage, {
    inputTokens: 2000,
    outputTokens: 40,
    cacheReadInputTokens: 300,
  });
  assert.equal(result.diagnostics.model, 'codex-current-model');
}));

test('CodexWorkerBridge.runTurn falls back to stdout aggregate usage when session log only has token count', withFakeBin('fake-codex-session-log-no-usage.mjs', async () => {
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
  assert.equal(result.diagnostics.inputTokens, 999);
  assert.equal(result.diagnostics.outputTokens, 11);
  assert.equal(result.diagnostics.cacheReadInputTokens, 222);
  assert.deepEqual(result.diagnostics.lastSubturnUsage, {
    inputTokens: 333,
    outputTokens: 5,
    cacheReadInputTokens: 44,
  });
  assert.equal(result.diagnostics.contextWindow, 258400);
  assert.equal(result.diagnostics.lastSubturnContextTokens, 377);
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
