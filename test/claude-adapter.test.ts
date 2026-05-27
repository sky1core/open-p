import assert from 'node:assert/strict';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ClaudeCodeBackend, exitPtyAfterTurn } from '../src/backends/claude/adapter.js';
import { isAbortError } from '../src/core/abort.js';
import { EXIT_CODES, OpenPError } from '../src/core/errors.js';
import type { PtyProvider, PtySession, PtyStartOptions } from '../src/runners/types.js';

test('single-turn backend propagates PTY exit failure after successful turn', async () => {
  await assert.rejects(
    () => exitPtyAfterTurn({
      exit: async () => {
        throw new Error('exit failed');
      },
      terminate: async () => undefined,
    }, null),
    /exit failed/,
  );
});

test('single-turn backend does not mask the primary turn failure with PTY exit failure', async () => {
  await assert.doesNotReject(() => exitPtyAfterTurn({
    exit: async () => {
      throw new Error('exit failed');
    },
    terminate: async () => undefined,
  }, new Error('primary failed')));
});

test('single-turn backend force terminates PTY cleanup after primary turn failure', async () => {
  let alive = true;
  const terminateSignals: NodeJS.Signals[] = [];

  await assert.doesNotReject(() => exitPtyAfterTurn({
    exit: async () => {
      throw new Error('exit failed');
    },
    isAlive: async () => alive,
    terminate: async (signal = 'SIGTERM') => {
      terminateSignals.push(signal);
      alive = false;
    },
  }, new Error('primary failed')));

  assert.deepEqual(terminateSignals, ['SIGTERM']);
});

test('single-turn backend escalates PTY cleanup from SIGTERM to SIGKILL', async () => {
  let alive = true;
  const terminateSignals: NodeJS.Signals[] = [];

  await assert.doesNotReject(() => exitPtyAfterTurn({
    exit: async () => {
      throw new Error('exit failed');
    },
    isAlive: async () => alive,
    terminate: async (signal = 'SIGTERM') => {
      terminateSignals.push(signal);
      if (signal === 'SIGKILL') {
        alive = false;
      }
    },
  }, new Error('primary failed'), 10));

  assert.deepEqual(terminateSignals, ['SIGTERM', 'SIGKILL']);
});

test('single-turn backend does not mask the primary turn failure when force cleanup fails', async () => {
  await assert.doesNotReject(() => exitPtyAfterTurn({
    exit: async () => {
      throw new Error('exit failed');
    },
    isAlive: async () => true,
    terminate: async () => {
      throw new Error('terminate failed');
    },
  }, new Error('primary failed'), 10));
});

test('single-turn backend keeps forceSignal wired during aborted PTY cleanup', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openp-claude-adapter-'));
  const fakeClaude = join(dir, 'claude');
  const stateRoot = join(dir, 'state');
  await writeFile(fakeClaude, '#!/bin/sh\n[ "$1" = "--version" ] && { echo "claude 0.0.0"; exit 0; }\nexit 0\n');
  await chmod(fakeClaude, 0o755);

  const previousPath = process.env.PATH;
  const previousStateRoot = process.env.XDG_STATE_HOME;
  const abort = new AbortController();
  const force = new AbortController();
  const session = new AbortDuringSubmitSession(() => abort.abort(), () => force.abort());
  const backend = new ClaudeCodeBackend(new SingleSessionProvider(session));

  process.env.PATH = `${dir}:${previousPath ?? ''}`;
  process.env.XDG_STATE_HOME = stateRoot;
  try {
    await assert.rejects(
      backend.runTurn(
        {
          turnId: '22222222-2222-4222-8222-222222222222',
          prompt: 'hello',
          jsonSchema: null,
        },
        {
          cwd: dir,
          backendSessionId: '11111111-1111-4111-8111-111111111111',
          resume: false,
          timeoutMs: 0,
          model: null,
          reasoningEffort: null,
          permissionMode: null,
          jsonSchema: null,
          backendArgs: [],
          debugLog: null,
          signal: abort.signal,
          forceSignal: force.signal,
        },
      ),
      isAbortError,
    );
  } finally {
    restoreEnv('PATH', previousPath);
    restoreEnv('XDG_STATE_HOME', previousStateRoot);
  }

  assert.equal(session.interruptCount, 1);
  assert.deepEqual(session.terminateSignals, ['SIGTERM']);
});

test('single-turn backend rejects open-p claude command before starting PTY', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openp-claude-adapter-'));
  const fakeOpenP = join(dir, 'claude');
  await writeFile(fakeOpenP, '#!/bin/sh\necho "openp 0.1.0"\n');
  await chmod(fakeOpenP, 0o755);

  const previousPath = process.env.PATH;
  const previousStateRoot = process.env.XDG_STATE_HOME;
  let providerStarted = false;
  const backend = new ClaudeCodeBackend({
    start: async () => {
      providerStarted = true;
      throw new Error('provider should not start');
    },
  });

  process.env.PATH = `.:${previousPath ?? ''}`;
  process.env.XDG_STATE_HOME = join(dir, 'state');
  try {
    await assert.rejects(
      backend.runTurn(
        {
          turnId: '22222222-2222-4222-8222-222222222223',
          prompt: 'hello',
          jsonSchema: null,
        },
        {
          cwd: dir,
          backendSessionId: '11111111-1111-4111-8111-111111111112',
          resume: false,
          timeoutMs: 0,
          model: null,
          reasoningEffort: null,
          permissionMode: null,
          jsonSchema: null,
          backendArgs: [],
          debugLog: null,
        },
      ),
      (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.backendStartFailed,
    );
  } finally {
    restoreEnv('PATH', previousPath);
    restoreEnv('XDG_STATE_HOME', previousStateRoot);
  }

  assert.equal(providerStarted, false);
});

class SingleSessionProvider implements PtyProvider {
  constructor(private readonly session: PtySession) {}

  async start(_command: string, _args: readonly string[], _options: PtyStartOptions): Promise<PtySession> {
    return this.session;
  }
}

class AbortDuringSubmitSession implements PtySession {
  readonly id = 'fake-pty';
  interruptCount = 0;
  readonly terminateSignals: NodeJS.Signals[] = [];
  private alive = true;

  constructor(
    private readonly abortTurn: () => void,
    private readonly forceDuringExit: () => void,
  ) {}

  async write(_input: string): Promise<void> {}

  async submit(): Promise<void> {
    this.abortTurn();
  }

  async interrupt(): Promise<void> {
    this.interruptCount += 1;
    this.alive = false;
  }

  async terminate(signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
    this.terminateSignals.push(signal);
    this.alive = false;
  }

  async exit(): Promise<void> {
    this.forceDuringExit();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  async isAlive(): Promise<boolean> {
    return this.alive;
  }

  async captureText(): Promise<string> {
    return '❯';
  }
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}
