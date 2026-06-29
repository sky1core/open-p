import { existsSync } from 'node:fs';
import { EXIT_CODES, OpenPError } from '../../core/errors.js';

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

export const LOCALHOST_ONLY_SANDBOX_PROFILE =
  '(version 1) (allow default) (deny network*) (allow network-outbound (remote ip "localhost:*"))';

export function buildLocalhostOnlySandboxCommand(bin: string, args: readonly string[]): {
  readonly bin: string;
  readonly args: readonly string[];
} {
  if (!existsSync(SANDBOX_EXEC)) {
    throw new OpenPError('OpenCode local-private mode requires sandbox-exec network guard', EXIT_CODES.backendStartFailed);
  }
  return {
    bin: SANDBOX_EXEC,
    args: ['-p', LOCALHOST_ONLY_SANDBOX_PROFILE, bin, ...args],
  };
}
