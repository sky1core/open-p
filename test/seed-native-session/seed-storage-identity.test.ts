import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { BackendProvider } from '../../src/core/backend.js';
import { createClaudeBackendProvider } from '../../src/backends/claude/index.js';
import { createCodexBackendProvider } from '../../src/backends/codex/index.js';
import { kiroBackendProvider } from '../../src/backends/kiro/index.js';
import { opencodeBackendProvider } from '../../src/backends/opencode/index.js';

async function digest(provider: BackendProvider, cwd: string): Promise<string> {
  assert.ok(provider.resolveSeedStorageIdentity);
  const identity = await provider.resolveSeedStorageIdentity({ cwd });
  assert.equal(identity.scheme, 'openp-native-store-v1');
  assert.match(identity.digest, /^[0-9a-f]{64}$/);
  return identity.digest;
}

test('seed storage identities follow each backend effective native storage locator', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'openp-seed-identity-cwd-'));
  const rootA = await mkdtemp(join(tmpdir(), 'openp-seed-identity-a-'));
  const rootB = await mkdtemp(join(tmpdir(), 'openp-seed-identity-b-'));
  const previous = {
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    CODEX_HOME: process.env.CODEX_HOME,
    HOME: process.env.HOME,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
  };
  try {
    const configuredClaudeA = createClaudeBackendProvider({ id: 'claude-alt', configDir: rootA });
    const configuredClaudeB = createClaudeBackendProvider({ id: 'claude-alt', configDir: rootB });
    assert.notEqual(await digest(configuredClaudeA, cwd), await digest(configuredClaudeB, cwd));
    process.env.CLAUDE_CONFIG_DIR = rootA;
    const baseClaudeA = await digest(createClaudeBackendProvider(), cwd);
    process.env.CLAUDE_CONFIG_DIR = rootB;
    assert.equal(await digest(createClaudeBackendProvider(), cwd), baseClaudeA);

    const configuredCodex = createCodexBackendProvider({ id: 'codex-alt', homeDir: rootA });
    process.env.CODEX_HOME = rootA;
    const configuredCodexA = await digest(configuredCodex, cwd);
    process.env.CODEX_HOME = rootB;
    assert.equal(await digest(configuredCodex, cwd), configuredCodexA);
    process.env.CODEX_HOME = rootA;
    const baseCodexA = await digest(createCodexBackendProvider(), cwd);
    process.env.CODEX_HOME = rootB;
    assert.notEqual(await digest(createCodexBackendProvider(), cwd), baseCodexA);

    process.env.HOME = rootA;
    const kiroA = await digest(kiroBackendProvider, cwd);
    process.env.HOME = rootB;
    assert.notEqual(await digest(kiroBackendProvider, cwd), kiroA);

    process.env.XDG_STATE_HOME = rootA;
    const openCodeA = await digest(opencodeBackendProvider, cwd);
    process.env.XDG_STATE_HOME = rootB;
    assert.notEqual(await digest(opencodeBackendProvider, cwd), openCodeA);

    const lexicalAlias = join(rootA, 'nested', '..');
    assert.equal(
      await digest(createCodexBackendProvider({ id: 'codex-alt', homeDir: lexicalAlias }), cwd),
      configuredCodexA,
    );
    assert.notEqual(
      await digest(createCodexBackendProvider({ id: 'codex-other', homeDir: rootA }), cwd),
      configuredCodexA,
    );
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
});
