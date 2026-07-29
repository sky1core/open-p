import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  loadConfiguredBackendInstances,
  resolveConfiguredBackendInstancesPath,
} from '../../src/core/configured-backend-instances.js';
import { EXIT_CODES, OpenPError } from '../../src/core/errors.js';

test('loads configured Claude backend instances from XDG config home', async () => {
  const { env } = await writeInstancesYaml(`
instances:
  claude-alt:
    backend: claude
    configDir: ~/.claude-alt
`);

  const instances = await loadConfiguredBackendInstances({ env });

  assert.deepEqual(instances, [{
    id: 'claude-alt',
    backend: 'claude',
    configDir: join(homedir(), '.claude-alt').normalize('NFC'),
  }]);
});

test('loads configured Codex backend instances from XDG config home', async () => {
  const { env } = await writeInstancesYaml(`
instances:
  codex-alt:
    backend: codex
    homeDir: ~/.codex-alt
`);

  const instances = await loadConfiguredBackendInstances({ env });

  assert.deepEqual(instances, [{
    id: 'codex-alt',
    backend: 'codex',
    homeDir: join(homedir(), '.codex-alt').normalize('NFC'),
  }]);
});

test('resolves the configured instances path from XDG config home', () => {
  assert.equal(
    resolveConfiguredBackendInstancesPath({ XDG_CONFIG_HOME: '/tmp/openp-config' }),
    '/tmp/openp-config/open-p/instances.yaml',
  );
});

test('uses the default config path when XDG config home is not absolute', () => {
  const expected = join(homedir(), '.config', 'open-p', 'instances.yaml');

  assert.equal(resolveConfiguredBackendInstancesPath({ XDG_CONFIG_HOME: 'relative-config' }), expected);
  assert.equal(resolveConfiguredBackendInstancesPath({ XDG_CONFIG_HOME: '~' }), expected);
  assert.equal(resolveConfiguredBackendInstancesPath({ XDG_CONFIG_HOME: '~/.config-alt' }), expected);
  assert.equal(resolveConfiguredBackendInstancesPath({ XDG_CONFIG_HOME: '' }), expected);
});

test('returns no instances when instances.yaml is absent', async () => {
  const configHome = await mkdtemp(join(tmpdir(), 'openp-empty-config-'));

  assert.deepEqual(
    await loadConfiguredBackendInstances({ env: { XDG_CONFIG_HOME: configHome } }),
    [],
  );
});

test('reports the cause when instances.yaml cannot be read', async () => {
  const path = await mkdtemp(join(tmpdir(), 'openp-config-read-failure-'));

  await assertUsageError(
    () => loadConfiguredBackendInstances({ path }),
    /failed to read configured backend instances: .*: (?:EISDIR|illegal operation|is a directory)/,
  );
});

test('rejects unknown root keys', async () => {
  const { env } = await writeInstancesYaml(`
instances: {}
extra: true
`);

  await assertUsageError(
    () => loadConfiguredBackendInstances({ env }),
    /root has unknown key: extra/,
  );
});

test('rejects unknown instance keys', async () => {
  const { env } = await writeInstancesYaml(`
instances:
  claude-alt:
    backend: claude
    configDir: ~/.claude-alt
    configdir: ~/.claude-wrong
`);

  await assertUsageError(
    () => loadConfiguredBackendInstances({ env }),
    /instance claude-alt has unknown key: configdir/,
  );
});

test('rejects relative instance configDir', async () => {
  const { env } = await writeInstancesYaml(`
instances:
  claude-alt:
    backend: claude
    configDir: .claude-alt
`);

  await assertUsageError(
    () => loadConfiguredBackendInstances({ env }),
    /configDir must be absolute or use ~/,
  );
});

test('rejects relative Codex instance homeDir', async () => {
  const { env } = await writeInstancesYaml(`
instances:
  codex-alt:
    backend: codex
    homeDir: .codex-alt
`);

  await assertUsageError(
    () => loadConfiguredBackendInstances({ env }),
    /homeDir must be absolute or use ~/,
  );
});

test('rejects instance entries missing backend', async () => {
  const { env } = await writeInstancesYaml(`
instances:
  claude-alt:
    configDir: ~/.claude-alt
`);

  await assertUsageError(
    () => loadConfiguredBackendInstances({ env }),
    /backend is required/,
  );
});

test('rejects instance entries missing configDir', async () => {
  const { env } = await writeInstancesYaml(`
instances:
  claude-alt:
    backend: claude
`);

  await assertUsageError(
    () => loadConfiguredBackendInstances({ env }),
    /configDir is required/,
  );
});

test('rejects Codex instance entries missing homeDir', async () => {
  const { env } = await writeInstancesYaml(`
instances:
  codex-alt:
    backend: codex
`);

  await assertUsageError(
    () => loadConfiguredBackendInstances({ env }),
    /homeDir is required/,
  );
});

test('rejects Claude instances with Codex homeDir', async () => {
  const { env } = await writeInstancesYaml(`
instances:
  claude-alt:
    backend: claude
    homeDir: ~/.codex-alt
`);

  await assertUsageError(
    () => loadConfiguredBackendInstances({ env }),
    /homeDir is not valid for backend claude/,
  );
});

test('rejects Codex instances with Claude configDir', async () => {
  const { env } = await writeInstancesYaml(`
instances:
  codex-alt:
    backend: codex
    configDir: ~/.claude-alt
`);

  await assertUsageError(
    () => loadConfiguredBackendInstances({ env }),
    /configDir is not valid for backend codex/,
  );
});

test('rejects unsupported instance backends', async () => {
  const { env } = await writeInstancesYaml(`
instances:
  kiro-alt:
    backend: kiro
    homeDir: ~/.kiro-alt
`);

  await assertUsageError(
    () => loadConfiguredBackendInstances({ env }),
    /backend kiro does not support configured instances/,
  );
});

test('rejects instance ids that are parsed as CLI options', async () => {
  const { env } = await writeInstancesYaml(`
instances:
  "-claude-alt":
    backend: claude
    configDir: ~/.claude-alt
`);

  await assertUsageError(
    () => loadConfiguredBackendInstances({ env }),
    /instance id must not start with -/,
  );
});

test('rejects instance ids containing whitespace', async () => {
  for (const instanceId of ['claude alt', 'claude\talt', 'claude\nalt']) {
    const { env } = await writeInstancesYaml(`
instances:
  ${JSON.stringify(instanceId)}:
    backend: claude
    configDir: ~/.claude-alt
`);

    await assertUsageError(
      () => loadConfiguredBackendInstances({ env }),
      /instance id must not contain whitespace/,
    );
  }
});

test('rejects instance ids that collide with built-in backends', async () => {
  const { env } = await writeInstancesYaml(`
instances:
  claude:
    backend: claude
    configDir: ~/.claude-alt
`);

  await assertUsageError(
    () => loadConfiguredBackendInstances({ env }),
    /instance id must not collide with built-in backend id: claude/,
  );
});

test('rejects instance ids that collide with top-level commands', async () => {
  for (const instanceId of ['seed', 'seed-status', 'auth-status']) {
    const { env } = await writeInstancesYaml(`
instances:
  ${JSON.stringify(instanceId)}:
    backend: claude
    configDir: ~/.claude-alt
`);

    await assertUsageError(
      () => loadConfiguredBackendInstances({ env }),
      new RegExp(`instance id must not collide with top-level command: ${instanceId}`),
    );
  }
});

test('rejects duplicate instance ids', async () => {
  const { env } = await writeInstancesYaml(`
instances:
  claude-alt:
    backend: claude
    configDir: ~/.claude-alt
  claude-alt:
    backend: claude
    configDir: ~/.claude-alt-2
`);

  await assertUsageError(
    () => loadConfiguredBackendInstances({ env }),
    /failed to parse configured backend instances/,
  );
});

test('rejects invalid YAML in instances.yaml', async () => {
  const { env } = await writeInstancesYaml('instances: [');

  await assertUsageError(
    () => loadConfiguredBackendInstances({ env }),
    /failed to parse configured backend instances/,
  );
});

async function writeInstancesYaml(text: string): Promise<{ readonly env: NodeJS.ProcessEnv }> {
  const configHome = await mkdtemp(join(tmpdir(), 'openp-config-'));
  const configDir = join(configHome, 'open-p');
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, 'instances.yaml'), text.trimStart());
  return { env: { XDG_CONFIG_HOME: configHome } };
}

async function assertUsageError(
  run: () => Promise<unknown>,
  message: RegExp,
): Promise<void> {
  await assert.rejects(
    run,
    (error) => error instanceof OpenPError &&
      error.exitCode === EXIT_CODES.usage &&
      message.test(error.message),
  );
}
