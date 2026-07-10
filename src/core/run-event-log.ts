import { closeSync, constants, fchmodSync, fsyncSync, openSync, writeSync } from 'node:fs';
import { EXIT_CODES, OpenPError } from './errors.js';
import type { BackendRunActivity } from './types.js';

export interface RunEventLogHeader {
  readonly runId: string | null;
  readonly pid: number;
  readonly startedAt: string;
  readonly backend: string;
  readonly resume: string | null;
}

export interface RunEventLogTerminal {
  readonly status: 'succeeded' | 'failed' | 'interrupted' | 'timeout';
  /** The openp exit code, or null when the real exit code is decided outside open-p (crash paths). */
  readonly exitCode: number | null;
  readonly reasonCode: string | null;
  readonly message: string | null;
  readonly endedAt: string;
}

export type RunEventLogActivity = BackendRunActivity;

export class RunEventLog {
  private terminalWritten = false;
  private writeWarningEmitted = false;

  constructor(
    private readonly fd: number,
    private readonly warn: (message: string) => void,
  ) {}

  writeHeader(header: RunEventLogHeader): void {
    this.writeLine(JSON.stringify({ openpRun: { schemaVersion: 1, header } }));
  }

  appendMirroredStdout(chunk: string): void {
    this.writeRaw(chunk);
  }

  writeActivity(activity: RunEventLogActivity): void {
    this.writeLine(JSON.stringify({ openpRun: { schemaVersion: 1, activity } }));
  }

  writeTerminal(terminal: RunEventLogTerminal): void {
    if (this.terminalWritten) {
      return;
    }
    this.terminalWritten = true;
    this.writeLine(JSON.stringify({ openpRun: { schemaVersion: 1, terminal } }));
    this.fsync();
  }

  close(): void {
    try {
      closeSync(this.fd);
    } catch {
      // Event-log close failures must not change the turn outcome.
    }
  }

  private writeLine(line: string): void {
    this.writeRaw(`${line}\n`);
  }

  private writeRaw(chunk: string): void {
    try {
      writeSync(this.fd, chunk, undefined, 'utf8');
    } catch (error) {
      this.warnWriteFailure(error);
    }
  }

  private fsync(): void {
    try {
      fsyncSync(this.fd);
    } catch (error) {
      this.warnWriteFailure(error);
    }
  }

  private warnWriteFailure(error: unknown): void {
    if (this.writeWarningEmitted) {
      return;
    }
    this.writeWarningEmitted = true;
    const message = error instanceof Error ? error.message : String(error);
    this.warn(`openp event-log write failed: ${message}\n`);
  }
}

export function openRunEventLog(
  path: string,
  header: RunEventLogHeader,
  warn: (message: string) => void,
): RunEventLog {
  let fd: number | null = null;
  try {
    fd = openSync(path, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY, 0o600);
    fchmodSync(fd, 0o600);
  } catch (error) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // The open/chmod failure remains the primary error.
      }
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new OpenPError(`failed to open --event-log: ${message}`, EXIT_CODES.usage);
  }
  if (fd === null) {
    throw new OpenPError('failed to open --event-log', EXIT_CODES.usage);
  }
  const eventLog = new RunEventLog(fd, warn);
  eventLog.writeHeader(header);
  return eventLog;
}

export function statusFromExitCode(exitCode: number): RunEventLogTerminal['status'] {
  if (exitCode === EXIT_CODES.success) {
    return 'succeeded';
  }
  if (exitCode === EXIT_CODES.interrupted) {
    return 'interrupted';
  }
  if (exitCode === EXIT_CODES.timeout) {
    return 'timeout';
  }
  return 'failed';
}
