import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileText } from '../src/core/command.js';

const PRINT_ANTHROPIC_ENV = [
  '-e',
  "process.stdout.write(JSON.stringify({base: process.env.ANTHROPIC_BASE_URL ?? null, extra: process.env.ANTHROPIC_TEST_ENV ?? null}))",
];

test('execFileText preserves ambient Anthropic env unless isolation is requested', async () => {
  const previousBaseUrl = process.env.ANTHROPIC_BASE_URL;
  const previousExtra = process.env.ANTHROPIC_TEST_ENV;
  process.env.ANTHROPIC_BASE_URL = 'ambient-base';
  process.env.ANTHROPIC_TEST_ENV = 'ambient-extra';
  try {
    const inherited = await execFileText(process.execPath, PRINT_ANTHROPIC_ENV, { env: {} });
    assert.deepEqual(JSON.parse(inherited.stdout), {
      base: 'ambient-base',
      extra: 'ambient-extra',
    });

    const isolated = await execFileText(process.execPath, PRINT_ANTHROPIC_ENV, {
      env: {},
      isolateAnthropicEnv: true,
    });
    assert.deepEqual(JSON.parse(isolated.stdout), {
      base: null,
      extra: null,
    });

    const explicit = await execFileText(process.execPath, PRINT_ANTHROPIC_ENV, {
      env: { ANTHROPIC_BASE_URL: 'explicit-base' },
      isolateAnthropicEnv: true,
    });
    assert.deepEqual(JSON.parse(explicit.stdout), {
      base: 'explicit-base',
      extra: null,
    });
  } finally {
    restoreEnv('ANTHROPIC_BASE_URL', previousBaseUrl);
    restoreEnv('ANTHROPIC_TEST_ENV', previousExtra);
  }
});

function restoreEnv(key: 'ANTHROPIC_BASE_URL' | 'ANTHROPIC_TEST_ENV', value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}
