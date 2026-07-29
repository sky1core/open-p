import assert from 'node:assert/strict';
import test from 'node:test';
import { buildLaunchSignature, launchSignaturesEqual, stableLaunchSignatureKey } from '../../src/core/launch-signature.js';

test('builds a stable launch signature with sorted env keys', () => {
  const first = buildLaunchSignature({
    backendId: 'claude',
    bin: 'claude',
    binArgs: ['--allowedTools', 'Bash'],
    model: 'claude-haiku',
    reasoningEffort: 'medium',
    executionMode: 'danger-full-access',
    tools: 'Read',
    jsonSchema: '{"type":"object"}',
    env: {
      ZED: 'last',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:9999',
    },
    local: true,
  });
  const second = buildLaunchSignature({
    backendId: 'claude',
    bin: 'claude',
    binArgs: ['--allowedTools', 'Bash'],
    model: 'claude-haiku',
    reasoningEffort: 'medium',
    executionMode: 'danger-full-access',
    tools: 'Read',
    jsonSchema: '{"type":"object"}',
    env: {
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:9999',
      ZED: 'last',
    },
    local: true,
  });

  assert.equal(stableLaunchSignatureKey(first), stableLaunchSignatureKey(second));
  assert.equal(launchSignaturesEqual(first, second), true);
});

test('detects model, reasoning, permission, tools, json schema, env, and arg changes', () => {
  const base = buildLaunchSignature({
    backendId: 'claude',
    bin: 'claude',
    binArgs: ['--allowedTools', 'Bash'],
    model: 'claude-haiku',
    reasoningEffort: 'medium',
    executionMode: 'danger-full-access',
    tools: 'Read',
    jsonSchema: '{"type":"object"}',
    env: {
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:9999',
    },
    local: true,
  });

  for (const changed of [
    buildLaunchSignature({ ...base, model: 'claude-sonnet' }),
    buildLaunchSignature({ ...base, reasoningEffort: 'high' }),
    buildLaunchSignature({ ...base, executionMode: 'acceptEdits' }),
    buildLaunchSignature({ ...base, tools: 'Bash' }),
    buildLaunchSignature({ ...base, jsonSchema: '{"type":"array"}' }),
    buildLaunchSignature({ ...base, env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8888' } }),
    buildLaunchSignature({ ...base, binArgs: ['--allowedTools', 'Read'] }),
  ]) {
    assert.equal(launchSignaturesEqual(base, changed), false);
  }
});

test('treats different native permission modes as different launch signatures', () => {
  // A live PTY carries the mode it was started with. Leaving the mode out of the reuse key would
  // hand a turn asking for one mode to a process already running under another, and the caller
  // would never learn its request was dropped.
  const base = {
    backendId: 'claude',
    bin: 'claude',
    binArgs: [],
    env: {},
    local: true,
  } as const;
  const first = buildLaunchSignature({ ...base, nativeExecutionMode: 'fixture-mode-alpha' });
  const second = buildLaunchSignature({ ...base, nativeExecutionMode: 'fixture-mode-beta' });

  assert.notEqual(stableLaunchSignatureKey(first), stableLaunchSignatureKey(second));
  assert.equal(launchSignaturesEqual(first, second), false);
  assert.equal(launchSignaturesEqual(first, buildLaunchSignature({ ...base, nativeExecutionMode: 'fixture-mode-alpha' })), true);
});
