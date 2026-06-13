export const CLAUDE_CODE_BACKGROUND_SUPPRESSION_ENV: Readonly<Record<string, string>> = {
  CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
};

export const CLAUDE_CODE_RESUME_MODAL_SUPPRESSION_ENV: Readonly<Record<string, string>> = {
  CLAUDE_CODE_RESUME_THRESHOLD_MINUTES: '1000000000',
  CLAUDE_CODE_RESUME_TOKEN_THRESHOLD: '1000000000000',
};

export const CLAUDE_CONFIG_DIR_ENV_KEY = 'CLAUDE_CONFIG_DIR';
export const CLAUDE_CODE_ACCOUNT_UNSET_ENV = [CLAUDE_CONFIG_DIR_ENV_KEY] as const;

// Ambient env name prefix that the Claude launch isolates from the child. This is the backend-owned
// value injected into the backend-neutral launch transport (core command / tmux), so that core/runners
// never hardcode a provider name. The Claude child is launched with every ambient ANTHROPIC_* removed.
export const CLAUDE_CODE_ISOLATED_ENV_PREFIXES = ['ANTHROPIC_'] as const;

// Keys the Claude launch always unsets at the launch boundary, even when no ambient value is present.
// CLAUDE_CONFIG_DIR (via CLAUDE_CODE_ACCOUNT_UNSET_ENV): ambient config dir would silently disagree with
//   the injected one (see SPEC).
// ANTHROPIC_BASE_URL: the single ANTHROPIC_* key the launch re-injects explicitly (endpoint config, not a
//   credential — see SAFE_ANTHROPIC_ENV_KEYS). Always unsetting it before the explicit value is injected
//   matches the prior tmux behavior of forcing this key onto the unset list regardless of ambient state.
export const CLAUDE_CODE_LAUNCH_UNSET_ENV = [...CLAUDE_CODE_ACCOUNT_UNSET_ENV, 'ANTHROPIC_BASE_URL'] as const;

const SAFE_ANTHROPIC_ENV_KEYS = new Set(['ANTHROPIC_BASE_URL']);

export const CLAUDE_CODE_PTY_DISALLOWED_TOOLS = 'Monitor,Workflow,AskUserQuestion';
export const CLAUDE_CODE_DISALLOWED_TOOLS_FLAG = '--disallowedTools';

export function withClaudeCodeBackgroundSuppressionEnv(
  env: Readonly<Record<string, string>> = {},
): Readonly<Record<string, string>> {
  return {
    ...env,
    ...CLAUDE_CODE_BACKGROUND_SUPPRESSION_ENV,
  };
}

export function withClaudeCodeResumeModalSuppressionEnv(
  env: Readonly<Record<string, string>> = {},
): Readonly<Record<string, string>> {
  return {
    ...env,
    ...CLAUDE_CODE_RESUME_MODAL_SUPPRESSION_ENV,
  };
}

export function withClaudeCodeSafeLaunchEnv(
  env: Readonly<Record<string, string>> = {},
): Readonly<Record<string, string>> {
  const safeEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('ANTHROPIC_') && !SAFE_ANTHROPIC_ENV_KEYS.has(key)) {
      continue;
    }
    safeEnv[key] = value;
  }
  return withClaudeCodeResumeModalSuppressionEnv(withClaudeCodeBackgroundSuppressionEnv(safeEnv));
}

export function withClaudeCodeAccountLaunchEnv(
  env: Readonly<Record<string, string>> = {},
  configDir: string | null = null,
): Readonly<Record<string, string>> {
  const launchEnv: Record<string, string> = {
    ...withClaudeCodeSafeLaunchEnv(env),
  };
  delete launchEnv[CLAUDE_CONFIG_DIR_ENV_KEY];
  if (configDir !== null) {
    launchEnv[CLAUDE_CONFIG_DIR_ENV_KEY] = configDir;
  }
  return launchEnv;
}

export function appendClaudeCodePtySuppressionArgs(args: string[]): void {
  args.push(CLAUDE_CODE_DISALLOWED_TOOLS_FLAG, CLAUDE_CODE_PTY_DISALLOWED_TOOLS);
}
