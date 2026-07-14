import assert from 'node:assert/strict';
import { appendFile, chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ClaudeCodeBackend, exitPtyAfterTurn } from '../src/backends/claude/adapter.js';
import { resolveClaudeCodeProjectLogDir } from '../src/backends/claude/session-log.js';
import { isAbortError } from '../src/core/abort.js';
import { EXIT_CODES, OpenPError } from '../src/core/errors.js';
import type { PtyProvider, PtySession, PtyStartOptions } from '../src/runners/types.js';

test('single-turn backend preserves successful turn when PTY exit cleanup fails', async () => {
  const warnings = await exitPtyAfterTurn({
    exit: async () => {
      throw new Error('exit failed');
    },
    isAlive: async () => false,
    terminate: async () => undefined,
  }, null);

  assert.deepEqual(warnings, [{
    severity: 'warning',
    code: 'pty_cleanup_failure',
    message: 'PTY cleanup failed after the result was confirmed; result was preserved. Backend process was already stopped when checked. Use --debug-log to record details.',
  }]);
});

test('single-turn backend force terminates PTY cleanup after successful turn exit failure', async () => {
  let alive = true;
  const terminateSignals: NodeJS.Signals[] = [];

  const warnings = await exitPtyAfterTurn({
      exit: async () => {
        throw new Error('exit failed');
      },
      isAlive: async () => alive,
      terminate: async (signal = 'SIGTERM') => {
        terminateSignals.push(signal);
        alive = false;
      },
    }, null);

  assert.equal(warnings[0]?.code, 'pty_cleanup_failure');
  assert.deepEqual(terminateSignals, ['SIGTERM']);
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

test('single-turn backend returns result, warning, and escalates when cleanup fails after success', async () => {
  await withSingleTurnBackend(
    'openp-claude-adapter-cleanup-warning-',
    (logPath, cwd, sessionId) => new SuccessfulTurnCleanupFailureSession(logPath, cwd, sessionId),
    async ({ backend, cwd, session, sessionId }) => {
      const debugLog = join(cwd, 'debug.jsonl');
      const result = await backend.runTurn(
        {
          turnId: '22222222-2222-4222-8222-222222222229',
          prompt: 'hello cleanup',
          jsonSchema: null,
        },
        {
          ...adapterRunOptions(cwd, sessionId, 5_000),
          debugLog,
        },
      );

      assert.equal(result.text, 'cleanup success result');
      assert.equal(result.sessionId, sessionId);
      assert.deepEqual(session.terminateSignals, ['SIGTERM']);
      assert.equal(result.warnings?.length, 1);
      assert.equal(result.warnings?.[0]?.code, 'pty_cleanup_failure');
      const debugEntries = (await readFile(debugLog, 'utf8'))
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line));
      const cleanupEntry = debugEntries.find((entry) => entry.event === 'pty_cleanup_failure');
      assert.equal(cleanupEntry?.severity, 'warning');
      assert.deepEqual(cleanupEntry?.exitError?.details, {
        kind: 'tmux_exit_failure',
        sessionName: 'fake-cleanup-session',
        exitTimeoutMs: 10,
        sessionAlive: true,
        paneDead: '0',
        panePid: 12345,
        paneCurrentCommand: 'claude',
        cursorY: '2',
      });
    },
  );
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
  let capturedIsolateEnvPrefixes: readonly string[] | undefined;
  const backend = new ClaudeCodeBackend({
    start: async (_command: string, args: readonly string[], options: PtyStartOptions): Promise<PtySession> => {
      capturedArgs = args;
      capturedDisableBackgroundTasks = options.env?.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS;
      capturedIsolateEnvPrefixes = options.isolateEnvPrefixes;
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
  assert.deepEqual(capturedIsolateEnvPrefixes, ['ANTHROPIC_']);
  const disallowIndex = capturedArgs.indexOf('--disallowedTools');
  assert.notEqual(disallowIndex, -1);
  assert.equal(capturedArgs[disallowIndex + 1], 'Monitor,Workflow,AskUserQuestion');
});

test('single-turn instance backend supplies configured Claude config dir at PTY launch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openp-claude-adapter-'));
  const fakeClaude = join(dir, 'claude');
  const stateRoot = join(dir, 'state');
  const instanceConfigDir = join(dir, 'claude-alt');
  await writeFile(fakeClaude, '#!/bin/sh\n[ "$1" = "--version" ] && { echo "claude 0.0.0"; exit 0; }\nexit 0\n');
  await chmod(fakeClaude, 0o755);

  const previousPath = process.env.PATH;
  const previousStateRoot = process.env.XDG_STATE_HOME;
  const abort = new AbortController();
  const session = new AbortDuringSubmitSession(() => abort.abort(), () => undefined);
  let capturedConfigDir: string | undefined;
  let capturedUnsetEnv: readonly string[] | undefined;
  const backend = new ClaudeCodeBackend({
    start: async (_command: string, _args: readonly string[], options: PtyStartOptions): Promise<PtySession> => {
      capturedConfigDir = options.env?.CLAUDE_CONFIG_DIR;
      capturedUnsetEnv = options.unsetEnv;
      return session;
    },
  }, {
    backendId: 'claude-alt',
    configDir: instanceConfigDir,
  });

  process.env.PATH = `${dir}:${previousPath ?? ''}`;
  process.env.XDG_STATE_HOME = stateRoot;
  try {
    await assert.rejects(
      backend.runTurn(
        {
          turnId: '33333333-3333-4333-8333-333333333334',
          prompt: 'hello',
          jsonSchema: null,
        },
        {
          cwd: dir,
          backendSessionId: '44444444-4444-4444-8444-444444444445',
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

  assert.equal(capturedConfigDir, instanceConfigDir);
  // The launch unsets the ambient config dir plus ANTHROPIC_BASE_URL (the latter is always unset before
  // the explicit endpoint value is re-injected), so both keys travel through the launch unsetEnv list.
  assert.deepEqual(capturedUnsetEnv, ['CLAUDE_CONFIG_DIR', 'ANTHROPIC_BASE_URL']);
});

test('base single-turn Claude backend unsets ambient Claude config dir at PTY launch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openp-claude-adapter-'));
  const fakeClaude = join(dir, 'claude');
  const stateRoot = join(dir, 'state');
  await writeFile(fakeClaude, '#!/bin/sh\n[ "$1" = "--version" ] && { echo "claude 0.0.0"; exit 0; }\nexit 0\n');
  await chmod(fakeClaude, 0o755);

  const previousPath = process.env.PATH;
  const previousStateRoot = process.env.XDG_STATE_HOME;
  const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const abort = new AbortController();
  const session = new AbortDuringSubmitSession(() => abort.abort(), () => undefined);
  let capturedConfigDir: string | undefined;
  let capturedUnsetEnv: readonly string[] | undefined;
  const backend = new ClaudeCodeBackend({
    start: async (_command: string, _args: readonly string[], options: PtyStartOptions): Promise<PtySession> => {
      capturedConfigDir = options.env?.CLAUDE_CONFIG_DIR;
      capturedUnsetEnv = options.unsetEnv;
      return session;
    },
  });

  process.env.PATH = `${dir}:${previousPath ?? ''}`;
  process.env.XDG_STATE_HOME = stateRoot;
  process.env.CLAUDE_CONFIG_DIR = join(dir, 'ambient-claude');
  try {
    await assert.rejects(
      backend.runTurn(
        {
          turnId: '33333333-3333-4333-8333-333333333335',
          prompt: 'hello',
          jsonSchema: null,
        },
        {
          cwd: dir,
          backendSessionId: '44444444-4444-4444-8444-444444444446',
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
    restoreEnv('CLAUDE_CONFIG_DIR', previousConfigDir);
  }

  assert.equal(capturedConfigDir, undefined);
  // The launch unsets the ambient config dir plus ANTHROPIC_BASE_URL (the latter is always unset before
  // the explicit endpoint value is re-injected), so both keys travel through the launch unsetEnv list.
  assert.deepEqual(capturedUnsetEnv, ['CLAUDE_CONFIG_DIR', 'ANTHROPIC_BASE_URL']);
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

test('single-turn backend returns local command output without retrying submission', async () => {
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
        prompt: '/compact',
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

    assert.equal(result.text, 'Compacted (ctrl+o to see full summary)');
    assert.equal(result.sessionId, sessionId);
    assert.equal(session.submitCount, 1);
    assert.deepEqual(session.writes, ['/compact']);
  } finally {
    restoreEnv('PATH', previousPath);
    restoreEnv('XDG_STATE_HOME', previousStateRoot);
    restoreEnv('HOME', previousHome);
  }
});

test('single-turn backend returns local command output when compact caveat omits isMeta', async () => {
  await withSingleTurnBackend(
    'openp-claude-adapter-local-command-no-meta-caveat-',
    (logPath, cwd, sessionId) => new PreCallerLocalCommandThenTurnSession(
      logPath,
      cwd,
      sessionId,
      0,
      null,
      false,
      true,
    ),
    async ({ backend, cwd, session, sessionId }) => {
      const result = await backend.runTurn(
        {
          turnId: '22222222-2222-4222-8222-222222222231',
          prompt: '/compact',
          jsonSchema: null,
        },
        adapterRunOptions(cwd, sessionId, 5_000),
      );

      assert.equal(result.text, 'Compacted (ctrl+o to see full summary)');
      assert.equal(result.sessionId, sessionId);
      assert.equal(session.submitCount, 1);
      assert.deepEqual(session.writes, ['/compact']);
    },
  );
});

test('single-turn backend returns local command output when slash prompt echo precedes transcript', async () => {
  await withSingleTurnBackend(
    'openp-claude-adapter-local-command-prompt-echo-',
    (logPath, cwd, sessionId) => new PreCallerLocalCommandThenTurnSession(
      logPath,
      cwd,
      sessionId,
      0,
      null,
      true,
      false,
      true,
      'system',
    ),
    async ({ backend, cwd, session, sessionId }) => {
      const result = await backend.runTurn(
        {
          turnId: '22222222-2222-4222-8222-222222222232',
          prompt: '/compact',
          jsonSchema: null,
        },
        adapterRunOptions(cwd, sessionId, 5_000),
      );

      assert.equal(result.text, 'Compacted (ctrl+o to see full summary)');
      assert.equal(result.sessionId, sessionId);
      assert.equal(session.submitCount, 1);
      assert.deepEqual(session.writes, ['/compact']);
    },
  );
});

test('single-turn recovery fails closed instead of retyping when no input draft is visible', async () => {
  await withSingleTurnBackend(
    'openp-claude-adapter-retry-no-draft-',
    (logPath, cwd, sessionId) => new PreCallerLocalCommandThenTurnSession(logPath, cwd, sessionId),
    async ({ backend, cwd, session, sessionId }) => {
      await assert.rejects(
        () => backend.runTurn(
          {
            turnId: '22222222-2222-4222-8222-222222222227',
            prompt: 'hello after compact',
            jsonSchema: null,
          },
          adapterRunOptions(cwd, sessionId, 30_000),
        ),
        (error) => error instanceof OpenPError &&
          error.exitCode === EXIT_CODES.protocolViolation &&
          error.reasonCode === 'prompt_not_executed',
      );
      assert.equal(session.submitCount, 1);
      assert.deepEqual(session.writes, ['hello after compact']);
    },
  );
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
      assert.equal(session.submitCount >= 1, true);
      assert.equal(session.submitCount <= 2, true);
      assert.deepEqual(session.writes, ['hello after compact']);
    },
  );
});

test('single-turn recovery resubmits stable wrapped draft when the initial submit is not accepted', async () => {
  await withSingleTurnBackend(
    'openp-claude-adapter-lost-submit-draft-',
    (logPath, cwd, sessionId) => new LostInitialSubmitStableDraftSession(
      logPath,
      cwd,
      sessionId,
      'continuation cursor row from wrapped prompt',
    ),
    async ({ backend, cwd, session, sessionId }) => {
      const result = await backend.runTurn(
        {
          turnId: '22222222-2222-4222-8222-222222222233',
          prompt: 'a long prompt that wraps to another row',
          jsonSchema: null,
        },
        adapterRunOptions(cwd, sessionId, 3_000),
      );

      assert.equal(result.text, 'single-turn recovered after lost initial submit');
      assert.equal(session.submitCount, 2);
      assert.deepEqual(session.writes, ['a long prompt that wraps to another row']);
    },
  );
});

test('single-turn recovery captures a draft that renders after the old fixed delay', async () => {
  await withSingleTurnBackend(
    'openp-claude-adapter-delayed-draft-render-',
    (logPath, cwd, sessionId) => new LostInitialSubmitStableDraftSession(
      logPath,
      cwd,
      sessionId,
      '❯ delayed draft',
      { draftRenderDelayMs: 250 },
    ),
    async ({ backend, cwd, session, sessionId }) => {
      const result = await backend.runTurn(
        {
          turnId: '22222222-2222-4222-8222-222222222240',
          prompt: 'delayed draft',
          jsonSchema: null,
        },
        adapterRunOptions(cwd, sessionId, 5_000),
      );

      assert.equal(result.text, 'single-turn recovered after lost initial submit');
      assert.equal(session.submitCount, 2);
      assert.deepEqual(session.writes, ['delayed draft']);
    },
  );
});

test('single-turn does not submit a rendered draft after the turn deadline', async () => {
  await withSingleTurnBackend(
    'openp-claude-adapter-draft-render-timeout-',
    (logPath, cwd, sessionId) => new LostInitialSubmitStableDraftSession(
      logPath,
      cwd,
      sessionId,
      '❯ Try "edit a file"',
      {
        unchangedLineAcrossWrite: '❯ Try "edit a file"',
        writeDelayMs: 1_500,
      },
    ),
    async ({ backend, cwd, session, sessionId }) => {
      await assert.rejects(
        () => backend.runTurn(
          {
            turnId: '22222222-2222-4222-8222-222222222241',
            prompt: 'prompt draft',
            jsonSchema: null,
          },
          adapterRunOptions(cwd, sessionId, 1_500),
        ),
        (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.timeout,
      );
      assert.equal(session.submitCount, 0);
      assert.deepEqual(session.writes, ['prompt draft']);
    },
  );
});

test('single-turn recovery does not treat an unchanged placeholder as a written draft', async () => {
  await withSingleTurnBackend(
    'openp-claude-adapter-lost-write-placeholder-',
    (logPath, cwd, sessionId) => new LostInitialSubmitStableDraftSession(
      logPath,
      cwd,
      sessionId,
      '❯ Try "edit a file"',
      { unchangedLineAcrossWrite: '❯ Try "edit a file"' },
    ),
    async ({ backend, cwd, session, sessionId }) => {
      await assert.rejects(
        () => backend.runTurn(
          {
            turnId: '22222222-2222-4222-8222-222222222239',
            prompt: 'prompt draft',
            jsonSchema: null,
          },
          adapterRunOptions(cwd, sessionId, 1_500),
        ),
        (error) => error instanceof OpenPError &&
          (error.exitCode === EXIT_CODES.timeout || error.exitCode === EXIT_CODES.sessionLogNotFound),
      );
      assert.equal(session.submitCount, 1);
      assert.deepEqual(session.writes, ['prompt draft']);
    },
  );
});

test('single-turn recovery does not resubmit when caller boundary appears during draft check', async () => {
  await withSingleTurnBackend(
    'openp-claude-adapter-lost-submit-late-caller-',
    (logPath, cwd, sessionId) => new LostInitialSubmitStableDraftSession(
      logPath,
      cwd,
      sessionId,
      '❯ prompt draft',
      {
        appendCallerDuringFirstPostSubmitCapture: true,
        appendCallerOnlyDuringFirstPostSubmitCapture: true,
      },
    ),
    async ({ backend, cwd, session, sessionId }) => {
      const result = await backend.runTurn(
        {
          turnId: '22222222-2222-4222-8222-222222222234',
          prompt: 'prompt draft',
          jsonSchema: null,
        },
        adapterRunOptions(cwd, sessionId, 1_500),
      );

      assert.equal(result.text, 'single-turn late caller after initial submit');
      assert.equal(session.submitCount, 1);
      assert.deepEqual(session.writes, ['prompt draft']);
    },
  );
});

test('single-turn recovery keeps session-log wait when the draft surface changes', async () => {
  await withSingleTurnBackend(
    'openp-claude-adapter-lost-submit-changed-',
    (logPath, cwd, sessionId) => new LostInitialSubmitStableDraftSession(
      logPath,
      cwd,
      sessionId,
      '❯ prompt draft',
      { currentLineAfterFirstSubmit: 'Generating response...' },
    ),
    async ({ backend, cwd, session, sessionId }) => {
      await assert.rejects(
        () => backend.runTurn(
          {
            turnId: '22222222-2222-4222-8222-222222222235',
            prompt: 'prompt draft',
            jsonSchema: null,
          },
          adapterRunOptions(cwd, sessionId, 1_500),
        ),
        (error) => error instanceof OpenPError &&
          (error.exitCode === EXIT_CODES.timeout || error.exitCode === EXIT_CODES.sessionLogNotFound),
      );
      assert.equal(session.submitCount, 1);
      assert.deepEqual(session.writes, ['prompt draft']);
    },
  );
});

test('single-turn recovery keeps session-log wait when the draft surface is ambiguous', async () => {
  await withSingleTurnBackend(
    'openp-claude-adapter-lost-submit-ambiguous-',
    (logPath, cwd, sessionId) => new LostInitialSubmitStableDraftSession(
      logPath,
      cwd,
      sessionId,
      '❯ prompt draft',
      { currentLineAfterFirstSubmit: '  ❯ 1. No, exit' },
    ),
    async ({ backend, cwd, session, sessionId }) => {
      await assert.rejects(
        () => backend.runTurn(
          {
            turnId: '22222222-2222-4222-8222-222222222236',
            prompt: 'prompt draft',
            jsonSchema: null,
          },
          adapterRunOptions(cwd, sessionId, 1_500),
        ),
        (error) => error instanceof OpenPError &&
          (error.exitCode === EXIT_CODES.timeout || error.exitCode === EXIT_CODES.sessionLogNotFound),
      );
      assert.equal(session.submitCount, 1);
      assert.deepEqual(session.writes, ['prompt draft']);
    },
  );
});

test('single-turn recovery keeps session-log wait when cursor line reading fails', async () => {
  await withSingleTurnBackend(
    'openp-claude-adapter-lost-submit-read-failure-',
    (logPath, cwd, sessionId) => new LostInitialSubmitStableDraftSession(
      logPath,
      cwd,
      sessionId,
      '❯ prompt draft',
      { throwOnFirstPostSubmitCapture: true },
    ),
    async ({ backend, cwd, session, sessionId }) => {
      await assert.rejects(
        () => backend.runTurn(
          {
            turnId: '22222222-2222-4222-8222-222222222237',
            prompt: 'prompt draft',
            jsonSchema: null,
          },
          adapterRunOptions(cwd, sessionId, 1_500),
        ),
        (error) => error instanceof OpenPError &&
          (error.exitCode === EXIT_CODES.timeout || error.exitCode === EXIT_CODES.sessionLogNotFound),
      );
      assert.equal(session.submitCount, 1);
      assert.deepEqual(session.writes, ['prompt draft']);
    },
  );
});

test('single-turn recovery returns resend-safe prompt_not_executed when second submit is not accepted', async () => {
  await withSingleTurnBackend(
    'openp-claude-adapter-lost-submit-second-failure-',
    (logPath, cwd, sessionId) => new LostInitialSubmitStableDraftSession(
      logPath,
      cwd,
      sessionId,
      '❯ prompt draft',
      { secondSubmitWritesResult: false },
    ),
    async ({ backend, cwd, session, sessionId }) => {
      await assert.rejects(
        () => backend.runTurn(
          {
            turnId: '22222222-2222-4222-8222-222222222238',
            prompt: 'prompt draft',
            jsonSchema: null,
          },
          adapterRunOptions(cwd, sessionId, 2_500),
        ),
        (error) => error instanceof OpenPError &&
          error.exitCode === EXIT_CODES.protocolViolation &&
          error.reasonCode === 'prompt_not_executed',
      );
      assert.equal(session.submitCount, 2);
      assert.deepEqual(session.writes, ['prompt draft']);
    },
  );
});

test('single-turn recovery enters wait without input readiness and picks up caller turn without submitting draft', async () => {
  await withSingleTurnBackend(
    'openp-claude-adapter-retry-late-caller-',
    (logPath, cwd, sessionId) => new PreCallerLocalCommandThenLateCallerSession(logPath, cwd, sessionId),
    async ({ backend, cwd, session, sessionId }) => {
      const result = await backend.runTurn(
        {
          turnId: '22222222-2222-4222-8222-222222222228',
          prompt: 'hello after compact',
          jsonSchema: null,
        },
        adapterRunOptions(cwd, sessionId, 5_000),
      );

      assert.equal(result.text, 'single-turn late caller result');
      assert.equal(session.submitCount, 1);
      assert.deepEqual(session.writes, ['hello after compact']);
    },
  );
});

test('single-turn retry keeps the original turn timeout budget', async () => {
  await withSingleTurnBackend(
    'openp-claude-adapter-retry-timeout-',
    (logPath, cwd, sessionId) => new PreCallerLocalCommandThenTurnSession(
      logPath,
      cwd,
      sessionId,
      4_500,
      '❯ hello after compact',
    ),
    async ({ backend, cwd, session, sessionId }) => {
      await assert.rejects(
        () => backend.runTurn(
          {
            turnId: '22222222-2222-4222-8222-222222222225',
            prompt: 'hello after compact',
            jsonSchema: null,
          },
          adapterRunOptions(cwd, sessionId, 5_000),
        ),
        (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.timeout,
      );
      assert.equal(session.submitCount, 2);
      assert.deepEqual(session.writes, ['hello after compact']);
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

test('single-turn backend returns result when scheduled local command transcript follows completion', async () => {
  await withSingleTurnBackend(
    'openp-claude-adapter-post-completion-command-',
    (logPath, cwd, sessionId) => new PostCompletionLocalCommandSession(logPath, cwd, sessionId),
    async ({ backend, cwd, session, sessionId }) => {
      const result = await backend.runTurn(
        {
          turnId: '22222222-2222-4222-8222-222222222230',
          prompt: 'hello',
          jsonSchema: null,
        },
        adapterRunOptions(cwd, sessionId, 5_000),
      );

      assert.equal(result.text, 'post-completion safe result');
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

class SuccessfulTurnCleanupFailureSession implements PtySession {
  readonly id = 'fake-cleanup-session';
  submitCount = 0;
  readonly terminateSignals: NodeJS.Signals[] = [];
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
        uuid: 'active-user',
        message: { content: this.lastWrite },
      }),
      eventLine({
        type: 'assistant',
        cwd: this.cwd,
        sessionId: this.sessionId,
        parentUuid: 'active-user',
        message: {
          content: [{ type: 'text', text: 'cleanup success result' }],
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
    this.terminateSignals.push(signal);
    this.alive = false;
  }

  async exit(): Promise<void> {
    throw new OpenPError(
      'tmux session fake-cleanup-session did not exit after graceful /exit',
      EXIT_CODES.backendExited,
      {
        details: {
          kind: 'tmux_exit_failure',
          sessionName: 'fake-cleanup-session',
          exitTimeoutMs: 10,
          sessionAlive: true,
          paneDead: '0',
          panePid: 12345,
          paneCurrentCommand: 'claude',
          cursorY: '2',
        },
      },
    );
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
    private readonly caveatIsMeta = true,
    private readonly includeCompactSummary = false,
    private readonly includePromptEcho = false,
    private readonly terminalOutputSource: 'user' | 'system' = 'user',
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
        ...(this.includePromptEcho ? [
          eventLine({
            type: 'user',
            cwd: this.cwd,
            sessionId: this.sessionId,
            promptId: 'compact-command',
            message: { content: this.lastWrite },
          }),
        ] : []),
        ...(this.includeCompactSummary ? [
          eventLine({
            type: 'user',
            cwd: this.cwd,
            sessionId: this.sessionId,
            promptId: 'compact-command',
            isCompactSummary: true,
            message: {
              content: 'This session is being continued from a previous conversation that ran out of context.',
            },
          }),
        ] : []),
        eventLine({
          type: 'user',
          cwd: this.cwd,
          sessionId: this.sessionId,
          promptId: 'compact-command',
          ...(this.caveatIsMeta ? { isMeta: true } : {}),
          message: { content: '<local-command-caveat>generated while running local commands</local-command-caveat>' },
        }),
        eventLine({
          type: 'user',
          cwd: this.cwd,
          sessionId: this.sessionId,
          promptId: 'compact-command',
          message: { content: '<command-name>/compact</command-name>\n<command-message>compact</command-message>' },
        }),
        eventLine(this.terminalOutputSource === 'system'
          ? {
              type: 'system',
              subtype: 'local_command',
              cwd: this.cwd,
              sessionId: this.sessionId,
              content: '<local-command-stdout>Compacted (ctrl+o to see full summary)</local-command-stdout>',
            }
          : {
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
    if (this.submitCount === 0 && this.lastWrite) {
      return `❯ ${this.lastWrite}`;
    }
    if (this.submitCount === 1 && this.draftLineAfterFirstSubmit) {
      return this.draftLineAfterFirstSubmit;
    }
    return '❯';
  }
}

class ImmortalAdapterPreCallerLocalCommandSession extends PreCallerLocalCommandThenTurnSession {
  override async exit(): Promise<void> {}
  override async terminate(): Promise<void> {}
  override async isAlive(): Promise<boolean> {
    return true;
  }
}

class LostInitialSubmitStableDraftSession implements PtySession {
  readonly id = 'lost-initial-submit-stable-draft-session';
  submitCount = 0;
  readonly writes: string[] = [];
  captureAfterFirstSubmitCount = 0;
  private alive = true;
  private lastWrite = '';
  private pendingCallerCompletion = false;
  private writeCompletedAtMs = 0;

  constructor(
    private readonly logPath: string,
    private readonly cwd: string,
    private readonly sessionId: string,
    private readonly draftLine: string,
    private readonly options: {
      readonly unchangedLineAcrossWrite?: string;
      readonly draftRenderDelayMs?: number;
      readonly writeDelayMs?: number;
      readonly currentLineAfterFirstSubmit?: string;
      readonly appendCallerDuringFirstPostSubmitCapture?: boolean;
      readonly appendCallerOnlyDuringFirstPostSubmitCapture?: boolean;
      readonly secondSubmitWritesResult?: boolean;
      readonly throwOnFirstPostSubmitCapture?: boolean;
    } = {},
  ) {}

  async write(input: string): Promise<void> {
    this.lastWrite = input;
    this.writes.push(input);
    if (this.options.writeDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, this.options.writeDelayMs));
    }
    this.writeCompletedAtMs = Date.now();
  }

  async submit(): Promise<void> {
    this.submitCount += 1;
    if (this.submitCount === 1) {
      return;
    }
    if (this.options.secondSubmitWritesResult === false) {
      return;
    }
    await appendFile(this.logPath, [
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
          content: [{ type: 'text', text: 'single-turn recovered after lost initial submit' }],
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
    if (this.pendingCallerCompletion) {
      this.pendingCallerCompletion = false;
      await appendFile(this.logPath, [
        eventLine({
          type: 'assistant',
          cwd: this.cwd,
          sessionId: this.sessionId,
          parentUuid: 'active-user',
          message: {
            content: [{ type: 'text', text: 'single-turn late caller after initial submit' }],
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
    return this.alive;
  }

  async captureText(): Promise<string> {
    return '❯';
  }

  async captureCursorLine(): Promise<string> {
    if (this.submitCount === 0) {
      if (this.options.unchangedLineAcrossWrite) {
        return this.options.unchangedLineAcrossWrite;
      }
      if (this.lastWrite && Date.now() - this.writeCompletedAtMs < (this.options.draftRenderDelayMs ?? 0)) {
        return '❯';
      }
      return this.lastWrite ? this.draftLine : '❯';
    }
    if (this.submitCount === 1) {
      this.captureAfterFirstSubmitCount += 1;
      if (this.options.throwOnFirstPostSubmitCapture) {
        throw new Error('cursor read failed');
      }
      if (this.options.appendCallerDuringFirstPostSubmitCapture && this.captureAfterFirstSubmitCount === 1) {
        const events = [
          eventLine({
            type: 'user',
            cwd: this.cwd,
            sessionId: this.sessionId,
            uuid: 'active-user',
            message: { content: this.lastWrite },
          }),
        ];
        if (this.options.appendCallerOnlyDuringFirstPostSubmitCapture) {
          this.pendingCallerCompletion = true;
        } else {
          events.push(
            eventLine({
              type: 'assistant',
              cwd: this.cwd,
              sessionId: this.sessionId,
              parentUuid: 'active-user',
              message: {
                content: [{ type: 'text', text: 'single-turn late caller after initial submit' }],
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
          );
        }
        await appendFile(this.logPath, events.join('\n') + '\n');
      }
      return this.options.currentLineAfterFirstSubmit ?? this.draftLine;
    }
    return this.draftLine;
  }
}

test('single-turn recovery downgrades resend safety when the backend survives shutdown escalation', async () => {
  await withSingleTurnBackend(
    'openp-claude-adapter-retry-immortal-',
    (logPath, cwd, sessionId) => new ImmortalAdapterPreCallerLocalCommandSession(logPath, cwd, sessionId),
    async ({ backend, cwd, session, sessionId }) => {
      await assert.rejects(
        () => backend.runTurn(
          {
            turnId: '22222222-2222-4222-8222-222222222228',
            prompt: 'hello after compact',
            jsonSchema: null,
          },
          adapterRunOptions(cwd, sessionId, 30_000),
        ),
        (error) => error instanceof OpenPError &&
          error.exitCode === EXIT_CODES.protocolViolation &&
          error.reasonCode === 'missing_turn_boundary' &&
          /not known to be safe/.test(error.message),
      );
      assert.deepEqual(session.writes, ['hello after compact']);
    },
  );
});

class PreCallerLocalCommandThenLateCallerSession implements PtySession {
  readonly id = 'fake-pty';
  submitCount = 0;
  readonly writes: string[] = [];
  private alive = true;
  private lastWrite = '';
  private lateCallerAppended = false;

  constructor(
    private readonly logPath: string,
    private readonly cwd: string,
    private readonly sessionId: string,
  ) {}

  async write(input: string): Promise<void> {
    this.lastWrite = input;
    this.writes.push(input);
  }

  async submit(): Promise<void> {
    this.submitCount += 1;
    if (this.submitCount !== 1) {
      throw new Error('recovery must not submit after the local-command prelude');
    }
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
    if (this.submitCount === 0) {
      return '❯';
    }
    return 'Claude Code v\nGenerating response...';
  }

  async captureCursorLine(): Promise<string> {
    if (this.submitCount === 0 && this.lastWrite) {
      return `❯ ${this.lastWrite}`;
    }
    if (this.submitCount === 0) {
      return '❯';
    }
    if (this.submitCount === 1 && !this.lateCallerAppended) {
      this.lateCallerAppended = true;
      await appendFile(this.logPath, [
        eventLine({
          type: 'user',
          cwd: this.cwd,
          sessionId: this.sessionId,
          uuid: 'active-user',
          message: { content: this.lastWrite },
        }),
        eventLine({
          type: 'user',
          cwd: this.cwd,
          sessionId: this.sessionId,
          promptId: 'compact-command',
          message: { content: '<local-command-stderr>late compact diagnostic</local-command-stderr>' },
        }),
        eventLine({
          type: 'assistant',
          cwd: this.cwd,
          sessionId: this.sessionId,
          parentUuid: 'active-user',
          message: {
            content: [{ type: 'text', text: 'single-turn late caller result' }],
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
    return 'Generating response...';
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

class PostCompletionLocalCommandSession implements PtySession {
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
        uuid: 'active-user',
        message: { content: this.lastWrite },
      }),
      eventLine({
        type: 'assistant',
        cwd: this.cwd,
        sessionId: this.sessionId,
        parentUuid: 'active-user',
        message: {
          content: [{ type: 'text', text: 'post-completion safe result' }],
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
      eventLine({
        type: 'system',
        subtype: 'local_command',
        cwd: this.cwd,
        sessionId: this.sessionId,
        content: '<command-name>/loop</command-name>',
      }),
      eventLine({
        type: 'system',
        subtype: 'local_command',
        cwd: this.cwd,
        sessionId: this.sessionId,
        content: '<local-command-stdout>system scheduled output</local-command-stdout>',
      }),
      eventLine({
        type: 'assistant',
        cwd: this.cwd,
        sessionId: this.sessionId,
        parentUuid: 'system-scheduled-loop-command',
        message: {
          content: [{ type: 'text', text: 'system scheduled task answer' }],
          stop_reason: 'end_turn',
        },
      }),
      eventLine({
        type: 'user',
        cwd: this.cwd,
        sessionId: this.sessionId,
        promptId: 'scheduled-loop-command',
        message: {
          content: '<command-name>/loop</command-name>\n<command-message>/loop</command-message>',
        },
      }),
      eventLine({
        type: 'user',
        cwd: this.cwd,
        sessionId: this.sessionId,
        promptId: 'scheduled-loop-command',
        message: {
          content: '<local-command-stdout>loop scheduled</local-command-stdout>',
        },
      }),
      eventLine({
        type: 'assistant',
        cwd: this.cwd,
        sessionId: this.sessionId,
        parentUuid: 'scheduled-loop-command',
        message: {
          content: [{ type: 'text', text: 'scheduled task answer' }],
          stop_reason: 'end_turn',
        },
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
