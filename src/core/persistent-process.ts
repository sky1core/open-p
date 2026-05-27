import { EXIT_CODES, OpenPError } from './errors.js';
import { launchSignaturesEqual } from './launch-signature.js';
import type { LaunchSignature } from './worker-types.js';

const SHUTDOWN_DURING_START_MESSAGE = 'persistent process manager is shutting down';

export interface ManagedBackendProcess {
  readonly sessionId: string;
  readonly launchSignature: LaunchSignature;
  isAlive(): Promise<boolean>;
  shutdown(): Promise<void>;
}

export interface ProcessStartRequest {
  readonly sessionId: string;
  readonly launchSignature: LaunchSignature;
  readonly resume: boolean;
}

export type ProcessStarter<TProcess extends ManagedBackendProcess> = (request: ProcessStartRequest) => Promise<TProcess>;

export class PersistentProcessManager<TProcess extends ManagedBackendProcess> {
  private readonly processes = new Map<string, TProcess>();
  private readonly pendingSessions = new Set<string>();
  private readonly quarantinedSessions = new Set<string>();
  private readonly activeStarts = new Set<Promise<void>>();
  private readonly startingSessions = new Set<string>();
  private readonly shuttingDownProcesses = new Map<TProcess, Promise<void>>();
  private closing = false;

  async getOrStart(
    sessionId: string,
    launchSignature: LaunchSignature,
    resume: boolean,
    start: ProcessStarter<TProcess>,
  ): Promise<TProcess> {
    if (this.closing) {
      throw new OpenPError(SHUTDOWN_DURING_START_MESSAGE, EXIT_CODES.sessionBusy);
    }
    if (this.quarantinedSessions.has(sessionId)) {
      throw new OpenPError(`session ${sessionId} has an unsafe leftover process and cannot be reused automatically`, EXIT_CODES.sessionBusy);
    }
    const existing = this.processes.get(sessionId);
    if (!existing) {
      return this.startAndTrack(sessionId, launchSignature, resume, start);
    }

    const existingAlive = await existing.isAlive();
    if (this.closing) {
      throw new OpenPError(SHUTDOWN_DURING_START_MESSAGE, EXIT_CODES.sessionBusy);
    }

    if (!existingAlive) {
      this.processes.delete(sessionId);
      return this.startAndTrack(sessionId, launchSignature, true, start);
    }

    if (!launchSignaturesEqual(existing.launchSignature, launchSignature)) {
      await this.shutdownTrackedProcess(sessionId, existing);
      if (this.closing) {
        throw new OpenPError(SHUTDOWN_DURING_START_MESSAGE, EXIT_CODES.sessionBusy);
      }
      return this.startAndTrack(sessionId, launchSignature, true, start);
    }

    return existing;
  }

  async isAliveForSession(sessionId: string): Promise<boolean> {
    const process = this.processes.get(sessionId);
    if (!process) {
      return false;
    }
    const alive = await process.isAlive();
    if (!alive) {
      this.processes.delete(sessionId);
    }
    return alive;
  }

  async runExclusive<TResult>(sessionId: string, task: () => Promise<TResult>): Promise<TResult> {
    if (this.closing) {
      throw new OpenPError(SHUTDOWN_DURING_START_MESSAGE, EXIT_CODES.sessionBusy);
    }
    if (this.pendingSessions.has(sessionId)) {
      throw new OpenPError(`session ${sessionId} is busy`, EXIT_CODES.sessionBusy);
    }
    this.pendingSessions.add(sessionId);
    try {
      return await task();
    } finally {
      this.pendingSessions.delete(sessionId);
    }
  }

  async shutdownAll(): Promise<void> {
    this.closing = true;
    const activeStartError = await this.waitForActiveStarts();
    const processes = [...this.processes.entries()];
    const results = await Promise.allSettled(
      processes.map(([sessionId, process]) => this.shutdownTrackedProcess(sessionId, process)),
    );
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (activeStartError) {
      throw activeStartError;
    }
    if (rejected) {
      throw rejected.reason;
    }
  }

  async discard(sessionId: string, process?: TProcess): Promise<void> {
    const tracked = this.processes.get(sessionId);
    if (!tracked || (process && tracked !== process)) {
      return;
    }
    await this.shutdownTrackedProcess(sessionId, tracked);
  }

  rekey(oldSessionId: string, newSessionId: string, process: TProcess): void {
    if (oldSessionId === newSessionId) {
      return;
    }
    const tracked = this.processes.get(oldSessionId);
    if (tracked !== process) {
      return;
    }
    const existing = this.processes.get(newSessionId);
    if (existing && existing !== process) {
      throw new OpenPError(`session ${newSessionId} is busy`, EXIT_CODES.sessionBusy);
    }
    this.processes.delete(oldSessionId);
    this.processes.set(newSessionId, process);
  }

  trackedSessionCount(): number {
    return this.processes.size;
  }

  private async startAndTrack(
    sessionId: string,
    launchSignature: LaunchSignature,
    resume: boolean,
    start: ProcessStarter<TProcess>,
  ): Promise<TProcess> {
    if (this.closing) {
      throw new OpenPError(SHUTDOWN_DURING_START_MESSAGE, EXIT_CODES.sessionBusy);
    }
    if (this.startingSessions.has(sessionId)) {
      throw new OpenPError(`session ${sessionId} is already starting`, EXIT_CODES.sessionBusy);
    }
    this.startingSessions.add(sessionId);
    const startPromise = (async () => {
      const process = await start({
        sessionId,
        launchSignature,
        resume,
      });
      if (this.closing) {
        await this.shutdownTrackedProcess(sessionId, process);
        throw new OpenPError(SHUTDOWN_DURING_START_MESSAGE, EXIT_CODES.sessionBusy);
      }
      this.processes.set(sessionId, process);
      return process;
    })();
    const activeStart = startPromise.then(
      () => undefined,
      (error) => {
        if (isExpectedShutdownDuringStart(error)) {
          return undefined;
        }
        throw error;
      },
    );
    void activeStart.catch(() => undefined);
    this.activeStarts.add(activeStart);
    try {
      return await startPromise;
    } catch (error) {
      if (!this.closing && error instanceof OpenPError && error.exitCode === EXIT_CODES.sessionBusy) {
        this.quarantinedSessions.add(sessionId);
      }
      throw error;
    } finally {
      this.activeStarts.delete(activeStart);
      this.startingSessions.delete(sessionId);
    }
  }

  private async waitForActiveStarts(): Promise<unknown | null> {
    let firstError: unknown | null = null;
    while (this.activeStarts.size > 0) {
      const results = await Promise.allSettled([...this.activeStarts]);
      const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (rejected && firstError === null) {
        firstError = rejected.reason;
      }
    }
    return firstError;
  }

  private async shutdownTrackedProcess(sessionId: string, process: TProcess): Promise<void> {
    const existingShutdown = this.shuttingDownProcesses.get(process);
    if (existingShutdown) {
      return existingShutdown;
    }
    const shutdown = this.performShutdownTrackedProcess(sessionId, process)
      .finally(() => {
        this.shuttingDownProcesses.delete(process);
      });
    this.shuttingDownProcesses.set(process, shutdown);
    return shutdown;
  }

  private async performShutdownTrackedProcess(sessionId: string, process: TProcess): Promise<void> {
    try {
      await process.shutdown();
      if (await process.isAlive()) {
        this.quarantinedSessions.add(sessionId);
        throw new OpenPError(`session ${sessionId} still has a live process after graceful shutdown`, EXIT_CODES.sessionBusy);
      }
      if (this.processes.get(sessionId) === process) {
        this.processes.delete(sessionId);
      }
    } catch (error) {
      this.quarantinedSessions.add(sessionId);
      throw error;
    }
  }
}

function isExpectedShutdownDuringStart(error: unknown): boolean {
  return error instanceof OpenPError &&
    error.exitCode === EXIT_CODES.sessionBusy &&
    error.message === SHUTDOWN_DURING_START_MESSAGE;
}
