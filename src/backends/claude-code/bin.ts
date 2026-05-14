export const CLAUDE_CODE_BIN_ENV = 'OPENP_CLAUDE_CODE_BIN';

export function resolveClaudeCodeBin(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[CLAUDE_CODE_BIN_ENV];
  return configured && configured.trim().length > 0 ? configured : 'claude';
}
