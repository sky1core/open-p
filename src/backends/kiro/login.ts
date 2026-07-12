import { EXIT_CODES, OpenPError } from '../../core/errors.js';
import { runNativeLoginProbe } from '../../core/login-probe.js';
import { resolveKiroBin } from './bin.js';

export async function probeKiroLogin(): Promise<boolean> {
  const result = await runNativeLoginProbe(resolveKiroBin(), ['whoami', '-f', 'json']);
  const status = parseStatus(result.stdout);
  if (result.exitCode === 0 && status.identityObject) {
    return true;
  }
  if (result.exitCode === 1 && status.account === null) {
    return false;
  }
  throw new OpenPError('Kiro returned an unsupported login status', EXIT_CODES.backendStartFailed);
}

function parseStatus(text: string): {
  readonly account?: unknown;
  readonly identityObject: boolean;
} {
  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      const hasAccount = Object.prototype.hasOwnProperty.call(record, 'account');
      return {
        ...(hasAccount ? { account: record.account } : {}),
        identityObject: !hasAccount && typeof record.accountType === 'string',
      };
    }
  } catch {
    // The bounded public failure below intentionally excludes native account payloads.
  }
  throw new OpenPError('Kiro returned an unsupported login status', EXIT_CODES.backendStartFailed);
}
