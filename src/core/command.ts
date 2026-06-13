import { spawn } from 'node:child_process';
import { EXIT_CODES, OpenPError } from './errors.js';

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

export function execFileText(
  command: string,
  args: readonly string[],
  options: {
    readonly input?: string;
    readonly env?: Readonly<Record<string, string>>;
    readonly isolateEnvPrefixes?: readonly string[];
    readonly unsetEnv?: readonly string[];
    readonly cwd?: string;
  } = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: (options.env || options.isolateEnvPrefixes?.length || options.unsetEnv)
        ? buildChildEnv(options.env ?? {}, options.isolateEnvPrefixes ?? [], options.unsetEnv ?? [])
        : undefined,
      cwd: options.cwd,
    });
    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.stdin.on('error', () => {
      // Child exit status remains the source of truth for command success/failure.
    });

    child.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        reject(new OpenPError(`command not found: ${command}`, EXIT_CODES.backendNotFound));
        return;
      }
      reject(error);
    });

    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new OpenPError(`${command} exited with ${signal ?? `code ${code}`}${stderr ? `: ${stderr.trim()}` : ''}`, EXIT_CODES.backendStartFailed));
    });

    if (options.input !== undefined) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
  });
}

export function buildChildEnv(
  env: Readonly<Record<string, string>>,
  isolateEnvPrefixes: readonly string[] = [],
  unsetEnv: readonly string[] = [],
): NodeJS.ProcessEnv {
  const childEnv = { ...process.env };
  if (isolateEnvPrefixes.length > 0) {
    for (const key of Object.keys(childEnv)) {
      if (isolateEnvPrefixes.some((prefix) => key.startsWith(prefix))) {
        delete childEnv[key];
      }
    }
  }
  for (const key of unsetEnv) {
    delete childEnv[key];
  }
  return { ...childEnv, ...env };
}

export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}
