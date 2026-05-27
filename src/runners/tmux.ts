import { execFileText, shellQuote } from '../core/command.js';
import { EXIT_CODES, OpenPError } from '../core/errors.js';
import type { PtyProvider, PtySession, PtyStartOptions } from './types.js';

type ProcessSignalSender = (pid: number, signal: NodeJS.Signals) => void;

export class TmuxProvider implements PtyProvider {
  constructor(private readonly tmuxBin = 'tmux') {}

  async start(command: string, args: readonly string[], options: PtyStartOptions): Promise<PtySession> {
    await this.ensureAvailable();
    const shellCommand = buildTmuxShellCommand(command, args, options.env ?? {}, options.isolateAnthropicEnv ?? false);
    await execFileText(this.tmuxBin, [
      'new-session',
      '-d',
      '-s',
      options.sessionName,
      '-c',
      options.cwd,
      shellCommand,
    ]);
    return new TmuxSession(this.tmuxBin, options.sessionName);
  }

  private async ensureAvailable(): Promise<void> {
    try {
      await execFileText(this.tmuxBin, ['-V']);
    } catch (error) {
      if (error instanceof OpenPError) {
        throw new OpenPError('tmux provider is unavailable: tmux was not found', EXIT_CODES.backendNotFound);
      }
      throw error;
    }
  }
}

export function buildTmuxShellCommand(
  command: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
  isolateAnthropicEnv: boolean,
  ambientEnv: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return [
    'env',
    ...(isolateAnthropicEnv ? anthropicUnsetArgs(ambientEnv) : []),
    ...Object.entries(env).map(([key, value]) => `${key}=${value}`),
    command,
    ...args,
  ].map(shellQuote).join(' ');
}

function anthropicUnsetArgs(ambientEnv: Readonly<Record<string, string | undefined>>): string[] {
  return [...new Set(['ANTHROPIC_BASE_URL', ...Object.keys(ambientEnv).filter((key) => key.startsWith('ANTHROPIC_'))])]
    .sort()
    .flatMap((key) => ['-u', key]);
}

export class TmuxSession implements PtySession {
  readonly id: string;

  constructor(
    private readonly tmuxBin: string,
    private readonly sessionName: string,
    private readonly exitTimeoutMs = 5000,
    private readonly sendProcessSignal: ProcessSignalSender = (pid, signal) => {
      process.kill(pid, signal);
    },
  ) {
    this.id = sessionName;
  }

  async write(input: string): Promise<void> {
    const bufferName = `${this.sessionName}-input`;
    await execFileText(this.tmuxBin, ['load-buffer', '-b', bufferName, '-'], { input });
    await execFileText(this.tmuxBin, ['paste-buffer', '-p', '-r', '-b', bufferName, '-t', this.sessionName]);
  }

  async submit(): Promise<void> {
    await execFileText(this.tmuxBin, ['send-keys', '-t', this.sessionName, 'Enter']);
  }

  async interrupt(): Promise<void> {
    await execFileText(this.tmuxBin, ['send-keys', '-t', this.sessionName, 'C-c']);
  }

  async terminate(signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
    if (!(await this.isAlive())) {
      return;
    }
    const panePid = await this.resolvePanePid();
    const sentSignal = panePid !== null && this.signalPaneProcess(panePid, signal);
    if (signal === 'SIGKILL' || !sentSignal) {
      await this.killSessionIfAlive();
    }
  }

  async exit(): Promise<void> {
    if (!(await this.isAlive())) {
      return;
    }
    await this.write('/exit');
    await this.submit();
    if (await this.waitForExit(this.exitTimeoutMs)) {
      return;
    }
    await this.interrupt();
    await sleep(500);
    if (!(await this.isAlive())) {
      return;
    }
    await this.write('/exit');
    await this.submit();
    if (await this.waitForExit(this.exitTimeoutMs)) {
      return;
    }
    throw new OpenPError(`tmux session ${this.sessionName} did not exit after graceful /exit`, EXIT_CODES.backendExited);
  }

  private async waitForExit(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!(await this.isAlive())) {
        return true;
      }
      await sleep(250);
    }
    return !(await this.isAlive());
  }

  async isAlive(): Promise<boolean> {
    try {
      await execFileText(this.tmuxBin, ['has-session', '-t', this.sessionName]);
      return true;
    } catch {
      return false;
    }
  }

  async captureText(): Promise<string> {
    const result = await execFileText(this.tmuxBin, ['capture-pane', '-pt', this.sessionName, '-S', '-1000']);
    return result.stdout;
  }

  private async resolvePanePid(): Promise<number | null> {
    try {
      const result = await execFileText(this.tmuxBin, ['display-message', '-p', '-t', this.sessionName, '#{pane_pid}']);
      const panePid = Number.parseInt(result.stdout.trim(), 10);
      return Number.isSafeInteger(panePid) && panePid > 0 ? panePid : null;
    } catch {
      return null;
    }
  }

  private signalPaneProcess(panePid: number, signal: NodeJS.Signals): boolean {
    try {
      this.sendProcessSignal(-panePid, signal);
      return true;
    } catch {
      try {
        this.sendProcessSignal(panePid, signal);
        return true;
      } catch {
        return false;
      }
    }
  }

  private async killSessionIfAlive(): Promise<void> {
    if (!(await this.isAlive())) {
      return;
    }
    try {
      await execFileText(this.tmuxBin, ['kill-session', '-t', this.sessionName]);
    } catch (error) {
      if (await this.isAlive()) {
        throw error;
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
