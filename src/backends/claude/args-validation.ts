import { EXIT_CODES, OpenPError } from '../../core/errors.js';

const UNSUPPORTED_BACKEND_FLAGS = new Set([
  '-p',
  '--print',
  '--input-format',
  '--output-format',
  '--include-partial-messages',
  '--permission-mode',
  '--dangerously-skip-permissions',
  '--effort',
]);

export function rejectStructuredClaudeCodeBackendArgs(args: readonly string[]): void {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const flag = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
    if (UNSUPPORTED_BACKEND_FLAGS.has(flag)) {
      throw new OpenPError(`unsupported backend arg: ${flag}`, EXIT_CODES.unsupportedOption);
    }
  }
}
