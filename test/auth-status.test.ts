import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runCommand } from './helpers/cli-integration.js';

const FIXTURE = join(import.meta.dirname, 'fixtures', 'auth-status', 'fake-auth-cli.mjs');

test('auth-status reports only login booleans for built-ins and configured instances', async () => {
  const env = await createAuthStatusEnv();
  const result = await runOpenPAuthStatus(env);

  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), {
    openp: {
      version: 1,
      backends: [
        { id: 'claude', backend: 'claude', loggedIn: true },
        { id: 'codex', backend: 'codex', loggedIn: true },
        { id: 'kiro', backend: 'kiro', loggedIn: true },
        { id: 'claude-alt', backend: 'claude', loggedIn: false },
        { id: 'codex-alt', backend: 'codex', loggedIn: false },
      ],
    },
  });
  assert.equal(result.stdout.includes('must-not-leak'), false);
});

test('auth-status fails without stdout when a native login result is unsupported', async () => {
  const env = await createAuthStatusEnv({ OPENP_FAKE_KIRO_LOGIN: 'malformed' });
  const result = await runOpenPAuthStatus(env);

  assert.equal(result.code, 11);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Kiro returned an unsupported login status/);
  assert.equal(result.stderr.includes('must-not-leak'), false);
});

test('auth-status reports Kiro account null as logged out', async () => {
  const env = await createAuthStatusEnv({ OPENP_FAKE_KIRO_LOGIN: 'false' });
  const result = await runOpenPAuthStatus(env);

  assert.equal(result.code, 0);
  const output = JSON.parse(result.stdout) as {
    readonly openp: { readonly backends: Array<{ readonly id: string; readonly loggedIn: boolean }> };
  };
  assert.deepEqual(
    output.openp.backends.find((backend) => backend.id === 'kiro'),
    { id: 'kiro', backend: 'kiro', loggedIn: false },
  );
});

test('auth-status rejects options and trailing arguments', async () => {
  const env = await createAuthStatusEnv();
  const repoRoot = process.cwd();
  const result = await runCommand(
    join(repoRoot, 'dist', 'src', 'cli.js'),
    ['auth-status', '--output-format', 'json'],
    repoRoot,
    env,
  );

  assert.equal(result.code, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /auth-status does not accept options or arguments/);
});

async function runOpenPAuthStatus(env: NodeJS.ProcessEnv) {
  const repoRoot = process.cwd();
  return runCommand(
    join(repoRoot, 'dist', 'src', 'cli.js'),
    ['auth-status'],
    repoRoot,
    env,
  );
}

async function createAuthStatusEnv(overrides: NodeJS.ProcessEnv = {}): Promise<NodeJS.ProcessEnv> {
  const root = await mkdtemp(join(tmpdir(), 'openp-auth-status-'));
  const binDir = join(root, 'bin');
  const configHome = join(root, 'config');
  const claudeAlt = join(root, 'claude-alt');
  const codexBase = join(root, 'codex-base');
  const codexAlt = join(root, 'codex-alt');
  await mkdir(binDir, { recursive: true });
  await mkdir(join(configHome, 'open-p'), { recursive: true });
  for (const backend of ['claude', 'codex', 'kiro']) {
    const command = backend === 'kiro' ? 'kiro-cli' : backend;
    const path = join(binDir, command);
    await writeFile(path, [
      '#!/bin/sh',
      `exec ${shellQuote(process.execPath)} ${shellQuote(FIXTURE)} ${backend} "$@"`,
      '',
    ].join('\n'));
    await chmod(path, 0o755);
  }
  await writeFile(join(configHome, 'open-p', 'instances.yaml'), [
    'instances:',
    '  claude-alt:',
    '    backend: claude',
    `    configDir: ${claudeAlt}`,
    '  codex-alt:',
    '    backend: codex',
    `    homeDir: ${codexAlt}`,
    '',
  ].join('\n'));
  return {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    XDG_CONFIG_HOME: configHome,
    CLAUDE_CONFIG_DIR: join(root, 'ambient-claude-must-be-unset'),
    CODEX_HOME: codexBase,
    OPENP_FAKE_LOGGED_OUT_CLAUDE_DIR: claudeAlt,
    OPENP_FAKE_LOGGED_OUT_CODEX_HOME: codexAlt,
    ...overrides,
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
