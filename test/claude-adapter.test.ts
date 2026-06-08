import assert from 'node:assert/strict';
import { appendFile, chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ClaudeCodeBackend, exitPtyAfterTurn } from '../src/backends/claude/adapter.js';
import { resolveClaudeCodeProjectLogDir } from '../src/backends/claude/session-log.js';
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

test('single-turn backend skips force cleanup signal after graceful interrupt closes PTY', async () => {
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
  assert.deepEqual(session.terminateSignals, []);
});

test('single-turn backend launches Claude with background suppression (env + disallowed tools)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openp-claude-adapter-'));
  const fakeClaude = join(dir, 'claude');
  const stateRoot = join(dir, 'state');
  await writeFile(fakeClaude, '#!/bin/sh\n[ "$1" = "--version" ] && { echo "claude 0.0.0"; exit 0; }\nexit 0\n');
  await chmod(fakeClaude, 0o755);

  const previousPath = process.env.PATH;
  const previousStateRoot = process.env.XDG_STATE_HOME;
  const abort = new AbortController();
  const session = new AbortDuringSubmitSession(() => abort.abort(), () => undefined);
  let capturedArgs: readonly string[] = [];
  let capturedDisableBackgroundTasks: string | undefined;
  let capturedIsolateAnthropicEnv: boolean | undefined;
  const backend = new ClaudeCodeBackend({
    start: async (_command: string, args: readonly string[], options: PtyStartOptions): Promise<PtySession> => {
      capturedArgs = args;
      capturedDisableBackgroundTasks = options.env?.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS;
      capturedIsolateAnthropicEnv = options.isolateAnthropicEnv;
      return session;
    },
  });

  process.env.PATH = `${dir}:${previousPath ?? ''}`;
  process.env.XDG_STATE_HOME = stateRoot;
  try {
    await assert.rejects(
      backend.runTurn(
        {
          turnId: '33333333-3333-4333-8333-333333333333',
          prompt: 'hello',
          jsonSchema: null,
        },
        {
          cwd: dir,
          backendSessionId: '44444444-4444-4444-8444-444444444444',
          resume: false,
          timeoutMs: 0,
          model: null,
          reasoningEffort: null,
          permissionMode: null,
          jsonSchema: null,
          backendArgs: [],
          debugLog: null,
          signal: abort.signal,
        },
      ),
      isAbortError,
    );
  } finally {
    restoreEnv('PATH', previousPath);
    restoreEnv('XDG_STATE_HOME', previousStateRoot);
  }

  assert.equal(capturedDisableBackgroundTasks, '1');
  assert.equal(capturedIsolateAnthropicEnv, true);
  const disallowIndex = capturedArgs.indexOf('--disallowedTools');
  assert.notEqual(disallowIndex, -1);
  assert.equal(capturedArgs[disallowIndex + 1], 'Monitor,Workflow,AskUserQuestion');
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

test('single-turn backend retries prompt submission after pre-caller local command consumes the first submit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openp-claude-adapter-retry-'));
  const fakeClaude = join(dir, 'claude');
  const stateRoot = join(dir, 'state');
  const home = join(dir, 'home');
  await writeFile(fakeClaude, '#!/bin/sh\n[ "$1" = "--version" ] && { echo "claude 0.0.0"; exit 0; }\nexit 0\n');
  await chmod(fakeClaude, 0o755);

  const previousPath = process.env.PATH;
  const previousStateRoot = process.env.XDG_STATE_HOME;
  const previousHome = process.env.HOME;
  const sessionId = '11111111-1111-4111-8111-111111111111';

  process.env.PATH = `${dir}:${previousPath ?? ''}`;
  process.env.XDG_STATE_HOME = stateRoot;
  process.env.HOME = home;
  const logDir = resolveClaudeCodeProjectLogDir(dir);
  await mkdir(logDir, { recursive: true });
  const logPath = join(logDir, `${sessionId}.jsonl`);

  const session = new PreCallerLocalCommandThenTurnSession(logPath, dir, sessionId, 1_200);
  const backend = new ClaudeCodeBackend(new SingleSessionProvider(session));
  try {
    const result = await backend.runTurn(
      {
        turnId: '22222222-2222-4222-8222-222222222222',
        prompt: 'hello after compact',
        jsonSchema: null,
      },
      {
        cwd: dir,
        backendSessionId: sessionId,
        resume: false,
        timeoutMs: 5_000,
        model: null,
        reasoningEffort: null,
        permissionMode: null,
        jsonSchema: null,
        backendArgs: [],
        debugLog: null,
      },
    );

    assert.equal(result.text, 'single-turn retry result');
    assert.equal(result.sessionId, sessionId);
    assert.equal(session.submitCount, 2);
    assert.deepEqual(session.writes, ['hello after compact', 'hello after compact']);
  } finally {
    restoreEnv('PATH', previousPath);
    restoreEnv('XDG_STATE_HOME', previousStateRoot);
    restoreEnv('HOME', previousHome);
  }
});

test('single-turn retry submits an existing input draft instead of writing the prompt twice', async () => {
  await withSingleTurnBackend(
    'openp-claude-adapter-retry-draft-',
    (logPath, cwd, sessionId) => new PreCallerLocalCommandThenTurnSession(
      logPath,
      cwd,
      sessionId,
      0,
      '❯ hello after compact',
    ),
    async ({ backend, cwd, session, sessionId }) => {
      const result = await backend.runTurn(
        {
          turnId: '22222222-2222-4222-8222-222222222224',
          prompt: 'hello after compact',
          jsonSchema: null,
        },
        adapterRunOptions(cwd, sessionId, 5_000),
      );

      assert.equal(result.text, 'single-turn retry result');
      assert.equal(session.submitCount, 2);
      assert.deepEqual(session.writes, ['hello after compact']);
    },
  );
});

test('single-turn retry keeps the original turn timeout budget', async () => {
  await withSingleTurnBackend(
    'openp-claude-adapter-retry-timeout-',
    (logPath, cwd, sessionId) => new PreCallerLocalCommandThenTurnSession(logPath, cwd, sessionId, 2_000),
    async ({ backend, cwd, session, sessionId }) => {
      await assert.rejects(
        () => backend.runTurn(
          {
            turnId: '22222222-2222-4222-8222-222222222225',
            prompt: 'hello after compact',
            jsonSchema: null,
          },
          adapterRunOptions(cwd, sessionId, 1_500),
        ),
        (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.timeout,
      );
      assert.equal(session.submitCount >= 1, true);
      assert.equal(session.submitCount <= 2, true);
    },
  );
});

test('single-turn retry does not retry unrelated protocol violations', async () => {
  await withSingleTurnBackend(
    'openp-claude-adapter-no-generic-protocol-retry-',
    (logPath, cwd, sessionId) => new DuplicateCallerTurnSession(logPath, cwd, sessionId),
    async ({ backend, cwd, session, sessionId }) => {
      await assert.rejects(
        () => backend.runTurn(
          {
            turnId: '22222222-2222-4222-8222-222222222226',
            prompt: 'hello',
            jsonSchema: null,
          },
          adapterRunOptions(cwd, sessionId, 5_000),
        ),
        (error) => error instanceof OpenPError &&
          error.exitCode === EXIT_CODES.protocolViolation &&
          /multiple caller user/.test(error.message),
      );
      assert.equal(session.submitCount, 1);
    },
  );
});

class SingleSessionProvider implements PtyProvider {
  constructor(private readonly session: PtySession) {}

  async start(_command: string, _args: readonly string[], _options: PtyStartOptions): Promise<PtySession> {
    return this.session;
  }
}

class PreCallerLocalCommandThenTurnSession implements PtySession {
  readonly id = 'fake-pty';
  submitCount = 0;
  readonly writes: string[] = [];
  private alive = true;
  private lastWrite = '';

  constructor(
    private readonly logPath: string,
    private readonly cwd: string,
    private readonly sessionId: string,
    private readonly secondSubmitDelayMs = 0,
    private readonly draftLineAfterFirstSubmit: string | null = null,
  ) {}

  async write(input: string): Promise<void> {
    this.lastWrite = input;
    this.writes.push(input);
  }

  async submit(): Promise<void> {
    this.submitCount += 1;
    if (this.submitCount === 1) {
      await appendFile(this.logPath, [
        eventLine({
          type: 'system',
          subtype: 'compact_boundary',
          cwd: this.cwd,
          sessionId: this.sessionId,
          content: 'Conversation compacted',
        }),
        eventLine({
          type: 'user',
          cwd: this.cwd,
          sessionId: this.sessionId,
          promptId: 'compact-command',
          isMeta: true,
          message: { content: '<local-command-caveat>generated while running local commands</local-command-caveat>' },
        }),
        eventLine({
          type: 'user',
          cwd: this.cwd,
          sessionId: this.sessionId,
          promptId: 'compact-command',
          message: { content: '<command-name>/compact</command-name>\n<command-message>compact</command-message>' },
        }),
        eventLine({
          type: 'user',
          cwd: this.cwd,
          sessionId: this.sessionId,
          promptId: 'compact-command',
          message: { content: '<local-command-stdout>Compacted (ctrl+o to see full summary)</local-command-stdout>' },
        }),
      ].join('\n') + '\n');
      return;
    }
    const appendResult = (): Promise<void> => appendFile(this.logPath, [
      eventLine({
        type: 'user',
        cwd: this.cwd,
        sessionId: this.sessionId,
        uuid: 'active-user',
        message: { content: this.lastWrite },
      }),
      eventLine({
        type: 'assistant',
        cwd: this.cwd,
        sessionId: this.sessionId,
        parentUuid: 'active-user',
        message: {
          content: [{ type: 'text', text: 'single-turn retry result' }],
          stop_reason: 'end_turn',
        },
      }),
      eventLine({
        type: 'system',
        subtype: 'turn_duration',
        cwd: this.cwd,
        sessionId: this.sessionId,
        durationMs: 10,
      }),
    ].join('\n') + '\n');
    if (this.secondSubmitDelayMs > 0) {
      setTimeout(() => {
        void appendResult();
      }, this.secondSubmitDelayMs);
      return;
    }
    await appendResult();
  }

  async interrupt(): Promise<void> {}

  async terminate(signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
    void signal;
    this.alive = false;
  }

  async exit(): Promise<void> {
    this.alive = false;
  }

  async isAlive(): Promise<boolean> {
    return this.alive;
  }

  async captureText(): Promise<string> {
    return '❯';
  }

  async captureCursorLine(): Promise<string> {
    if (this.submitCount === 1 && this.draftLineAfterFirstSubmit) {
      return this.draftLineAfterFirstSubmit;
    }
    return '❯';
  }
}

class DuplicateCallerTurnSession implements PtySession {
  readonly id = 'fake-pty';
  submitCount = 0;
  private alive = true;
  private lastWrite = '';

  constructor(
    private readonly logPath: string,
    private readonly cwd: string,
    private readonly sessionId: string,
  ) {}

  async write(input: string): Promise<void> {
    this.lastWrite = input;
  }

  async submit(): Promise<void> {
    this.submitCount += 1;
    await appendFile(this.logPath, [
      eventLine({
        type: 'user',
        cwd: this.cwd,
        sessionId: this.sessionId,
        uuid: 'active-user-1',
        message: { content: this.lastWrite },
      }),
      eventLine({
        type: 'user',
        cwd: this.cwd,
        sessionId: this.sessionId,
        uuid: 'active-user-2',
        message: { content: 'unexpected second caller' },
      }),
      eventLine({
        type: 'assistant',
        cwd: this.cwd,
        sessionId: this.sessionId,
        parentUuid: 'active-user-2',
        message: {
          content: [{ type: 'text', text: 'should not retry' }],
          stop_reason: 'end_turn',
        },
      }),
      eventLine({
        type: 'system',
        subtype: 'turn_duration',
        cwd: this.cwd,
        sessionId: this.sessionId,
        durationMs: 10,
      }),
    ].join('\n') + '\n');
  }

  async interrupt(): Promise<void> {}

  async terminate(signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
    void signal;
    this.alive = false;
  }

  async exit(): Promise<void> {
    this.alive = false;
  }

  async isAlive(): Promise<boolean> {
    return this.alive;
  }

  async captureText(): Promise<string> {
    return '❯';
  }

  async captureCursorLine(): Promise<string> {
    return '❯';
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

  async captureCursorLine(): Promise<string> {
    return '❯';
  }
}

async function withSingleTurnBackend<TSession extends PtySession>(
  tempPrefix: string,
  createSession: (logPath: string, cwd: string, sessionId: string) => TSession,
  run: (context: {
    readonly backend: ClaudeCodeBackend;
    readonly cwd: string;
    readonly session: TSession;
    readonly sessionId: string;
  }) => Promise<void>,
): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), tempPrefix));
  const fakeClaude = join(cwd, 'claude');
  const stateRoot = join(cwd, 'state');
  const home = join(cwd, 'home');
  await writeFile(fakeClaude, '#!/bin/sh\n[ "$1" = "--version" ] && { echo "claude 0.0.0"; exit 0; }\nexit 0\n');
  await chmod(fakeClaude, 0o755);

  const previousPath = process.env.PATH;
  const previousStateRoot = process.env.XDG_STATE_HOME;
  const previousHome = process.env.HOME;
  const sessionId = '11111111-1111-4111-8111-111111111111';

  process.env.PATH = `${cwd}:${previousPath ?? ''}`;
  process.env.XDG_STATE_HOME = stateRoot;
  process.env.HOME = home;
  const logDir = resolveClaudeCodeProjectLogDir(cwd);
  await mkdir(logDir, { recursive: true });
  const logPath = join(logDir, `${sessionId}.jsonl`);
  const session = createSession(logPath, cwd, sessionId);
  const backend = new ClaudeCodeBackend(new SingleSessionProvider(session));

  try {
    await run({ backend, cwd, session, sessionId });
  } finally {
    restoreEnv('PATH', previousPath);
    restoreEnv('XDG_STATE_HOME', previousStateRoot);
    restoreEnv('HOME', previousHome);
  }
}

function adapterRunOptions(cwd: string, sessionId: string, timeoutMs: number) {
  return {
    cwd,
    backendSessionId: sessionId,
    resume: false,
    timeoutMs,
    model: null,
    reasoningEffort: null,
    permissionMode: null,
    jsonSchema: null,
    backendArgs: [],
    debugLog: null,
  };
}

function eventLine(event: unknown): string {
  return JSON.stringify(event);
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}
