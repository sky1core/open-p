import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requireLocalModel } from '../src/backends/opencode/args.js';
import {
  buildOpenCodeHistoryEnv,
  buildOpenCodePrivateEnv,
  sanitizeOpenCodeEnv,
} from '../src/backends/opencode/env.js';

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
    OPENCODE_CONFIG: 'blocked-value',
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

test('buildOpenCodePrivateEnv supplies only the selected localhost provider config', async () => {
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

test('buildOpenCodePrivateEnv keeps its exact turn-path env shape after the shared-base refactor', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'openp-opencode-project-'));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-opencode-state-'));
  try {
    // XDG_STATE_HOME selects the isolated root but is not itself a passthrough variable.
    const baseEnv = { PATH: '/bin', TMPDIR: '/tmp', XDG_STATE_HOME: stateRoot };
    const turn = await buildOpenCodePrivateEnv(projectRoot, baseEnv, requireLocalModel('mlx-lm/qwen-coder'));

    assert.deepEqual(Object.keys(turn.env).sort(), [
      'HOME',
      'OPENCODE_CONFIG_CONTENT',
      'OPENCODE_DISABLE_AUTOUPDATE',
      'OPENCODE_DISABLE_MODELS_FETCH',
      'OPENCODE_DISABLE_PROJECT_CONFIG',
      'PATH',
      'TMPDIR',
      'XDG_CACHE_HOME',
      'XDG_CONFIG_HOME',
      'XDG_DATA_HOME',
    ]);
    assert.equal(turn.env.PATH, '/bin');
    assert.equal(turn.env.TMPDIR, '/tmp');
    assert.equal(turn.env.HOME, turn.homeDir);
    assert.equal(turn.env.XDG_CONFIG_HOME, turn.configDir);
    assert.equal(turn.env.XDG_DATA_HOME, turn.dataDir);
    assert.equal(turn.env.XDG_CACHE_HOME, turn.cacheDir);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test('buildOpenCodeHistoryEnv equals the turn env exactly minus OPENCODE_CONFIG_CONTENT', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'openp-opencode-project-'));
  const stateRoot = await mkdtemp(join(tmpdir(), 'openp-opencode-state-'));
  try {
    const baseEnv = { PATH: '/bin', TMPDIR: '/tmp', XDG_STATE_HOME: stateRoot };
    const turn = await buildOpenCodePrivateEnv(projectRoot, baseEnv, requireLocalModel('mlx-lm/qwen-coder'));
    const history = await buildOpenCodeHistoryEnv(projectRoot, baseEnv);

    // Identical isolated directory layout so the history runs see the same session store as turns.
    assert.equal(history.homeDir, turn.homeDir);
    assert.equal(history.configDir, turn.configDir);
    assert.equal(history.dataDir, turn.dataDir);
    assert.equal(history.cacheDir, turn.cacheDir);

    // The history env drops exactly OPENCODE_CONFIG_CONTENT; no model provider config is present.
    assert.equal(history.env.OPENCODE_CONFIG_CONTENT, undefined);
    assert.equal(typeof turn.env.OPENCODE_CONFIG_CONTENT, 'string');
    assert.deepEqual(
      Object.keys(turn.env).filter((key) => key !== 'OPENCODE_CONFIG_CONTENT').sort(),
      Object.keys(history.env).sort(),
    );
    for (const key of Object.keys(history.env)) {
      assert.equal(history.env[key], turn.env[key], `env ${key} must match the turn env byte-for-byte`);
    }
    // Turn env is reconstructible as the history env plus only the model config content.
    assert.deepEqual(
      { ...history.env, OPENCODE_CONFIG_CONTENT: turn.env.OPENCODE_CONFIG_CONTENT },
      turn.env,
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(stateRoot, { recursive: true, force: true });
  }
});
