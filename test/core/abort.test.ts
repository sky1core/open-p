import assert from 'node:assert/strict';
import test from 'node:test';
import { createAbortError, isAbortError, runAbortableOperation, throwIfAborted } from '../../src/core/abort.js';
import { EXIT_CODES, toExitCode } from '../../src/core/errors.js';

test('creates AbortError with ABORT_ERR code and interrupted draft metadata', () => {
  const error = createAbortError('stopped', 'draft text');

  assert.equal(error.name, 'AbortError');
  assert.equal(error.code, 'ABORT_ERR');
  assert.equal(error.interruptedReasoningContent, 'draft text');
  assert.equal(isAbortError(error), true);
  assert.equal(toExitCode(error), EXIT_CODES.interrupted);
});

test('throws immediately when signal is already aborted', () => {
  const controller = new AbortController();
  controller.abort();

  assert.throws(() => throwIfAborted(controller.signal), isAbortError);
});

test('active abort calls backend interrupt and rejects with interrupted draft', async () => {
  const controller = new AbortController();
  let interrupted = false;
  const promise = runAbortableOperation({
    signal: controller.signal,
    interrupt: () => {
      interrupted = true;
    },
    getInterruptedDraft: () => 'partial assistant text',
    operation: () => new Promise<string>(() => undefined),
  });

  controller.abort();
  await assert.rejects(promise, (error) => {
    assert.equal(isAbortError(error), true);
    assert.equal((error as { readonly interruptedReasoningContent?: unknown }).interruptedReasoningContent, 'partial assistant text');
    return true;
  });
  assert.equal(interrupted, true);
});

test('settled abort mode waits for operation cleanup before surfacing AbortError', async () => {
  const controller = new AbortController();
  let cleanupFinished = false;
  let releaseCleanup: (() => void) | null = null;
  const cleanupGate = new Promise<void>((resolve) => {
    releaseCleanup = resolve;
  });
  const promise = runAbortableOperation({
    signal: controller.signal,
    awaitOperationAfterAbort: true,
    interrupt: () => undefined,
    operation: async () => {
      await cleanupGate;
      cleanupFinished = true;
      throw new Error('inner operation stopped');
    },
  });

  controller.abort();
  await Promise.resolve();
  assert.equal(cleanupFinished, false);
  releaseCleanup!();
  await assert.rejects(promise, isAbortError);
  assert.equal(cleanupFinished, true);
});

test('settled abort mode preserves a safety-critical operation error', async () => {
  const controller = new AbortController();
  let releaseCleanup: (() => void) | null = null;
  const cleanupGate = new Promise<void>((resolve) => {
    releaseCleanup = resolve;
  });
  const safetyError = new Error('caller boundary became uncertain');
  const promise = runAbortableOperation({
    signal: controller.signal,
    awaitOperationAfterAbort: true,
    interrupt: () => undefined,
    preserveOperationErrorAfterAbort: (error) => error === safetyError,
    operation: async () => {
      await cleanupGate;
      throw safetyError;
    },
  });

  controller.abort();
  releaseCleanup!();
  await assert.rejects(promise, (error) => error === safetyError);
});
