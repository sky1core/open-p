import assert from 'node:assert/strict';
import test from 'node:test';
import { GracefulInterrupt, installProcessSignalHandlers } from '../src/core/graceful-interrupt.js';

test('repeated interrupt clears the old interrupt grace before terminate grace starts', async () => {
  const signals: NodeJS.Signals[] = [];
  const interrupter = new GracefulInterrupt({
    interruptGraceMs: 40,
    terminateGraceMs: 200,
    isAlive: () => true,
    sendSignal: (signal) => signals.push(signal),
  });

  interrupter.requestGracefulStop();
  await sleep(20);
  interrupter.requestForceStop();
  await sleep(60);

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
