export function resolveInitialTurnSessionId(input: {
  readonly resume: boolean;
  readonly backendSessionId: string;
}): string | null {
  if (input.resume) {
    return input.backendSessionId;
  }

  return null;
}
