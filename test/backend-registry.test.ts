import assert from 'node:assert/strict';
import test from 'node:test';
import { registerBackend, getBackendProvider, getRegisteredBackendIds, getKnownBackendNames, resolveRegisteredBackendId } from '../src/core/backend-registry.js';
import type { BackendProvider } from '../src/core/backend.js';

function stubProvider(id: string): BackendProvider {
  return {
    id,
    descriptor: {} as never,
    createBackend: () => ({ runTurn: async () => ({}) }) as never,
    createWorkerBridge: () => ({
      runTurn: async () => ({}),
      isChildAliveForSession: async () => false,
      shutdown: async () => {},
    }) as never,
    resolveSessionLogPath: async () => null,
  };
}

test('getBackendProvider throws for unregistered backend', () => {
  assert.throws(
    () => getBackendProvider('test-nonexistent-backend'),
    /unsupported backend: test-nonexistent-backend/,
  );
});

test('registerBackend and getBackendProvider round-trip', () => {
  const provider = stubProvider('test-round-trip');
  registerBackend(provider);
  assert.equal(getBackendProvider('test-round-trip'), provider);
});

test('getRegisteredBackendIds includes registered backends', () => {
  registerBackend(stubProvider('test-list-a'));
  registerBackend(stubProvider('test-list-b'));
  const ids = getRegisteredBackendIds();
  assert.ok(ids.includes('test-list-a'));
  assert.ok(ids.includes('test-list-b'));
});

test('registerBackend replaces existing provider with same id', () => {
  const first = stubProvider('test-replace');
  const second = stubProvider('test-replace');
  registerBackend(first);
  registerBackend(second);
  assert.equal(getBackendProvider('test-replace'), second);
  assert.notEqual(getBackendProvider('test-replace'), first);
});

test('resolveRegisteredBackendId validates registered backend id', () => {
  registerBackend(stubProvider('test-registered'));
  assert.equal(resolveRegisteredBackendId('test-registered'), 'test-registered');
});

test('getKnownBackendNames includes registered ids', () => {
  registerBackend(stubProvider('test-known-id'));
  const names = getKnownBackendNames();
  assert.ok(names.has('test-known-id'));
});
