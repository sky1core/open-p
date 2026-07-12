import { EXIT_CODES, OpenPError } from '../../core/errors.js';
import { runNativeLoginProbe } from '../../core/login-probe.js';
import { resolveClaudeCodeBin } from './bin.js';
import {
  CLAUDE_CODE_ISOLATED_ENV_PREFIXES,
  CLAUDE_CODE_LAUNCH_UNSET_ENV,
  withClaudeCodeAccountLaunchEnv,
} from './launch-safety.js';

export async function probeClaudeCodeLogin(configDir: string | null): Promise<boolean> {
  const command = resolveClaudeCodeBin();
  const result = await runNativeLoginProbe(command, ['auth', 'status', '--json'], {
    env: withClaudeCodeAccountLaunchEnv({}, configDir),
    isolateEnvPrefixes: CLAUDE_CODE_ISOLATED_ENV_PREFIXES,
    unsetEnv: CLAUDE_CODE_LAUNCH_UNSET_ENV,
  });
  const status = parseStatus(result.stdout);
  if (result.exitCode === 0 && status.loggedIn === true) {
    return true;
  }
  if (result.exitCode !== 0 && status.loggedIn === false) {
    return false;
  }
  throw new OpenPError('Claude Code returned an inconsistent login status', EXIT_CODES.backendStartFailed);
}

function parseStatus(text: string): { readonly loggedIn: boolean } {
  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const loggedIn = (value as Record<string, unknown>).loggedIn;
      if (typeof loggedIn === 'boolean') {
        return { loggedIn };
      }
    }
  } catch {
    // The bounded public failure below intentionally excludes native account payloads.
  }
  throw new OpenPError('Claude Code returned an unsupported login status', EXIT_CODES.backendStartFailed);
}
