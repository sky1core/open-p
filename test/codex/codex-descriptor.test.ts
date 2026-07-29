import assert from 'node:assert/strict';
import test from 'node:test';
import { CODEX_DESCRIPTOR } from '../../src/backends/codex/descriptor.js';
import { createCodexBackendProvider } from '../../src/backends/codex/index.js';

test('Codex descriptor publishes backend identity and implemented capabilities', () => {
  assert.equal(CODEX_DESCRIPTOR.id, 'codex');
  assert.notEqual(CODEX_DESCRIPTOR.id, 'claude');
  assert.deepEqual(CODEX_DESCRIPTOR.capabilities, {
    streaming: true,
    streamingGranularity: 'subturn',
    backgroundAssistant: false,
    reasoningContent: true,
    abort: true,
    persistentProcess: false,
  });
});

test('Codex descriptor leaves model metadata to backend discovery', () => {
  assert.equal(CODEX_DESCRIPTOR.defaultModel, null);
  assert.deepEqual(CODEX_DESCRIPTOR.models, []);
  assert.equal(CODEX_DESCRIPTOR.contextWindow, null);
  assert.deepEqual(CODEX_DESCRIPTOR.contextWindowsByModel, {});
});

test('Codex descriptor declares execution modes', () => {
  assert.deepEqual(CODEX_DESCRIPTOR.executionModes, ['default', 'danger-full-access']);
});

test('Codex descriptor does not advertise a hardcoded reasoning effort catalog', () => {
  assert.deepEqual(CODEX_DESCRIPTOR.reasoningEfforts, []);
});

test('configured Codex provider descriptor uses the instance id', () => {
  const provider = createCodexBackendProvider({
    id: 'codex-alt',
    homeDir: '/tmp/openp-codex-alt',
  });

  assert.equal(provider.id, 'codex-alt');
  assert.equal(provider.descriptor.id, 'codex-alt');
  assert.equal(provider.descriptor.label, 'codex-alt');
  assert.equal(provider.descriptor.commandDisplay, CODEX_DESCRIPTOR.commandDisplay);
});
