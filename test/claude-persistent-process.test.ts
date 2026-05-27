import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFile, chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readinessTimeoutMs, waitForClaudeCodeInputReady } from '../src/backends/claude/interactive.js';
import { PersistentClaudeCodeProcess, startPersistentClaudeCodeProcess } from '../src/backends/claude/persistent-process.js';
import { buildLaunchSignature } from '../src/core/launch-signature.js';
import { EXIT_CODES, OpenPError } from '../src/core/errors.js';
import type { IntermediateTextSource } from '../src/core/types.js';
import type { PtyProvider, PtySession, PtyStartOptions } from '../src/runners/types.js';

const TEST_CWD = process.cwd();

class StartupFailureSession implements PtySession {
  readonly id = 'startup-failure-session';
  exitCount = 0;
  alive = true;
  submitCount = 0;

  constructor(
    private readonly closeOnExit: boolean,
    private readonly readyAfterTrust: boolean = false,
  ) {}

  async write(): Promise<void> {}

  async submit(): Promise<void> {
    this.submitCount += 1;
  }

  async interrupt(): Promise<void> {}

  async terminate(): Promise<void> {
    this.alive = false;
  }

  async exit(): Promise<void> {
    this.exitCount += 1;
    if (this.closeOnExit) {
      this.alive = false;
    }
  }

  async isAlive(): Promise<boolean> {
    return this.alive;
  }

  async captureText(): Promise<string> {
    if (this.readyAfterTrust && this.submitCount > 0) {
      return 'Claude Code v\n❯';
    }
    return 'Quick safety check: trust this folder?';
  }
}

class TurnLogSession implements PtySession {
  readonly id = 'turn-log-session';
  alive = true;
  interleaveTaskBeforeFinal = false;
  private lastWrite = '';

  constructor(private readonly logPath: string) {}

  async write(input: string): Promise<void> {
    this.lastWrite = input;
  }

  async submit(): Promise<void> {
    const lines = [
      eventLine({
        type: 'user',
        uuid: 'active-user',
        message: { content: this.lastWrite },
      }),
    ];
    if (this.interleaveTaskBeforeFinal) {
      this.interleaveTaskBeforeFinal = false;
      lines.push(eventLine({
        type: 'user',
        uuid: 'background-user',
        parentUuid: 'active-user',
        origin: { kind: 'task-notification' },
        message: { content: 'interleaved task complete' },
      }));
      lines.push(eventLine({
        type: 'assistant',
        parentUuid: 'background-user',
        message: {
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'interleaved background done' }],
        },
      }));
    }
    lines.push(
      eventLine({
        type: 'assistant',
        parentUuid: 'active-user',
        message: {
          content: [{ type: 'text', text: 'active result' }],
        },
      }),
      eventLine({
        type: 'system',
        subtype: 'turn_duration',
        durationMs: 10,
      }),
    );
    await appendFile(this.logPath, lines.join('\n') + '\n');
  }

  async interrupt(): Promise<void> {}

  async terminate(): Promise<void> {
    this.alive = false;
  }

  async exit(): Promise<void> {
    this.alive = false;
  }

  async isAlive(): Promise<boolean> {
    return this.alive;
  }

  async captureText(): Promise<string> {
    return 'Claude Code v\n❯';
  }
}

class ReadinessBoundarySession implements PtySession {
  readonly id = 'readiness-boundary-session';
  alive = true;
  private lastWrite = '';
  private appendedDuringReadiness = false;

  constructor(private readonly logPath: string) {}

  async write(input: string): Promise<void> {
    this.lastWrite = input;
  }

  async submit(): Promise<void> {
    setTimeout(() => {
      void appendFile(this.logPath, [
        eventLine({
          type: 'user',
          uuid: 'active-user',
          message: { content: this.lastWrite },
        }),
        eventLine({
          type: 'assistant',
          parentUuid: 'active-user',
          message: {
            content: [{ type: 'text', text: 'active result' }],
          },
        }),
        eventLine({
          type: 'system',
          subtype: 'turn_duration',
          durationMs: 10,
        }),
      ].join('\n') + '\n');
    }, 100);
  }

  async interrupt(): Promise<void> {}

  async terminate(): Promise<void> {
    this.alive = false;
  }

  async exit(): Promise<void> {
    this.alive = false;
  }

  async isAlive(): Promise<boolean> {
    return this.alive;
  }

  async captureText(): Promise<string> {
    if (!this.appendedDuringReadiness) {
      this.appendedDuringReadiness = true;
      await appendFile(this.logPath, eventLine({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'startup stale assistant' }],
        },
      }) + '\n');
    }
    return 'Claude Code v\n❯';
  }
}

class ScreenBeforeJsonlSession implements PtySession {
  readonly id = 'screen-before-jsonl-session';
  alive = true;
  private lastWrite = '';

  constructor(
    private readonly logPath: string,
    private readonly screenText = 'screen-only preview',
    private readonly jsonlText = 'jsonl progress',
  ) {}

  async write(input: string): Promise<void> {
    this.lastWrite = input;
  }

  async submit(): Promise<void> {
    setTimeout(() => {
      void appendFile(this.logPath, [
        eventLine({
          type: 'user',
          uuid: 'active-user',
          message: { content: this.lastWrite },
        }),
        eventLine({
          type: 'assistant',
          parentUuid: 'active-user',
          message: {
            content: [{ type: 'text', text: this.jsonlText }],
          },
        }),
      ].join('\n') + '\n');
    }, 350);
    setTimeout(() => {
      void appendFile(this.logPath, eventLine({
        type: 'system',
        subtype: 'turn_duration',
        durationMs: 10,
      }) + '\n');
    }, 1_100);
  }

  async interrupt(): Promise<void> {}

  async terminate(): Promise<void> {
    this.alive = false;
  }

  async exit(): Promise<void> {
    this.alive = false;
  }

  async isAlive(): Promise<boolean> {
    return this.alive;
  }

  async captureText(): Promise<string> {
    return [
      'Claude Code v',
      '❯ hello',
      '',
      `⏺ ${this.screenText}`,
    ].join('\n');
  }
}

class ScreenExtendsAfterRawJsonlSession implements PtySession {
  readonly id = 'screen-extends-after-raw-jsonl-session';
  alive = true;
  private lastWrite = '';
  private captureCount = 0;

  constructor(private readonly logPath: string) {}

  async write(input: string): Promise<void> {
    this.lastWrite = input;
  }

  async submit(): Promise<void> {
    this.captureCount = 0;
    setTimeout(() => {
      void appendFile(this.logPath, [
        eventLine({
          type: 'user',
          uuid: 'active-user',
          message: { content: this.lastWrite },
        }),
        eventLine({
          type: 'assistant',
          parentUuid: 'active-user',
          message: {
            content: [{ type: 'text', text: '## Title extended' }],
          },
        }),
      ].join('\n') + '\n');
    }, 350);
    setTimeout(() => {
      void appendFile(this.logPath, eventLine({
        type: 'system',
        subtype: 'turn_duration',
        durationMs: 10,
      }) + '\n');
    }, 700);
  }

  async interrupt(): Promise<void> {}

  async terminate(): Promise<void> {
    this.alive = false;
  }

  async exit(): Promise<void> {
    this.alive = false;
  }

  async isAlive(): Promise<boolean> {
    return this.alive;
  }

  async captureText(): Promise<string> {
    this.captureCount += 1;
    return [
      'Claude Code v',
      '❯ hello',
      '',
      `⏺ ${this.captureCount <= 1 ? 'Title' : 'Title extended'}`,
    ].join('\n');
  }
}

class JsonlThenStaleScreenSession implements PtySession {
  readonly id = 'jsonl-then-stale-screen-session';
  alive = true;
  private lastWrite = '';

  constructor(private readonly logPath: string) {}

  async write(input: string): Promise<void> {
    this.lastWrite = input;
  }

  async submit(): Promise<void> {
    setTimeout(() => {
      void appendFile(this.logPath, [
        eventLine({
          type: 'user',
          uuid: 'active-user',
          message: { content: this.lastWrite },
        }),
        eventLine({
          type: 'assistant',
          parentUuid: 'active-user',
          message: {
            content: [{ type: 'text', text: 'jsonl newer and longer draft' }],
          },
        }),
      ].join('\n') + '\n');
    }, 100);
  }

  async interrupt(): Promise<void> {}

  async terminate(): Promise<void> {
    this.alive = false;
  }

  async exit(): Promise<void> {
    this.alive = false;
  }

  async isAlive(): Promise<boolean> {
    return this.alive;
  }

  async captureText(): Promise<string> {
    return [
      'Claude Code v',
      '❯ hello',
      '',
      '⏺ stale',
    ].join('\n');
  }
}

class ReasoningThenAbortSession implements PtySession {
  readonly id = 'reasoning-then-abort-session';
  alive = true;
  private lastWrite = '';

  constructor(private readonly logPath: string) {}

  async write(input: string): Promise<void> {
    this.lastWrite = input;
  }

  async submit(): Promise<void> {
    setTimeout(() => {
      void appendFile(this.logPath, [
        eventLine({
          type: 'user',
          uuid: 'active-user',
          message: { content: this.lastWrite },
        }),
        eventLine({
          type: 'assistant',
          parentUuid: 'active-user',
          message: {
            content: [
              { type: 'thinking', thinking: 'explicit reasoning draft' },
              { type: 'text', text: 'answer draft' },
            ],
          },
        }),
      ].join('\n') + '\n');
    }, 100);
  }

  async interrupt(): Promise<void> {}

  async terminate(): Promise<void> {
    this.alive = false;
  }

  async exit(): Promise<void> {
    this.alive = false;
  }

  async isAlive(): Promise<boolean> {
    return this.alive;
  }

  async captureText(): Promise<string> {
    return 'Claude Code v\n❯';
  }
}

class TimeoutTurnSession implements PtySession {
  readonly id = 'timeout-turn-session';
  alive = true;
  interruptCount = 0;
  exitCount = 0;
  readonly terminateSignals: NodeJS.Signals[] = [];

  async write(): Promise<void> {}

  async submit(): Promise<void> {}

  async interrupt(): Promise<void> {
    this.interruptCount += 1;
  }

  async terminate(signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
    this.terminateSignals.push(signal);
    this.alive = false;
  }

  async exit(): Promise<void> {
    this.exitCount += 1;
    this.alive = false;
  }

  async isAlive(): Promise<boolean> {
    return this.alive;
  }

  async captureText(): Promise<string> {
    return 'Claude Code v\n❯';
  }
}

test('persistent Claude Code startup auto-confirms workspace trust prompt', async () => {
  const session = new StartupFailureSession(true, true);
  const provider = providerFor(session);

  const started = await startPersistentClaudeCodeProcess({
    sessionId: randomUUID(),
    launchSignature: signature(),
    resume: false,
    cwd: TEST_CWD,
    provider,
    timeoutMs: 1_000,
  });

  assert.equal(session.submitCount, 1);
  await started.shutdown();
  assert.equal(session.exitCount, 1);
});

test('persistent Claude Code startup rejects open-p claude command before starting PTY', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openp-claude-startup-'));
  const fakeOpenP = join(dir, 'claude');
  await writeFile(fakeOpenP, '#!/bin/sh\necho "openp 0.1.0"\n');
  await chmod(fakeOpenP, 0o755);
  let providerStarted = false;
  const provider: PtyProvider = {
    start: async () => {
      providerStarted = true;
      throw new Error('provider should not start');
    },
  };

  await assert.rejects(
    () => startPersistentClaudeCodeProcess({
      sessionId: randomUUID(),
      launchSignature: buildLaunchSignature({
        backendId: 'claude',
        bin: 'claude',
        binArgs: [],
        env: { PATH: `.:${process.env.PATH ?? ''}` },
        local: false,
      }),
      resume: false,
      cwd: dir,
      provider,
      timeoutMs: 1_000,
    }),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.backendStartFailed,
  );

  assert.equal(providerStarted, false);
});

test('persistent Claude Code startup failure gracefully exits the started PTY', async () => {
  const session = new StartupFailureSession(true, false);
  const provider = providerFor(session);

  await assert.rejects(
    () => startPersistentClaudeCodeProcess({
      sessionId: randomUUID(),
      launchSignature: signature(),
      resume: false,
      cwd: TEST_CWD,
      provider,
      timeoutMs: 1_000,
    }),
    /still waiting for workspace trust/i,
  );

  assert.equal(session.exitCount, 1);
  assert.equal(await session.isAlive(), false);
});

test('readiness timeout stays bounded when turn timeout is disabled', () => {
  assert.equal(readinessTimeoutMs(0), 15_000);
  assert.equal(readinessTimeoutMs(1_000), 1_000);
  assert.equal(readinessTimeoutMs(60_000), 15_000);
});

test('readiness timeout includes the last captured Claude Code screen', async () => {
  const session: PtySession = {
    id: 'never-ready-session',
    async write() {},
    async submit() {},
    async interrupt() {},
    async terminate() {},
    async exit() {},
    async isAlive() {
      return true;
    },
    async captureText() {
      return 'Claude Code v\nLoading plugins...\nNo prompt yet';
    },
  };

  await assert.rejects(
    () => waitForClaudeCodeInputReady(session, 1),
    /Last Claude Code screen:[\s\S]*Loading plugins[\s\S]*No prompt yet/,
  );
});

test('readiness accepts a visible Claude Code prompt without the version banner', async () => {
  const session: PtySession = {
    id: 'prompt-only-ready-session',
    async write() {},
    async submit() {},
    async interrupt() {},
    async terminate() {},
    async exit() {},
    async isAlive() {
      return true;
    },
    async captureText() {
      return [
        'previous assistant text',
        '⎿ See ya!',
        '────────────────────────────────',
        '❯',
      ].join('\n');
    },
  };

  await waitForClaudeCodeInputReady(session, 1_000);
});

test('persistent Claude Code startup failure reports unsafe session when graceful exit leaves PTY alive', async () => {
  const session = new StartupFailureSession(false, false);
  const provider = providerFor(session);

  await assert.rejects(
    () => startPersistentClaudeCodeProcess({
      sessionId: randomUUID(),
      launchSignature: signature(),
      resume: false,
      cwd: TEST_CWD,
      provider,
      timeoutMs: 1_000,
    }),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionBusy,
  );

  assert.equal(session.exitCount, 1);
  assert.equal(await session.isAlive(), true);
});

test('persistent background watcher keeps pending flush on the previous callback before arming the new task', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openp-background-'));
  const logPath = join(dir, 'session.jsonl');
  await writeFile(logPath, '');
  const sessionId = randomUUID();
  const session = new TurnLogSession(logPath);
  const process = new PersistentClaudeCodeProcess(sessionId, signature(), dir, session, logPath, logPath, 0);
  const backgroundTexts: string[] = [];

  process.startBackgroundWatcher();
  try {
    const result = await process.sendTurn('hello', {
      timeoutMs: 5_000,
      onBackgroundAssistantText: (text) => backgroundTexts.push(text),
    });
    assert.equal(result.text, 'active result');

    await appendFile(logPath, [
      eventLine({
        type: 'user',
        uuid: 'first-background-user',
        origin: { kind: 'task-notification' },
        message: { content: 'first task complete' },
      }),
      eventLine({
        type: 'assistant',
        parentUuid: 'first-background-user',
        message: {
          content: [{ type: 'text', text: 'first pending' }],
        },
      }),
      eventLine({
        type: 'user',
        uuid: 'second-background-user',
        origin: { kind: 'task-notification' },
        message: { content: 'second task complete' },
      }),
      eventLine({
        type: 'assistant',
        parentUuid: 'second-background-user',
        message: {
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'second done' }],
        },
      }),
    ].join('\n') + '\n');

    await waitUntil(() => backgroundTexts.length === 2);
    assert.deepEqual(backgroundTexts, ['first pending', 'second done']);
  } finally {
    await process.shutdown();
  }
});

test('persistent background watcher does not route active assistant text as background text when notification comes first', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openp-background-final-'));
  const logPath = join(dir, 'session.jsonl');
  await writeFile(logPath, '');
  const sessionId = randomUUID();
  const session = new TurnLogSession(logPath);
  const process = new PersistentClaudeCodeProcess(sessionId, signature(), dir, session, logPath, logPath, 0);
  const firstTurnBackgroundTexts: string[] = [];
  const secondTurnBackgroundTexts: string[] = [];

  process.startBackgroundWatcher();
  try {
    await process.sendTurn('first', {
      timeoutMs: 5_000,
      onBackgroundAssistantText: (text) => firstTurnBackgroundTexts.push(text),
    });

    session.interleaveTaskBeforeFinal = true;
    const result = await process.sendTurn('second', {
      timeoutMs: 5_000,
      onBackgroundAssistantText: (text) => secondTurnBackgroundTexts.push(text),
    });

    assert.equal(result.text, 'active result');
    await waitUntil(() => secondTurnBackgroundTexts.length === 1);
    assert.deepEqual(firstTurnBackgroundTexts, []);
    assert.deepEqual(secondTurnBackgroundTexts, ['interleaved background done']);
    assert.equal(secondTurnBackgroundTexts.some((text) => text.includes('active result')), false);
  } finally {
    await process.shutdown();
  }
});

test('persistent turn publishes JSONL assistant snapshots without screen previews', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openp-screen-jsonl-'));
  const logPath = join(dir, 'session.jsonl');
  await writeFile(logPath, '');
  const sessionId = randomUUID();
  const session = new ScreenBeforeJsonlSession(logPath, 'jsonl', 'jsonl progress');
  const process = new PersistentClaudeCodeProcess(sessionId, signature(), dir, session, logPath, logPath, 0);
  const intermediate: Array<{ text: string; source: IntermediateTextSource }> = [];

  try {
    const result = await process.sendTurn('hello', {
      timeoutMs: 5_000,
      paceIntermediateEvents: true,
      onIntermediateText: (text, source) => intermediate.push({ text, source }),
    });

    assert.equal(result.text, 'jsonl progress');
    assert.deepEqual(intermediate, [
      { text: 'jsonl progress', source: 'jsonl' },
    ]);
  } finally {
    await process.shutdown();
  }
});

test('persistent turn does not derive public previews from screen text', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openp-screen-raw-jsonl-'));
  const logPath = join(dir, 'session.jsonl');
  await writeFile(logPath, '');
  const sessionId = randomUUID();
  const session = new ScreenExtendsAfterRawJsonlSession(logPath);
  const process = new PersistentClaudeCodeProcess(sessionId, signature(), dir, session, logPath, logPath, 0);
  const intermediate: Array<{ text: string; source: IntermediateTextSource }> = [];

  try {
    const result = await process.sendTurn('hello', {
      timeoutMs: 5_000,
      paceIntermediateEvents: true,
      onIntermediateText: (text, source) => intermediate.push({ text, source }),
    });

    assert.equal(result.text, '## Title extended');
    assert.deepEqual(intermediate, [
      { text: '## Title extended', source: 'jsonl' },
    ]);
  } finally {
    await process.shutdown();
  }
});

test('persistent turn starts JSONL parsing at the prompt submission boundary', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openp-startup-boundary-'));
  const logPath = join(dir, 'session.jsonl');
  await writeFile(logPath, '');
  const sessionId = randomUUID();
  const session = new ReadinessBoundarySession(logPath);
  const process = new PersistentClaudeCodeProcess(sessionId, signature(), dir, session, logPath, logPath, 0);
  const intermediate: string[] = [];

  try {
    const result = await process.sendTurn('hello', {
      timeoutMs: 5_000,
      onIntermediateText: (text) => intermediate.push(text),
    });

    assert.equal(result.text, 'active result');
    assert.deepEqual(intermediate, ['active result']);
  } finally {
    await process.shutdown();
  }
});

test('persistent turn ignores matching screen text and publishes JSONL once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openp-screen-jsonl-same-'));
  const logPath = join(dir, 'session.jsonl');
  await writeFile(logPath, '');
  const sessionId = randomUUID();
  const session = new ScreenBeforeJsonlSession(logPath, 'same progress', 'same progress');
  const process = new PersistentClaudeCodeProcess(sessionId, signature(), dir, session, logPath, logPath, 0);
  const intermediate: Array<{ text: string; source: IntermediateTextSource }> = [];

  try {
    const result = await process.sendTurn('hello', {
      timeoutMs: 5_000,
      paceIntermediateEvents: true,
      onIntermediateText: (text, source) => intermediate.push({ text, source }),
    });

    assert.equal(result.text, 'same progress');
    assert.deepEqual(intermediate, [
      { text: 'same progress', source: 'jsonl' },
    ]);
  } finally {
    await process.shutdown();
  }
});

test('persistent turn keeps screen previews disabled when stream pacing is not requested', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openp-screen-disabled-'));
  const logPath = join(dir, 'session.jsonl');
  await writeFile(logPath, '');
  const sessionId = randomUUID();
  const session = new ScreenBeforeJsonlSession(logPath, 'jsonl progress', 'jsonl progress');
  const process = new PersistentClaudeCodeProcess(sessionId, signature(), dir, session, logPath, logPath, 0);
  const intermediate: Array<{ text: string; source: IntermediateTextSource }> = [];

  try {
    const result = await process.sendTurn('hello', {
      timeoutMs: 5_000,
      onIntermediateText: (text, source) => intermediate.push({ text, source }),
    });

    assert.equal(result.text, 'jsonl progress');
    assert.deepEqual(intermediate, [
      { text: 'jsonl progress', source: 'jsonl' },
    ]);
  } finally {
    await process.shutdown();
  }
});

test('persistent turn keeps newer JSONL draft when stale screen preview arrives before abort', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openp-jsonl-stale-screen-'));
  const logPath = join(dir, 'session.jsonl');
  await writeFile(logPath, '');
  const sessionId = randomUUID();
  const session = new JsonlThenStaleScreenSession(logPath);
  const process = new PersistentClaudeCodeProcess(sessionId, signature(), dir, session, logPath, logPath, 0);
  const controller = new AbortController();

  setTimeout(() => controller.abort(), 1_200);
  try {
    await assert.rejects(
      () => process.sendTurn('hello', {
        timeoutMs: 5_000,
        paceIntermediateEvents: true,
        signal: controller.signal,
        onIntermediateText: () => undefined,
      }),
      (error) => {
        assert.equal((error as { readonly code?: unknown }).code, 'ABORT_ERR');
        assert.equal(
          (error as { readonly interruptedReasoningContent?: unknown }).interruptedReasoningContent,
          'jsonl newer and longer draft',
        );
        return true;
      },
    );
  } finally {
    await process.shutdown();
  }
});

test('persistent turn preserves explicit reasoning over answer draft when aborted', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openp-reasoning-abort-'));
  const logPath = join(dir, 'session.jsonl');
  await writeFile(logPath, '');
  const sessionId = randomUUID();
  const session = new ReasoningThenAbortSession(logPath);
  const process = new PersistentClaudeCodeProcess(sessionId, signature(), dir, session, logPath, logPath, 0);
  const controller = new AbortController();

  setTimeout(() => controller.abort(), 1_200);
  try {
    await assert.rejects(
      () => process.sendTurn('hello', {
        timeoutMs: 5_000,
        signal: controller.signal,
      }),
      (error) => {
        assert.equal((error as { readonly code?: unknown }).code, 'ABORT_ERR');
        assert.equal(
          (error as { readonly interruptedReasoningContent?: unknown }).interruptedReasoningContent,
          'explicit reasoning draft',
        );
        return true;
      },
    );
  } finally {
    await process.shutdown();
  }
});

test('persistent turn sends C-c before shutdown when active turn times out', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openp-timeout-interrupt-'));
  const logPath = join(dir, 'session.jsonl');
  await writeFile(logPath, '');
  const sessionId = randomUUID();
  const session = new TimeoutTurnSession();
  const process = new PersistentClaudeCodeProcess(sessionId, signature(), dir, session, logPath, logPath, 0);

  try {
    await assert.rejects(
      () => process.sendTurn('hello', {
        timeoutMs: 25,
      }),
      (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.timeout,
    );
  } finally {
    await process.shutdown();
  }

  assert.equal(session.interruptCount, 1);
  assert.equal(session.exitCount, 1);
  assert.deepEqual(session.terminateSignals, []);
});

function providerFor(session: PtySession): PtyProvider {
  return {
    start: async (_command: string, _args: readonly string[], _options: PtyStartOptions) => session,
  };
}

function eventLine(event: unknown): string {
  return JSON.stringify(event);
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(predicate(), true);
}

function signature() {
  return buildLaunchSignature({
    backendId: 'claude',
    bin: process.execPath,
    binArgs: [],
    env: {},
    local: false,
  });
}
