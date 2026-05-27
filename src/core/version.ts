import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface OpenPVersionInfo {
  readonly version: string;
  readonly gitCommit: string | null;
}

let cachedVersionInfo: OpenPVersionInfo | null = null;

export function getOpenPVersion(): string {
  return getOpenPVersionInfo().version;
}

export function getOpenPVersionInfo(): OpenPVersionInfo {
  cachedVersionInfo ??= resolveOpenPVersionInfo();
  return cachedVersionInfo;
}

function resolveOpenPVersionInfo(): OpenPVersionInfo {
  const packageRoot = findPackageRoot(dirname(fileURLToPath(import.meta.url)));
  if (!packageRoot) {
    return {
      version: '0.0.0-unknown',
      gitCommit: null,
    };
  }
  return {
    version: packageRoot.version,
    gitCommit: readGitCommit(packageRoot.path),
  };
}

function findPackageRoot(startDir: string): { readonly path: string; readonly version: string } | null {
  let dir = startDir;
  while (true) {
    const packageJsonPath = join(dir, 'package.json');
    try {
      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
        readonly name?: unknown;
        readonly version?: unknown;
      };
      if (packageJson.name === 'open-p' && typeof packageJson.version === 'string') {
        return { path: dir, version: packageJson.version };
      }
    } catch {
      // Keep walking toward the filesystem root.
    }

    const parent = dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

function readGitCommit(packageRoot: string): string | null {
  const gitPath = join(packageRoot, '.git');
  if (!existsSync(gitPath)) {
    return null;
  }
  try {
    const gitDir = statSync(gitPath).isDirectory()
      ? gitPath
      : resolve(packageRoot, parseGitDirFile(gitPath));
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
    if (!head) {
      return null;
    }
    if (!head.startsWith('ref: ')) {
      return shortCommit(head);
    }
    const refPath = join(gitDir, head.slice('ref: '.length));
    return shortCommit(readFileSync(refPath, 'utf8').trim());
  } catch {
    return null;
  }
}

function parseGitDirFile(path: string): string {
  const content = readFileSync(path, 'utf8').trim();
  if (!content.startsWith('gitdir:')) {
    throw new Error('invalid .git file');
  }
  return content.slice('gitdir:'.length).trim();
}

function shortCommit(commit: string): string | null {
  return /^[0-9a-f]{7,40}$/i.test(commit) ? commit.slice(0, 12) : null;
}
