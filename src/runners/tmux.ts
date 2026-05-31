import { spawnSync } from 'node:child_process';
import { execFileText, shellQuote } from '../core/command.js';
import { EXIT_CODES, OpenPError } from '../core/errors.js';
import type { PtyProvider, PtySession, PtyStartOptions } from './types.js';

type ProcessSignalSender = (pid: number, signal: NodeJS.Signals) => void;

// A detached tmux session survives its launcher. If openp is killed before it can `/exit` the session
// (e.g. a force-kill after a caller timeout), the Claude process inside leaks. Two safety nets keep leaked
// sessions from accumulating:
//   1. reapOrphanedOpenpSessions — before launching a session for a backend session id, kill any leftover
//      openp tmux session for the SAME id. The per-session lock guarantees no concurrent legitimate use, so
//      a match is always an orphan from a previously force-killed openp. This reaps even SIGKILL leaks on
//      the next turn of that session.
//   2. a synchronous `process.on('exit')` handler — kills any session this openp launched but did not
//      cleanly exit (covers the launch window before the per-turn cleanup and any cleanup gap). This does
//      not run on SIGKILL; (1) handles that case on reuse.
const activeOpenpTmuxSessions = new Map<string, string>(); // session name -> tmux binary
let tmuxExitCleanupRegistered = false;

function registerTmuxExitCleanup(): void {
  if (tmuxExitCleanupRegistered) {
    return;
  }
  tmuxExitCleanupRegistered = true;
  process.on('exit', () => {
    for (const [name, tmuxBin] of activeOpenpTmuxSessions) {
      spawnSync(tmuxBin, ['kill-session', '-t', name], { stdio: 'ignore' });
    }
  });
}

// Pure prefix match for the reaper: a candidate is reapable only if it shares this launch's
// `openp-<normalizedSessionId>-` prefix (same full backend session id) and is not the session being created.
export function selectReapableOpenpSessions(sessionName: string, candidateNames: readonly string[]): string[] {
  if (!sessionName.startsWith('openp-')) {
    return []; // only ever reap open-p-owned sessions
  }
  const lastDash = sessionName.lastIndexOf('-');
  if (lastDash <= 0) {
    return [];
  }
  const prefix = sessionName.slice(0, lastDash + 1); // `openp-<normalizedSessionId>-`
  return candidateNames.filter((name) => name !== sessionName && name.startsWith(prefix));
}

async function reapOrphanedOpenpSessions(tmuxBin: string, sessionName: string): Promise<void> {
  let listed: string;
  try {
    listed = (await execFileText(tmuxBin, ['list-sessions', '-F', '#{session_name}'])).stdout;
  } catch {
    return; // no tmux server / no sessions
  }
  const names = listed.split('\n').map((line) => line.trim()).filter(Boolean);
  for (const name of selectReapableOpenpSessions(sessionName, names)) {
    await execFileText(tmuxBin, ['kill-session', '-t', name]).catch(() => undefined);
  }
}

export class TmuxProvider implements PtyProvider {
  constructor(private readonly tmuxBin = 'tmux') {}

  async start(command: string, args: readonly string[], options: PtyStartOptions): Promise<PtySession> {
    await this.ensureAvailable();
    registerTmuxExitCleanup();
    await reapOrphanedOpenpSessions(this.tmuxBin, options.sessionName);
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
    activeOpenpTmuxSessions.set(options.sessionName, this.tmuxBin);
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
    const result = await execFileText(this.tmuxBin, ['capture-pane', '-pt', this.sessionName]);
    return result.stdout;
  }

  async captureCursorLine(): Promise<string> {
    const cursor = await execFileText(this.tmuxBin, [
      'display-message',
      '-p',
      '-t',
      this.sessionName,
      '#{cursor_y}',
    ]);
    const cursorY = Number.parseInt(cursor.stdout.trim(), 10);
    if (!Number.isSafeInteger(cursorY) || cursorY < 0) {
      throw new OpenPError(`tmux session ${this.sessionName} returned invalid cursor row`, EXIT_CODES.backendStartFailed);
    }
    const line = await execFileText(this.tmuxBin, [
      'capture-pane',
      '-p',
      '-t',
      this.sessionName,
      '-S',
      String(cursorY),
      '-E',
      String(cursorY),
    ]);
    return line.stdout.replace(/\r?\n$/, '');
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
