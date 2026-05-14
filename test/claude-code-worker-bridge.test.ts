import assert from 'node:assert/strict';
import test from 'node:test';
import { ClaudeCodeWorkerBridge, type ClaudeCodeManagedProcess, type ClaudeCodeWorkerBridgeStartRequest } from '../src/backends/claude-code/worker-bridge.js';
import { isAbortError } from '../src/core/abort.js';
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
  readonly intermediateCallbacks: Array<((text: string, source: 'jsonl' | 'screen') => void) | undefined> = [];
  readonly backgroundCallbacks: Array<((text: string) => void) | undefined> = [];
  shutdownCount = 0;
  alive = true;
  failNextTurn = false;

  constructor(
    readonly sessionId: string,
    readonly launchSignature: LaunchSignature,
  ) {}

  async sendTurn(prompt: string, options: {
    readonly onIntermediateText?: (text: string, source: 'jsonl' | 'screen') => void;
    readonly onBackgroundAssistantText?: (text: string) => void;
  }): Promise<TurnResult> {
    this.prompts.push(prompt);
    this.intermediateCallbacks.push(options.onIntermediateText);
    this.backgroundCallbacks.push(options.onBackgroundAssistantText);
    if (this.failNextTurn) {
      throw new Error('turn failed');
    }
    options.onIntermediateText?.('progress', 'jsonl');
    options.onBackgroundAssistantText?.('background');
    return {
      turnId: `turn-${this.prompts.length}`,
      text: 'final',
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
    executionMode: 'bypassPermissions',
    appendSystemPrompt: 'extra system',
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
  assert.equal(starts[0]?.appendSystemPrompt, 'extra system');
  assert.equal(starts[0]?.launchSignature.jsonSchema, '{"type":"object"}');
  assert.equal(result.sessionId, starts[0]?.sessionId);
  assert.equal(result.content, 'final');
  assert.equal(result.diagnostics.stopReason, 'end_turn');
  assert.equal(result.diagnostics.contextWindow, 200_000);
  assert.equal(result.diagnostics.intermediateTextCount, 1);
  assert.deepEqual(streamed, ['progress']);
  assert.deepEqual(background, ['background']);
  assert.equal(processes[0]?.prompts[0], 'continue');
  assert.equal(starts[0]?.launchSignature.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:9999');
});

test('worker bridge uses Claude Code binary override when no request bin is supplied', async () => {
  const original = process.env.OPENP_CLAUDE_CODE_BIN;
  process.env.OPENP_CLAUDE_CODE_BIN = '/opt/open-p/real-claude';
  try {
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

    assert.equal(starts[0]?.launchSignature.bin, '/opt/open-p/real-claude');
  } finally {
    if (original === undefined) {
      delete process.env.OPENP_CLAUDE_CODE_BIN;
    } else {
      process.env.OPENP_CLAUDE_CODE_BIN = original;
    }
  }
});

test('worker bridge request bin takes precedence over Claude Code binary override', async () => {
  const original = process.env.OPENP_CLAUDE_CODE_BIN;
  process.env.OPENP_CLAUDE_CODE_BIN = '/opt/open-p/real-claude';
  try {
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
  } finally {
    if (original === undefined) {
      delete process.env.OPENP_CLAUDE_CODE_BIN;
    } else {
      process.env.OPENP_CLAUDE_CODE_BIN = original;
    }
  }
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
