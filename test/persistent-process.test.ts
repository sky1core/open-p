import assert from 'node:assert/strict';
import test from 'node:test';
import { PersistentProcessManager, type ManagedBackendProcess, type ProcessStartRequest } from '../src/core/persistent-process.js';
import { buildLaunchSignature } from '../src/core/launch-signature.js';
import { EXIT_CODES, OpenPError } from '../src/core/errors.js';
import type { LaunchSignature } from '../src/core/worker-types.js';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';

class FakeProcess implements ManagedBackendProcess {
  shutdownCount = 0;
  refuseShutdown = false;
  shutdownDelayMs = 0;
  isAliveWait: Promise<void> | null = null;

  constructor(
    readonly sessionId: string,
    readonly launchSignature: LaunchSignature,
    private alive: boolean,
  ) {}

  async isAlive(): Promise<boolean> {
    await this.isAliveWait;
    return this.alive;
  }

  async shutdown(): Promise<void> {
    this.shutdownCount += 1;
    if (this.shutdownDelayMs > 0) {
      await sleep(this.shutdownDelayMs);
    }
    if (this.refuseShutdown) {
      return;
    }
    this.alive = false;
  }

  markDead(): void {
    this.alive = false;
  }
}

test('reuses an alive process with the same launch signature', async () => {
  const manager = new PersistentProcessManager<FakeProcess>();
  const signature = signatureFor('claude-haiku');
  const starts: ProcessStartRequest[] = [];
  const start = async (request: ProcessStartRequest) => {
    starts.push(request);
    return new FakeProcess(request.sessionId, request.launchSignature, true);
  };

  const first = await manager.getOrStart(SESSION_ID, signature, false, start);
  const second = await manager.getOrStart(SESSION_ID, signature, false, start);

  assert.equal(first, second);
  assert.equal(starts.length, 1);
  assert.equal(starts[0]?.resume, false);
});

test('restarts with resume when the tracked process is dead', async () => {
  const manager = new PersistentProcessManager<FakeProcess>();
  const signature = signatureFor('claude-haiku');
  const starts: ProcessStartRequest[] = [];
  const start = async (request: ProcessStartRequest) => {
    starts.push(request);
    return new FakeProcess(request.sessionId, request.launchSignature, true);
  };

  const first = await manager.getOrStart(SESSION_ID, signature, false, start);
  first.markDead();
  const second = await manager.getOrStart(SESSION_ID, signature, false, start);

  assert.notEqual(first, second);
  assert.equal(starts.length, 2);
  assert.equal(starts[1]?.resume, true);
});

test('restarts with resume when launch signature changes', async () => {
  const manager = new PersistentProcessManager<FakeProcess>();
  const firstSignature = signatureFor('claude-haiku');
  const secondSignature = signatureFor('claude-sonnet');
  const starts: ProcessStartRequest[] = [];
  const start = async (request: ProcessStartRequest) => {
    starts.push(request);
    return new FakeProcess(request.sessionId, request.launchSignature, true);
  };

  const first = await manager.getOrStart(SESSION_ID, firstSignature, false, start);
  const second = await manager.getOrStart(SESSION_ID, secondSignature, false, start);

  assert.notEqual(first, second);
  assert.equal(first.shutdownCount, 1);
  assert.equal(starts.length, 2);
  assert.equal(starts[1]?.resume, true);
});

test('quarantines a session when launch-signature restart cannot shut down the old process', async () => {
  const manager = new PersistentProcessManager<FakeProcess>();
  const firstSignature = signatureFor('claude-haiku');
  const secondSignature = signatureFor('claude-sonnet');
  const start = async (request: ProcessStartRequest) => new FakeProcess(request.sessionId, request.launchSignature, true);

  const first = await manager.getOrStart(SESSION_ID, firstSignature, false, start);
  first.refuseShutdown = true;

  await assert.rejects(
    () => manager.getOrStart(SESSION_ID, secondSignature, false, start),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionBusy,
  );
  await assert.rejects(
    () => manager.getOrStart(SESSION_ID, firstSignature, true, start),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionBusy,
  );
});

test('quarantines a session when process start reports an unsafe leftover process', async () => {
  const manager = new PersistentProcessManager<FakeProcess>();
  const signature = signatureFor('claude-haiku');
  let starts = 0;
  const start = async () => {
    starts += 1;
    throw new OpenPError('unsafe leftover process', EXIT_CODES.sessionBusy);
  };

  await assert.rejects(
    () => manager.getOrStart(SESSION_ID, signature, false, start),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionBusy,
  );
  await assert.rejects(
    () => manager.getOrStart(SESSION_ID, signature, true, start),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionBusy,
  );
  assert.equal(starts, 1);
});

test('rejects concurrent starts for the same session before a process is tracked', async () => {
  const manager = new PersistentProcessManager<FakeProcess>();
  const signature = signatureFor('claude-haiku');
  let starts = 0;
  let resolveStart!: (process: FakeProcess) => void;
  const started = new Promise<FakeProcess>((resolve) => {
    resolveStart = resolve;
  });
  const start = async (request: ProcessStartRequest) => {
    starts += 1;
    return started.then((process) => process ?? new FakeProcess(request.sessionId, request.launchSignature, true));
  };

  const first = manager.getOrStart(SESSION_ID, signature, false, start);
  await assert.rejects(
    () => manager.getOrStart(SESSION_ID, signature, false, start),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionBusy,
  );
  resolveStart(new FakeProcess(SESSION_ID, signature, true));
  await first;

  assert.equal(starts, 1);
  assert.equal(manager.trackedSessionCount(), 1);
});

test('runExclusive rejects concurrent turns and clears pending state after failure', async () => {
  const manager = new PersistentProcessManager<FakeProcess>();
  let release!: () => void;
  const active = manager.runExclusive(SESSION_ID, () => new Promise<void>((resolve) => {
    release = resolve;
  }));

  await assert.rejects(
    () => manager.runExclusive(SESSION_ID, async () => undefined),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionBusy,
  );

  release();
  await active;
  const result = await manager.runExclusive(SESSION_ID, async () => 'next');
  assert.equal(result, 'next');
});

test('shutdownAll shuts down tracked processes and clears state', async () => {
  const manager = new PersistentProcessManager<FakeProcess>();
  const firstSignature = signatureFor('claude-haiku');
  const secondSignature = signatureFor('claude-sonnet');
  const start = async (request: ProcessStartRequest) => new FakeProcess(request.sessionId, request.launchSignature, true);

  const first = await manager.getOrStart(SESSION_ID, firstSignature, false, start);
  const second = await manager.getOrStart('22222222-2222-4222-8222-222222222222', secondSignature, false, start);

  await manager.shutdownAll();

  assert.equal(first.shutdownCount, 1);
  assert.equal(second.shutdownCount, 1);
  assert.equal(manager.trackedSessionCount(), 0);
  assert.equal(await manager.isAliveForSession(SESSION_ID), false);
});

test('shutdownAll keeps an unsafe live process quarantined when graceful shutdown fails', async () => {
  const manager = new PersistentProcessManager<FakeProcess>();
  const signature = signatureFor('claude-haiku');
  const start = async (request: ProcessStartRequest) => new FakeProcess(request.sessionId, request.launchSignature, true);
  const process = await manager.getOrStart(SESSION_ID, signature, false, start);
  process.refuseShutdown = true;

  await assert.rejects(
    () => manager.shutdownAll(),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionBusy,
  );
  await assert.rejects(
    () => manager.getOrStart(SESSION_ID, signature, true, start),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionBusy,
  );
  assert.equal(manager.trackedSessionCount(), 1);
});

test('shutdownAll waits for every tracked process before reporting a shutdown failure', async () => {
  const manager = new PersistentProcessManager<FakeProcess>();
  const firstSignature = signatureFor('claude-haiku');
  const secondSignature = signatureFor('claude-sonnet');
  const start = async (request: ProcessStartRequest) => new FakeProcess(request.sessionId, request.launchSignature, true);
  const failed = await manager.getOrStart(SESSION_ID, firstSignature, false, start);
  const delayed = await manager.getOrStart('22222222-2222-4222-8222-222222222222', secondSignature, false, start);
  failed.refuseShutdown = true;
  delayed.shutdownDelayMs = 25;

  await assert.rejects(
    () => manager.shutdownAll(),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionBusy,
  );

  assert.equal(failed.shutdownCount, 1);
  assert.equal(delayed.shutdownCount, 1);
  assert.equal(await delayed.isAlive(), false);
  assert.equal(manager.trackedSessionCount(), 1);
});

test('shutdownAll rejects new turns without clearing an active pending session guard', async () => {
  const manager = new PersistentProcessManager<FakeProcess>();
  const signature = signatureFor('claude-haiku');
  const start = async (request: ProcessStartRequest) => new FakeProcess(request.sessionId, request.launchSignature, true);
  await manager.getOrStart(SESSION_ID, signature, false, start);

  let release!: () => void;
  const active = manager.runExclusive(SESSION_ID, () => new Promise<void>((resolve) => {
    release = resolve;
  }));
  await manager.shutdownAll();

  await assert.rejects(
    () => manager.runExclusive(SESSION_ID, async () => undefined),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionBusy,
  );

  release();
  await active;
});

test('shutdownAll waits for an in-flight start and shuts down the process it creates', async () => {
  const manager = new PersistentProcessManager<FakeProcess>();
  const signature = signatureFor('claude-haiku');
  let resolveStart!: (process: FakeProcess) => void;
  const started = new Promise<FakeProcess>((resolve) => {
    resolveStart = resolve;
  });
  const start = async () => started;

  const pendingStart = manager.getOrStart(SESSION_ID, signature, false, start);
  const shutdown = manager.shutdownAll();
  const process = new FakeProcess(SESSION_ID, signature, true);
  resolveStart(process);

  await assert.rejects(
    () => pendingStart,
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionBusy,
  );
  await shutdown;

  assert.equal(process.shutdownCount, 1);
  assert.equal(await process.isAlive(), false);
  assert.equal(manager.trackedSessionCount(), 0);
});

test('shutdownAll reports an in-flight start cleanup failure', async () => {
  const manager = new PersistentProcessManager<FakeProcess>();
  const signature = signatureFor('claude-haiku');
  let resolveStart!: (process: FakeProcess) => void;
  const started = new Promise<FakeProcess>((resolve) => {
    resolveStart = resolve;
  });
  const start = async () => started;

  const pendingStart = manager.getOrStart(SESSION_ID, signature, false, start);
  const shutdown = manager.shutdownAll();
  const process = new FakeProcess(SESSION_ID, signature, true);
  process.refuseShutdown = true;
  resolveStart(process);

  await assert.rejects(
    () => pendingStart,
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionBusy,
  );
  await assert.rejects(
    () => shutdown,
    (error) =>
      error instanceof OpenPError &&
      error.exitCode === EXIT_CODES.sessionBusy &&
      error.message.includes('still has a live process after graceful shutdown'),
  );

  assert.equal(process.shutdownCount, 1);
  assert.equal(await process.isAlive(), true);
  assert.equal(manager.trackedSessionCount(), 0);
});

test('shutdownAll still shuts down tracked processes when in-flight start cleanup fails', async () => {
  const manager = new PersistentProcessManager<FakeProcess>();
  const signature = signatureFor('claude-haiku');
  const trackedStart = async (request: ProcessStartRequest) => new FakeProcess(request.sessionId, request.launchSignature, true);
  const tracked = await manager.getOrStart(SESSION_ID, signature, false, trackedStart);

  let resolveStart!: (process: FakeProcess) => void;
  const started = new Promise<FakeProcess>((resolve) => {
    resolveStart = resolve;
  });
  const pendingStart = manager.getOrStart('22222222-2222-4222-8222-222222222222', signature, false, async () => started);
  const shutdown = manager.shutdownAll();
  const failedStartProcess = new FakeProcess('22222222-2222-4222-8222-222222222222', signature, true);
  failedStartProcess.refuseShutdown = true;
  resolveStart(failedStartProcess);

  await assert.rejects(
    () => pendingStart,
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionBusy,
  );
  await assert.rejects(
    () => shutdown,
    (error) =>
      error instanceof OpenPError &&
      error.exitCode === EXIT_CODES.sessionBusy &&
      error.message.includes('still has a live process after graceful shutdown'),
  );

  assert.equal(tracked.shutdownCount, 1);
  assert.equal(await tracked.isAlive(), false);
  assert.equal(failedStartProcess.shutdownCount, 1);
  assert.equal(await failedStartProcess.isAlive(), true);
  assert.equal(manager.trackedSessionCount(), 0);
});

test('shutdownAll prevents a delayed restart decision from starting a new process', async () => {
  const manager = new PersistentProcessManager<FakeProcess>();
  const signature = signatureFor('claude-haiku');
  const initialStart = async (request: ProcessStartRequest) => new FakeProcess(request.sessionId, request.launchSignature, true);
  const tracked = await manager.getOrStart(SESSION_ID, signature, false, initialStart);
  tracked.markDead();
  let releaseIsAlive!: () => void;
  tracked.isAliveWait = new Promise<void>((resolve) => {
    releaseIsAlive = resolve;
  });
  let restartCalls = 0;
  const restart = manager.getOrStart(SESSION_ID, signature, false, async (request) => {
    restartCalls += 1;
    return new FakeProcess(request.sessionId, request.launchSignature, true);
  });
  const shutdown = manager.shutdownAll();

  releaseIsAlive();

  await assert.rejects(
    () => restart,
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionBusy,
  );
  await shutdown;

  assert.equal(restartCalls, 0);
  assert.equal(tracked.shutdownCount, 1);
  assert.equal(manager.trackedSessionCount(), 0);
});

test('shutdownAll prevents delayed same-signature reuse from returning an existing process', async () => {
  const manager = new PersistentProcessManager<FakeProcess>();
  const signature = signatureFor('claude-haiku');
  const initialStart = async (request: ProcessStartRequest) => new FakeProcess(request.sessionId, request.launchSignature, true);
  const tracked = await manager.getOrStart(SESSION_ID, signature, false, initialStart);
  let releaseIsAlive!: () => void;
  tracked.isAliveWait = new Promise<void>((resolve) => {
    releaseIsAlive = resolve;
  });

  const reuse = manager.getOrStart(SESSION_ID, signature, false, async (request) => (
    new FakeProcess(request.sessionId, request.launchSignature, true)
  ));
  const shutdown = manager.shutdownAll();

  releaseIsAlive();

  await assert.rejects(
    () => reuse,
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionBusy,
  );
  await shutdown;

  assert.equal(tracked.shutdownCount, 1);
  assert.equal(manager.trackedSessionCount(), 0);
});

test('shutdownAll prevents a launch-signature restart from starting after old shutdown begins', async () => {
  const manager = new PersistentProcessManager<FakeProcess>();
  const firstSignature = signatureFor('claude-haiku');
  const secondSignature = signatureFor('claude-sonnet');
  const initialStart = async (request: ProcessStartRequest) => new FakeProcess(request.sessionId, request.launchSignature, true);
  const tracked = await manager.getOrStart(SESSION_ID, firstSignature, false, initialStart);
  tracked.shutdownDelayMs = 25;
  let restartCalls = 0;

  const restart = manager.getOrStart(SESSION_ID, secondSignature, false, async (request) => {
    restartCalls += 1;
    return new FakeProcess(request.sessionId, request.launchSignature, true);
  });
  const shutdown = manager.shutdownAll();

  await assert.rejects(
    () => restart,
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionBusy,
  );
  await shutdown;

  assert.equal(restartCalls, 0);
  assert.equal(tracked.shutdownCount, 1);
  assert.equal(await tracked.isAlive(), false);
  assert.equal(manager.trackedSessionCount(), 0);
});

test('dedupes concurrent discard and shutdownAll for the same process', async () => {
  const manager = new PersistentProcessManager<FakeProcess>();
  const signature = signatureFor('claude-haiku');
  const start = async (request: ProcessStartRequest) => new FakeProcess(request.sessionId, request.launchSignature, true);
  const tracked = await manager.getOrStart(SESSION_ID, signature, false, start);
  tracked.shutdownDelayMs = 25;

  const discard = manager.discard(SESSION_ID, tracked);
  const shutdown = manager.shutdownAll();

  await discard;
  await shutdown;

  assert.equal(tracked.shutdownCount, 1);
  assert.equal(await tracked.isAlive(), false);
  assert.equal(manager.trackedSessionCount(), 0);
});

test('discard shuts down and removes only the tracked process instance', async () => {
  const manager = new PersistentProcessManager<FakeProcess>();
  const signature = signatureFor('claude-haiku');
  const start = async (request: ProcessStartRequest) => new FakeProcess(request.sessionId, request.launchSignature, true);
  const tracked = await manager.getOrStart(SESSION_ID, signature, false, start);
  const other = new FakeProcess(SESSION_ID, signature, true);

  await manager.discard(SESSION_ID, other);
  assert.equal(manager.trackedSessionCount(), 1);
  assert.equal(tracked.shutdownCount, 0);

  await manager.discard(SESSION_ID, tracked);
  assert.equal(manager.trackedSessionCount(), 0);
  assert.equal(tracked.shutdownCount, 1);
});

test('discard quarantines a session when graceful shutdown leaves the process alive', async () => {
  const manager = new PersistentProcessManager<FakeProcess>();
  const signature = signatureFor('claude-haiku');
  const start = async (request: ProcessStartRequest) => new FakeProcess(request.sessionId, request.launchSignature, true);
  const tracked = await manager.getOrStart(SESSION_ID, signature, false, start);
  tracked.refuseShutdown = true;

  await assert.rejects(
    () => manager.discard(SESSION_ID, tracked),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionBusy,
  );
  await assert.rejects(
    () => manager.getOrStart(SESSION_ID, signature, true, start),
    (error) => error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionBusy,
  );
});

function signatureFor(model: string): LaunchSignature {
  return buildLaunchSignature({
    backendId: 'claude-code',
    bin: 'claude',
    binArgs: [],
    model,
    reasoningEffort: 'medium',
    executionMode: 'bypassPermissions',
    env: {},
    local: false,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
