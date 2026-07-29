import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileText } from '../../src/core/command.js';

const PRINT_ANTHROPIC_ENV = [
  '-e',
  "process.stdout.write(JSON.stringify({base: process.env.ANTHROPIC_BASE_URL ?? null, extra: process.env.ANTHROPIC_TEST_ENV ?? null}))",
];

const PRINT_CLAUDE_CONFIG_ENV = [
  '-e',
  "process.stdout.write(JSON.stringify({configDir: process.env.CLAUDE_CONFIG_DIR ?? null}))",
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
      isolateEnvPrefixes: ['ANTHROPIC_'],
    });
    assert.deepEqual(JSON.parse(isolated.stdout), {
      base: null,
      extra: null,
    });

    const explicit = await execFileText(process.execPath, PRINT_ANTHROPIC_ENV, {
      env: { ANTHROPIC_BASE_URL: 'explicit-base' },
      isolateEnvPrefixes: ['ANTHROPIC_'],
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

test('execFileText can unset ambient Claude config dir and preserve explicit instance config dir', async () => {
  const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = '/tmp/ambient-claude';
  try {
    const isolated = await execFileText(process.execPath, PRINT_CLAUDE_CONFIG_ENV, {
      env: {},
      unsetEnv: ['CLAUDE_CONFIG_DIR'],
    });
    assert.deepEqual(JSON.parse(isolated.stdout), {
      configDir: null,
    });

    const explicit = await execFileText(process.execPath, PRINT_CLAUDE_CONFIG_ENV, {
      env: { CLAUDE_CONFIG_DIR: '/tmp/openp-claude-alt' },
      unsetEnv: ['CLAUDE_CONFIG_DIR'],
    });
    assert.deepEqual(JSON.parse(explicit.stdout), {
      configDir: '/tmp/openp-claude-alt',
    });
  } finally {
    restoreEnv('CLAUDE_CONFIG_DIR', previousConfigDir);
  }
});

test('execFileText settles when child closes stdin before input is written', async () => {
  const uncaughtErrors: unknown[] = [];
  const onUncaughtException = (error: unknown): void => {
    uncaughtErrors.push(error);
  };
  process.prependListener('uncaughtException', onUncaughtException);
  try {
    const result = await execFileText('bash', ['-c', 'exec 0<&-; sleep 0.2; exit 0'], {
      input: 'x'.repeat(64 * 1024 * 1024),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.deepEqual(result, { stdout: '', stderr: '' });
    assert.deepEqual(uncaughtErrors, []);
  } finally {
    process.removeListener('uncaughtException', onUncaughtException);
  }
});

function restoreEnv(
  key: 'ANTHROPIC_BASE_URL' | 'ANTHROPIC_TEST_ENV' | 'CLAUDE_CONFIG_DIR',
  value: string | undefined,
): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}
