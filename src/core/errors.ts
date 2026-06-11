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

export const ARTIFACT_REJECTION_REASONS = {
  noCandidate: 'no_candidate',
  ambiguousCandidate: 'ambiguous_candidate',
  missingTurnBoundary: 'missing_turn_boundary',
  promptNotExecuted: 'prompt_not_executed',
  multipleTurnBoundaries: 'multiple_turn_boundaries',
  missingCompletion: 'missing_completion',
  unsupportedArtifactShape: 'unsupported_artifact_shape',
} as const;

export type ArtifactRejectionReasonCode =
  typeof ARTIFACT_REJECTION_REASONS[keyof typeof ARTIFACT_REJECTION_REASONS];

export interface OpenPErrorOptions {
  readonly reasonCode?: ArtifactRejectionReasonCode | null;
}

export class OpenPError extends Error {
  readonly reasonCode?: ArtifactRejectionReasonCode;

  constructor(
    message: string,
    readonly exitCode: ExitCode,
    reasonCodeOrOptions?: ArtifactRejectionReasonCode | OpenPErrorOptions,
  ) {
    super(message);
    this.name = 'OpenPError';
    const reasonCode = typeof reasonCodeOrOptions === 'string'
      ? reasonCodeOrOptions
      : reasonCodeOrOptions?.reasonCode;
    if (reasonCode) {
      this.reasonCode = reasonCode;
    }
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
