import { execFileText } from '../../core/command.js';
import { EXIT_CODES, OpenPError } from '../../core/errors.js';

export function resolveClaudeCodeBin(): string {
  return 'claude';
}

export async function assertClaudeCodeBin(
  command: string,
  options: {
    readonly env?: Readonly<Record<string, string>>;
    readonly isolateAnthropicEnv?: boolean;
    readonly cwd?: string;
  } = {},
): Promise<void> {
  const result = await execFileText(command, ['--version'], options);
  const versionText = `${result.stdout}\n${result.stderr}`.trim();
  if (!isOpenPVersionOutput(versionText)) {
    return;
  }
  throw new OpenPError(
    `Claude Code binary resolved to open-p (${command}); the claude command must resolve to the real Claude Code binary`,
    EXIT_CODES.backendStartFailed,
  );
}

function isOpenPVersionOutput(text: string): boolean {
  return /^openp(?:\s|$)/i.test(text);
}
