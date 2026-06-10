import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createAbortError } from '../../core/abort.js';
import { EXIT_CODES, OpenPError } from '../../core/errors.js';
import { GracefulInterrupt, shouldTerminateOnAbort } from '../../core/graceful-interrupt.js';

export interface CodexExecOptions {
  readonly bin: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly forceSignal?: AbortSignal;
  readonly killSignal?: AbortSignal;
  readonly interruptGraceMs?: number;
  readonly terminateGraceMs?: number;
  readonly onStdoutLine?: (line: string) => void;
}

export interface CodexExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
}

export function runCodexExec(options: CodexExecOptions): Promise<CodexExecResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(createAbortError());
      return;
    }

    const child: ChildProcess = spawn(options.bin, [...options.args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    child.stdin?.end();

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let terminationSignal: NodeJS.Signals | null = null;
    let settled = false;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let closeGraceTimer: NodeJS.Timeout | undefined;
    const interrupter = new GracefulInterrupt({
      interruptGraceMs: options.interruptGraceMs,
      terminateGraceMs: options.terminateGraceMs,
      isAlive: () => child.exitCode === null && child.signalCode === null,
      sendSignal: (signal) => {
        terminationSignal = signal;
        child.kill(signal);
      },
    });

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

    const settle = (result: CodexExecResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(closeGraceTimer);
      interrupter.clear();
      options.signal?.removeEventListener('abort', onAbort);
      options.forceSignal?.removeEventListener('abort', onForce);
      options.killSignal?.removeEventListener('abort', onKill);
      resolve(result);
    };

    const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });
    rl.on('line', (line: string) => {
      if (settled) {
        // The result is already resolved; a grandchild holding the inherited
        // stdout pipe must not emit streaming records after the result.
        return;
      }
      stdout += line + '\n';
      try {
        options.onStdoutLine?.(line);
      } catch {
        // callback errors must not crash the runner
      }
    });

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeoutTimer);
        clearTimeout(closeGraceTimer);
        interrupter.clear();
        options.signal?.removeEventListener('abort', onAbort);
        options.forceSignal?.removeEventListener('abort', onForce);
        options.killSignal?.removeEventListener('abort', onKill);
        if (isErrorCode(err, 'ENOENT')) {
          reject(new OpenPError(
            `backend executable not found: ${options.bin}`,
            EXIT_CODES.backendNotFound,
          ));
          return;
        }
        reject(err);
      }
    });

    child.on('exit', (code, sig) => {
      // Capture only exitCode/signal here; stdout/stderr are assembled at
      // settle time so lines that a grandchild writes to the inherited stdout
      // pipe between exit and the grace settle are not lost.
      const settleWithCurrentBuffers = (): void => {
        settle({
          stdout,
          stderr,
          exitCode: code,
          signal: sig ?? terminationSignal,
          timedOut,
        });
      };
      if (timedOut || aborted) {
        settleWithCurrentBuffers();
        return;
      }
      closeGraceTimer = setTimeout(settleWithCurrentBuffers, 1000);
    });

    child.on('close', (code, sig) => {
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
      if (options.signal.aborted) {
        onAbort();
      } else {
        options.signal.addEventListener('abort', onAbort, { once: true });
      }
    }
    if (options.forceSignal) {
      if (options.forceSignal.aborted) {
        onForce();
      } else {
        options.forceSignal.addEventListener('abort', onForce, { once: true });
      }
    }
    if (options.killSignal) {
      if (options.killSignal.aborted) {
        onKill();
      } else {
        options.killSignal.addEventListener('abort', onKill, { once: true });
      }
    }
  });
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
