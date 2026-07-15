import { spawn, type ChildProcess } from 'node:child_process';
import { isUtf8 } from 'node:buffer';
import { createInterface } from 'node:readline';
import { createAbortError } from '../../core/abort.js';
import { EXIT_CODES, OpenPError } from '../../core/errors.js';
import { GracefulInterrupt, shouldTerminateOnAbort } from '../../core/graceful-interrupt.js';

export interface OpenCodeExecOptions {
  readonly bin: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly forceSignal?: AbortSignal;
  readonly killSignal?: AbortSignal;
}

export interface OpenCodeExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
}

export function runOpenCodeExec(options: OpenCodeExecOptions): Promise<OpenCodeExecResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(createAbortError());
      return;
    }

    const child: ChildProcess = spawn(options.bin, [...options.args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin?.end();

    let stdout = '';
    const stdoutChunks: Buffer[] = [];
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let terminationSignal: NodeJS.Signals | null = null;
    let settled = false;
    let timeoutTimer: NodeJS.Timeout | undefined;
    const interrupter = new GracefulInterrupt({
      isAlive: () => child.exitCode === null && child.signalCode === null,
      sendSignal: (signal) => {
        terminationSignal = signal;
        child.kill(signal);
      },
    });

    const cleanup = (): void => {
      clearTimeout(timeoutTimer);
      interrupter.clear();
      options.signal?.removeEventListener('abort', onAbort);
      options.forceSignal?.removeEventListener('abort', onForce);
      options.killSignal?.removeEventListener('abort', onKill);
    };
    const settle = (result: OpenCodeExecResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      rl.close();
      resolve(result);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      rl.close();
      reject(error);
    };

    const onAbort = (): void => {
      if (timedOut) {
        interrupter.requestForceStop();
        return;
      }
      aborted = true;
      clearTimeout(timeoutTimer);
      if (shouldTerminateOnAbort(options.signal)) {
        interrupter.requestForceStop();
        return;
      }
      interrupter.requestGracefulStop();
    };
    const onForce = (): void => {
      interrupter.requestForceStop();
    };
    const onKill = (): void => {
      interrupter.requestKillNow();
    };

    const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutChunks.push(Buffer.from(chunk));
    });
    rl.on('line', (line: string) => {
      stdout += line + '\n';
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (err) => {
      if (isErrorCode(err, 'ENOENT')) {
        fail(new OpenPError(`backend executable not found: ${options.bin}`, EXIT_CODES.backendNotFound));
        return;
      }
      fail(err);
    });
    child.on('close', (code, sig) => {
      if (aborted) {
        fail(createAbortError());
        return;
      }
      // Process-control and native CLI failures are primary. Their stdout is diagnostic only, not
      // native/result evidence, so malformed bytes must not replace abort, timeout, signal, or
      // non-zero-exit classification.
      if (timedOut || sig !== null || terminationSignal !== null || code !== 0) {
        settle({
          stdout,
          stderr,
          exitCode: code,
          signal: sig ?? terminationSignal,
          timedOut,
        });
        return;
      }
      if (!isUtf8(Buffer.concat(stdoutChunks))) {
        fail(new OpenPError('OpenCode stdout is not valid UTF-8', EXIT_CODES.protocolViolation));
        return;
      }
      settle({
        stdout,
        stderr,
        exitCode: code,
        signal: sig ?? terminationSignal,
        timedOut,
      });
    });

    timeoutTimer = options.timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          interrupter.requestGracefulStop();
        }, options.timeoutMs)
      : undefined;

    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
    }
    if (options.forceSignal) {
      if (options.forceSignal.aborted) onForce();
      else options.forceSignal.addEventListener('abort', onForce, { once: true });
    }
    if (options.killSignal) {
      if (options.killSignal.aborted) onKill();
      else options.killSignal.addEventListener('abort', onKill, { once: true });
    }
  });
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
