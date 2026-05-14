import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  loadLocalClaudeCodeBackendRuntimesFromModelsYaml,
  loadLocalClaudeCodeBackendsFromModelsYaml,
} from '../src/backends/claude-code/models-config.js';

test('loads claude-code local backends from config models yaml arrays', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openp-models-'));
  const path = join(dir, 'models.yaml');
  await writeFile(path, [
    'backends:',
    '  - id: local-claude-code',
    '    kind: claude-code',
    '    label: Local Claude Code',
    '    anthropicBaseUrl: http://127.0.0.1:9999',
    '    defaultModel: local-sonnet',
    '    models:',
    '      - id: local-sonnet',
    '        maxContextTokens: 123000',
    '        defaultReasoningEffort: medium',
    '        reasoningEfforts: [low, medium, high]',
    '  - id: other',
    '    kind: openai',
    '',
  ].join('\n'));

  const backends = await loadLocalClaudeCodeBackendsFromModelsYaml(path);

  assert.equal(backends.length, 1);
  assert.equal(backends[0]?.id, 'local-claude-code');
  assert.equal(backends[0]?.anthropicBaseUrl, 'http://127.0.0.1:9999');
  assert.equal(backends[0]?.models?.[0]?.maxContextTokens, 123_000);
  assert.deepEqual(backends[0]?.models?.[0]?.reasoningEfforts, ['low', 'medium', 'high']);
});

test('loads claude-code local backends from config backend maps', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openp-models-'));
  const path = join(dir, 'models.yaml');
  await writeFile(path, [
    'backends:',
    '  local-claude-code:',
    '    kind: claude-code',
    '    baseUrl: http://127.0.0.1:8888',
    '',
  ].join('\n'));

  const backends = await loadLocalClaudeCodeBackendsFromModelsYaml(path);

  assert.equal(backends.length, 1);
  assert.equal(backends[0]?.id, 'local-claude-code');
  assert.equal(backends[0]?.baseUrl, 'http://127.0.0.1:8888');
});

test('loads caller-ready local backend runtimes from config models yaml', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openp-models-'));
  const path = join(dir, 'models.yaml');
  await writeFile(path, [
    'backends:',
    '  local-claude-code:',
    '    kind: claude-code',
    '    anthropicBaseUrl: http://127.0.0.1:9999',
    '    defaultModel: local-sonnet',
    '    models:',
    '      - id: local-sonnet',
    '        maxContextTokens: 123000',
    '',
  ].join('\n'));

  const runtimes = await loadLocalClaudeCodeBackendRuntimesFromModelsYaml(path);

  assert.equal(runtimes.length, 1);
  assert.equal(runtimes[0]?.id, 'local-claude-code');
  assert.equal(runtimes[0]?.descriptor.defaultModel, 'local-sonnet');
  assert.equal(runtimes[0]?.workerDefaults.local, true);
  assert.deepEqual(runtimes[0]?.workerDefaults.env, {
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:9999',
  });
  assert.deepEqual(runtimes[0]?.workerDefaults.contextWindowsByModel, {
    'local-sonnet': 123_000,
  });
});

test('fails closed when claude-code backend or model id is missing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openp-models-'));
  const missingBackendId = join(dir, 'missing-backend-id.yaml');
  const missingModelId = join(dir, 'missing-model-id.yaml');
  await writeFile(missingBackendId, 'kind: claude-code\n');
  await writeFile(missingModelId, [
    'id: local-claude-code',
    'kind: claude-code',
    'models:',
    '  - maxContextTokens: 1',
    '',
  ].join('\n'));

  await assert.rejects(() => loadLocalClaudeCodeBackendsFromModelsYaml(missingBackendId), /requires id/);
  await assert.rejects(() => loadLocalClaudeCodeBackendsFromModelsYaml(missingModelId), /model config requires id/);
});

test('fails closed when defaultModel is absent from configured models in models yaml', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openp-models-'));
  const path = join(dir, 'default-model-missing.yaml');
  await writeFile(path, [
    'backends:',
    '  local-claude-code:',
    '    kind: claude-code',
    '    defaultModel: missing-model',
    '    models:',
    '      - id: local-sonnet',
    '        maxContextTokens: 123000',
    '',
  ].join('\n'));

  await assert.rejects(
    () => loadLocalClaudeCodeBackendsFromModelsYaml(path),
    /defaultModel must match a configured model id/,
  );
  await assert.rejects(
    () => loadLocalClaudeCodeBackendRuntimesFromModelsYaml(path),
    /defaultModel must match a configured model id/,
  );
});
