import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assertClaudeCodeBin, resolveClaudeCodeBin } from '../src/backends/claude/bin.js';
import { EXIT_CODES, OpenPError } from '../src/core/errors.js';

test('resolves Claude Code binary from command lookup', () => {
  assert.equal(resolveClaudeCodeBin(), 'claude');
});

test('rejects open-p shim as Claude Code binary', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openp-claude-bin-'));
  try {
    const fakeOpenP = join(dir, 'claude');
    await writeFile(fakeOpenP, '#!/bin/sh\necho "openp 0.1.0"\n');
    await chmod(fakeOpenP, 0o755);

    await assert.rejects(
      () => assertClaudeCodeBin(fakeOpenP),
      (error) =>
        error instanceof OpenPError &&
        error.exitCode === EXIT_CODES.backendStartFailed &&
        error.message.includes('the claude command must resolve to the real Claude Code binary'),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('accepts non-openp Claude Code version output', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openp-claude-bin-'));
  try {
    const fakeClaude = join(dir, 'claude');
    await writeFile(fakeClaude, '#!/bin/sh\necho "2.1.147"\n');
    await chmod(fakeClaude, 0o755);

    await assertClaudeCodeBin(fakeClaude);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('validates claude command lookup from the supplied cwd', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openp-claude-bin-'));
  try {
    const projectDir = join(dir, 'project');
    const realBinDir = join(dir, 'real-bin');
    await mkdir(projectDir);
    await mkdir(realBinDir);
    const fakeOpenP = join(projectDir, 'claude');
    const fakeClaude = join(realBinDir, 'claude');
    await writeFile(fakeOpenP, '#!/bin/sh\necho "openp 0.1.0"\n');
    await writeFile(fakeClaude, '#!/bin/sh\necho "2.1.147"\n');
    await chmod(fakeOpenP, 0o755);
    await chmod(fakeClaude, 0o755);

    await assert.rejects(
      () => assertClaudeCodeBin('claude', {
        cwd: projectDir,
        env: { PATH: `.:${realBinDir}:${process.env.PATH ?? ''}` },
      }),
      (error) =>
        error instanceof OpenPError &&
        error.exitCode === EXIT_CODES.backendStartFailed &&
        error.message.includes('the claude command must resolve to the real Claude Code binary'),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
