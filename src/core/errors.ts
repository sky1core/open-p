export const EXIT_CODES = {
  success: 0,
  usage: 2,
  unsupportedOption: 3,
  backendNotFound: 10,
  backendStartFailed: 11,
  backendExited: 12,
  sessionState: 20,
  sessionBusy: 21,
  timeout: 30,
  protocolViolation: 40,
  sessionLogNotFound: 41,
  sessionLogParse: 42,
  interrupted: 130,
} as const;

export type ExitCode = typeof EXIT_CODES[keyof typeof EXIT_CODES];

export class OpenPError extends Error {
  constructor(
    message: string,
    readonly exitCode: ExitCode,
  ) {
    super(message);
    this.name = 'OpenPError';
  }
}

export function toExitCode(error: unknown): ExitCode {
  if (
    error instanceof Error &&
    error.name === 'AbortError' &&
    (error as { readonly code?: unknown }).code === 'ABORT_ERR'
  ) {
    return EXIT_CODES.interrupted;
  }
  if (error instanceof OpenPError) {
    return error.exitCode;
  }
  return EXIT_CODES.backendStartFailed;
}
