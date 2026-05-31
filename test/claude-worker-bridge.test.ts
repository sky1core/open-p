import assert from 'node:assert/strict';
import test from 'node:test';
import { ClaudeCodeWorkerBridge, type ClaudeCodeManagedProcess, type ClaudeCodeWorkerBridgeStartRequest } from '../src/backends/claude/worker-bridge.js';
import { isAbortError } from '../src/core/abort.js';
import { EXIT_CODES, OpenPError } from '../src/core/errors.js';
import type { LaunchSignature } from '../src/core/worker-types.js';
import type { TurnResult } from '../src/core/types.js';
import type { PtyProvider } from '../src/runners/types.js';

const UNUSED_PROVIDER: PtyProvider = {
  start: async () => {
    throw new Error('provider should not be used by injected starter');
  },
};

class FakeManagedProcess implements ClaudeCodeManagedProcess {
  readonly prompts: string[] = [];
  readonly turnTimeouts: number[] = [];
  readonly intermediateCallbacks: Array<((text: string, source: 'jsonl' | 'screen') => void) | undefined> = [];
  readonly backgroundCallbacks: Array<((text: string) => void) | undefined> = [];
  shutdownCount = 0;
  alive = true;
  failNextTurn = false;
  intermediateText: string | null = 'final';
  resultText = 'final';

  constructor(
    readonly sessionId: string,
    readonly launchSignature: LaunchSignature,
    private readonly resultSessionId: string | null = sessionId,
  ) {}

  async sendTurn(prompt: string, options: {
    readonly timeoutMs: number;
    readonly onIntermediateText?: (text: string, source: 'jsonl' | 'screen') => void;
    readonly onBackgroundAssistantText?: (text: string) => void;
  }): Promise<TurnResult> {
    this.prompts.push(prompt);
    this.turnTimeouts.push(options.timeoutMs);
    this.intermediateCallbacks.push(options.onIntermediateText);
    this.backgroundCallbacks.push(options.onBackgroundAssistantText);
    if (this.failNextTurn) {
      throw new Error('turn failed');
    }
    if (this.intermediateText !== null) {
      options.onIntermediateText?.(this.intermediateText, 'jsonl');
    }
    options.onBackgroundAssistantText?.('background');
    return {
      turnId: `turn-${this.prompts.length}`,
      text: this.resultText,
      ...(this.resultSessionId ? { sessionId: this.resultSessionId } : {}),
      diagnostics: {
        durationMs: 10,
        stopReason: 'end_turn',
        toolsUsed: ['Bash'],
        usage: {
          inputTokens: 1,
          cacheReadInputTokens: 2,
          outputTokens: 3,
        },
        rawEventCount: 4,
      },
    };
  }

  async isAlive(): Promise<boolean> {
    return this.alive;
  }

  async shutdown(): Promise<void> {
    this.shutdownCount += 1;
    this.alive = false;
  }
}

test('worker bridge creates a backend session and sends first turn as raw message', async () => {
  const starts: ClaudeCodeWorkerBridgeStartRequest[] = [];
  const processes: FakeManagedProcess[] = [];
  const bridge = new ClaudeCodeWorkerBridge(UNUSED_PROVIDER, undefined, async (request) => {
    starts.push(request);
    const process = new FakeManagedProcess(request.sessionId, request.launchSignature);
    processes.push(process);
    return process;
  });
  const streamed: string[] = [];
  const background: string[] = [];

  const result = await bridge.runTurn({
    sessionId: null,
    projectRoot: '/work/open-p',
    message: 'continue',
    seedContext: 'seed',
    transcript: [{ role: 'assistant', content: 'old' }],
    model: 'haiku',
    reasoningEffort: 'medium',
    executionMode: 'danger-full-access',
    tools: 'Read',
    jsonSchema: '{"type":"object"}',
    bin: 'claude',
    binArgs: ['--allowedTools', 'Bash'],
    env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9999' },
    local: true,
    contextWindowsByModel: { haiku: 200_000 },
    onIntermediateText: (text) => streamed.push(text),
    onBackgroundAssistantText: (text) => background.push(text),
  });

  assert.equal(starts.length, 1);
  assert.equal(starts[0]?.resume, false);
  assert.equal(starts[0]?.timeoutMs, 0);
  assert.equal(starts[0]?.launchSignature.jsonSchema, '{"type":"object"}');
  assert.equal(starts[0]?.launchSignature.tools, 'Read');
  assert.equal(result.sessionId, starts[0]?.sessionId);
  assert.equal(result.content, 'final');
  assert.equal(result.diagnostics.stopReason, 'end_turn');
  assert.equal(result.diagnostics.contextWindow, 200_000);
  assert.equal(result.diagnostics.intermediateTextCount, 1);
  assert.deepEqual(streamed, ['final']);
  assert.deepEqual(background, []);
  assert.equal(processes[0]?.prompts[0], 'continue');
  assert.equal(processes[0]?.turnTimeouts[0], 0);
  assert.equal(starts[0]?.launchSignature.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:9999');
  assert.equal(starts[0]?.launchSignature.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, '1');
});

test('worker bridge keeps result when JSONL streaming differs from result', async () => {
  const processes: FakeManagedProcess[] = [];
  const bridge = new ClaudeCodeWorkerBridge(UNUSED_PROVIDER, undefined, async (request) => {
    const process = new FakeManagedProcess(request.sessionId, request.launchSignature);
    process.intermediateText = 'draft progress';
    process.resultText = 'authoritative final';
    processes.push(process);
    return process;
  });
  const streamed: string[] = [];

  const result = await bridge.runTurn({
    sessionId: null,
    projectRoot: '/work/open-p',
    message: 'continue',
    onIntermediateText: (text) => streamed.push(text),
  });

  assert.deepEqual(streamed, ['draft progress']);
  assert.equal(result.content, 'authoritative final');
  assert.equal(result.diagnostics.intermediateTextCount, 1);
});

test('worker bridge rejects first turn when Claude session log omits backend session id', async () => {
  const bridge = new ClaudeCodeWorkerBridge(UNUSED_PROVIDER, undefined, async (request) =>
    new FakeManagedProcess(request.sessionId, request.launchSignature, null)
  );

  await assert.rejects(
    () => bridge.runTurn({
      sessionId: null,
      projectRoot: '/work/open-p',
      message: 'hello',
    }),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.protocolViolation,
  );
});

test('worker bridge ignores caller session id when request is explicitly a first turn', async () => {
  const starts: ClaudeCodeWorkerBridgeStartRequest[] = [];
  const processes: FakeManagedProcess[] = [];
  const bridge = new ClaudeCodeWorkerBridge(UNUSED_PROVIDER, undefined, async (request) => {
    starts.push(request);
    const process = new FakeManagedProcess(request.sessionId, request.launchSignature);
    processes.push(process);
    return process;
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
  assert.equal(starts[0]?.sessionId, 'caller-selected-id');
  assert.equal(starts[0]?.resume, true);
  assert.equal(starts[1]?.resume, false);
  assert.notEqual(starts[1]?.sessionId, 'caller-selected-id');
  assert.deepEqual(processes[0]?.prompts, ['resume prompt']);
  assert.deepEqual(processes[1]?.prompts, ['first prompt']);
  assert.equal(first.sessionId, starts[1]?.sessionId);
});

test('worker bridge uses claude command lookup when no request bin is supplied', async () => {
  const starts: ClaudeCodeWorkerBridgeStartRequest[] = [];
  const bridge = new ClaudeCodeWorkerBridge(UNUSED_PROVIDER, undefined, async (request) => {
    starts.push(request);
    return new FakeManagedProcess(request.sessionId, request.launchSignature);
  });

  await bridge.runTurn({
    sessionId: null,
    projectRoot: '/work/open-p',
    message: 'hello',
  });

  assert.equal(starts[0]?.launchSignature.bin, 'claude');
});

test('worker bridge request bin takes precedence over default command lookup', async () => {
  const starts: ClaudeCodeWorkerBridgeStartRequest[] = [];
  const bridge = new ClaudeCodeWorkerBridge(UNUSED_PROVIDER, undefined, async (request) => {
    starts.push(request);
    return new FakeManagedProcess(request.sessionId, request.launchSignature);
  });

  await bridge.runTurn({
    sessionId: null,
    projectRoot: '/work/open-p',
    message: 'hello',
    bin: '/custom/claude',
  });

  assert.equal(starts[0]?.launchSignature.bin, '/custom/claude');
});

test('worker bridge reuses same live process and sends resume turn as raw message', async () => {
  const starts: ClaudeCodeWorkerBridgeStartRequest[] = [];
  const processes: FakeManagedProcess[] = [];
  const bridge = new ClaudeCodeWorkerBridge(UNUSED_PROVIDER, undefined, async (request) => {
    starts.push(request);
    const process = new FakeManagedProcess(request.sessionId, request.launchSignature);
    processes.push(process);
    return process;
  });

  const first = await bridge.runTurn({
    sessionId: null,
    projectRoot: '/work/open-p',
    message: 'first',
  });
  await bridge.runTurn({
    sessionId: first.sessionId,
    projectRoot: '/work/open-p',
    message: 'second',
    seedContext: 'must not repeat',
  });

  assert.equal(starts.length, 1);
  assert.equal(processes[0]?.prompts.length, 2);
  assert.equal(processes[0]?.prompts[1], 'second');
});

test('worker bridge rejects resume when Claude session log returns a different session id', async () => {
  const bridge = new ClaudeCodeWorkerBridge(UNUSED_PROVIDER, undefined, async (request) =>
    new FakeManagedProcess(
      request.sessionId,
      request.launchSignature,
      '22222222-2222-4222-8222-222222222222',
    )
  );

  await assert.rejects(
    () => bridge.runTurn({
      sessionId: '11111111-1111-4111-8111-111111111111',
      projectRoot: '/work/open-p',
      message: 'resume',
    }),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.protocolViolation,
  );
});

test('worker bridge restarts with resume when launch signature changes', async () => {
  const starts: ClaudeCodeWorkerBridgeStartRequest[] = [];
  const processes: FakeManagedProcess[] = [];
  const bridge = new ClaudeCodeWorkerBridge(UNUSED_PROVIDER, undefined, async (request) => {
    starts.push(request);
    const process = new FakeManagedProcess(request.sessionId, request.launchSignature);
    processes.push(process);
    return process;
  });

  const first = await bridge.runTurn({
    sessionId: null,
    projectRoot: '/work/open-p',
    message: 'first',
    model: 'haiku',
  });
  await bridge.runTurn({
    sessionId: first.sessionId,
    projectRoot: '/work/open-p',
    message: 'second',
    model: 'sonnet',
  });

  assert.equal(starts.length, 2);
  assert.equal(starts[1]?.resume, true);
  assert.equal(processes[0]?.shutdownCount, 1);
  assert.equal(starts[1]?.launchSignature.model, 'sonnet');
});

test('worker bridge discards a process after turn failure before allowing another turn', async () => {
  const sessionId = '11111111-1111-4111-8111-111111111111';
  const starts: ClaudeCodeWorkerBridgeStartRequest[] = [];
  const processes: FakeManagedProcess[] = [];
  const bridge = new ClaudeCodeWorkerBridge(UNUSED_PROVIDER, undefined, async (request) => {
    starts.push(request);
    const process = new FakeManagedProcess(request.sessionId, request.launchSignature);
    processes.push(process);
    if (starts.length === 1) {
      process.failNextTurn = true;
    }
    return process;
  });

  await assert.rejects(() => bridge.runTurn({
    sessionId,
    projectRoot: '/work/open-p',
    message: 'first',
  }), /turn failed/);
  await bridge.runTurn({
    sessionId,
    projectRoot: '/work/open-p',
    message: 'second',
  });

  assert.equal(starts.length, 2);
  assert.equal(starts[1]?.resume, true);
  assert.equal(processes[0]?.shutdownCount, 1);
  assert.equal(processes[1]?.prompts[0], 'second');
});

test('worker bridge rejects an already aborted turn before starting a process', async () => {
  let starts = 0;
  const bridge = new ClaudeCodeWorkerBridge(UNUSED_PROVIDER, undefined, async (request) => {
    starts += 1;
    return new FakeManagedProcess(request.sessionId, request.launchSignature);
  });
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () => bridge.runTurn({
      sessionId: null,
      projectRoot: '/work/open-p',
      message: 'should not start',
      signal: controller.signal,
    }),
    isAbortError,
  );
  assert.equal(starts, 0);
});
