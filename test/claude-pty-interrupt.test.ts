import assert from 'node:assert/strict';
import test from 'node:test';
import { createClaudePtyInterrupter } from '../src/backends/claude/pty-interrupt.js';
import { DEFAULT_TERMINATE_GRACE_MS } from '../src/core/graceful-interrupt.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('Claude PTY interrupter does not signal an already-dead PTY', async () => {
  const signals: NodeJS.Signals[] = [];
  const interrupter = createClaudePtyInterrupter({
    async interrupt() {
      signals.push('SIGINT');
    },
    async terminate(signal: NodeJS.Signals = 'SIGTERM') {
      signals.push(signal);
    },
    async isAlive() {
      return false;
    },
  });

  interrupter.requestGracefulStop();
  interrupter.requestForceStop();
  interrupter.requestKillNow();
  await sleep(20);

  assert.deepEqual(signals, []);
});

test('Claude PTY interrupter does not escalate to SIGKILL after SIGTERM closes the PTY', async () => {
  let alive = true;
  const signals: NodeJS.Signals[] = [];
  const interrupter = createClaudePtyInterrupter({
    async interrupt() {
      signals.push('SIGINT');
    },
    async terminate(signal: NodeJS.Signals = 'SIGTERM') {
      signals.push(signal);
      alive = false;
    },
    async isAlive() {
      return alive;
    },
  });

  interrupter.requestForceStop();
  await sleep(20);
  interrupter.requestKillNow();
  await sleep(20);

  assert.deepEqual(signals, ['SIGTERM']);
});

test('Claude PTY interrupter escalates to SIGKILL when the PTY stays alive after SIGTERM', async () => {
  const signals: NodeJS.Signals[] = [];
  const interrupter = createClaudePtyInterrupter({
    async interrupt() {
      signals.push('SIGINT');
    },
    async terminate(signal: NodeJS.Signals = 'SIGTERM') {
      signals.push(signal);
    },
    async isAlive() {
      return true;
    },
  });

  try {
    interrupter.requestForceStop();
    await sleep(DEFAULT_TERMINATE_GRACE_MS + 250);

    assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  } finally {
    interrupter.clear();
  }
});
