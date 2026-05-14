#!/usr/bin/env node

import { constants } from 'node:fs';
import { access, chmod, mkdir, stat, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENV_NAME = 'OPENP_CLAUDE_CODE_BIN';

async function main(argv) {
  const options = parseArgs(argv);
  if (!options.targetDir || !options.claudeBin) {
    throw new Error('usage: node scripts/install-claude-shim.mjs --target-dir <dir> --claude-bin <path> [--openp-cli <path>] [--force]');
  }

  const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const targetDir = resolve(options.targetDir);
  const openpCli = resolve(options.openpCli ?? join(repoRoot, 'dist', 'src', 'cli.js'));
  const realClaude = resolve(options.claudeBin);

  await ensureExecutable(realClaude, 'real Claude Code binary');
  await ensureReadable(openpCli, 'openp CLI');
  await installClaudeShim({
    targetDir,
    openpCli,
    nodeBin: process.execPath,
    realClaude,
    force: options.force,
  });
  process.stdout.write(`installed claude shim: ${join(targetDir, 'claude')}\n`);
  process.stdout.write(`${ENV_NAME}=${realClaude}\n`);
}

export async function installClaudeShim(options) {
  await mkdir(options.targetDir, { recursive: true });
  const target = join(options.targetDir, 'claude');
  if (!options.force && await exists(target)) {
    throw new Error(`${target} already exists; pass --force to replace it`);
  }
  await writeFile(target, buildClaudeShimScript({
    nodeBin: options.nodeBin,
    openpCli: options.openpCli,
    realClaude: options.realClaude,
  }), { mode: 0o755 });
  await chmod(target, 0o755);
}

export function buildClaudeShimScript(options) {
  return [
    '#!/bin/sh',
    `export ${ENV_NAME}=${shellQuote(options.realClaude)}`,
    `exec ${shellQuote(options.nodeBin)} ${shellQuote(options.openpCli)} "$@"`,
    '',
  ].join('\n');
}

function parseArgs(argv) {
  const options = {
    targetDir: null,
    claudeBin: null,
    openpCli: null,
    force: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--force') {
      options.force = true;
      continue;
    }
    if (arg === '--target-dir' || arg === '--claude-bin' || arg === '--openp-cli') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`missing value for ${arg}`);
      }
      index += 1;
      if (arg === '--target-dir') options.targetDir = value;
      if (arg === '--claude-bin') options.claudeBin = value;
      if (arg === '--openp-cli') options.openpCli = value;
      continue;
    }
    throw new Error(`unsupported option: ${arg}`);
  }
  return options;
}

async function ensureExecutable(path, label) {
  if (!path) {
    throw new Error(`${label} path is required`);
  }
  if (!await isExecutable(path)) {
    throw new Error(`${label} is not executable: ${path}`);
  }
}

async function ensureReadable(path, label) {
  if (!path) {
    throw new Error(`${label} path is required`);
  }
  try {
    const info = await stat(path);
    if (!info.isFile()) {
      throw new Error(`${label} is not a file: ${path}`);
    }
    await access(path, constants.R_OK);
  } catch (error) {
    if (error instanceof Error && error.message.includes('is not a file')) {
      throw error;
    }
    throw new Error(`${label} is not readable: ${path}`);
  }
}

async function isExecutable(path) {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
