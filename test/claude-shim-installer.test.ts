import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

test('installs optional claude shim with the real Claude Code binary pinned', async () => {
  const repoRoot = process.cwd();
  const tempRoot = await mkdtemp(join(tmpdir(), 'openp-shim-'));
  const targetDir = join(tempRoot, 'bin');
  const realClaude = join(tempRoot, 'real-claude');
  const openpCli = join(tempRoot, 'openp-cli.js');

  await writeFile(realClaude, '#!/bin/sh\nexit 0\n', 'utf8');
  await chmod(realClaude, 0o755);
  await writeFile(openpCli, '#!/usr/bin/env node\n', 'utf8');

  const result = await execFileAsync(process.execPath, [
    join(repoRoot, 'scripts', 'install-claude-shim.mjs'),
    '--target-dir',
    targetDir,
    '--claude-bin',
    realClaude,
    '--openp-cli',
    openpCli,
  ], { encoding: 'utf8' });

  const shim = await readFile(join(targetDir, 'claude'), 'utf8');
  assert.match(result.stdout, /installed claude shim:/);
  assert.match(shim, new RegExp(`OPENP_CLAUDE_CODE_BIN=.*${escapeRegExp(realClaude)}`));
  assert.match(shim, new RegExp(`exec .*${escapeRegExp(openpCli)} "\\$@"`));
});

test('optional claude shim installer refuses to overwrite by default', async () => {
  const repoRoot = process.cwd();
  const tempRoot = await mkdtemp(join(tmpdir(), 'openp-shim-'));
  const targetDir = join(tempRoot, 'bin');
  const realClaude = join(tempRoot, 'real-claude');
  const openpCli = join(tempRoot, 'openp-cli.js');

  await writeFile(realClaude, '#!/bin/sh\nexit 0\n', 'utf8');
  await chmod(realClaude, 0o755);
  await writeFile(openpCli, '#!/usr/bin/env node\n', 'utf8');
  await execFileAsync(process.execPath, [
    join(repoRoot, 'scripts', 'install-claude-shim.mjs'),
    '--target-dir',
    targetDir,
    '--claude-bin',
    realClaude,
    '--openp-cli',
    openpCli,
  ], { encoding: 'utf8' });

  await assert.rejects(
    () => execFileAsync(process.execPath, [
      join(repoRoot, 'scripts', 'install-claude-shim.mjs'),
      '--target-dir',
      targetDir,
      '--claude-bin',
      realClaude,
      '--openp-cli',
      openpCli,
    ], { encoding: 'utf8' }),
    /already exists/,
  );
});

test('optional claude shim installer requires explicit real Claude Code binary', async () => {
  const repoRoot = process.cwd();
  const tempRoot = await mkdtemp(join(tmpdir(), 'openp-shim-'));

  await assert.rejects(
    () => execFileAsync(process.execPath, [
      join(repoRoot, 'scripts', 'install-claude-shim.mjs'),
      '--target-dir',
      join(tempRoot, 'bin'),
    ], { encoding: 'utf8' }),
    /--claude-bin <path>/,
  );
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
