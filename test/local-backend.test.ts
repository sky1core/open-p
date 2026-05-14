import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildLocalClaudeCodeBackendRuntime,
  buildLocalClaudeCodeDescriptor,
  buildLocalClaudeCodeEnv,
  validateLocalBackendId,
} from '../src/backends/claude-code/local-backend.js';

test('builds isolated child env for local Claude Code backend', () => {
  const env = buildLocalClaudeCodeEnv({
    id: 'local-claude-code',
    anthropicBaseUrl: 'http://127.0.0.1:9999',
  });

  assert.deepEqual(env, {
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:9999',
  });
});

test('supports legacy baseUrl alias', () => {
  const env = buildLocalClaudeCodeEnv({
    id: 'local-claude-code',
    baseUrl: 'http://127.0.0.1:8888',
  });

  assert.deepEqual(env, {
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:8888',
  });
});

test('builds local descriptor metadata from configured models', () => {
  const descriptor = buildLocalClaudeCodeDescriptor({
    id: 'local-claude-code',
    label: 'Local Claude Code',
    defaultModel: 'local-sonnet',
    models: [
      {
        id: 'local-sonnet',
        maxContextTokens: 123_000,
        defaultReasoningEffort: 'medium',
        reasoningEfforts: ['low', 'medium', 'high'],
      },
    ],
  });

  assert.equal(descriptor.id, 'local-claude-code');
  assert.equal(descriptor.label, 'Local Claude Code');
  assert.equal(descriptor.defaultModel, 'local-sonnet');
  assert.deepEqual(descriptor.models, ['local-sonnet']);
  assert.equal(descriptor.contextWindowsByModel['local-sonnet'], 123_000);
  assert.equal(descriptor.defaultReasoningEffortsByModel['local-sonnet'], 'medium');
  assert.deepEqual(descriptor.reasoningEffortsByModel['local-sonnet'], ['low', 'medium', 'high']);
  assert.equal(descriptor.capabilities.persistentProcess, true);
  assert.equal(descriptor.capabilities.streaming, true);
  assert.equal(descriptor.capabilities.streamingGranularity, 'subturn');
});

test('builds a caller-ready local backend runtime for WorkerBridge defaults', () => {
  const runtime = buildLocalClaudeCodeBackendRuntime({
    id: 'local-claude-code',
    anthropicBaseUrl: 'http://127.0.0.1:9999',
    defaultModel: 'local-sonnet',
    models: [
      {
        id: 'local-sonnet',
        maxContextTokens: 123_000,
      },
    ],
  });

  assert.equal(runtime.id, 'local-claude-code');
  assert.equal(runtime.descriptor.id, 'local-claude-code');
  assert.deepEqual(runtime.workerDefaults, {
    local: true,
    env: {
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:9999',
    },
    model: 'local-sonnet',
    contextWindowsByModel: {
      'local-sonnet': 123_000,
    },
    contextWindow: null,
  });
});

test('fails closed when defaultModel is not one of the configured models', () => {
  assert.throws(
    () =>
      buildLocalClaudeCodeDescriptor({
        id: 'local-claude-code',
        defaultModel: 'missing-model',
        models: [{ id: 'local-sonnet' }],
      }),
    /defaultModel must match a configured model id/,
  );

  assert.throws(
    () =>
      buildLocalClaudeCodeBackendRuntime({
        id: 'local-claude-code',
        defaultModel: 'missing-model',
        models: [{ id: 'local-sonnet' }],
      }),
    /defaultModel must match a configured model id/,
  );
});

test('rejects local backend ids that collide with built-ins', () => {
  assert.throws(() => validateLocalBackendId('claude'), /must not collide/);
  assert.throws(() => validateLocalBackendId('codex'), /must not collide/);
});
