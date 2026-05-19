import assert from 'node:assert/strict';
import test from 'node:test';
import { registerBackend, getBackendProvider, getRegisteredBackendIds, getKnownBackendNames, resolveCanonicalBackendId } from '../src/core/backend-registry.js';
import type { BackendProvider } from '../src/core/backend.js';

function stubProvider(id: string, aliases: string[] = []): BackendProvider {
  return {
    id,
    aliases,
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

test('resolves alias to canonical provider', () => {
  const provider = stubProvider('test-alias-target', ['test-short']);
  registerBackend(provider);
  assert.equal(getBackendProvider('test-short'), provider);
  assert.equal(getBackendProvider('test-alias-target'), provider);
});

test('replacement cleans up stale aliases', () => {
  registerBackend(stubProvider('test-stale', ['test-old-alias']));
  assert.equal(getBackendProvider('test-old-alias').id, 'test-stale');
  registerBackend(stubProvider('test-stale', ['test-new-alias']));
  assert.throws(
    () => getBackendProvider('test-old-alias'),
    /unsupported backend: test-old-alias/,
  );
  assert.equal(getBackendProvider('test-new-alias').id, 'test-stale');
});

test('resolveCanonicalBackendId returns canonical id for alias', () => {
  registerBackend(stubProvider('test-canonical', ['test-canon-alias']));
  assert.equal(resolveCanonicalBackendId('test-canon-alias'), 'test-canonical');
  assert.equal(resolveCanonicalBackendId('test-canonical'), 'test-canonical');
});

test('getKnownBackendNames includes ids and aliases', () => {
  registerBackend(stubProvider('test-known-id', ['test-known-alias']));
  const names = getKnownBackendNames();
  assert.ok(names.has('test-known-id'));
  assert.ok(names.has('test-known-alias'));
});
