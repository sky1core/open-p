import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requireLocalModel } from '../src/backends/opencode/args.js';
import { buildOpenCodePrivateEnv, sanitizeOpenCodeEnv } from '../src/backends/opencode/env.js';

test('sanitizeOpenCodeEnv strips cloud provider and backend-specific environment', () => {
  const env = sanitizeOpenCodeEnv({
    PATH: '/bin',
    OPENAI_API_KEY: 'openai-secret',
    ANTHROPIC_API_KEY: 'anthropic-secret',
    GITHUB_TOKEN: 'github-secret',
    AWS_SECRET: 'aws-secret',
    AWS_ACCESS_KEY_ID: 'aws-access',
    AWS_SECRET_ACCESS_KEY: 'aws-secret-access',
    SSH_AUTH_SOCK: '/tmp/ssh.sock',
    PRIVATE_KEY: 'private-key',
    OPENCODE_CONFIG: 'unsafe',
    CLAUDE_CONFIG_DIR: '/tmp/claude',
    CODEX_HOME: '/tmp/codex',
  });
  assert.equal(env.PATH, '/bin');
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.AWS_SECRET, undefined);
  assert.equal(env.AWS_ACCESS_KEY_ID, undefined);
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(env.SSH_AUTH_SOCK, undefined);
  assert.equal(env.PRIVATE_KEY, undefined);
  assert.equal(env.OPENCODE_CONFIG, undefined);
  assert.equal(env.CLAUDE_CONFIG_DIR, undefined);
  assert.equal(env.CODEX_HOME, undefined);
});

test('buildOpenCodePrivateEnv injects only the selected localhost provider config', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'openp-opencode-project-'));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-opencode-state-'));
  try {
    const privateEnv = await buildOpenCodePrivateEnv(
      projectRoot,
      { PATH: '/bin', XDG_STATE_HOME: stateRoot },
      requireLocalModel('mlx-lm/qwen-coder'),
    );
    const config = JSON.parse(privateEnv.env.OPENCODE_CONFIG_CONTENT ?? '{}');
    assert.equal(config.share, 'disabled');
    assert.deepEqual(config.mcp, {});
    assert.deepEqual(config.plugin, []);
    assert.deepEqual(Object.keys(config.provider), ['mlx-lm']);
    assert.equal(config.provider['mlx-lm'].npm, '@ai-sdk/openai-compatible');
    assert.equal(config.provider['mlx-lm'].options.baseURL, 'http://localhost:8091/v1');
    assert.deepEqual(Object.keys(config.provider['mlx-lm'].models), ['qwen-coder']);
    assert.equal(privateEnv.env.OPENCODE_DISABLE_AUTOUPDATE, '1');
    assert.equal(privateEnv.env.OPENCODE_DISABLE_MODELS_FETCH, '1');
    assert.equal(privateEnv.env.OPENCODE_DISABLE_PROJECT_CONFIG, '1');
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(stateRoot, { recursive: true, force: true });
  }
});
