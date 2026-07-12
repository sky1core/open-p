import { spawn } from 'node:child_process';
import { buildChildEnv } from './command.js';
import { EXIT_CODES, OpenPError } from './errors.js';

const LOGIN_PROBE_TIMEOUT_MS = 5_000;
const LOGIN_PROBE_OUTPUT_LIMIT_BYTES = 64 * 1024;
const LOGIN_PROBE_CLOSE_GRACE_MS = 250;

export interface NativeLoginProbeResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export function runNativeLoginProbe(
  command: string,
  args: readonly string[],
  options: {
    readonly env?: Readonly<Record<string, string>>;
    readonly isolateEnvPrefixes?: readonly string[];
    readonly unsetEnv?: readonly string[];
    readonly timeoutMs?: number;
  } = {},
): Promise<NativeLoginProbeResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: (options.env || options.isolateEnvPrefixes?.length || options.unsetEnv)
        ? buildChildEnv(options.env ?? {}, options.isolateEnvPrefixes ?? [], options.unsetEnv ?? [])
        : undefined,
    });
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let timedOut = false;
    let outputExceeded = false;
    let settled = false;
    let closeGrace: NodeJS.Timeout | undefined;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs ?? LOGIN_PROBE_TIMEOUT_MS);

    const capture = (target: 'stdout' | 'stderr', chunk: Buffer | string): void => {
      const text = chunk.toString();
      outputBytes += Buffer.byteLength(text);
      if (outputBytes > LOGIN_PROBE_OUTPUT_LIMIT_BYTES) {
        outputExceeded = true;
        child.kill('SIGKILL');
        return;
      }
      if (target === 'stdout') {
        stdout += text;
      } else {
        stderr += text;
      }
    };

    child.stdout.on('data', (chunk: Buffer | string) => capture('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer | string) => capture('stderr', chunk));

    const rejectOnce = (error: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (closeGrace) clearTimeout(closeGrace);
      reject(error);
    };

    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (closeGrace) clearTimeout(closeGrace);
      if (timedOut) {
        reject(new OpenPError(`${command} login status probe timed out`, EXIT_CODES.timeout));
        return;
      }
      if (outputExceeded) {
        reject(new OpenPError(`${command} login status output exceeded the limit`, EXIT_CODES.backendStartFailed));
        return;
      }
      if (code === null) {
        reject(new OpenPError(`${command} login status probe exited with ${signal ?? 'unknown signal'}`, EXIT_CODES.backendStartFailed));
        return;
      }
      resolve({ exitCode: code, stdout, stderr });
    };

    child.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        rejectOnce(new OpenPError(`command not found: ${command}`, EXIT_CODES.backendNotFound));
        return;
      }
      rejectOnce(error);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timeout);
      closeGrace = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish(code, signal);
      }, LOGIN_PROBE_CLOSE_GRACE_MS);
    });
    child.on('close', finish);
  });
}
