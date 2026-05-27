import assert from 'node:assert/strict';
import test from 'node:test';
import { buildLaunchSignature, launchSignaturesEqual, stableLaunchSignatureKey } from '../src/core/launch-signature.js';

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
