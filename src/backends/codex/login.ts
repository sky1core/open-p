import { EXIT_CODES, OpenPError } from '../../core/errors.js';
import { runNativeLoginProbe } from '../../core/login-probe.js';
import { resolveCodexBin } from './bin.js';

export async function probeCodexLogin(homeDir: string | null): Promise<boolean> {
  const result = await runNativeLoginProbe(resolveCodexBin(), ['login', 'status'], {
    ...(homeDir === null ? {} : { env: { CODEX_HOME: homeDir } }),
  });
  const statusText = `${result.stdout}\n${result.stderr}`.trim();
  if (result.exitCode === 0 && /^Logged in(?:\s+using\s+.+)?$/i.test(statusText)) {
    return true;
  }
  if (result.exitCode === 1 && /^Not logged in$/i.test(statusText)) {
    return false;
  }
  throw new OpenPError('Codex returned an unsupported login status', EXIT_CODES.backendStartFailed);
}
