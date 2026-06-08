import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  resolveClaudeCodeProjectLogDir,
  resolveClaudeCodeSessionLogPath,
  readNewText,
  snapshotClaudeCodeSessionLogPaths,
  waitForClaudeCodeTurnResult,
} from '../src/backends/claude/session-log.js';
import { createClaudeSessionLogIdleDebugLogger } from '../src/backends/claude/diagnostics.js';
import { EXIT_CODES, OpenPError } from '../src/core/errors.js';
import { formatTurnResult } from '../src/core/output.js';

function line(event: unknown): string {
  return `${JSON.stringify(event)}\n`;
}

async function withClaudeProjectsRoot<T>(run: (root: string) => Promise<T>): Promise<T> {
  const original = process.env.HOME;
  const home = await mkdtemp(join(tmpdir(), 'openp-claude-home-'));
  const root = join(home, '.claude', 'projects');
  process.env.HOME = home;
  try {
    return await run(root);
  } finally {
    if (original === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = original;
    }
    await rm(root, { recursive: true, force: true });
  }
}

function withDefaultClaudeProjectsRoot<T>(run: () => T): T {
  return run();
}

test('resolves the direct Claude Code session log path for a cwd before the file exists', () => {
  withDefaultClaudeProjectsRoot(() => {
    assert.equal(
      resolveClaudeCodeSessionLogPath(
        '11111111-1111-4111-8111-111111111111',
        '/tmp/open-p',
      ),
      join(
        homedir(),
        '.claude',
        'projects',
        '-tmp-open-p',
        '11111111-1111-4111-8111-111111111111.jsonl',
      ),
    );
  });
});

test('resolves direct session log paths for opaque session ids', () => {
  withDefaultClaudeProjectsRoot(() => {
    assert.equal(
      resolveClaudeCodeSessionLogPath(
        'agent-session_01:opaque',
        '/tmp/open-p',
      ),
      join(
        homedir(),
        '.claude',
        'projects',
        '-tmp-open-p',
        'agent-session_01:opaque.jsonl',
      ),
    );
  });
});

test('rejects unsafe session ids before building a session log path', () => {
  assert.throws(
    () => resolveClaudeCodeSessionLogPath('../escape', '/tmp/open-p'),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionState,
  );
});

test('reports backend exit during active turn instead of waiting for timeout', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openp-session-log-'));
  const logPath = join(dir, 'session.jsonl');
  await writeFile(logPath, '');

  await assert.rejects(
    () => waitForClaudeCodeTurnResult({
      sessionId: '11111111-1111-4111-8111-111111111111',
      turnId: 'turn-1',
      timeoutMs: 10_000,
      initialOffset: 0,
      knownLogPath: logPath,
      isBackendAlive: async () => false,
    }),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.backendExited,
  );
});

test('readNewText does not advance past an incomplete UTF-8 tail byte sequence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openp-session-log-utf8-'));
  const logPath = join(dir, 'session.jsonl');
  const prefix = Buffer.from('{"text":"');
  const splitChar = Buffer.from('한');
  const suffix = Buffer.from('"}\n');

  await writeFile(logPath, Buffer.concat([prefix, splitChar.subarray(0, 1)]));

  const first = await readNewText(logPath, 0);
  assert.equal(first.text, prefix.toString('utf8'));
  assert.equal(first.nextOffset, prefix.length);
  assert.equal(first.text.includes('�'), false);

  await appendFile(logPath, Buffer.concat([splitChar.subarray(1), suffix]));

  const second = await readNewText(logPath, first.nextOffset);
  assert.equal(second.text, '한"}\n');
  assert.equal(second.nextOffset, prefix.length + splitChar.length + suffix.length);
  assert.equal(second.text.includes('�'), false);
});

test('fails closed on Claude Code API error assistant without publishing it as intermediate text', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openp-session-log-'));
  const logPath = join(dir, 'session.jsonl');
  const sessionId = randomUUID();
  const intermediateTexts: string[] = [];
  await writeFile(logPath, [
    line({
      type: 'user',
      sessionId,
      message: { role: 'user', content: 'generate image' },
    }),
    line({
      type: 'assistant',
      sessionId,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'starting generation' }],
        stop_reason: 'tool_use',
      },
    }),
    line({
      type: 'assistant',
      sessionId,
      error: 'authentication_failed',
      isApiErrorMessage: true,
      apiErrorStatus: 401,
      message: {
        model: '<synthetic>',
        role: 'assistant',
        stop_reason: 'stop_sequence',
        content: [{
          type: 'text',
          text: 'Please run /login · API Error: 401 The socket connection was closed unexpectedly.',
        }],
      },
    }),
    line({ type: 'system', subtype: 'turn_duration', sessionId, durationMs: 10 }),
  ].join(''));

  try {
    await assert.rejects(
      () => waitForClaudeCodeTurnResult({
        sessionId,
        turnId: 'turn-1',
        timeoutMs: 10_000,
        initialOffset: 0,
        knownLogPath: logPath,
        isBackendAlive: async () => true,
        onIntermediateText: (text) => {
          intermediateTexts.push(text);
        },
      }),
      (error) =>
        error instanceof OpenPError &&
        error.exitCode === EXIT_CODES.backendExited &&
        error.message.includes('Claude Code API error for turn turn-1') &&
        error.message.includes('status 401'),
    );
    assert.deepEqual(intermediateTexts, ['starting generation']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('notifies timeout before throwing an active turn timeout error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openp-session-log-'));
  const logPath = join(dir, 'session.jsonl');
  await writeFile(logPath, '');
  let timeoutCount = 0;

  await assert.rejects(
    () => waitForClaudeCodeTurnResult({
      sessionId: '11111111-1111-4111-8111-111111111111',
      turnId: 'turn-1',
      timeoutMs: 25,
      initialOffset: 0,
      knownLogPath: logPath,
      isBackendAlive: async () => true,
      onTimeout: () => {
        timeoutCount += 1;
      },
    }),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.timeout,
  );
  assert.equal(timeoutCount, 1);
});

test('reports missing expected session log as session log not found', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openp-session-log-'));
  const missingLogPath = join(dir, 'missing-session.jsonl');
  const sessionId = randomUUID();

  await assert.rejects(
    () => waitForClaudeCodeTurnResult({
      sessionId,
      turnId: 'turn-1',
      timeoutMs: 50,
      initialOffset: 0,
      knownLogPath: null,
      expectedLogPath: missingLogPath,
      cwd: dir,
      isBackendAlive: async () => true,
    }),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionLogNotFound,
  );
});

test('discovers backend-generated first-turn session log without reusing preexisting recent logs', async () => {
  await withClaudeProjectsRoot(async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'openp-session-log-cwd-'));
  const logDir = resolveClaudeCodeProjectLogDir(cwd);
  const oldSessionId = randomUUID();
  const newSessionId = randomUUID();
  const oldLogPath = join(logDir, `${oldSessionId}.jsonl`);
  const newLogPath = join(logDir, `${newSessionId}.jsonl`);
  await mkdir(logDir, { recursive: true });

  try {
    await writeFile(oldLogPath, [
      line({
        type: 'user',
        cwd,
        sessionId: oldSessionId,
        message: { content: 'old prompt' },
      }),
      line({
        type: 'assistant',
        cwd,
        sessionId: oldSessionId,
        message: {
          content: [{ type: 'text', text: 'old final' }],
          stop_reason: 'end_turn',
        },
      }),
      line({ type: 'system', subtype: 'turn_duration', cwd, sessionId: oldSessionId, durationMs: 1 }),
    ].join(''));
    const excludedLogPaths = await snapshotClaudeCodeSessionLogPaths(cwd);
    await appendFile(oldLogPath, line({
      type: 'system',
      subtype: 'turn_duration',
      cwd,
      sessionId: oldSessionId,
      durationMs: 2,
    }));

    const pendingResult = waitForClaudeCodeTurnResult({
      sessionId: null,
      turnId: 'turn-1',
      timeoutMs: 10_000,
      initialOffset: 0,
      knownLogPath: null,
      cwd,
      discoveryStartedAtMs: Date.now() - 1000,
      excludedLogPaths,
      isBackendAlive: async () => true,
    });
    await sleep(50);
    await writeFile(newLogPath, [
      line({
        type: 'user',
        cwd,
        sessionId: newSessionId,
        message: { content: 'new prompt' },
      }),
      line({
        type: 'assistant',
        cwd,
        sessionId: newSessionId,
        message: {
          content: [{ type: 'text', text: 'new final' }],
          stop_reason: 'end_turn',
        },
      }),
      line({ type: 'system', subtype: 'turn_duration', cwd, sessionId: newSessionId, durationMs: 3 }),
    ].join(''));

    const result = await pendingResult;

    assert.equal(result.sessionId, newSessionId);
    assert.equal(result.text, 'new final');
  } finally {
    await rm(logDir, { recursive: true, force: true });
  }
  });
});

test('first-turn session log discovery ignores compaction and local-command transcript user events', async () => {
  await withClaudeProjectsRoot(async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'openp-session-log-cwd-'));
  const logDir = resolveClaudeCodeProjectLogDir(cwd);
  const sessionId = randomUUID();
  const logPath = join(logDir, `${sessionId}.jsonl`);
  await mkdir(logDir, { recursive: true });

  try {
    const pendingResult = waitForClaudeCodeTurnResult({
      sessionId: null,
      turnId: 'turn-1',
      timeoutMs: 10_000,
      initialOffset: 0,
      knownLogPath: null,
      cwd,
      discoveryStartedAtMs: Date.now() - 1000,
      isBackendAlive: async () => true,
    });
    await sleep(50);
    await writeFile(logPath, [
      line({
        type: 'user',
        cwd,
        sessionId,
        message: { content: 'new prompt' },
      }),
      line({ type: 'system', subtype: 'compact_boundary', cwd, sessionId, content: 'Conversation compacted' }),
      line({
        type: 'user',
        cwd,
        sessionId,
        isCompactSummary: true,
        message: { content: 'This session is being continued from a previous conversation that ran out of context.' },
      }),
      line({
        type: 'user',
        cwd,
        sessionId,
        promptId: 'local-command-1',
        isMeta: true,
        message: { content: '<local-command-caveat>generated while running local commands</local-command-caveat>' },
      }),
      line({
        type: 'user',
        cwd,
        sessionId,
        promptId: 'local-command-1',
        message: { content: '<command-name>/compact</command-name>\n<command-message>compact</command-message>' },
      }),
      line({
        type: 'user',
        cwd,
        sessionId,
        promptId: 'local-command-1',
        message: { content: '<local-command-stdout>Compacted (ctrl+o to see full summary)</local-command-stdout>' },
      }),
      line({
        type: 'assistant',
        cwd,
        sessionId,
        message: {
          content: [{ type: 'text', text: 'new final' }],
          stop_reason: 'end_turn',
        },
      }),
      line({ type: 'system', subtype: 'turn_duration', cwd, sessionId, durationMs: 3 }),
    ].join(''));

    const result = await pendingResult;

    assert.equal(result.sessionId, sessionId);
    assert.equal(result.text, 'new final');
  } finally {
    await rm(logDir, { recursive: true, force: true });
  }
  });
});

test('first-turn session log discovery waits through pre-caller local-command transcript', async () => {
  await withClaudeProjectsRoot(async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'openp-session-log-cwd-'));
    const logDir = resolveClaudeCodeProjectLogDir(cwd);
    const sessionId = randomUUID();
    const logPath = join(logDir, `${sessionId}.jsonl`);
    await mkdir(logDir, { recursive: true });

    try {
      await writeFile(logPath, [
        line({
          type: 'user',
          cwd,
          sessionId,
          promptId: 'local-command-1',
          isMeta: true,
          message: { content: '<local-command-caveat>generated while running local commands</local-command-caveat>' },
        }),
        line({
          type: 'user',
          cwd,
          sessionId,
          promptId: 'local-command-1',
          message: { content: '<command-name>/compact</command-name>\n<command-message>compact</command-message>' },
        }),
        line({
          type: 'system',
          subtype: 'local_command',
          cwd,
          sessionId,
          content: '<local-command-stderr>Error: No messages to compact</local-command-stderr>',
        }),
      ].join(''));
      const pendingResult = waitForClaudeCodeTurnResult({
        sessionId: null,
        turnId: 'turn-1',
        timeoutMs: 10_000,
        initialOffset: 0,
        knownLogPath: null,
        cwd,
        discoveryStartedAtMs: Date.now() - 1000,
        isBackendAlive: async () => true,
      });
      const observedResult = pendingResult.then(
        (result) => ({ result, error: null }),
        (error: unknown) => ({ result: null, error }),
      );
      let settled = false;
      void observedResult.then(() => {
        settled = true;
      });
      await sleep(350);
      assert.equal(settled, false);
      await appendFile(logPath, [
        line({
          type: 'user',
          cwd,
          sessionId,
          message: { content: 'caller prompt after pre-caller local command' },
        }),
        line({
          type: 'assistant',
          cwd,
          sessionId,
          message: {
            content: [{ type: 'text', text: 'result after pre-caller local command' }],
            stop_reason: 'end_turn',
          },
        }),
        line({ type: 'system', subtype: 'turn_duration', cwd, sessionId, durationMs: 3 }),
      ].join(''));

      const observed = await observedResult;
      if (observed.error) {
        throw observed.error;
      }
      assert.equal(observed.result?.sessionId, sessionId);
      assert.equal(observed.result?.text, 'result after pre-caller local command');
    } finally {
      await rm(logDir, { recursive: true, force: true });
    }
  });
});

test('active turn waits through pre-caller compact transcript until caller prompt is logged', async () => {
  await withClaudeProjectsRoot(async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'openp-session-log-cwd-'));
    const logDir = resolveClaudeCodeProjectLogDir(cwd);
    const sessionId = randomUUID();
    const logPath = join(logDir, `${sessionId}.jsonl`);
    await mkdir(logDir, { recursive: true });

    try {
      const pendingResult = waitForClaudeCodeTurnResult({
        sessionId,
        turnId: 'turn-1',
        timeoutMs: 10_000,
        initialOffset: 0,
        knownLogPath: logPath,
        cwd,
        isBackendAlive: async () => true,
      });
      const observedResult = pendingResult.then(
        (result) => ({ result, error: null }),
        (error: unknown) => ({ result: null, error }),
      );
      await sleep(50);
      await writeFile(logPath, [
        line({
          type: 'system',
          subtype: 'compact_boundary',
          cwd,
          sessionId,
          content: 'Conversation compacted',
        }),
        line({
          type: 'user',
          cwd,
          sessionId,
          promptId: 'local-command-1',
          isMeta: true,
          message: { content: '<local-command-caveat>generated while running local commands</local-command-caveat>' },
        }),
        line({
          type: 'user',
          cwd,
          sessionId,
          promptId: 'local-command-1',
          message: { content: '<command-name>/compact</command-name>\n<command-message>compact</command-message>' },
        }),
        line({
          type: 'user',
          cwd,
          sessionId,
          promptId: 'local-command-1',
          message: { content: '<local-command-stdout>Compacted (ctrl+o to see full summary)</local-command-stdout>' },
        }),
      ].join(''));
      await sleep(50);
      await appendFile(logPath, [
        line({
          type: 'user',
          cwd,
          sessionId,
          message: { content: 'caller prompt after compact' },
        }),
        line({
          type: 'assistant',
          cwd,
          sessionId,
          message: {
            content: [{ type: 'text', text: 'result after compact' }],
            stop_reason: 'end_turn',
          },
        }),
        line({ type: 'system', subtype: 'turn_duration', cwd, sessionId, durationMs: 3 }),
      ].join(''));

      const observed = await observedResult;
      if (observed.error) {
        throw observed.error;
      }
      assert.equal(observed.result?.text, 'result after compact');
    } finally {
      await rm(logDir, { recursive: true, force: true });
    }
  });
});

test('active turn ignores synthetic no-response and pre-caller compact transcript until caller prompt', async () => {
  await withClaudeProjectsRoot(async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'openp-session-log-cwd-'));
    const logDir = resolveClaudeCodeProjectLogDir(cwd);
    const sessionId = randomUUID();
    const logPath = join(logDir, `${sessionId}.jsonl`);
    await mkdir(logDir, { recursive: true });

    try {
      const pendingResult = waitForClaudeCodeTurnResult({
        sessionId,
        turnId: 'turn-1',
        timeoutMs: 10_000,
        initialOffset: 0,
        knownLogPath: logPath,
        cwd,
        isBackendAlive: async () => true,
      });
      const observedResult = pendingResult.then(
        (result) => ({ result, error: null }),
        (error: unknown) => ({ result: null, error }),
      );
      await sleep(50);
      await writeFile(logPath, [
        line({
          type: 'assistant',
          cwd,
          sessionId,
          message: {
            model: '<synthetic>',
            role: 'assistant',
            stop_reason: 'stop_sequence',
            stop_sequence: '',
            content: [{ type: 'text', text: 'No response requested.' }],
          },
        }),
        line({
          type: 'user',
          cwd,
          sessionId,
          promptId: 'compact-command',
          isMeta: true,
          message: { content: '<local-command-caveat>generated while running local commands</local-command-caveat>' },
        }),
        line({
          type: 'user',
          cwd,
          sessionId,
          promptId: 'compact-command',
          message: { content: '<command-name>/compact</command-name>\n<command-message>compact</command-message>' },
        }),
        line({
          type: 'user',
          cwd,
          sessionId,
          promptId: 'compact-command',
          message: { content: '<local-command-stdout>Compacted (ctrl+o to see full summary)</local-command-stdout>' },
        }),
        line({
          type: 'user',
          cwd,
          sessionId,
          promptId: 'compact-command',
          isCompactSummary: true,
          message: { content: 'This session is being continued from a previous conversation.' },
        }),
      ].join(''));
      await sleep(50);
      await appendFile(logPath, [
        line({
          type: 'user',
          cwd,
          sessionId,
          message: { content: 'caller prompt after synthetic compact prelude' },
        }),
        line({
          type: 'assistant',
          cwd,
          sessionId,
          message: {
            content: [{ type: 'text', text: 'result after synthetic compact prelude' }],
            stop_reason: 'end_turn',
          },
        }),
        line({ type: 'system', subtype: 'turn_duration', cwd, sessionId, durationMs: 4 }),
      ].join(''));

      const observed = await observedResult;
      if (observed.error) {
        throw observed.error;
      }
      assert.equal(observed.result?.text, 'result after synthetic compact prelude');
    } finally {
      await rm(logDir, { recursive: true, force: true });
    }
  });
});

test('active turn fails instead of waiting forever when local command output is logged without caller turn', async () => {
  await withClaudeProjectsRoot(async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'openp-session-log-cwd-'));
    const logDir = resolveClaudeCodeProjectLogDir(cwd);
    const sessionId = randomUUID();
    const logPath = join(logDir, `${sessionId}.jsonl`);
    await mkdir(logDir, { recursive: true });

    try {
      await writeFile(logPath, [
        line({
          type: 'assistant',
          cwd,
          sessionId,
          message: {
            model: '<synthetic>',
            role: 'assistant',
            stop_reason: 'stop_sequence',
            stop_sequence: '',
            content: [{ type: 'text', text: 'No response requested.' }],
          },
        }),
        line({
          type: 'user',
          cwd,
          sessionId,
          promptId: 'compact-command',
          isMeta: true,
          message: { content: '<local-command-caveat>generated while running local commands</local-command-caveat>' },
        }),
        line({
          type: 'user',
          cwd,
          sessionId,
          promptId: 'compact-command',
          message: { content: '<command-name>/compact</command-name>\n<command-message>compact</command-message>' },
        }),
        line({
          type: 'user',
          cwd,
          sessionId,
          promptId: 'compact-command',
          message: { content: '<local-command-stdout>Compacted (ctrl+o to see full summary)</local-command-stdout>' },
        }),
      ].join(''));

      await assert.rejects(
        () => waitForClaudeCodeTurnResult({
          sessionId,
          turnId: 'turn-1',
          timeoutMs: 0,
          initialOffset: 0,
          knownLogPath: logPath,
          cwd,
          isBackendAlive: async () => true,
        }),
        (error) => error instanceof OpenPError &&
          error.exitCode === EXIT_CODES.protocolViolation &&
          /session log became idle after local command output before logging caller user turn/.test(error.message),
      );
    } finally {
      await rm(logDir, { recursive: true, force: true });
    }
  });
});

test('first-turn discovery fails instead of waiting forever when local command output is logged without caller turn', async () => {
  await withClaudeProjectsRoot(async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'openp-session-log-cwd-'));
    const logDir = resolveClaudeCodeProjectLogDir(cwd);
    const sessionId = randomUUID();
    const logPath = join(logDir, `${sessionId}.jsonl`);
    await mkdir(logDir, { recursive: true });

    try {
      await writeFile(logPath, [
        line({
          type: 'assistant',
          cwd,
          sessionId,
          message: {
            model: '<synthetic>',
            role: 'assistant',
            stop_reason: 'stop_sequence',
            stop_sequence: '',
            content: [{ type: 'text', text: 'No response requested.' }],
          },
        }),
        line({
          type: 'user',
          cwd,
          sessionId,
          promptId: 'compact-command',
          isMeta: true,
          message: { content: '<local-command-caveat>generated while running local commands</local-command-caveat>' },
        }),
        line({
          type: 'user',
          cwd,
          sessionId,
          promptId: 'compact-command',
          message: { content: '<command-name>/compact</command-name>\n<command-message>compact</command-message>' },
        }),
        line({
          type: 'user',
          cwd,
          sessionId,
          promptId: 'compact-command',
          message: { content: '<local-command-stdout>Compacted (ctrl+o to see full summary)</local-command-stdout>' },
        }),
      ].join(''));

      await assert.rejects(
        () => waitForClaudeCodeTurnResult({
          sessionId: null,
          turnId: 'turn-1',
          timeoutMs: 0,
          initialOffset: 0,
          knownLogPath: null,
          cwd,
          discoveryStartedAtMs: Date.now() - 1000,
          isBackendAlive: async () => true,
        }),
        (error) => error instanceof OpenPError &&
          error.exitCode === EXIT_CODES.protocolViolation &&
          /session log became idle after local command output before logging caller user turn/.test(error.message),
      );
    } finally {
      await rm(logDir, { recursive: true, force: true });
    }
  });
});

test('first-turn session log discovery treats local-command-looking prompt text as caller input', async () => {
  await withClaudeProjectsRoot(async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'openp-session-log-cwd-'));
  const logDir = resolveClaudeCodeProjectLogDir(cwd);
  const sessionId = randomUUID();
  const logPath = join(logDir, `${sessionId}.jsonl`);
  await mkdir(logDir, { recursive: true });

  try {
    const pendingResult = waitForClaudeCodeTurnResult({
      sessionId: null,
      turnId: 'turn-1',
      timeoutMs: 10_000,
      initialOffset: 0,
      knownLogPath: null,
      cwd,
      discoveryStartedAtMs: Date.now() - 1000,
      isBackendAlive: async () => true,
    });
    await sleep(50);
    await writeFile(logPath, [
      line({
        type: 'user',
        cwd,
        sessionId,
        message: { content: '<command-name>/compact</command-name>\n<command-message>compact</command-message>' },
      }),
      line({
        type: 'assistant',
        cwd,
        sessionId,
        message: {
          content: [{ type: 'text', text: 'literal prompt handled' }],
          stop_reason: 'end_turn',
        },
      }),
      line({ type: 'system', subtype: 'turn_duration', cwd, sessionId, durationMs: 3 }),
    ].join(''));

    const result = await pendingResult;

    assert.equal(result.sessionId, sessionId);
    assert.equal(result.text, 'literal prompt handled');
  } finally {
    await rm(logDir, { recursive: true, force: true });
  }
  });
});

test('first-turn session log discovery excludes preexisting empty jsonl logs', async () => {
  await withClaudeProjectsRoot(async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'openp-session-log-cwd-'));
  const logDir = resolveClaudeCodeProjectLogDir(cwd);
  const oldSessionId = randomUUID();
  const newSessionId = randomUUID();
  const oldLogPath = join(logDir, `${oldSessionId}.jsonl`);
  const newLogPath = join(logDir, `${newSessionId}.jsonl`);
  await mkdir(logDir, { recursive: true });

  try {
    await writeFile(oldLogPath, '');
    const excludedLogPaths = await snapshotClaudeCodeSessionLogPaths(cwd);
    assert.equal(excludedLogPaths.has(oldLogPath), true);

    const pendingResult = waitForClaudeCodeTurnResult({
      sessionId: null,
      turnId: 'turn-1',
      timeoutMs: 10_000,
      initialOffset: 0,
      knownLogPath: null,
      cwd,
      discoveryStartedAtMs: Date.now() - 1000,
      excludedLogPaths,
      isBackendAlive: async () => true,
    });
    await sleep(50);
    await writeFile(oldLogPath, [
      line({
        type: 'user',
        cwd,
        sessionId: oldSessionId,
        message: { content: 'same prompt' },
      }),
      line({
        type: 'assistant',
        cwd,
        sessionId: oldSessionId,
        message: {
          content: [{ type: 'text', text: 'old final' }],
          stop_reason: 'end_turn',
        },
      }),
      line({ type: 'system', subtype: 'turn_duration', cwd, sessionId: oldSessionId, durationMs: 1 }),
    ].join(''));
    await sleep(50);
    await writeFile(newLogPath, [
      line({
        type: 'user',
        cwd,
        sessionId: newSessionId,
        message: { content: 'same prompt' },
      }),
      line({
        type: 'assistant',
        cwd,
        sessionId: newSessionId,
        message: {
          content: [{ type: 'text', text: 'new final' }],
          stop_reason: 'end_turn',
        },
      }),
      line({ type: 'system', subtype: 'turn_duration', cwd, sessionId: newSessionId, durationMs: 2 }),
    ].join(''));

    const result = await pendingResult;

    assert.equal(result.sessionId, newSessionId);
    assert.equal(result.text, 'new final');
  } finally {
    await rm(logDir, { recursive: true, force: true });
  }
  });
});

test('first-turn session log discovery fails on multiple structural workspace candidates', async () => {
  await withClaudeProjectsRoot(async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'openp-session-log-cwd-'));
  const logDir = resolveClaudeCodeProjectLogDir(cwd);
  const targetSessionId = randomUUID();
  const otherSessionId = randomUUID();
  const targetLogPath = join(logDir, `${targetSessionId}.jsonl`);
  const otherLogPath = join(logDir, `${otherSessionId}.jsonl`);
  await mkdir(logDir, { recursive: true });

  try {
    await writeFile(targetLogPath, [
      line({
        type: 'user',
        cwd,
        sessionId: targetSessionId,
        message: { content: 'target prompt' },
      }),
      line({
        type: 'assistant',
        cwd,
        sessionId: targetSessionId,
        message: {
          content: [{ type: 'text', text: 'target final' }],
          stop_reason: 'end_turn',
        },
      }),
      line({ type: 'system', subtype: 'turn_duration', cwd, sessionId: targetSessionId, durationMs: 1 }),
    ].join(''));
    await sleep(20);
    await writeFile(otherLogPath, [
      line({
        type: 'user',
        cwd,
        sessionId: otherSessionId,
        message: { content: 'other prompt' },
      }),
      line({
        type: 'assistant',
        cwd,
        sessionId: otherSessionId,
        message: {
          content: [{ type: 'text', text: 'other final' }],
          stop_reason: 'end_turn',
        },
      }),
      line({ type: 'system', subtype: 'turn_duration', cwd, sessionId: otherSessionId, durationMs: 2 }),
    ].join(''));

    await assert.rejects(
      () => waitForClaudeCodeTurnResult({
        sessionId: null,
        turnId: 'turn-1',
        timeoutMs: 10_000,
        initialOffset: 0,
        knownLogPath: null,
        cwd,
        discoveryStartedAtMs: Date.now() - 1000,
        isBackendAlive: async () => true,
      }),
      (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.protocolViolation,
    );
  } finally {
    await rm(logDir, { recursive: true, force: true });
  }
  });
});

test('first-turn session log discovery requires caller user-turn cwd to match workspace', async () => {
  await withClaudeProjectsRoot(async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'openp-session-log-cwd-'));
  const otherCwd = await mkdtemp(join(tmpdir(), 'openp-session-log-other-cwd-'));
  const sessionId = randomUUID();
  const logDir = resolveClaudeCodeProjectLogDir(cwd);
  const logPath = join(logDir, `${sessionId}.jsonl`);
  await mkdir(logDir, { recursive: true });

  try {
    await writeFile(logPath, [
      line({
        type: 'user',
        cwd: otherCwd,
        sessionId,
        message: { content: 'other workspace prompt' },
      }),
      line({
        type: 'assistant',
        cwd,
        sessionId,
        message: {
          content: [{ type: 'text', text: 'wrong workspace final' }],
          stop_reason: 'end_turn',
        },
      }),
      line({ type: 'system', subtype: 'turn_duration', cwd, sessionId, durationMs: 1 }),
    ].join(''));

    await assert.rejects(
      () => waitForClaudeCodeTurnResult({
        sessionId: null,
        turnId: 'turn-1',
        timeoutMs: 100,
        initialOffset: 0,
        knownLogPath: null,
        cwd,
        discoveryStartedAtMs: Date.now() - 1000,
        isBackendAlive: async () => true,
      }),
      (error) => error instanceof OpenPError &&
        error.exitCode === EXIT_CODES.protocolViolation &&
        /caller user turn does not match the requested workspace/.test(error.message),
    );
  } finally {
    await rm(logDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
    await rm(otherCwd, { recursive: true, force: true });
  }
  });
});

test('first-turn session log discovery fails when multiple new logs match the same prompt', async () => {
  await withClaudeProjectsRoot(async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'openp-session-log-cwd-'));
  const logDir = resolveClaudeCodeProjectLogDir(cwd);
  const firstSessionId = randomUUID();
  const secondSessionId = randomUUID();
  await mkdir(logDir, { recursive: true });

  try {
    for (const sessionId of [firstSessionId, secondSessionId]) {
      await writeFile(join(logDir, `${sessionId}.jsonl`), [
        line({
          type: 'user',
          cwd,
          sessionId,
          message: { content: 'same prompt' },
        }),
        line({
          type: 'assistant',
          cwd,
          sessionId,
          message: {
            content: [{ type: 'text', text: `final ${sessionId}` }],
            stop_reason: 'end_turn',
          },
        }),
        line({ type: 'system', subtype: 'turn_duration', cwd, sessionId, durationMs: 1 }),
      ].join(''));
    }

    await assert.rejects(
      () => waitForClaudeCodeTurnResult({
        sessionId: null,
        turnId: 'turn-1',
        timeoutMs: 10_000,
        initialOffset: 0,
        knownLogPath: null,
        cwd,
        discoveryStartedAtMs: Date.now() - 1000,
        isBackendAlive: async () => true,
      }),
      (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.protocolViolation,
    );
  } finally {
    await rm(logDir, { recursive: true, force: true });
  }
  });
});

test('first-turn session log discovery rechecks ambiguity before returning a result', async () => {
  await withClaudeProjectsRoot(async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'openp-session-log-cwd-'));
  const logDir = resolveClaudeCodeProjectLogDir(cwd);
  const firstSessionId = randomUUID();
  const secondSessionId = randomUUID();
  const firstLogPath = join(logDir, `${firstSessionId}.jsonl`);
  const secondLogPath = join(logDir, `${secondSessionId}.jsonl`);
  const intermediate: string[] = [];
  await mkdir(logDir, { recursive: true });

  try {
    await writeFile(firstLogPath, [
      line({
        type: 'user',
        cwd,
        sessionId: firstSessionId,
        message: { content: 'same prompt' },
      }),
      line({
        type: 'assistant',
        cwd,
        sessionId: firstSessionId,
        message: {
          content: [{ type: 'text', text: 'working' }],
        },
      }),
    ].join(''));

    const pendingResult = waitForClaudeCodeTurnResult({
      sessionId: null,
      turnId: 'turn-1',
      timeoutMs: 10_000,
      initialOffset: 0,
      knownLogPath: null,
      cwd,
      discoveryStartedAtMs: Date.now() - 1000,
      isBackendAlive: async () => true,
      onIntermediateText: (text) => intermediate.push(text),
    });

    await waitUntil(() => intermediate.length > 0);
    await writeFile(secondLogPath, [
      line({
        type: 'user',
        cwd,
        sessionId: secondSessionId,
        message: { content: 'same prompt' },
      }),
      line({
        type: 'assistant',
        cwd,
        sessionId: secondSessionId,
        message: {
          content: [{ type: 'text', text: 'other final' }],
          stop_reason: 'end_turn',
        },
      }),
      line({ type: 'system', subtype: 'turn_duration', cwd, sessionId: secondSessionId, durationMs: 2 }),
    ].join(''));
    await appendFile(firstLogPath, line({
      type: 'assistant',
      cwd,
      sessionId: firstSessionId,
      message: {
        content: [{ type: 'text', text: 'first final' }],
        stop_reason: 'end_turn',
      },
    }));
    await appendFile(firstLogPath, line({
      type: 'system',
      subtype: 'turn_duration',
      cwd,
      sessionId: firstSessionId,
      durationMs: 3,
    }));

    await assert.rejects(
      () => pendingResult,
      (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.protocolViolation,
    );
  } finally {
    await rm(logDir, { recursive: true, force: true });
  }
  });
});

test('first-turn session log discovery ignores subagent logs', async () => {
  await withClaudeProjectsRoot(async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'openp-session-log-cwd-'));
  const sessionId = randomUUID();
  const topLevelLogDir = resolveClaudeCodeProjectLogDir(cwd);
  const subagentDir = join(topLevelLogDir, 'subagents');
  const subagentLogPath = join(subagentDir, `${randomUUID()}.jsonl`);
  const topLevelLogPath = join(topLevelLogDir, `${sessionId}.jsonl`);
  await mkdir(subagentDir, { recursive: true });

  try {
    await writeFile(subagentLogPath, [
      line({
        type: 'user',
        cwd,
        sessionId: randomUUID(),
        message: { content: 'subagent prompt' },
      }),
      line({
        type: 'assistant',
        cwd,
        sessionId: randomUUID(),
        message: {
          content: [{ type: 'text', text: 'subagent final' }],
          stop_reason: 'end_turn',
        },
      }),
      line({ type: 'system', subtype: 'turn_duration', cwd, sessionId: randomUUID(), durationMs: 1 }),
    ].join(''));
    await sleep(20);
    await writeFile(topLevelLogPath, [
      line({
        type: 'user',
        cwd,
        sessionId,
        message: { content: 'top-level prompt' },
      }),
      line({
        type: 'assistant',
        cwd,
        sessionId,
        message: {
          content: [{ type: 'text', text: 'top-level final' }],
          stop_reason: 'end_turn',
        },
      }),
      line({ type: 'system', subtype: 'turn_duration', cwd, sessionId, durationMs: 1 }),
    ].join(''));

    const result = await waitForClaudeCodeTurnResult({
      sessionId: null,
      turnId: 'turn-1',
      timeoutMs: 10_000,
      initialOffset: 0,
      knownLogPath: null,
      cwd,
      discoveryStartedAtMs: Date.now() - 1000,
      isBackendAlive: async () => true,
    });

    assert.equal(result.sessionId, sessionId);
    assert.equal(result.text, 'top-level final');
  } finally {
    await rm(topLevelLogDir, { recursive: true, force: true });
  }
  });
});

test('first-turn session log discovery searches realpath project log dir for symlink cwd', async () => {
  await withClaudeProjectsRoot(async () => {
  const realCwd = await realpath(await mkdtemp(join(tmpdir(), 'openp-session-log-real-cwd-')));
  const linkParent = await mkdtemp(join(tmpdir(), 'openp-session-log-link-parent-'));
  const linkCwd = join(linkParent, 'linked-cwd');
  await symlink(realCwd, linkCwd);
  const sessionId = randomUUID();
  const logDir = resolveClaudeCodeProjectLogDir(realCwd);
  const logPath = join(logDir, `${sessionId}.jsonl`);
  await mkdir(logDir, { recursive: true });

  try {
    await writeFile(logPath, [
      line({
        type: 'user',
        cwd: realCwd,
        sessionId,
        message: { content: 'realpath prompt' },
      }),
      line({
        type: 'assistant',
        cwd: realCwd,
        sessionId,
        message: {
          content: [{ type: 'text', text: 'realpath final' }],
          stop_reason: 'end_turn',
        },
      }),
      line({ type: 'system', subtype: 'turn_duration', cwd: realCwd, sessionId, durationMs: 1 }),
    ].join(''));

    const result = await waitForClaudeCodeTurnResult({
      sessionId: null,
      turnId: 'turn-1',
      timeoutMs: 10_000,
      initialOffset: 0,
      knownLogPath: null,
      cwd: linkCwd,
      discoveryStartedAtMs: Date.now() - 1000,
      isBackendAlive: async () => true,
    });

    assert.equal(result.sessionId, sessionId);
    assert.equal(result.text, 'realpath final');
  } finally {
    await rm(logDir, { recursive: true, force: true });
    await rm(linkParent, { recursive: true, force: true });
    await rm(realCwd, { recursive: true, force: true });
  }
  });
});

test('publishes active assistant intermediate text while waiting for turn result', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openp-session-log-'));
  const logPath = join(dir, 'session.jsonl');
  await writeFile(logPath, [
    line({
      type: 'user',
      message: {
        content: 'hello',
      },
    }),
    line({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'working' }],
      },
    }),
  ].join(''));
  const intermediate: string[] = [];

  const pendingResult = waitForClaudeCodeTurnResult({
    sessionId: '11111111-1111-4111-8111-111111111111',
    turnId: 'turn-1',
    timeoutMs: 10_000,
    initialOffset: 0,
    knownLogPath: logPath,
    isBackendAlive: async () => true,
    onIntermediateText: (text) => intermediate.push(text),
  });

  await waitUntil(() => intermediate.length === 1);
  await appendFile(logPath, line({
    type: 'assistant',
    message: {
      content: [{ type: 'text', text: 'final' }],
      stop_reason: 'end_turn',
    },
  }));
  await appendFile(logPath, line({ type: 'system', subtype: 'turn_duration', durationMs: 12 }));

  const result = await pendingResult;

  assert.equal(result.text, 'working\n\nfinal');
  assert.deepEqual(intermediate, ['working', 'working\n\nfinal']);
});

test('does not report session log idle while JSONL progress keeps arriving', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openp-session-log-progress-'));
  const logPath = join(dir, 'session.jsonl');
  await writeFile(logPath, line({
    type: 'user',
    message: {
      content: 'hello',
    },
  }));
  const intermediate: string[] = [];
  const idleDiagnostics: unknown[] = [];

  const pendingResult = waitForClaudeCodeTurnResult({
    sessionId: '11111111-1111-4111-8111-111111111111',
    turnId: 'turn-1',
    timeoutMs: 10_000,
    initialOffset: 0,
    knownLogPath: logPath,
    sessionLogIdleDiagnosticIntervalMs: 150,
    isBackendAlive: async () => true,
    onIntermediateText: (text) => intermediate.push(text),
    onSessionLogIdle: (diagnostic) => {
      idleDiagnostics.push(diagnostic);
    },
  });

  await sleep(50);
  await appendFile(logPath, line({
    type: 'assistant',
    message: {
      content: [{ type: 'text', text: 'working 1' }],
    },
  }));
  await waitUntil(() => intermediate.at(-1) === 'working 1');
  await sleep(50);
  await appendFile(logPath, line({
    type: 'assistant',
    message: {
      content: [{ type: 'text', text: 'working 2' }],
    },
  }));
  await waitUntil(() => intermediate.at(-1) === 'working 1\n\nworking 2');
  await sleep(50);
  await appendFile(logPath, [
    line({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'final' }],
        stop_reason: 'end_turn',
      },
    }),
    line({ type: 'system', subtype: 'turn_duration', durationMs: 12 }),
  ].join(''));

  const result = await pendingResult;

  assert.equal(result.text, 'working 1\n\nworking 2\n\nfinal');
  assert.deepEqual(idleDiagnostics, []);
});

test('reports session log idle as a diagnostic without failing a later result', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openp-session-log-idle-'));
  const logPath = join(dir, 'session.jsonl');
  await writeFile(logPath, line({
    type: 'user',
    message: {
      content: 'hello',
    },
  }));
  const idleDiagnostics: Array<{
    readonly turnId?: unknown;
    readonly stage?: unknown;
    readonly logPath?: unknown;
    readonly idleMs?: unknown;
    readonly sawCallerUserTurn?: unknown;
  }> = [];

  const pendingResult = waitForClaudeCodeTurnResult({
    sessionId: '11111111-1111-4111-8111-111111111111',
    turnId: 'turn-1',
    timeoutMs: 10_000,
    initialOffset: 0,
    knownLogPath: logPath,
    sessionLogIdleDiagnosticIntervalMs: 50,
    isBackendAlive: async () => true,
    onSessionLogIdle: (diagnostic) => {
      idleDiagnostics.push(diagnostic);
    },
  });

  await waitUntil(() => idleDiagnostics.length > 0);
  await appendFile(logPath, [
    line({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'final after wait' }],
        stop_reason: 'end_turn',
      },
    }),
    line({ type: 'system', subtype: 'turn_duration', durationMs: 12 }),
  ].join(''));

  const result = await pendingResult;
  const firstDiagnostic = idleDiagnostics[0]!;

  assert.equal(result.text, 'final after wait');
  assert.equal(firstDiagnostic.turnId, 'turn-1');
  assert.equal(firstDiagnostic.stage, 'waiting_for_completion');
  assert.equal(firstDiagnostic.logPath, logPath);
  assert.equal(firstDiagnostic.sawCallerUserTurn, true);
  assert.equal(typeof firstDiagnostic.idleMs, 'number');
  assert.equal((firstDiagnostic.idleMs as number) >= 50, true);
});

test('writes Claude session log idle diagnostics to debug log', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openp-session-log-debug-'));
  const debugLogPath = join(dir, 'debug.jsonl');
  const logger = createClaudeSessionLogIdleDebugLogger({
    debugLog: debugLogPath,
    backendSessionId: 'backend-session',
    nativeSessionId: 'native-session',
    ptySessionId: 'openp-backend-session-pty',
  });

  await logger({
    turnId: 'turn-1',
    stage: 'waiting_for_completion',
    logPath: join(dir, 'session.jsonl'),
    offset: 123,
    idleMs: 30_000,
    observedLogFile: true,
    sawCallerUserTurn: true,
  });

  const entries = (await readFile(debugLogPath, 'utf8'))
    .trim()
    .split('\n')
    .map((entry) => JSON.parse(entry) as Record<string, unknown>);
  const entry = entries[0]!;

  assert.equal(entry.event, 'claude_session_log_waiting');
  assert.equal(entry.severity, 'info');
  assert.equal(entry.backend, 'claude');
  assert.equal(entry.backendSessionId, 'backend-session');
  assert.equal(entry.nativeSessionId, 'native-session');
  assert.equal(entry.ptySessionId, 'openp-backend-session-pty');
  assert.equal(entry.turnId, 'turn-1');
  assert.equal(entry.stage, 'waiting_for_completion');
  assert.equal(entry.offset, 123);
  assert.equal(entry.idleMs, 30_000);
  assert.equal(entry.observedLogFile, true);
  assert.equal(entry.sawCallerUserTurn, true);
});

test('publishes same-message Claude session-log snapshots as replacements, not appended answers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openp-session-log-'));
  const logPath = join(dir, 'session.jsonl');
  await writeFile(logPath, line({
    type: 'user',
    message: {
      content: 'hello',
    },
  }));
  const intermediate: string[] = [];
  const snapshots: string[] = [];

  const pendingResult = waitForClaudeCodeTurnResult({
    sessionId: '11111111-1111-4111-8111-111111111111',
    turnId: 'turn-1',
    timeoutMs: 10_000,
    initialOffset: 0,
    knownLogPath: logPath,
    isBackendAlive: async () => true,
    onIntermediateText: (text) => intermediate.push(text),
    onIntermediateAssistantSnapshot: (snapshot) => {
      const content = snapshot.message.content;
      if (Array.isArray(content)) {
        const first = content[0];
        if (first && typeof first === 'object' && !Array.isArray(first)) {
          const text = (first as Record<string, unknown>).text;
          if (typeof text === 'string') {
            snapshots.push(text);
          }
        }
      }
    },
  });

  await appendFile(logPath, line({
    type: 'assistant',
    message: {
      id: 'msg_same',
      content: [{ type: 'text', text: 'A' }],
    },
  }));
  await waitUntil(() => intermediate.length === 1);
  await appendFile(logPath, line({
    type: 'assistant',
    message: {
      id: 'msg_same',
      content: [{ type: 'text', text: 'AB' }],
      stop_reason: 'end_turn',
    },
  }));
  await appendFile(logPath, line({ type: 'system', subtype: 'turn_duration', durationMs: 12 }));

  const result = await pendingResult;

  assert.equal(result.text, 'AB');
  assert.deepEqual(intermediate, ['A', 'AB']);
  assert.deepEqual(snapshots, ['A', 'AB']);
});

test('session log result preserves tool-use assistant text through public result output', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openp-session-log-'));
  const logPath = join(dir, 'session.jsonl');
  await writeFile(logPath, [
    line({
      type: 'user',
      message: {
        content: 'hello',
      },
    }),
    line({
      type: 'assistant',
      message: {
        id: 'msg-tool',
        content: [
          { type: 'text', text: 'checking file' },
          { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'README.md' } },
        ],
        stop_reason: 'tool_use',
      },
    }),
    line({
      type: 'assistant',
      message: {
        id: 'msg-final',
        content: [{ type: 'text', text: 'done' }],
        stop_reason: 'end_turn',
      },
    }),
    line({ type: 'system', subtype: 'turn_duration', durationMs: 12 }),
  ].join(''));

  const result = await waitForClaudeCodeTurnResult({
    sessionId: '11111111-1111-4111-8111-111111111111',
    turnId: 'turn-1',
    timeoutMs: 10_000,
    initialOffset: 0,
    knownLogPath: logPath,
    isBackendAlive: async () => true,
  });
  const textOutput = formatTurnResult(result, {
    outputFormat: 'text',
    backendSessionId: '11111111-1111-4111-8111-111111111111',
    backend: 'claude',
  });
  const streamJsonOutput = JSON.parse(formatTurnResult(result, {
    outputFormat: 'stream-json',
    backendSessionId: '11111111-1111-4111-8111-111111111111',
    backend: 'claude',
  })).openp.output;

  assert.equal(result.text, 'checking file\n\ndone');
  assert.equal(textOutput, 'checking file\n\ndone\n');
  assert.deepEqual(streamJsonOutput.answer, ['checking file', 'done']);
  assert.deepEqual(streamJsonOutput.toolCall, [{
    type: 'tool_use',
    id: 'toolu_1',
    name: 'Read',
    input: { file_path: 'README.md' },
  }]);
});

test('preserves newlines inside Claude Code JSONL text blocks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openp-session-log-'));
  const logPath = join(dir, 'session.jsonl');
  await writeFile(logPath, [
    line({
      type: 'user',
      message: {
        content: 'hello',
      },
    }),
    line({
      type: 'assistant',
      message: {
        id: 'msg-active',
        content: [{ type: 'text', text: 'line 1\nline 2' }],
      },
    }),
  ].join(''));
  const intermediate: string[] = [];

  const pendingResult = waitForClaudeCodeTurnResult({
    sessionId: '11111111-1111-4111-8111-111111111111',
    turnId: 'turn-1',
    timeoutMs: 10_000,
    initialOffset: 0,
    knownLogPath: logPath,
    isBackendAlive: async () => true,
    onIntermediateText: (text) => intermediate.push(text),
  });

  await waitUntil(() => intermediate.length === 1);
  await appendFile(logPath, line({
    type: 'assistant',
    message: {
      id: 'msg-active',
      content: [{ type: 'text', text: 'line 1\nline 2\nline 3' }],
      stop_reason: 'end_turn',
    },
  }));
  await appendFile(logPath, line({ type: 'system', subtype: 'turn_duration', durationMs: 12 }));

  const result = await pendingResult;

  assert.deepEqual(intermediate, ['line 1\nline 2', 'line 1\nline 2\nline 3']);
  assert.equal(result.text, 'line 1\nline 2\nline 3');
});

test('ignores Claude Code synthetic no-response assistant before the active user turn', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openp-session-log-'));
  const logPath = join(dir, 'session.jsonl');
  await writeFile(logPath, [
    line({
      type: 'assistant',
      message: {
        model: '<synthetic>',
        content: [{ type: 'text', text: 'No response requested.' }],
        stop_reason: 'stop_sequence',
        stop_sequence: '',
      },
    }),
    line({
      type: 'user',
      message: {
        content: 'hello',
      },
    }),
  ].join(''));
  const intermediate: string[] = [];

  const pendingResult = waitForClaudeCodeTurnResult({
    sessionId: '11111111-1111-4111-8111-111111111111',
    turnId: 'turn-1',
    timeoutMs: 10_000,
    initialOffset: 0,
    knownLogPath: logPath,
    isBackendAlive: async () => true,
    onIntermediateText: (text) => intermediate.push(text),
  });

  await appendFile(logPath, line({
    type: 'assistant',
    message: {
      content: [{ type: 'text', text: 'final' }],
      stop_reason: 'end_turn',
    },
  }));
  await appendFile(logPath, line({ type: 'system', subtype: 'turn_duration', durationMs: 12 }));

  const result = await pendingResult;

  assert.equal(result.text, 'final');
  assert.deepEqual(intermediate, ['final']);
});

test('publishes intermediate reasoning before text for combined assistant snapshots', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openp-session-log-'));
  const logPath = join(dir, 'session.jsonl');
  await writeFile(logPath, [
    line({
      type: 'user',
      message: {
        content: 'hello',
      },
    }),
    line({
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'thinking' },
          { type: 'text', text: 'working' },
        ],
      },
    }),
  ].join(''));
  const callbacks: string[] = [];

  const pendingResult = waitForClaudeCodeTurnResult({
    sessionId: '11111111-1111-4111-8111-111111111111',
    turnId: 'turn-1',
    timeoutMs: 10_000,
    initialOffset: 0,
    knownLogPath: logPath,
    isBackendAlive: async () => true,
    onIntermediateReasoning: (text) => callbacks.push(`reasoning:${text}`),
    onIntermediateText: (text) => callbacks.push(`text:${text}`),
  });

  await waitUntil(() => callbacks.length === 2);
  await appendFile(logPath, line({
    type: 'assistant',
    message: {
      content: [{ type: 'text', text: 'final' }],
      stop_reason: 'end_turn',
    },
  }));
  await appendFile(logPath, line({ type: 'system', subtype: 'turn_duration', durationMs: 12 }));

  const result = await pendingResult;

  assert.equal(result.text, 'working\n\nfinal');
  assert.deepEqual(callbacks, ['reasoning:thinking', 'text:working', 'text:working\n\nfinal']);
});

test('publishes reasoning log append before later text append during active polling', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openp-session-log-'));
  const logPath = join(dir, 'session.jsonl');
  await writeFile(logPath, line({
    type: 'user',
    message: {
      content: 'hello',
    },
  }));
  const callbacks: string[] = [];
  let textAppended = false;

  const pendingResult = waitForClaudeCodeTurnResult({
    sessionId: '11111111-1111-4111-8111-111111111111',
    turnId: 'turn-1',
    timeoutMs: 10_000,
    initialOffset: 0,
    knownLogPath: logPath,
    isBackendAlive: async () => true,
    onIntermediateReasoning: (text) => callbacks.push(`reasoning:${text}:textAppended=${textAppended}`),
    onIntermediateText: (text) => callbacks.push(`text:${text}`),
  });

  await appendFile(logPath, line({
    type: 'assistant',
    message: {
      content: [{ type: 'thinking', thinking: 'thinking' }],
    },
  }));
  await waitUntil(() => callbacks.some((entry) => entry.startsWith('reasoning:thinking')));
  textAppended = true;
  await appendFile(logPath, line({
    type: 'assistant',
    message: {
      content: [{ type: 'text', text: 'final' }],
      stop_reason: 'end_turn',
    },
  }));
  await appendFile(logPath, line({ type: 'system', subtype: 'turn_duration', durationMs: 12 }));

  const result = await pendingResult;

  assert.equal(result.text, 'final');
  assert.deepEqual(callbacks, ['reasoning:thinking:textAppended=false', 'text:final']);
});

test('publishes reasoning before text when log appends are closer than the polling fallback', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openp-session-log-'));
  const logPath = join(dir, 'session.jsonl');
  await writeFile(logPath, line({
    type: 'user',
    message: {
      content: 'hello',
    },
  }));
  const callbacks: string[] = [];

  const pendingResult = waitForClaudeCodeTurnResult({
    sessionId: '11111111-1111-4111-8111-111111111111',
    turnId: 'turn-1',
    timeoutMs: 10_000,
    initialOffset: 0,
    knownLogPath: logPath,
    isBackendAlive: async () => true,
    onIntermediateReasoning: (text) => callbacks.push(`reasoning:${text}`),
    onIntermediateText: (text) => callbacks.push(`text:${text}`),
  });

  await appendFile(logPath, line({
    type: 'assistant',
    message: {
      content: [{ type: 'thinking', thinking: 'thinking' }],
    },
  }));
  await appendFile(logPath, line({
    type: 'assistant',
    message: {
      content: [{ type: 'text', text: 'final' }],
      stop_reason: 'end_turn',
    },
  }));
  await appendFile(logPath, line({ type: 'system', subtype: 'turn_duration', durationMs: 12 }));

  const result = await pendingResult;

  assert.equal(result.text, 'final');
  assert.deepEqual(callbacks, ['reasoning:thinking', 'text:final']);
});

test('publishes result assistant content before returning when completion is already in the chunk', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openp-session-log-'));
  const logPath = join(dir, 'session.jsonl');
  await writeFile(logPath, [
    line({
      type: 'user',
      message: {
        content: 'hello',
      },
    }),
    line({
      type: 'assistant',
      message: {
        content: [{ type: 'thinking', thinking: 'thinking' }],
      },
    }),
    line({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'final' }],
        stop_reason: 'end_turn',
      },
    }),
    line({ type: 'system', subtype: 'turn_duration', durationMs: 12 }),
  ].join(''));
  const callbacks: string[] = [];

  const result = await waitForClaudeCodeTurnResult({
    sessionId: '11111111-1111-4111-8111-111111111111',
    turnId: 'turn-1',
    timeoutMs: 10_000,
    initialOffset: 0,
    knownLogPath: logPath,
    isBackendAlive: async () => true,
    onIntermediateReasoning: (text) => callbacks.push(`reasoning:${text}`),
    onIntermediateText: (text) => callbacks.push(`text:${text}`),
  });

  assert.equal(result.text, 'final');
  assert.deepEqual(callbacks, ['reasoning:thinking', 'text:final']);
});

test('paces assistant events read from one chunk using Claude Code timestamps', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openp-session-log-'));
  const logPath = join(dir, 'session.jsonl');
  await writeFile(logPath, [
    line({
      type: 'user',
      message: {
        content: 'hello',
      },
    }),
    line({
      type: 'assistant',
      timestamp: '2026-05-17T20:24:01.294Z',
      message: {
        content: [{ type: 'thinking', thinking: 'thinking' }],
      },
    }),
    line({
      type: 'assistant',
      timestamp: '2026-05-17T20:24:01.319Z',
      message: {
        content: [{ type: 'text', text: 'final' }],
        stop_reason: 'end_turn',
      },
    }),
    line({ type: 'system', subtype: 'turn_duration', durationMs: 12 }),
  ].join(''));
  const callbacks: Array<{ readonly kind: string; readonly ms: number }> = [];
  const started = Date.now();

  const result = await waitForClaudeCodeTurnResult({
    sessionId: '11111111-1111-4111-8111-111111111111',
    turnId: 'turn-1',
    timeoutMs: 10_000,
    initialOffset: 0,
    knownLogPath: logPath,
    paceIntermediateEvents: true,
    isBackendAlive: async () => true,
    onIntermediateReasoning: () => callbacks.push({ kind: 'reasoning', ms: Date.now() - started }),
    onIntermediateText: () => callbacks.push({ kind: 'text', ms: Date.now() - started }),
  });

  assert.equal(result.text, 'final');
  assert.deepEqual(callbacks.map((callback) => callback.kind), ['reasoning', 'text']);
  assert.equal(callbacks[1]!.ms - callbacks[0]!.ms >= 10, true);
});

test('does not pace timestamp replay when intermediate streaming is disabled', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openp-session-log-'));
  const logPath = join(dir, 'session.jsonl');
  await writeFile(logPath, [
    line({
      type: 'user',
      message: {
        content: 'hello',
      },
    }),
    line({
      type: 'assistant',
      timestamp: '2026-05-17T20:24:01.000Z',
      message: {
        content: [{ type: 'thinking', thinking: 'thinking' }],
      },
    }),
    line({
      type: 'assistant',
      timestamp: '2026-05-17T20:24:01.100Z',
      message: {
        content: [{ type: 'text', text: 'final' }],
        stop_reason: 'end_turn',
      },
    }),
    line({ type: 'system', subtype: 'turn_duration', durationMs: 12 }),
  ].join(''));

  const result = await waitForClaudeCodeTurnResult({
    sessionId: '11111111-1111-4111-8111-111111111111',
    turnId: 'turn-1',
    timeoutMs: 10,
    initialOffset: 0,
    knownLogPath: logPath,
    isBackendAlive: async () => true,
  });

  assert.equal(result.text, 'final');
});

test('timestamp replay pacing does not outlive the turn timeout', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openp-session-log-'));
  const logPath = join(dir, 'session.jsonl');
  await writeFile(logPath, [
    line({
      type: 'user',
      message: {
        content: 'hello',
      },
    }),
    line({
      type: 'assistant',
      timestamp: '2026-05-17T20:24:01.000Z',
      message: {
        content: [{ type: 'thinking', thinking: 'thinking' }],
      },
    }),
    line({
      type: 'assistant',
      timestamp: '2026-05-17T20:24:01.100Z',
      message: {
        content: [{ type: 'text', text: 'final' }],
        stop_reason: 'end_turn',
      },
    }),
    line({ type: 'system', subtype: 'turn_duration', durationMs: 12 }),
  ].join(''));

  await assert.rejects(
    () => waitForClaudeCodeTurnResult({
      sessionId: '11111111-1111-4111-8111-111111111111',
      turnId: 'turn-1',
      timeoutMs: 10,
      initialOffset: 0,
      knownLogPath: logPath,
      paceIntermediateEvents: true,
      isBackendAlive: async () => true,
      onIntermediateReasoning: () => undefined,
      onIntermediateText: () => undefined,
    }),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.timeout,
  );
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await sleep(50);
  }
  assert.equal(predicate(), true);
}
