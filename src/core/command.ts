import { spawn } from 'node:child_process';
import { EXIT_CODES, OpenPError } from './errors.js';

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

export function execFileText(
  command: string,
  args: readonly string[],
  options: { input?: string; env?: Readonly<Record<string, string>>; isolateAnthropicEnv?: boolean } = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: options.env || options.isolateAnthropicEnv ? buildChildEnv(options.env ?? {}, options.isolateAnthropicEnv ?? false) : undefined,
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

export function buildChildEnv(env: Readonly<Record<string, string>>, isolateAnthropicEnv: boolean): NodeJS.ProcessEnv {
  const childEnv = { ...process.env };
  if (isolateAnthropicEnv) {
    for (const key of Object.keys(childEnv)) {
      if (key.startsWith('ANTHROPIC_')) {
        delete childEnv[key];
      }
    }
  }
  return { ...childEnv, ...env };
}

export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}
