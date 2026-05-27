import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import {
  buildClaudeCodeStdioWorkerArgs,
  ClaudeCodeStdioWorkerBridge,
  ClaudeCodeStdioWorkerProcess,
  startClaudeCodeStdioWorkerProcess,
} from '../src/backends/claude/stdio-worker-bridge.js';
import { isAbortError } from '../src/core/abort.js';
import { EXIT_CODES, OpenPError } from '../src/core/errors.js';
import { buildLaunchSignature } from '../src/core/launch-signature.js';
import { formatWorkerTurnResult } from '../src/core/output.js';
import type { LaunchSignature } from '../src/core/worker-types.js';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const FIXTURE_SESSION_ID = '11111111-1111-4111-8111-000000000001';

class FakeClaudeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;
  exitCode: number | null = null;
  readonly prompts: string[] = [];
  readonly signals: NodeJS.Signals[] = [];

  constructor(
    private readonly turnTexts: readonly string[] = ['hello'],
    private readonly sessionId: string | null = SESSION_ID,
    private readonly turnReasoningTexts: readonly (string | null)[] = [],
    private readonly responseDelayMs = 0,
    private readonly autoRespond = true,
    private readonly ignoredSignals: readonly NodeJS.Signals[] = [],
    private readonly signalExitDelayMs = 0,
    private readonly stdinEndExitDelayMs: number | null = null,
  ) {
    super();
    this.stdin.setEncoding('utf8');
    this.stdin.on('data', (chunk: string | Buffer) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (!line.trim()) {
          continue;
        }
        const event = JSON.parse(line) as { readonly message?: { readonly content?: unknown } };
        const prompt = typeof event.message?.content === 'string' ? event.message.content : '';
        this.prompts.push(prompt);
        if (this.autoRespond) {
          this.emitTurn(this.turnTexts[this.prompts.length - 1] ?? this.turnTexts.at(-1) ?? 'hello');
        }
      }
    });
    this.stdin.on('end', () => {
      if (this.stdinEndExitDelayMs === null || this.killed || this.exitCode !== null) {
        return;
      }
      this.stdout.end();
      this.stderr.end();
      setTimeout(() => this.emit('exit', 0, null), this.stdinEndExitDelayMs);
    });
  }

  kill(signal?: NodeJS.Signals): boolean {
    const resolvedSignal = signal ?? 'SIGTERM';
    this.signals.push(resolvedSignal);
    if (this.ignoredSignals.includes(resolvedSignal)) {
      return true;
    }
    if (this.killed) {
      return false;
    }
    this.killed = true;
    this.stdout.end();
    this.stderr.end();
    if (this.signalExitDelayMs > 0) {
      setTimeout(() => this.emit('exit', null, resolvedSignal), this.signalExitDelayMs);
    } else {
      queueMicrotask(() => this.emit('exit', null, resolvedSignal));
    }
    return true;
  }

  private emitTurn(text: string): void {
    const reasoningText = this.turnReasoningTexts[this.prompts.length - 1] ?? null;
    const textChunks = chunkText(text);
    const reasoningChunks = reasoningText ? chunkText(reasoningText) : [];
    const sessionField = this.sessionId ? { session_id: this.sessionId } : {};
    const events = [
      { type: 'system', subtype: 'init', ...sessionField },
      ...reasoningChunks.map((chunk) => ({
        type: 'stream_event',
        ...sessionField,
        event: {
          type: 'content_block_delta',
          delta: {
            type: 'thinking_delta',
            thinking: chunk,
          },
        },
      })),
      ...textChunks.map((chunk) => ({
        type: 'stream_event',
        ...sessionField,
        event: {
          type: 'content_block_delta',
          delta: {
            type: 'text_delta',
            text: chunk,
          },
        },
      })),
      {
        type: 'assistant',
        ...sessionField,
        message: {
          id: `msg_${this.prompts.length}`,
          type: 'message',
          role: 'assistant',
          content: reasoningText
            ? [{ type: 'thinking', thinking: reasoningText }, { type: 'text', text }]
            : [{ type: 'text', text }],
          stop_reason: null,
          usage: {
            input_tokens: 1,
            output_tokens: 2,
            cache_read_input_tokens: 3,
          },
        },
      },
      {
        type: 'result',
        subtype: 'success',
        ...sessionField,
        result: text,
        stop_reason: 'end_turn',
        duration_ms: 10,
        usage: {
          input_tokens: 1,
          output_tokens: 2,
          cache_read_input_tokens: 3,
        },
      },
    ];
    const writeEvents = (): void => {
      for (const event of events) {
        this.stdout.write(`${JSON.stringify(event)}\n`);
      }
    };
    if (this.responseDelayMs > 0) {
      setTimeout(writeEvents, this.responseDelayMs);
      return;
    }
    for (const event of events) {
      queueMicrotask(() => this.stdout.write(`${JSON.stringify(event)}\n`));
    }
  }
}

class FixtureReplayClaudeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;
  exitCode: number | null = null;
  readonly prompts: string[] = [];
  readonly signals: NodeJS.Signals[] = [];

  constructor(private readonly fixtureFileName: string) {
    super();
    this.stdin.setEncoding('utf8');
    this.stdin.on('data', (chunk: string | Buffer) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (!line.trim()) {
          continue;
        }
        const event = JSON.parse(line) as { readonly message?: { readonly content?: unknown } };
        const prompt = typeof event.message?.content === 'string' ? event.message.content : '';
        this.prompts.push(prompt);
        this.replayFixture();
      }
    });
    this.stdin.on('end', () => {
      this.stdout.end();
      this.stderr.end();
      queueMicrotask(() => this.emit('exit', 0, null));
    });
  }

  kill(signal?: NodeJS.Signals): boolean {
    const resolvedSignal = signal ?? 'SIGTERM';
    this.signals.push(resolvedSignal);
    if (this.killed) {
      return false;
    }
    this.killed = true;
    this.stdout.end();
    this.stderr.end();
    queueMicrotask(() => this.emit('exit', null, resolvedSignal));
    return true;
  }

  private replayFixture(): void {
    const text = readFileSync(`test/fixtures/claude/${this.fixtureFileName}`, 'utf8');
    for (const line of text.trim().split('\n')) {
      queueMicrotask(() => this.stdout.write(`${line}\n`));
    }
  }
}

class ResultAfterInterruptChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;
  exitCode: number | null = null;
  readonly signals: NodeJS.Signals[] = [];

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signals.push(signal);
    this.killed = true;
    if (signal === 'SIGINT') {
      queueMicrotask(() => {
        this.stdout.write(`${JSON.stringify({ type: 'system', subtype: 'init', session_id: SESSION_ID })}\n`);
        this.stdout.write(
          `${JSON.stringify({ type: 'assistant', session_id: SESSION_ID, message: { content: [{ type: 'text', text: 'partial' }] } })}\n`,
        );
        this.stdout.write(
          `${JSON.stringify({ type: 'result', subtype: 'success', session_id: SESSION_ID, result: 'partial', usage: {} })}\n`,
        );
      });
      return true;
    }
    this.forceExit(signal);
    return true;
  }

  forceExit(signal: NodeJS.Signals = 'SIGTERM'): void {
    this.stdout.end();
    this.stderr.end();
    queueMicrotask(() => this.emit('exit', null, signal));
  }
}

class EmptyLifecycleResultThenAnswerChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;
  exitCode: number | null = null;
  readonly prompts: string[] = [];

  constructor(private readonly lifecycleResultText = '') {
    super();
    this.stdin.setEncoding('utf8');
    this.stdin.on('data', (chunk: string | Buffer) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (!line.trim()) {
          continue;
        }
        const event = JSON.parse(line) as { readonly message?: { readonly content?: unknown } };
        const prompt = typeof event.message?.content === 'string' ? event.message.content : '';
        this.prompts.push(prompt);
        this.emitTurn();
      }
    });
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.killed = true;
    this.stdout.end();
    this.stderr.end();
    queueMicrotask(() => this.emit('exit', null, signal ?? 'SIGTERM'));
    return true;
  }

  private emitTurn(): void {
    const sessionField = { session_id: SESSION_ID };
    const events = [
      { type: 'system', subtype: 'init', ...sessionField },
      { type: 'system', subtype: 'compact_boundary', ...sessionField },
      { type: 'result', subtype: 'success', ...sessionField, result: this.lifecycleResultText, duration_ms: 1 },
      {
        type: 'assistant',
        ...sessionField,
        message: {
          id: 'msg_final',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'result answer after lifecycle result' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3 },
        },
      },
      {
        type: 'result',
        subtype: 'success',
        ...sessionField,
        result: 'result answer after lifecycle result',
        stop_reason: 'end_turn',
        duration_ms: 10,
        usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3 },
      },
    ];
    for (const event of events) {
      this.stdout.write(`${JSON.stringify(event)}\n`);
    }
  }
}

class ErrorResultChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;
  exitCode: number | null = null;

  constructor(
    private readonly resultText = '',
    private readonly errorFields: Record<string, unknown> = {
      subtype: 'error',
      is_error: true,
      api_error_status: 500,
      error: { message: 'backend failed before result content' },
    },
  ) {
    super();
    this.stdin.setEncoding('utf8');
    this.stdin.on('data', (chunk: string | Buffer) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (!line.trim()) {
          continue;
        }
        this.emitTurn();
      }
    });
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.killed = true;
    this.stdout.end();
    this.stderr.end();
    queueMicrotask(() => this.emit('exit', null, signal ?? 'SIGTERM'));
    return true;
  }

  private emitTurn(): void {
    const sessionField = { session_id: SESSION_ID };
    const events = [
      { type: 'system', subtype: 'init', ...sessionField },
      {
        type: 'result',
        ...sessionField,
        result: this.resultText,
        ...this.errorFields,
      },
    ];
    for (const event of events) {
      this.stdout.write(`${JSON.stringify(event)}\n`);
    }
  }
}

class ToolUseProgressThenAnswerChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;
  exitCode: number | null = null;
  readonly prompts: string[] = [];

  constructor(
    private readonly finalAnswer: string,
    private readonly progressText: string,
    private readonly reasoningText: string,
  ) {
    super();
    this.stdin.setEncoding('utf8');
    this.stdin.on('data', (chunk: string | Buffer) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (!line.trim()) {
          continue;
        }
        const event = JSON.parse(line) as { readonly message?: { readonly content?: unknown } };
        const prompt = typeof event.message?.content === 'string' ? event.message.content : '';
        this.prompts.push(prompt);
        this.emitTurn();
      }
    });
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.killed = true;
    this.stdout.end();
    this.stderr.end();
    queueMicrotask(() => this.emit('exit', null, signal ?? 'SIGTERM'));
    return true;
  }

  private emitTurn(): void {
    const sessionField = { session_id: SESSION_ID };
    const events = [
      { type: 'system', subtype: 'init', ...sessionField },
      ...messageStreamEvents({
        id: 'msg_tool',
        textChunks: ['도구를 ', '확인합니다.'],
        reasoningChunks: ['파일을 ', '읽어야 함'],
        hasToolUse: true,
        stopReason: 'tool_use',
      }),
      {
        type: 'assistant',
        ...sessionField,
        message: {
          id: 'msg_tool',
          type: 'message',
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: this.reasoningText },
            { type: 'text', text: this.progressText },
            { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'a.txt' } },
          ],
          stop_reason: 'tool_use',
        },
      },
      ...messageStreamEvents({
        id: 'msg_final',
        textChunks: ['최종 답변 1문단.\n\n', '최종 답변 2문단.'],
        reasoningChunks: [],
        hasToolUse: false,
        stopReason: 'end_turn',
      }),
      {
        type: 'assistant',
        ...sessionField,
        message: {
          id: 'msg_final',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: this.finalAnswer }],
          stop_reason: 'end_turn',
        },
      },
      {
        type: 'result',
        subtype: 'success',
        ...sessionField,
        result: this.finalAnswer,
        stop_reason: 'end_turn',
        usage: {},
      },
    ];
    for (const event of events) {
      queueMicrotask(() => this.stdout.write(`${JSON.stringify(event)}\n`));
    }
  }
}

function chunkText(text: string): string[] {
  const midpoint = Math.max(1, Math.floor(text.length / 2));
  return [text.slice(0, midpoint), text.slice(midpoint)].filter(Boolean);
}

function messageStreamEvents(input: {
  readonly id: string;
  readonly textChunks: readonly string[];
  readonly reasoningChunks: readonly string[];
  readonly hasToolUse: boolean;
  readonly stopReason: string;
}): Record<string, unknown>[] {
  let index = 0;
  const events: Record<string, unknown>[] = [{
    type: 'stream_event',
    session_id: SESSION_ID,
    event: {
      type: 'message_start',
      message: {
        id: input.id,
        type: 'message',
        role: 'assistant',
        content: [],
        stop_reason: null,
      },
    },
  }];
  if (input.reasoningChunks.length > 0) {
    events.push({
      type: 'stream_event',
      session_id: SESSION_ID,
      event: {
        type: 'content_block_start',
        index,
        content_block: { type: 'thinking', thinking: '' },
      },
    });
    events.push(...input.reasoningChunks.map((thinking) => ({
      type: 'stream_event',
      session_id: SESSION_ID,
      event: {
        type: 'content_block_delta',
        index,
        delta: { type: 'thinking_delta', thinking },
      },
    })));
    events.push({
      type: 'stream_event',
      session_id: SESSION_ID,
      event: { type: 'content_block_stop', index },
    });
    index += 1;
  }
  if (input.textChunks.length > 0) {
    events.push({
      type: 'stream_event',
      session_id: SESSION_ID,
      event: {
        type: 'content_block_start',
        index,
        content_block: { type: 'text', text: '' },
      },
    });
    events.push(...input.textChunks.map((text) => ({
      type: 'stream_event',
      session_id: SESSION_ID,
      event: {
        type: 'content_block_delta',
        index,
        delta: { type: 'text_delta', text },
      },
    })));
    events.push({
      type: 'stream_event',
      session_id: SESSION_ID,
      event: { type: 'content_block_stop', index },
    });
    index += 1;
  }
  if (input.hasToolUse) {
    events.push({
      type: 'stream_event',
      session_id: SESSION_ID,
      event: {
        type: 'content_block_start',
        index,
        content_block: { type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} },
      },
    });
    events.push({
      type: 'stream_event',
      session_id: SESSION_ID,
      event: { type: 'content_block_stop', index },
    });
  }
  events.push({
    type: 'stream_event',
    session_id: SESSION_ID,
    event: {
      type: 'message_delta',
      delta: { stop_reason: input.stopReason, stop_sequence: null },
    },
  });
  events.push({
    type: 'stream_event',
    session_id: SESSION_ID,
    event: { type: 'message_stop' },
  });
  return events;
}

test('stdio worker args call Claude Code stream-json internally without backend one-shot relay', () => {
  const args = buildClaudeCodeStdioWorkerArgs({
    sessionId: SESSION_ID,
    resume: false,
    cwd: '/work/open-p',
    launchSignature: launchSignature({
      binArgs: [
        '-p',
        '--print',
        '--verbose',
        '--include-partial-messages',
        '--brief',
        '--allowedTools',
        'Read',
      ],
      model: 'sonnet',
      reasoningEffort: 'low',
      executionMode: 'plan',
      tools: 'Read,Grep',
    }),
  });

  assert.deepEqual(args.slice(0, 13), [
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--brief',
    '--model',
    'sonnet',
    '--effort',
    'low',
    '--permission-mode',
    'acceptEdits',
  ]);
  assert.equal(args.includes('--session-id'), false);
  assert.equal(args.includes('-p'), false);
  assert.equal(args.includes('--print'), false);
  assert.equal(args.filter((arg) => arg === '--include-partial-messages').length, 1);
  assert.equal(args.filter((arg) => arg === '--brief').length, 1);
  assert.deepEqual(args.slice(-4), ['--tools', 'Read,Grep', '--allowedTools', 'Read']);
});

test('stdio worker args reject raw reasoning effort backend arg', () => {
  assert.throws(
    () => buildClaudeCodeStdioWorkerArgs({
      sessionId: SESSION_ID,
      resume: false,
      cwd: '/work/open-p',
      launchSignature: launchSignature({
        binArgs: ['--effort', 'high'],
        reasoningEffort: 'low',
      }),
    }),
    /unsupported backend arg: --effort/,
  );
  assert.throws(
    () => buildClaudeCodeStdioWorkerArgs({
      sessionId: SESSION_ID,
      resume: false,
      cwd: '/work/open-p',
      launchSignature: launchSignature({
        binArgs: ['--effort=high'],
        reasoningEffort: 'low',
      }),
    }),
    /unsupported backend arg: --effort/,
  );
});

test('stdio worker startup rejects open-p claude command before spawning child', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openp-claude-stdio-'));
  const fakeOpenP = join(dir, 'claude');
  await writeFile(fakeOpenP, '#!/bin/sh\necho "openp 0.1.0"\n');
  await chmod(fakeOpenP, 0o755);
  let spawned = false;

  await assert.rejects(
    () => startClaudeCodeStdioWorkerProcess({
      sessionId: SESSION_ID,
      launchSignature: launchSignature({
        bin: 'claude',
        env: { PATH: `.:${process.env.PATH ?? ''}` },
      }),
      resume: false,
      cwd: dir,
      timeoutMs: 0,
    }, () => {
      spawned = true;
      return new FakeClaudeChild(['answer']);
    }),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.backendStartFailed,
  );

  assert.equal(spawned, false);
});

test('stdio worker process streams cumulative text deltas before resolving the result', async () => {
  const child = new FakeClaudeChild(['hello']);
  const process = new ClaudeCodeStdioWorkerProcess(
    SESSION_ID,
    launchSignature(),
    '/work/open-p',
    child,
  );
  const streamed: Array<{ text: string; source: string }> = [];

  const result = await process.sendTurn('prompt', {
    sessionId: SESSION_ID,
    projectRoot: '/work/open-p',
    message: 'prompt',
    onIntermediateText: (text, source) => streamed.push({ text, source }),
  });

  assert.deepEqual(child.prompts, ['prompt']);
  assert.deepEqual(streamed, [
    { text: 'he', source: 'jsonl' },
    { text: 'hello', source: 'jsonl' },
  ]);
  assert.equal(result.content, 'hello');
  assert.equal(result.sessionId, SESSION_ID);
  assert.equal(result.diagnostics.intermediateTextCount, 2);
  assert.equal(result.diagnostics.inputTokens, 1);
  await process.shutdown();
});

test('stdio worker process publishes text deltas before message_stop', async () => {
  const child = new FakeClaudeChild([], SESSION_ID, [], 0, false);
  const process = new ClaudeCodeStdioWorkerProcess(
    SESSION_ID,
    launchSignature(),
    '/work/open-p',
    child,
  );
  const streamed: string[] = [];
  let resolved = false;
  const turn = process.sendTurn('prompt', {
    sessionId: SESSION_ID,
    projectRoot: '/work/open-p',
    message: 'prompt',
    onIntermediateText: (text) => streamed.push(text),
  });
  turn.then(
    () => {
      resolved = true;
    },
    () => {
      resolved = true;
    },
  );

  await waitForCondition(() => child.prompts.length === 1);
  writeClaudeStdout(child, { type: 'system', subtype: 'init', session_id: SESSION_ID });
  writeClaudeStdout(child, {
    type: 'stream_event',
    session_id: SESSION_ID,
    event: {
      type: 'message_start',
      message: { id: 'msg_live', type: 'message', role: 'assistant', content: [], stop_reason: null },
    },
  });
  writeClaudeStdout(child, {
    type: 'stream_event',
    session_id: SESSION_ID,
    event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  });
  writeClaudeStdout(child, {
    type: 'stream_event',
    session_id: SESSION_ID,
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hel' } },
  });
  await waitForCondition(() => streamed.length === 1);
  assert.deepEqual(streamed, ['hel']);
  assert.equal(resolved, false);

  writeClaudeStdout(child, {
    type: 'stream_event',
    session_id: SESSION_ID,
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } },
  });
  await waitForCondition(() => streamed.length === 2);
  assert.deepEqual(streamed, ['hel', 'hello']);
  assert.equal(resolved, false);

  writeClaudeStdout(child, {
    type: 'stream_event',
    session_id: SESSION_ID,
    event: { type: 'content_block_stop', index: 0 },
  });
  writeClaudeStdout(child, {
    type: 'stream_event',
    session_id: SESSION_ID,
    event: { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null } },
  });
  writeClaudeStdout(child, {
    type: 'stream_event',
    session_id: SESSION_ID,
    event: { type: 'message_stop' },
  });
  assert.equal(resolved, false);
  writeClaudeStdout(child, {
    type: 'assistant',
    session_id: SESSION_ID,
    message: {
      id: 'msg_live',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'hello' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3 },
    },
  });
  writeClaudeStdout(child, {
    type: 'result',
    subtype: 'success',
    session_id: SESSION_ID,
    result: 'hello',
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3 },
  });

  const result = await turn;
  assert.equal(result.content, 'hello');
  assert.equal(result.diagnostics.intermediateTextCount, 2);
  await process.shutdown();
});

test('stdio worker process publishes thinking deltas before message_stop', async () => {
  const child = new FakeClaudeChild([], SESSION_ID, [], 0, false);
  const process = new ClaudeCodeStdioWorkerProcess(
    SESSION_ID,
    launchSignature(),
    '/work/open-p',
    child,
  );
  const streamedReasoning: string[] = [];
  let resolved = false;
  const turn = process.sendTurn('prompt', {
    sessionId: SESSION_ID,
    projectRoot: '/work/open-p',
    message: 'prompt',
    onIntermediateReasoning: (text) => streamedReasoning.push(text),
  });
  turn.then(
    () => {
      resolved = true;
    },
    () => {
      resolved = true;
    },
  );

  await waitForCondition(() => child.prompts.length === 1);
  writeClaudeStdout(child, { type: 'system', subtype: 'init', session_id: SESSION_ID });
  writeClaudeStdout(child, {
    type: 'stream_event',
    session_id: SESSION_ID,
    event: {
      type: 'message_start',
      message: { id: 'msg_live', type: 'message', role: 'assistant', content: [], stop_reason: null },
    },
  });
  writeClaudeStdout(child, {
    type: 'stream_event',
    session_id: SESSION_ID,
    event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
  });
  writeClaudeStdout(child, {
    type: 'stream_event',
    session_id: SESSION_ID,
    event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'thi' } },
  });
  await waitForCondition(() => streamedReasoning.length === 1);
  assert.deepEqual(streamedReasoning, ['thi']);
  assert.equal(resolved, false);

  writeClaudeStdout(child, {
    type: 'stream_event',
    session_id: SESSION_ID,
    event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'nk' } },
  });
  await waitForCondition(() => streamedReasoning.length === 2);
  assert.deepEqual(streamedReasoning, ['thi', 'think']);
  assert.equal(resolved, false);

  writeClaudeStdout(child, {
    type: 'stream_event',
    session_id: SESSION_ID,
    event: { type: 'content_block_stop', index: 0 },
  });
  writeClaudeStdout(child, {
    type: 'stream_event',
    session_id: SESSION_ID,
    event: { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null } },
  });
  writeClaudeStdout(child, {
    type: 'stream_event',
    session_id: SESSION_ID,
    event: { type: 'message_stop' },
  });
  assert.equal(resolved, false);
  writeClaudeStdout(child, {
    type: 'assistant',
    session_id: SESSION_ID,
    message: {
      id: 'msg_live',
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'think' },
        { type: 'text', text: 'answer' },
      ],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3 },
    },
  });
  writeClaudeStdout(child, {
    type: 'result',
    subtype: 'success',
    session_id: SESSION_ID,
    result: 'answer',
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3 },
  });

  const result = await turn;
  assert.equal(result.content, 'answer');
  assert.equal(result.reasoningContent, 'think');
  await process.shutdown();
});

test('stdio worker process streams cumulative thinking deltas before resolving the result', async () => {
  const child = new FakeClaudeChild(['answer'], SESSION_ID, ['think']);
  const process = new ClaudeCodeStdioWorkerProcess(
    SESSION_ID,
    launchSignature(),
    '/work/open-p',
    child,
  );
  const streamedText: Array<{ text: string; source: string }> = [];
  const streamedReasoning: Array<{ text: string; source: string }> = [];

  const result = await process.sendTurn('prompt', {
    sessionId: SESSION_ID,
    projectRoot: '/work/open-p',
    message: 'prompt',
    onIntermediateText: (text, source) => streamedText.push({ text, source }),
    onIntermediateReasoning: (text, source) => streamedReasoning.push({ text, source: source ?? 'unknown' }),
  });

  assert.deepEqual(child.prompts, ['prompt']);
  assert.deepEqual(streamedReasoning, [
    { text: 'th', source: 'jsonl' },
    { text: 'think', source: 'jsonl' },
  ]);
  assert.deepEqual(streamedText, [
    { text: 'ans', source: 'jsonl' },
    { text: 'answer', source: 'jsonl' },
  ]);
  assert.equal(result.content, 'answer');
  assert.equal(result.reasoningContent, 'think');
  await process.shutdown();
});

test('stdio worker process publishes and preserves tool-use assistant text as answer output', async () => {
  const finalAnswer = '최종 답변 1문단.\n\n최종 답변 2문단.';
  const child = new ToolUseProgressThenAnswerChild(
    finalAnswer,
    '도구를 확인합니다.',
    '파일을 읽어야 함',
  );
  const process = new ClaudeCodeStdioWorkerProcess(
    SESSION_ID,
    launchSignature(),
    '/work/open-p',
    child,
  );
  const streamedText: Array<{ text: string; source: string }> = [];
  const streamedReasoning: Array<{ text: string; source: string }> = [];

  const result = await process.sendTurn('prompt', {
    sessionId: SESSION_ID,
    projectRoot: '/work/open-p',
    message: 'prompt',
    onIntermediateText: (text, source) => streamedText.push({ text, source }),
    onIntermediateReasoning: (text, source) => streamedReasoning.push({ text, source: source ?? 'unknown' }),
  });

  assert.deepEqual(child.prompts, ['prompt']);
  assert.deepEqual(streamedText, [
    { text: '도구를 ', source: 'jsonl' },
    { text: '도구를 확인합니다.', source: 'jsonl' },
    { text: '도구를 확인합니다.\n\n최종 답변 1문단.\n\n', source: 'jsonl' },
    { text: `도구를 확인합니다.\n\n${finalAnswer}`, source: 'jsonl' },
  ]);
  assert.deepEqual(streamedReasoning, [
    { text: '파일을 ', source: 'jsonl' },
    { text: '파일을 읽어야 함', source: 'jsonl' },
  ]);
  assert.equal(result.content, finalAnswer);
  assert.equal(result.reasoningContent, '파일을 읽어야 함');
  assert.deepEqual((result.assistantEvents ?? []).map(assistantText), [
    '도구를 확인합니다.',
    finalAnswer,
  ]);
  const openp = JSON.parse(formatWorkerTurnResult(result, {
    turnId: 'turn-tool-use',
    backend: 'claude',
  })).openp;
  assert.deepEqual(openp.output.answer, ['도구를 확인합니다.', finalAnswer]);
  assert.deepEqual(openp.output.toolCall, [{
    type: 'tool_use',
    id: 'toolu_1',
    name: 'Read',
    input: { file_path: 'a.txt' },
  }]);
  assert.equal(result.diagnostics.intermediateTextCount, 4);
  await process.shutdown();
});

test('stdio worker process replays redacted long-answer stdout fixture as many streaming snapshots', async () => {
  const child = new FixtureReplayClaudeChild('redacted-stdout-long-answer-stream.jsonl');
  const process = new ClaudeCodeStdioWorkerProcess(
    FIXTURE_SESSION_ID,
    launchSignature(),
    '/work/open-p',
    child,
  );
  const streamedText: Array<{ text: string; source: string }> = [];
  const streamedReasoning: Array<{ text: string; source: string }> = [];

  const result = await process.sendTurn('prompt', {
    sessionId: FIXTURE_SESSION_ID,
    projectRoot: '/work/open-p',
    message: 'prompt',
    onIntermediateText: (text, source) => streamedText.push({ text, source }),
    onIntermediateReasoning: (text, source) => streamedReasoning.push({ text, source: source ?? 'unknown' }),
  });

  assert.deepEqual(child.prompts, ['prompt']);
  assert.equal(streamedText.length, 95);
  assert.equal(streamedReasoning.length, 4);
  assert.equal(streamedText.every((snapshot) => snapshot.source === 'jsonl'), true);
  assert.equal(streamedReasoning.every((snapshot) => snapshot.source === 'jsonl'), true);
  assert.equal(streamedText.at(-1)?.text, result.content);
  assert.equal(streamedReasoning.at(-1)?.text, result.reasoningContent);
  assert.equal(result.diagnostics.intermediateTextCount, 95);
  const openp = JSON.parse(formatWorkerTurnResult(result, {
    turnId: 'turn-long-answer-reference',
    backend: 'claude',
  })).openp;
  assert.deepEqual(openp.output.answer, [result.content]);
  assert.equal(openp.output.reasoning.length, 1);
  assert.deepEqual(openp.output.toolCall, []);
  assert.deepEqual(openp.output.toolResult, []);
  await process.shutdown();
});

test('stdio worker process replays redacted complex tool-use stdout fixture without dropping outputs', async () => {
  const child = new FixtureReplayClaudeChild('redacted-stdout-tool-use-file-complex.jsonl');
  const process = new ClaudeCodeStdioWorkerProcess(
    FIXTURE_SESSION_ID,
    launchSignature(),
    '/work/open-p',
    child,
  );
  const streamedText: Array<{ text: string; source: string }> = [];
  const streamedReasoning: Array<{ text: string; source: string }> = [];

  const result = await process.sendTurn('prompt', {
    sessionId: FIXTURE_SESSION_ID,
    projectRoot: '/work/open-p',
    message: 'prompt',
    onIntermediateText: (text, source) => streamedText.push({ text, source }),
    onIntermediateReasoning: (text, source) => streamedReasoning.push({ text, source: source ?? 'unknown' }),
  });

  assert.deepEqual(child.prompts, ['prompt']);
  assert.equal(streamedText.length, 26);
  assert.equal(streamedReasoning.length, 3);
  assert.equal(streamedText[0]?.text, '`data/input.txt`를 읽고 `data/result.txt`를 생성한');
  assert.equal(streamedText[1]?.text, '`data/input.txt`를 읽고 `data/result.txt`를 생성한다.');
  assert.equal(streamedText.at(-1)?.text, `\`data/input.txt\`를 읽고 \`data/result.txt\`를 생성한다.\n\n${result.content}`);
  const openp = JSON.parse(formatWorkerTurnResult(result, {
    turnId: 'turn-tool-use-reference',
    backend: 'claude',
  })).openp;
  assert.deepEqual(openp.output.answer, [
    '`data/input.txt`를 읽고 `data/result.txt`를 생성한다.',
    result.content,
  ]);
  assert.deepEqual(openp.output.toolCall.map((toolCall: Record<string, unknown>) => toolCall.name), [
    'Read',
    'Write',
  ]);
  assert.deepEqual(openp.output.toolResult.map((toolResult: Record<string, unknown>) => toolResult.toolUseId), [
    'toolu_redacted_01',
    'toolu_redacted_02',
  ]);
  await process.shutdown();
});

test('stdio worker bridge reuses one Claude Code stream-json child for sequential turns', async () => {
  const children: FakeClaudeChild[] = [];
  const bridge = new ClaudeCodeStdioWorkerBridge(undefined, async (request) => {
    const child = new FakeClaudeChild(['first answer', 'second answer'], request.sessionId);
    children.push(child);
    return new ClaudeCodeStdioWorkerProcess(
      request.sessionId,
      request.launchSignature,
      request.cwd,
      child,
    );
  });
  const streamed: string[] = [];

  const first = await bridge.runTurn({
    sessionId: null,
    projectRoot: '/work/open-p',
    message: 'first prompt',
    onIntermediateText: (text) => streamed.push(text),
  });
  const second = await bridge.runTurn({
    sessionId: first.sessionId,
    projectRoot: '/work/open-p',
    message: 'second prompt',
    onIntermediateText: (text) => streamed.push(text),
  });

  assert.equal(children.length, 1);
  assert.deepEqual(children[0]?.prompts, ['first prompt', 'second prompt']);
  assert.equal(first.content, 'first answer');
  assert.equal(second.content, 'second answer');
  assert.equal(second.sessionId, first.sessionId);
  assert.deepEqual(streamed, [
    'first ',
    'first answer',
    'second',
    'second answer',
  ]);
  await bridge.shutdown();
});

test('stdio worker bridge waits for child exit after stdout closes during shutdown', async () => {
  const children: FakeClaudeChild[] = [];
  const bridge = new ClaudeCodeStdioWorkerBridge(undefined, async (request) => {
    const child = new FakeClaudeChild(['answer'], request.sessionId, [], 0, true, [], 25);
    children.push(child);
    return new ClaudeCodeStdioWorkerProcess(
      request.sessionId,
      request.launchSignature,
      request.cwd,
      child,
      {
        eofGraceMs: 1,
        terminateGraceMs: 100,
        killGraceMs: 100,
      },
    );
  });

  const result = await bridge.runTurn({
    sessionId: null,
    projectRoot: '/work/open-p',
    message: 'first prompt',
  });

  await bridge.shutdown();

  assert.equal(children.length, 1);
  assert.deepEqual(children[0]?.signals, ['SIGTERM']);
  assert.equal(await bridge.isChildAliveForSession(result.sessionId), false);
});

test('stdio worker bridge treats stdout close before EOF exit as graceful shutdown', async () => {
  const children: FakeClaudeChild[] = [];
  const bridge = new ClaudeCodeStdioWorkerBridge(undefined, async (request) => {
    const child = new FakeClaudeChild(['answer'], request.sessionId, [], 0, true, [], 0, 25);
    children.push(child);
    return new ClaudeCodeStdioWorkerProcess(
      request.sessionId,
      request.launchSignature,
      request.cwd,
      child,
      {
        eofGraceMs: 1,
        stdoutCloseExitGraceMs: 100,
        terminateGraceMs: 100,
        killGraceMs: 100,
      },
    );
  });

  const result = await bridge.runTurn({
    sessionId: null,
    projectRoot: '/work/open-p',
    message: 'first prompt',
  });

  await bridge.shutdown();

  assert.equal(children.length, 1);
  assert.deepEqual(children[0]?.signals, []);
  assert.equal(await bridge.isChildAliveForSession(result.sessionId), false);
});

test('stdio worker bridge ignores caller session id when request is explicitly a first turn', async () => {
  const starts: Array<{ sessionId: string; resume: boolean }> = [];
  const children: FakeClaudeChild[] = [];
  const bridge = new ClaudeCodeStdioWorkerBridge(undefined, async (request) => {
    starts.push({ sessionId: request.sessionId, resume: request.resume });
    const child = new FakeClaudeChild([request.resume ? 'resume answer' : 'first answer'], request.sessionId);
    children.push(child);
    return new ClaudeCodeStdioWorkerProcess(
      request.sessionId,
      request.launchSignature,
      request.cwd,
      child,
    );
  });

  await bridge.runTurn({
    sessionId: 'caller-selected-id',
    isFirstTurn: false,
    projectRoot: '/work/open-p',
    message: 'resume prompt',
  });
  const first = await bridge.runTurn({
    sessionId: 'caller-selected-id',
    isFirstTurn: true,
    projectRoot: '/work/open-p',
    message: 'first prompt',
  });

  assert.equal(starts.length, 2);
  assert.deepEqual(starts[0], { sessionId: 'caller-selected-id', resume: true });
  assert.equal(starts[1]?.resume, false);
  assert.notEqual(starts[1]?.sessionId, 'caller-selected-id');
  assert.deepEqual(children[0]?.prompts, ['resume prompt']);
  assert.deepEqual(children[1]?.prompts, ['first prompt']);
  assert.equal(first.sessionId, starts[1]?.sessionId);
  await bridge.shutdown();
});

test('stdio worker bridge rejects first turn when Claude stream-json omits backend session id', async () => {
  const bridge = new ClaudeCodeStdioWorkerBridge(undefined, async (request) => new ClaudeCodeStdioWorkerProcess(
    request.sessionId,
    request.launchSignature,
    request.cwd,
    new FakeClaudeChild(['answer'], null),
  ));

  await assert.rejects(
    () => bridge.runTurn({
      sessionId: null,
      projectRoot: '/work/open-p',
      message: 'first prompt',
    }),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.protocolViolation,
  );
  await bridge.shutdown();
});

test('stdio worker process rejects resume when Claude stream-json returns a different session id', async () => {
  const child = new FakeClaudeChild(['answer'], '22222222-2222-4222-8222-222222222222');
  const process = new ClaudeCodeStdioWorkerProcess(
    SESSION_ID,
    launchSignature(),
    '/work/open-p',
    child,
  );

  await assert.rejects(
    () => process.sendTurn('prompt', {
      sessionId: SESSION_ID,
      isFirstTurn: false,
      projectRoot: '/work/open-p',
      message: 'prompt',
    }),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.protocolViolation,
  );
  await process.shutdown();
});

test('stdio worker process ignores empty lifecycle result and waits for later result answer', async () => {
  const child = new EmptyLifecycleResultThenAnswerChild();
  const process = new ClaudeCodeStdioWorkerProcess(
    SESSION_ID,
    launchSignature(),
    '/work/open-p',
    child,
  );

  const result = await process.sendTurn('prompt', {
    sessionId: SESSION_ID,
    projectRoot: '/work/open-p',
    message: 'prompt',
  });

  assert.equal(result.content, 'result answer after lifecycle result');
  assert.equal(result.sessionId, SESSION_ID);
  assert.deepEqual(child.prompts, ['prompt']);
  await process.shutdown();
});

test('stdio worker process ignores whitespace lifecycle result and waits for later result answer', async () => {
  const child = new EmptyLifecycleResultThenAnswerChild('   \n');
  const process = new ClaudeCodeStdioWorkerProcess(
    SESSION_ID,
    launchSignature(),
    '/work/open-p',
    child,
  );

  const result = await process.sendTurn('prompt', {
    sessionId: SESSION_ID,
    projectRoot: '/work/open-p',
    message: 'prompt',
  });

  assert.equal(result.content, 'result answer after lifecycle result');
  assert.equal(result.sessionId, SESSION_ID);
  assert.deepEqual(child.prompts, ['prompt']);
  await process.shutdown();
});

test('stdio worker process does not ignore explicit empty error results', async () => {
  const child = new ErrorResultChild();
  const process = new ClaudeCodeStdioWorkerProcess(
    SESSION_ID,
    launchSignature(),
    '/work/open-p',
    child,
  );
  const turn = process.sendTurn('prompt', {
    sessionId: SESSION_ID,
    projectRoot: '/work/open-p',
    message: 'prompt',
  });

  try {
    await assert.rejects(
      Promise.race([
        turn,
        sleep(200).then(() => {
          throw new Error('sendTurn timed out');
        }),
      ]),
      (error) =>
        error instanceof OpenPError &&
        error.exitCode === EXIT_CODES.backendExited &&
        error.message.includes('result returned an error'),
    );
  } finally {
    await process.shutdown();
    await turn.catch(() => undefined);
  }
});

test('stdio worker process rejects explicit non-empty error results instead of resolving as result content', async () => {
  const child = new ErrorResultChild('backend failed in result text');
  const process = new ClaudeCodeStdioWorkerProcess(
    SESSION_ID,
    launchSignature(),
    '/work/open-p',
    child,
  );

  try {
    await assert.rejects(
      process.sendTurn('prompt', {
        sessionId: SESSION_ID,
        projectRoot: '/work/open-p',
        message: 'prompt',
      }),
      (error) =>
        error instanceof OpenPError &&
        error.exitCode === EXIT_CODES.backendExited &&
        error.message.includes('backend failed in result text'),
    );
  } finally {
    await process.shutdown();
  }
});

test('stdio worker process rejects each explicit error result signal independently', async () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly fields: Record<string, unknown>;
  }> = [
    { name: 'is_error', fields: { is_error: true } },
    { name: 'subtype', fields: { subtype: 'error' } },
    { name: 'api_error_status', fields: { api_error_status: 500 } },
    { name: 'error', fields: { error: { message: 'backend failed' } } },
  ];

  for (const item of cases) {
    const child = new ErrorResultChild('backend failed in result text', item.fields);
    const process = new ClaudeCodeStdioWorkerProcess(
      SESSION_ID,
      launchSignature(),
      '/work/open-p',
      child,
    );

    try {
      await assert.rejects(
        process.sendTurn('prompt', {
          sessionId: SESSION_ID,
          projectRoot: '/work/open-p',
          message: 'prompt',
        }),
        (error) =>
          error instanceof OpenPError &&
          error.exitCode === EXIT_CODES.backendExited &&
          error.message.includes('result returned an error'),
        item.name,
      );
    } finally {
      await process.shutdown();
    }
  }
});

test('stdio worker process sends SIGINT first when an active turn is aborted', async () => {
  const child = new FakeClaudeChild(['late answer'], SESSION_ID, [], 0, false);
  const process = new ClaudeCodeStdioWorkerProcess(
    SESSION_ID,
    launchSignature(),
    '/work/open-p',
    child,
  );
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 10);

  await assert.rejects(
    process.sendTurn('prompt', {
      sessionId: SESSION_ID,
      projectRoot: '/work/open-p',
      message: 'prompt',
      signal: controller.signal,
    }),
    isAbortError,
  );

  assert.deepEqual(child.signals, ['SIGINT']);
});

test('stdio worker process treats SIGTERM abort reason as terminate phase', async () => {
  const child = new FakeClaudeChild(['late answer'], SESSION_ID, [], 0, false);
  const process = new ClaudeCodeStdioWorkerProcess(
    SESSION_ID,
    launchSignature(),
    '/work/open-p',
    child,
  );
  const controller = new AbortController();
  setTimeout(() => controller.abort('SIGTERM'), 10);

  await assert.rejects(
    process.sendTurn('prompt', {
      sessionId: SESSION_ID,
      projectRoot: '/work/open-p',
      message: 'prompt',
      signal: controller.signal,
    }),
    isAbortError,
  );

  assert.deepEqual(child.signals, ['SIGTERM']);
});

test('stdio worker process preserves timeout classification when abort arrives after timeout', async () => {
  const child = new FakeClaudeChild(['late answer'], SESSION_ID, [], 0, false, ['SIGINT']);
  const process = new ClaudeCodeStdioWorkerProcess(
    SESSION_ID,
    launchSignature(),
    '/work/open-p',
    child,
  );
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 30);

  await assert.rejects(
    process.sendTurn('prompt', {
      sessionId: SESSION_ID,
      projectRoot: '/work/open-p',
      message: 'prompt',
      timeoutMs: 10,
      signal: controller.signal,
    }),
    /timed out waiting for Claude Code stream-json result/,
  );

  assert.deepEqual(child.signals, ['SIGINT', 'SIGTERM']);
});

test('stdio worker shutdown still terminates after graceful signal sets child.killed', async () => {
  const child = new ResultAfterInterruptChild();
  const process = new ClaudeCodeStdioWorkerProcess(
    SESSION_ID,
    launchSignature(),
    '/work/open-p',
    child,
  );
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 10);

  await assert.rejects(
    process.sendTurn('prompt', {
      sessionId: SESSION_ID,
      projectRoot: '/work/open-p',
      message: 'prompt',
      signal: controller.signal,
    }),
    isAbortError,
  );

  let shutdownError: unknown = null;
  const shutdown = process.shutdown();
  try {
    await Promise.race([
      shutdown,
      sleep(200).then(() => {
        throw new Error('shutdown timed out');
      }),
    ]);
  } catch (error) {
    shutdownError = error;
  } finally {
    child.forceExit();
    await shutdown.catch(() => undefined);
  }

  if (shutdownError) {
    throw shutdownError;
  }
  assert.deepEqual(child.signals, ['SIGINT', 'SIGTERM']);
});

function launchSignature(input: Partial<LaunchSignature> = {}): LaunchSignature {
  return buildLaunchSignature({
    backendId: 'claude',
    bin: 'claude',
    binArgs: input.binArgs ?? [],
    model: input.model ?? null,
    reasoningEffort: input.reasoningEffort ?? null,
    executionMode: input.executionMode ?? null,
    tools: input.tools ?? null,
    jsonSchema: input.jsonSchema ?? null,
    env: input.env ?? {},
    local: input.local ?? false,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await sleep(5);
  }
  assert.equal(predicate(), true);
}

function writeClaudeStdout(child: FakeClaudeChild, event: Record<string, unknown>): void {
  child.stdout.write(`${JSON.stringify(event)}\n`);
}

function assistantText(snapshot: { readonly message: Record<string, unknown> }): string | null {
  const content = snapshot.message.content;
  if (!Array.isArray(content)) {
    return null;
  }
  const parts = content.flatMap((block) => {
    if (!block || typeof block !== 'object' || Array.isArray(block)) {
      return [];
    }
    const item = block as Record<string, unknown>;
    return item.type === 'text' && typeof item.text === 'string' ? [item.text] : [];
  });
  return parts.length > 0 ? parts.join('\n\n') : null;
}
