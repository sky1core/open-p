import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import {
  buildClaudeCodeStdioWorkerArgs,
  ClaudeCodeStdioWorkerBridge,
  ClaudeCodeStdioWorkerProcess,
} from '../src/backends/claude-code/stdio-worker-bridge.js';
import { buildLaunchSignature } from '../src/core/launch-signature.js';
import type { LaunchSignature } from '../src/core/worker-types.js';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';

class FakeClaudeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;
  exitCode: number | null = null;
  readonly prompts: string[] = [];

  constructor(
    private readonly turnTexts: readonly string[] = ['hello'],
    private readonly sessionId: string = SESSION_ID,
    private readonly turnReasoningTexts: readonly (string | null)[] = [],
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
        this.emitTurn(this.turnTexts[this.prompts.length - 1] ?? this.turnTexts.at(-1) ?? 'hello');
      }
    });
  }

  kill(signal?: NodeJS.Signals): boolean {
    if (this.killed) {
      return false;
    }
    this.killed = true;
    this.stdout.end();
    this.stderr.end();
    queueMicrotask(() => this.emit('exit', null, signal ?? 'SIGTERM'));
    return true;
  }

  private emitTurn(text: string): void {
    const reasoningText = this.turnReasoningTexts[this.prompts.length - 1] ?? null;
    const textChunks = chunkText(text);
    const reasoningChunks = reasoningText ? chunkText(reasoningText) : [];
    const events = [
      { type: 'system', subtype: 'init', session_id: this.sessionId },
      ...reasoningChunks.map((chunk) => ({
        type: 'stream_event',
        session_id: this.sessionId,
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
        session_id: this.sessionId,
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
        session_id: this.sessionId,
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
        session_id: this.sessionId,
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
    for (const event of events) {
      queueMicrotask(() => this.stdout.write(`${JSON.stringify(event)}\n`));
    }
  }
}

function chunkText(text: string): string[] {
  const midpoint = Math.max(1, Math.floor(text.length / 2));
  return [text.slice(0, midpoint), text.slice(midpoint)].filter(Boolean);
}

test('stdio worker args call Claude Code stream-json internally without backend print mode', () => {
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
        '--allowedTools',
        'Read',
      ],
      model: 'sonnet',
      reasoningEffort: 'low',
      executionMode: 'plan',
    }),
  });

  assert.deepEqual(args.slice(0, 14), [
    '--session-id',
    SESSION_ID,
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--model',
    'sonnet',
    '--effort',
    'low',
    '--permission-mode',
    'acceptEdits',
  ]);
  assert.equal(args.includes('-p'), false);
  assert.equal(args.includes('--print'), false);
  assert.equal(args.filter((arg) => arg === '--include-partial-messages').length, 1);
  assert.equal(args.at(-2), '--allowedTools');
  assert.equal(args.at(-1), 'Read');
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

function launchSignature(input: Partial<LaunchSignature> = {}): LaunchSignature {
  return buildLaunchSignature({
    backendId: 'claude-code',
    bin: 'claude',
    binArgs: input.binArgs ?? [],
    model: input.model ?? null,
    reasoningEffort: input.reasoningEffort ?? null,
    executionMode: input.executionMode ?? null,
    appendSystemPrompt: input.appendSystemPrompt ?? null,
    jsonSchema: input.jsonSchema ?? null,
    env: input.env ?? {},
    local: input.local ?? false,
  });
}
