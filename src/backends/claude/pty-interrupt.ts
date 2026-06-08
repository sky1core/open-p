import { DEFAULT_INTERRUPT_GRACE_MS, DEFAULT_TERMINATE_GRACE_MS } from '../../core/graceful-interrupt.js';

export interface ClaudePtyInterruptTarget {
  interrupt(): Promise<void>;
  terminate(signal?: NodeJS.Signals): Promise<void>;
  isAlive(): Promise<boolean>;
}

export interface ClaudePtyInterrupter {
  requestGracefulStop(): void;
  requestForceStop(): void;
  requestKillNow(): void;
  clear(): void;
}

export function createClaudePtyInterrupter(target: ClaudePtyInterruptTarget): ClaudePtyInterrupter {
  return new AsyncClaudePtyInterrupter(target);
}

class AsyncClaudePtyInterrupter implements ClaudePtyInterrupter {
  private sentInterrupt = false;
  private sentTerminate = false;
  private sentKill = false;
  private interruptTimer: NodeJS.Timeout | undefined;
  private terminateTimer: NodeJS.Timeout | undefined;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly target: ClaudePtyInterruptTarget) {}

  requestGracefulStop(): void {
    this.enqueueIfAlive(async () => {
      if (this.sentTerminate || this.sentKill) {
        return;
      }
      if (!this.sentInterrupt) {
        this.sentInterrupt = true;
        await this.target.interrupt().catch(() => undefined);
      }
      this.scheduleTerminate();
    });
  }

  requestForceStop(): void {
    this.enqueueIfAlive(async () => {
      if (this.sentKill) {
        return;
      }
      this.clearInterruptTimer();
      if (!this.sentTerminate) {
        this.sentTerminate = true;
        await this.target.terminate('SIGTERM').catch(() => undefined);
        this.scheduleKill();
        return;
      }
      this.requestKillNow();
    });
  }

  requestKillNow(): void {
    this.enqueueIfAlive(async () => {
      if (this.sentKill) {
        return;
      }
      this.clearInterruptTimer();
      this.clearTerminateTimer();
      this.sentKill = true;
      await this.target.terminate('SIGKILL').catch(() => undefined);
    });
  }

  clear(): void {
    this.clearInterruptTimer();
    this.clearTerminateTimer();
  }

  private enqueueIfAlive(action: () => Promise<void>): void {
    this.queue = this.queue
      .then(async () => {
        if (!(await this.target.isAlive().catch(() => false))) {
          return;
        }
        await action();
      })
      .catch(() => undefined);
  }

  private scheduleTerminate(): void {
    if (this.interruptTimer) {
      return;
    }
    this.interruptTimer = setTimeout(() => {
      this.interruptTimer = undefined;
      this.requestForceStop();
    }, DEFAULT_INTERRUPT_GRACE_MS);
  }

  private scheduleKill(): void {
    if (this.terminateTimer) {
      return;
    }
    this.terminateTimer = setTimeout(() => {
      this.terminateTimer = undefined;
      this.requestKillNow();
    }, DEFAULT_TERMINATE_GRACE_MS);
  }

  private clearInterruptTimer(): void {
    clearTimeout(this.interruptTimer);
    this.interruptTimer = undefined;
  }

  private clearTerminateTimer(): void {
    clearTimeout(this.terminateTimer);
    this.terminateTimer = undefined;
  }
}
