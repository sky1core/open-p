import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { CodexBackend } from '../src/backends/codex/backend.js';
import { isAbortError } from '../src/core/abort.js';
import { SessionLockStore } from '../src/core/session-lock.js';
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
    const prevStateHome = process.env.XDG_STATE_HOME;
    const prevCodexHome = process.env.CODEX_HOME;
    const binDir = await mkdtemp(join(tmpdir(), 'openp-codex-bin-'));
    const stateRoot = await mkdtemp(join(tmpdir(), 'openp-codex-backend-'));
    const codexHome = await mkdtemp(join(tmpdir(), 'openp-codex-home-'));
    await symlink(join(FIXTURES, name), join(binDir, 'codex'));
    process.env.PATH = `${binDir}:${prevPath ?? ''}`;
    process.env.XDG_STATE_HOME = stateRoot;
    process.env.CODEX_HOME = codexHome;
    try {
      await fn();
    } finally {
      if (prevPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = prevPath;
      }
      if (prevStateHome === undefined) {
        delete process.env.XDG_STATE_HOME;
      } else {
        process.env.XDG_STATE_HOME = prevStateHome;
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

async function writeCodexMalformedCurrentLog(): Promise<void> {
  const codexHome = process.env.CODEX_HOME;
  assert.ok(codexHome);
  const sessionsDir = join(codexHome, 'sessions', '2026', '05', '23');
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(codexTestLogPath(codexHome), [
    JSON.stringify({ type: 'thread.started', thread_id: FAKE_CODEX_SESSION_ID }),
    codexUserTurn(),
    '{not json',
    JSON.stringify({
      type: 'turn.completed',
      session_id: FAKE_CODEX_SESSION_ID,
      result: 'session log answer',
    }),
    '',
  ].join('\n'));
}

function codexTestLogPath(codexHome: string): string {
  return join(codexHome, 'sessions', '2026', '05', '23', `rollout-${FAKE_CODEX_SESSION_ID}.jsonl`);
}

function assistantEventText(result: Awaited<ReturnType<CodexBackend['runTurn']>>, index: number): string | undefined {
  const content = result.assistantEvents?.[index]?.message.content;
  return Array.isArray(content) ? (content[0] as { readonly text?: string } | undefined)?.text : undefined;
}

const BASE_OPTIONS = {
  cwd: process.cwd(),
  backendSessionId: 'test-session-001',
  resume: false,
  timeoutMs: 10000,
  model: null,
  reasoningEffort: null,
  permissionMode: null,
  tools: null,
  jsonSchema: null,
  backendArgs: [] as string[],
  debugLog: null,
};
const STRUCTURED_OUTPUT_SCHEMA = '{"type":"object","properties":{"ok":{"type":"boolean"}},"required":["ok"],"additionalProperties":false}';

test('CodexBackend.runTurn succeeds on first turn', withFakeBin('fake-codex-success.sh', async () => {
  const backend = new CodexBackend();
  const result = await backend.runTurn(
    { turnId: 'turn-1', prompt: 'hello' },
    BASE_OPTIONS,
  );

  assert.equal(result.text, 'final answer here');
  assert.equal(result.reasoningContent, 'Thinking about it...');
  assert.equal(result.diagnostics.usage.inputTokens, 1700);
  assert.equal(result.diagnostics.usage.outputTokens, 340);
  assert.equal(result.diagnostics.usage.cacheReadInputTokens, 900);
  assert.equal(result.diagnostics.model, 'codex-test-model');
  assert.equal(result.diagnostics.contextWindow, 200000);
  assert.deepEqual(result.diagnostics.lastSubturnUsage, {
    inputTokens: 1500,
    outputTokens: 300,
    cacheReadInputTokens: 800,
  });
  assert.equal(result.diagnostics.lastSubturnContextTokens, 2300);
  assert.equal(result.diagnostics.stopReason, null);
  assert.equal(result.sessionId, FAKE_CODEX_SESSION_ID);
  assert.ok(result.diagnostics.durationMs! >= 0);
}));

test('CodexBackend.runTurn throws on non-zero exit', withFakeBin('fake-codex-error.sh', async () => {
  const backend = new CodexBackend();

  await assert.rejects(
    backend.runTurn(
      { turnId: 'turn-1', prompt: 'hello' },
      BASE_OPTIONS,
    ),
    (err: Error) => err.message.includes('exited with code 1'),
  );
}));

test('CodexBackend.runTurn reports a completed Codex turn with no final answer', withFakeBin('fake-codex-exit-no-final-session-log.mjs', async () => {
  await writeCodexPreviousTurnLog();
  const backend = new CodexBackend();

  await assert.rejects(
    backend.runTurn(
      { turnId: 'turn-no-final', prompt: 'hello' },
      { ...BASE_OPTIONS, resume: true, backendSessionId: FAKE_CODEX_SESSION_ID },
    ),
    (error) => error instanceof OpenPError &&
      error.exitCode === EXIT_CODES.backendExited &&
      error.message.includes('Codex CLI completed without a final answer') &&
      error.message.includes('exit code 1'),
  );
}));

test('CodexBackend.runTurn diagnoses a first-turn Codex completion with no final answer', withFakeBin('fake-codex-exit-no-final-session-log.mjs', async () => {
  const backend = new CodexBackend();

  await assert.rejects(
    backend.runTurn(
      { turnId: 'turn-first-no-final', prompt: 'hello' },
      BASE_OPTIONS,
    ),
    (error) => error instanceof OpenPError &&
      error.exitCode === EXIT_CODES.backendExited &&
      error.message.includes('Codex CLI completed without a final answer') &&
      error.message.includes('exit code 1'),
  );
}));

test('CodexBackend.runTurn throws on empty response', withFakeBin('fake-codex-empty.sh', async () => {
  const backend = new CodexBackend();

  await assert.rejects(
    backend.runTurn(
      { turnId: 'turn-1', prompt: 'hello' },
      BASE_OPTIONS,
    ),
    (err: Error) => err.message.includes('did not return a session id'),
  );
}));

test('CodexBackend.runTurn throws when first turn has no session id', withFakeBin('fake-codex-no-session.sh', async () => {
  const backend = new CodexBackend();

  await assert.rejects(
    backend.runTurn(
      { turnId: 'turn-1', prompt: 'hello' },
      BASE_OPTIONS,
    ),
    (err: Error) => err.message.includes('did not return a session id'),
  );
}));

test('CodexBackend.runTurn throws on timeout', withFakeBin('fake-codex-slow.sh', async () => {
  const backend = new CodexBackend();

  await assert.rejects(
    backend.runTurn(
      { turnId: 'turn-1', prompt: 'hello' },
      { ...BASE_OPTIONS, timeoutMs: 500 },
    ),
    (err: Error) => err.message.includes('did not respond within'),
  );
}));

test('CodexBackend.runTurn rejects unsupported backend args', withFakeBin('fake-codex-success.sh', async () => {
  const backend = new CodexBackend();

  await assert.rejects(
    backend.runTurn(
      { turnId: 'turn-1', prompt: 'hello' },
      { ...BASE_OPTIONS, backendArgs: ['--tools', 'Read,Grep,Glob'] },
    ),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.unsupportedOption,
  );
  await assert.rejects(
    backend.runTurn(
      { turnId: 'turn-1', prompt: 'hello' },
      { ...BASE_OPTIONS, backendArgs: ['--effort', 'high'] },
    ),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.unsupportedOption,
  );
}));

test('CodexBackend.runTurn rejects public tool allowlist because Codex has no verified tool surface', withFakeBin('fake-codex-success.sh', async () => {
  const backend = new CodexBackend();

  await assert.rejects(
    backend.runTurn(
      { turnId: 'turn-1', prompt: 'hello' },
      { ...BASE_OPTIONS, tools: 'Read,Grep' },
    ),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.unsupportedOption,
  );
}));

test('CodexBackend.runTurn accepts public reasoning effort option', withFakeBin('fake-codex-success.sh', async () => {
  const prevArgsLog = process.env.OPENP_FAKE_CODEX_ARGS_LOG;
  const argsLog = join(await mkdtemp(join(tmpdir(), 'openp-codex-args-')), 'args.log');
  process.env.OPENP_FAKE_CODEX_ARGS_LOG = argsLog;
  const backend = new CodexBackend();
  try {
    const result = await backend.runTurn(
      { turnId: 'turn-1', prompt: 'hello' },
      { ...BASE_OPTIONS, reasoningEffort: 'high' },
    );

    const args = await readFile(argsLog, 'utf8');
    assert.match(args, /\t-c\tmodel_reasoning_effort="high"/);
    assert.equal(result.text, 'final answer here');
  } finally {
    if (prevArgsLog === undefined) {
      delete process.env.OPENP_FAKE_CODEX_ARGS_LOG;
    } else {
      process.env.OPENP_FAKE_CODEX_ARGS_LOG = prevArgsLog;
    }
  }
}));

test('CodexBackend.runTurn streams intermediate text and reasoning', withFakeBin('fake-codex-success.sh', async () => {
  const backend = new CodexBackend();
  const intermediateTexts: string[] = [];
  const reasoningTexts: string[] = [];

  const result = await backend.runTurn(
    { turnId: 'turn-1', prompt: 'hello' },
    {
      ...BASE_OPTIONS,
      onIntermediateText: (text) => intermediateTexts.push(text),
      onIntermediateReasoning: (text) => reasoningTexts.push(text),
    },
  );

  assert.ok(intermediateTexts.length > 0);
  assert.ok(reasoningTexts.length > 0);
  assert.equal(result.text, 'final answer here');
}));

test('CodexBackend.runTurn keeps Codex session log out of streaming and uses it for result diagnostics', withFakeBin('fake-codex-session-log-stream.mjs', async () => {
  const backend = new CodexBackend();
  const intermediateTexts: string[] = [];
  const snapshots: string[] = [];

  const result = await backend.runTurn(
    { turnId: 'turn-1', prompt: 'hello' },
    {
      ...BASE_OPTIONS,
      onIntermediateText: (text) => intermediateTexts.push(text),
      onIntermediateAssistantSnapshot: (snapshot) => snapshots.push((snapshot.message.content as any[])[0]?.text),
    },
  );

  assert.deepEqual(snapshots, []);
  assert.deepEqual(intermediateTexts, []);
  assert.equal(result.text, 'session log final answer');
  assert.equal(result.diagnostics.model, 'codex-log-model');
  assert.deepEqual(result.diagnostics.usage, {
    inputTokens: 444,
    outputTokens: 8,
    cacheReadInputTokens: 66,
  });
  assert.deepEqual(result.diagnostics.lastSubturnUsage, {
    inputTokens: 333,
    outputTokens: 5,
    cacheReadInputTokens: 44,
  });
  assert.equal(result.diagnostics.contextWindow, 258400);
  assert.equal(result.diagnostics.lastSubturnContextTokens, 377);
}));

test('CodexBackend.runTurn does not mix stdout aggregate usage when session log only has token count', withFakeBin('fake-codex-session-log-token-count-only.mjs', async () => {
  const backend = new CodexBackend();

  const result = await backend.runTurn(
    { turnId: 'turn-1', prompt: 'hello' },
    BASE_OPTIONS,
  );

  assert.equal(result.text, 'session log final answer');
  assert.equal(result.diagnostics.model, 'codex-log-model');
  assert.deepEqual(result.diagnostics.usage, {
    inputTokens: 333,
    outputTokens: 5,
    cacheReadInputTokens: 44,
  });
  assert.deepEqual(result.diagnostics.lastSubturnUsage, {
    inputTokens: 333,
    outputTokens: 5,
    cacheReadInputTokens: 44,
  });
  assert.equal(result.diagnostics.contextWindow, 258400);
  assert.equal(result.diagnostics.lastSubturnContextTokens, 377);
}));

test('CodexBackend.runTurn streams stdout only when the session log mirrors stdout items', withFakeBin('fake-codex-stdout-session-log-mirror.mjs', async () => {
  const backend = new CodexBackend();
  const intermediateTexts: string[] = [];
  const snapshotTypes: string[] = [];

  const result = await backend.runTurn(
    { turnId: 'turn-1', prompt: 'hello' },
    {
      ...BASE_OPTIONS,
      onIntermediateText: (text) => intermediateTexts.push(text),
      onIntermediateAssistantSnapshot: (snapshot) => {
        const block = (snapshot.message.content as any[])[0];
        snapshotTypes.push(block?.type);
      },
    },
  );

  assert.deepEqual(intermediateTexts, [
    'stdout first answer',
    'stdout first answer\n\nstdout second answer',
    'stdout first answer\n\nstdout second answer\n\nstdout final answer',
  ]);
  assert.deepEqual(snapshotTypes, ['tool_use', 'tool_result']);
  assert.equal(result.text, 'stdout final answer');
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

test('CodexBackend.runTurn parses json-schema result text as structured output', withFakeBin('fake-codex-structured-output.sh', async () => {
  const backend = new CodexBackend();
  const intermediateTexts: string[] = [];
  const result = await backend.runTurn(
    { turnId: 'turn-structured', prompt: 'json' },
    {
      ...BASE_OPTIONS,
      jsonSchema: STRUCTURED_OUTPUT_SCHEMA,
      onIntermediateText: (text) => intermediateTexts.push(text),
    },
  );

  assert.deepEqual(intermediateTexts, []);
  assert.equal(result.text, '{"ok":true}');
  assert.deepEqual(result.structuredOutput, { ok: true });
}));

test('CodexBackend.runTurn streams unphased assistant text and returns result response', withFakeBin('fake-codex-stream-mismatch.sh', async () => {
  const backend = new CodexBackend();
  const intermediateTexts: string[] = [];

  const result = await backend.runTurn(
    { turnId: 'turn-1', prompt: 'hello' },
    { ...BASE_OPTIONS, onIntermediateText: (text) => intermediateTexts.push(text) },
  );

  assert.deepEqual(intermediateTexts, ['streamed draft']);
  assert.equal(result.text, 'final answer here');
}));

test('CodexBackend.runTurn emits commentary progress as Codex-owned answer stream and snapshot', withFakeBin('fake-codex-commentary.sh', async () => {
  const backend = new CodexBackend();
  const intermediateTexts: string[] = [];
  const snapshots: string[] = [];

  const result = await backend.runTurn(
    { turnId: 'turn-1', prompt: 'hello' },
    {
      ...BASE_OPTIONS,
      onIntermediateText: (text) => intermediateTexts.push(text),
      onIntermediateAssistantSnapshot: (snapshot) => snapshots.push((snapshot.message.content as any[])[0]?.text),
    },
  );

  assert.deepEqual(intermediateTexts, ['checking files...']);
  assert.deepEqual(snapshots, ['checking files...']);
  assert.equal(result.text, 'final answer here');
  assert.equal(assistantEventText(result, 0), 'checking files...');
}));

test('CodexBackend.runTurn succeeds when stdout has commentary answers but no result answer text', withFakeBin('fake-codex-commentary-only.mjs', async () => {
  const backend = new CodexBackend();

  const result = await backend.runTurn(
    { turnId: 'turn-1', prompt: 'hello' },
    BASE_OPTIONS,
  );

  assert.equal(result.text, '');
  assert.equal(result.assistantEvents?.length, 2);
  assert.equal(assistantEventText(result, 0), 'checking files...');
  assert.equal(assistantEventText(result, 1), 'running tests...');
}));

test('CodexBackend.runTurn preserves stdout tool snapshots when no session log exists', withFakeBin('fake-codex-tool-stdout.mjs', async () => {
  const backend = new CodexBackend();

  const result = await backend.runTurn(
    { turnId: 'turn-1', prompt: 'hello' },
    BASE_OPTIONS,
  );

  const toolUse = (result.assistantEvents?.[0]?.message.content as any[])[0];
  const toolResult = (result.assistantEvents?.[1]?.message.content as any[])[0];
  assert.equal(result.text, 'final with tool');
  assert.equal(result.assistantEvents?.length, 2);
  assert.equal(toolUse.type, 'tool_use');
  assert.equal(toolUse.id, 'call_stdout');
  assert.equal(toolUse.name, 'read_file');
  assert.deepEqual(toolUse.input, { path: 'README.md' });
  assert.equal(toolResult.type, 'tool_result');
  assert.equal(toolResult.tool_use_id, 'call_stdout');
  assert.equal(toolResult.content, 'file contents');
}));

test('CodexBackend.runTurn rejects incomplete readable session log instead of falling back to stdout', withFakeBin('fake-codex-tool-stdout.mjs', async () => {
  await writeCodexIncompleteCurrentLog();
  const backend = new CodexBackend();

  await assert.rejects(
    backend.runTurn(
      { turnId: 'turn-1', prompt: 'hello' },
      BASE_OPTIONS,
    ),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.protocolViolation,
  );
}));

test('CodexBackend.runTurn rejects malformed readable session log instead of falling back to stdout', withFakeBin('fake-codex-tool-stdout.mjs', async () => {
  await writeCodexMalformedCurrentLog();
  const backend = new CodexBackend();

  await assert.rejects(
    backend.runTurn(
      { turnId: 'turn-1', prompt: 'hello' },
      BASE_OPTIONS,
    ),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.protocolViolation,
  );
}));

test('CodexBackend.runTurn succeeds when stdout has tool artifacts but no answer text', withFakeBin('fake-codex-tool-only-stdout.mjs', async () => {
  const backend = new CodexBackend();

  const result = await backend.runTurn(
    { turnId: 'turn-1', prompt: 'hello' },
    BASE_OPTIONS,
  );

  const toolUse = (result.assistantEvents?.[0]?.message.content as any[])[0];
  const toolResult = (result.assistantEvents?.[1]?.message.content as any[])[0];
  assert.equal(result.text, '');
  assert.equal(result.assistantEvents?.length, 2);
  assert.equal(toolUse.type, 'tool_use');
  assert.equal(toolUse.id, 'call_stdout');
  assert.equal(toolUse.name, 'read_file');
  assert.deepEqual(toolUse.input, { path: 'README.md' });
  assert.equal(toolResult.type, 'tool_result');
  assert.equal(toolResult.tool_use_id, 'call_stdout');
  assert.equal(toolResult.content, 'file contents');
}));

test('CodexBackend.runTurn uses stdout final_answer event_msg when no session log exists', withFakeBin('fake-codex-event-final.mjs', async () => {
  const backend = new CodexBackend();

  const result = await backend.runTurn(
    { turnId: 'turn-1', prompt: 'hello' },
    BASE_OPTIONS,
  );

  assert.equal(result.text, 'event final answer');
}));

test('CodexBackend.runTurn streams unphased item assistant text and returns result response', withFakeBin('fake-codex-item-progress-final.mjs', async () => {
  const backend = new CodexBackend();
  const intermediateTexts: string[] = [];

  const result = await backend.runTurn(
    { turnId: 'turn-1', prompt: 'hello' },
    { ...BASE_OPTIONS, onIntermediateText: (text) => intermediateTexts.push(text) },
  );

  assert.deepEqual(intermediateTexts, [
    'checking sources',
    'checking sources\n\nsources checked',
    'checking sources\n\nsources checked\n\nfinal researched answer',
  ]);
  assert.equal(result.text, 'final researched answer');
}));

test('CodexBackend.runTurn accumulates discrete assistant messages', withFakeBin('fake-codex-discrete-agent-messages.mjs', async () => {
  const backend = new CodexBackend();
  const intermediateTexts: string[] = [];

  const result = await backend.runTurn(
    { turnId: 'turn-1', prompt: 'hello' },
    { ...BASE_OPTIONS, onIntermediateText: (text) => intermediateTexts.push(text) },
  );

  const expected = 'A\n\nB\n\nC';
  assert.deepEqual(intermediateTexts, ['A', 'A\n\nB', expected]);
  assert.equal(result.text, expected);
}));

test('CodexBackend.runTurn accumulates discrete assistant messages after separate text', withFakeBin('fake-codex-discrete-after-intro.mjs', async () => {
  const backend = new CodexBackend();
  const intermediateTexts: string[] = [];

  const result = await backend.runTurn(
    { turnId: 'turn-1', prompt: 'hello' },
    { ...BASE_OPTIONS, onIntermediateText: (text) => intermediateTexts.push(text) },
  );

  assert.deepEqual(intermediateTexts, ['Intro', 'Intro\n\nA', 'Intro\n\nA\n\nB', 'Intro\n\nA\n\nB\n\nC']);
  assert.equal(result.text, 'Intro\n\nA\n\nB\n\nC');
}));

test('CodexBackend.runTurn preserves prefix-like discrete assistant messages after separate text', withFakeBin('fake-codex-prefix-like-discrete-messages.mjs', async () => {
  const backend = new CodexBackend();
  const intermediateTexts: string[] = [];

  const result = await backend.runTurn(
    { turnId: 'turn-1', prompt: 'hello' },
    { ...BASE_OPTIONS, onIntermediateText: (text) => intermediateTexts.push(text) },
  );

  assert.deepEqual(intermediateTexts, ['Intro', 'Intro\n\nA', 'Intro\n\nA\n\nAB', 'Intro\n\nA\n\nAB\n\nABC']);
  assert.equal(result.text, 'Intro\n\nA\n\nAB\n\nABC');
}));

test('CodexBackend.runTurn streams unphased prefix without completing it from backend result text', withFakeBin('fake-codex-item-prefix-final.mjs', async () => {
  const backend = new CodexBackend();
  const intermediateTexts: string[] = [];

  const result = await backend.runTurn(
    { turnId: 'turn-1', prompt: 'hello' },
    { ...BASE_OPTIONS, onIntermediateText: (text) => intermediateTexts.push(text) },
  );

  assert.deepEqual(intermediateTexts, ['final']);
  assert.equal(result.text, 'final answer');
}));

test('CodexBackend.runTurn falls back to stdout when resume session log is absent before launch', withFakeBin('fake-codex-resume-stdout-only.mjs', async () => {
  const backend = new CodexBackend();

  const result = await backend.runTurn(
    { turnId: 'turn-2', prompt: 'follow up' },
    { ...BASE_OPTIONS, resume: true, backendSessionId: FAKE_CODEX_SESSION_ID },
  );

  assert.equal(result.text, 'stdout-only final answer');
  assert.equal(result.sessionId, FAKE_CODEX_SESSION_ID);
  assert.equal(result.reasoningContent, 'stdout-only reasoning');
  assert.equal(result.assistantEvents?.length, 1);
  assert.equal(assistantEventText(result, 0), 'stdout-only commentary');
  assert.deepEqual(result.diagnostics.usage, {
    inputTokens: 120,
    outputTokens: 12,
    cacheReadInputTokens: 30,
  });
  assert.equal(result.diagnostics.contextWindow, null);
  assert.equal(result.diagnostics.lastSubturnUsage, null);
}));

test('CodexBackend.runTurn rejects resume when the known session log disappears before result read', withFakeBin('fake-codex-remove-session-log.mjs', async () => {
  await writeCodexPreviousTurnLog();
  const backend = new CodexBackend();

  await assert.rejects(
    backend.runTurn(
      { turnId: 'turn-2', prompt: 'follow up' },
      { ...BASE_OPTIONS, resume: true, backendSessionId: FAKE_CODEX_SESSION_ID },
    ),
    (error) => error instanceof OpenPError
      && error.exitCode === EXIT_CODES.protocolViolation
      && error.message.includes('became unavailable'),
  );
}));

test('CodexBackend.runTurn rejects resume when the known session log is replaced by another matching log', withFakeBin('fake-codex-replace-session-log.mjs', async () => {
  await writeCodexPreviousTurnLog();
  const backend = new CodexBackend();

  await assert.rejects(
    backend.runTurn(
      { turnId: 'turn-2', prompt: 'follow up' },
      { ...BASE_OPTIONS, resume: true, backendSessionId: FAKE_CODEX_SESSION_ID },
    ),
    (error) => error instanceof OpenPError
      && error.exitCode === EXIT_CODES.protocolViolation
      && error.message.includes('became unavailable'),
  );
}));

test('CodexBackend.runTurn uses a newly created resume session log when none existed before launch', withFakeBin('fake-codex-resume-session-log.mjs', async () => {
  const backend = new CodexBackend();
  const result = await backend.runTurn(
    { turnId: 'turn-2', prompt: 'follow up' },
    { ...BASE_OPTIONS, resume: true, backendSessionId: FAKE_CODEX_SESSION_ID },
  );

  assert.equal(result.text, 'current turn final answer');
  assert.equal(result.reasoningContent, 'current turn reasoning');
  assert.equal(result.assistantEvents?.length, 2);
  assert.equal(assistantEventText(result, 0), 'current turn commentary');
  assert.equal(assistantEventText(result, 1), 'current turn final answer');
  assert.equal(result.diagnostics.model, 'codex-current-model');
  assert.equal(result.diagnostics.contextWindow, 200000);
  assert.deepEqual(result.diagnostics.usage, {
    inputTokens: 2000,
    outputTokens: 40,
    cacheReadInputTokens: 300,
  });
  assert.deepEqual(result.diagnostics.lastSubturnUsage, {
    inputTokens: 200,
    outputTokens: 10,
    cacheReadInputTokens: 50,
  });
}));

test('CodexBackend.runTurn rejects resume when a newly created session log is unreadable', withFakeBin('fake-codex-unreadable-session-log.mjs', async () => {
  const backend = new CodexBackend();

  await assert.rejects(
    backend.runTurn(
      { turnId: 'turn-2', prompt: 'follow up' },
      { ...BASE_OPTIONS, resume: true, backendSessionId: FAKE_CODEX_SESSION_ID },
    ),
    (error) => error instanceof OpenPError
      && error.exitCode === EXIT_CODES.protocolViolation
      && error.message.includes('became unavailable'),
  );
}));

test('CodexBackend.runTurn reads resumed turn result after the previous log offset', withFakeBin('fake-codex-resume-session-log.mjs', async () => {
  await writeCodexPreviousTurnLog();

  const backend = new CodexBackend();
  const result = await backend.runTurn(
    { turnId: 'turn-2', prompt: 'follow up' },
    { ...BASE_OPTIONS, resume: true, backendSessionId: FAKE_CODEX_SESSION_ID },
  );

  assert.equal(result.text, 'current turn final answer');
  assert.equal(result.sessionId, FAKE_CODEX_SESSION_ID);
  assert.equal(result.reasoningContent, 'current turn reasoning');
  assert.equal(result.assistantEvents?.length, 2);
  assert.equal(assistantEventText(result, 0), 'current turn commentary');
  assert.equal(assistantEventText(result, 1), 'current turn final answer');
  // Aggregate usage sums the resumed turn's last_token_usage values only;
  // session-cumulative total_token_usage (2100/320/50) must not leak in.
  assert.deepEqual(result.diagnostics.usage, {
    inputTokens: 2000,
    outputTokens: 40,
    cacheReadInputTokens: 300,
  });
  assert.deepEqual(result.diagnostics.lastSubturnUsage, {
    inputTokens: 200,
    outputTokens: 10,
    cacheReadInputTokens: 50,
  });
  assert.equal(result.diagnostics.model, 'codex-current-model');
}));

test('CodexBackend.runTurn parses json-schema resume result text as structured output', withFakeBin('fake-codex-resume-structured-output.mjs', async () => {
  await writeCodexPreviousTurnLog();

  const backend = new CodexBackend();
  const intermediateTexts: string[] = [];

  const result = await backend.runTurn(
    { turnId: 'turn-2', prompt: 'follow up' },
    {
      ...BASE_OPTIONS,
      resume: true,
      backendSessionId: FAKE_CODEX_SESSION_ID,
      jsonSchema: STRUCTURED_OUTPUT_SCHEMA,
      onIntermediateText: (text) => intermediateTexts.push(text),
    },
  );

  assert.deepEqual(intermediateTexts, []);
  assert.equal(result.text, '{"ok":true}');
  assert.deepEqual(result.structuredOutput, { ok: true });
}));

test('CodexBackend.runTurn rejects a different returned session id on resume', withFakeBin('fake-codex-mismatch-session.sh', async () => {
  await writeCodexPreviousTurnLog();
  const backend = new CodexBackend();

  await assert.rejects(
    backend.runTurn(
      { turnId: 'turn-2', prompt: 'follow up' },
      { ...BASE_OPTIONS, resume: true, backendSessionId: FAKE_CODEX_SESSION_ID },
    ),
    /different session id/,
  );
}));

test('CodexBackend.runTurn rejects busy sessions before launch', withFakeBin('fake-codex-success.sh', async () => {
  const prevStateDir = process.env.XDG_STATE_HOME;
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-codex-lock-'));
  process.env.XDG_STATE_HOME = stateRoot;
  const lock = await new SessionLockStore(BASE_OPTIONS.cwd).acquire(BASE_OPTIONS.backendSessionId);

  try {
    const backend = new CodexBackend();
    await assert.rejects(
      backend.runTurn(
        { turnId: 'turn-busy', prompt: 'hello' },
        BASE_OPTIONS,
      ),
      (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionBusy,
    );
  } finally {
    await lock.release();
    if (prevStateDir === undefined) {
      delete process.env.XDG_STATE_HOME;
    } else {
      process.env.XDG_STATE_HOME = prevStateDir;
    }
  }
}));

test('CodexBackend.runTurn handles abort signal', withFakeBin('fake-codex-slow.sh', async () => {
  const backend = new CodexBackend();
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
