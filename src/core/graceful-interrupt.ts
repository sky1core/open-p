export const DEFAULT_INTERRUPT_GRACE_MS = 3000;
export const DEFAULT_TERMINATE_GRACE_MS = 5000;

export interface GracefulInterruptOptions {
  readonly sendSignal: (signal: NodeJS.Signals) => void;
  readonly isAlive: () => boolean;
  readonly interruptGraceMs?: number;
  readonly terminateGraceMs?: number;
}

export class GracefulInterrupt {
  private sentInterrupt = false;
  private sentTerminate = false;
  private sentKill = false;
  private interruptTimer: NodeJS.Timeout | undefined;
  private terminateTimer: NodeJS.Timeout | undefined;

  constructor(private readonly options: GracefulInterruptOptions) {}

  requestGracefulStop(): void {
    if (!this.options.isAlive()) {
      return;
    }
    if (this.sentTerminate || this.sentKill) {
      return;
    }
    if (!this.sentInterrupt) {
      this.sentInterrupt = true;
      this.options.sendSignal('SIGINT');
    }
    this.scheduleTerminate();
  }

  requestForceStop(): void {
    if (!this.options.isAlive()) {
      return;
    }
    this.clearInterruptTimer();
    if (!this.sentTerminate) {
      this.sentTerminate = true;
      this.options.sendSignal('SIGTERM');
      this.scheduleKill();
      return;
    }
    this.requestKillNow();
  }

  requestKillNow(): void {
    if (!this.options.isAlive() || this.sentKill) {
      return;
    }
    this.clearInterruptTimer();
    this.clearTerminateTimer();
    this.sentKill = true;
    this.options.sendSignal('SIGKILL');
  }

  clear(): void {
    this.clearInterruptTimer();
    this.clearTerminateTimer();
  }

  private scheduleTerminate(): void {
    if (this.interruptTimer) {
      return;
    }
    this.interruptTimer = setTimeout(() => {
      this.interruptTimer = undefined;
      this.requestForceStop();
    }, this.options.interruptGraceMs ?? DEFAULT_INTERRUPT_GRACE_MS);
  }

  private scheduleKill(): void {
    if (this.terminateTimer) {
      return;
    }
    this.terminateTimer = setTimeout(() => {
      this.terminateTimer = undefined;
      this.requestKillNow();
    }, this.options.terminateGraceMs ?? DEFAULT_TERMINATE_GRACE_MS);
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

export function shouldTerminateOnAbort(signal?: AbortSignal): boolean {
  return signal?.reason === 'SIGTERM' || signal?.reason === 'SIGKILL';
}

export interface InstalledProcessSignalHandlers {
  readonly signal: AbortSignal;
  readonly forceSignal: AbortSignal;
  readonly killSignal: AbortSignal;
  dispose(): void;
}

export function installProcessSignalHandlers(): InstalledProcessSignalHandlers {
  const abortController = new AbortController();
  const forceController = new AbortController();
  const killController = new AbortController();
  const handleSignal = (signal: NodeJS.Signals): void => {
    if (!abortController.signal.aborted) {
      abortController.abort(signal);
      return;
    }
    if (!forceController.signal.aborted) {
      forceController.abort(signal);
      return;
    }
    if (!killController.signal.aborted) {
      killController.abort(signal);
      return;
    }
    process.exitCode = 130;
  };

  process.on('SIGINT', handleSignal);
  process.on('SIGTERM', handleSignal);

  return {
    signal: abortController.signal,
    forceSignal: forceController.signal,
    killSignal: killController.signal,
    dispose: () => {
      process.removeListener('SIGINT', handleSignal);
      process.removeListener('SIGTERM', handleSignal);
    },
  };
}
