import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdtemp, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  resolveClaudeCodeSessionLogPath,
  waitForClaudeCodeTurnResult,
} from '../src/backends/claude-code/session-log.js';
import { EXIT_CODES, OpenPError } from '../src/core/errors.js';

function line(event: unknown): string {
  return `${JSON.stringify(event)}\n`;
}

test('resolves the direct Claude Code session log path for a cwd before the file exists', () => {
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

test('publishes active assistant intermediate text while waiting for final turn result', async () => {
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

  assert.equal(result.text, 'final');
  assert.deepEqual(intermediate, ['working', 'final']);
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

  assert.equal(result.text, 'final');
  assert.deepEqual(callbacks, ['reasoning:thinking', 'text:working', 'text:final']);
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

test('publishes final assistant content before returning when completion is already in the chunk', async () => {
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
