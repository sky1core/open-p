import assert from 'node:assert/strict';
import test from 'node:test';
import { GracefulInterrupt, installProcessSignalHandlers } from '../../src/core/graceful-interrupt.js';

test('repeated interrupt clears the old interrupt grace before terminate grace starts', async () => {
  const signals: NodeJS.Signals[] = [];
  // The force stop must land well inside the interrupt grace even on a loaded machine, and the
  // second sleep must reach past the interrupt grace deadline so a leaked (uncleared) grace timer
  // would fire inside the observation window, while staying far below the terminate grace so the
  // scheduled SIGKILL cannot.
  const interrupter = new GracefulInterrupt({
    interruptGraceMs: 1000,
    terminateGraceMs: 30_000,
    isAlive: () => true,
    sendSignal: (signal) => signals.push(signal),
  });

  interrupter.requestGracefulStop();
  await sleep(50);
  interrupter.requestForceStop();
  await sleep(1500);

  assert.deepEqual(signals, ['SIGINT', 'SIGTERM']);

  interrupter.clear();
});

test('terminate phase never regresses to a graceful SIGINT', () => {
  const signals: NodeJS.Signals[] = [];
  const interrupter = new GracefulInterrupt({
    isAlive: () => true,
    sendSignal: (signal) => signals.push(signal),
  });

  interrupter.requestForceStop();
  interrupter.requestGracefulStop();

  assert.deepEqual(signals, ['SIGTERM']);

  interrupter.clear();
});

test('process signal handlers expose third interrupt as kill signal', () => {
  const handlers = installProcessSignalHandlers();
  const events: string[] = [];
  handlers.signal.addEventListener('abort', () => events.push(`signal:${String(handlers.signal.reason)}`));
  handlers.forceSignal.addEventListener('abort', () => events.push(`force:${String(handlers.forceSignal.reason)}`));
  handlers.killSignal.addEventListener('abort', () => events.push(`kill:${String(handlers.killSignal.reason)}`));
  const handler = process.listeners('SIGINT').at(-1) as ((signal: NodeJS.Signals) => void) | undefined;
  if (!handler) {
    throw new Error('SIGINT handler was not installed');
  }

  try {
    handler('SIGINT');
    handler('SIGINT');
    handler('SIGINT');
  } finally {
    handlers.dispose();
  }

  assert.deepEqual(events, ['signal:SIGINT', 'force:SIGINT', 'kill:SIGINT']);
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
