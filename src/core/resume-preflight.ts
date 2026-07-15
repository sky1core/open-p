import { EXIT_CODES, OpenPError } from './errors.js';

export async function settlePendingSeedBeforeResume(input: {
  readonly resume: boolean;
  readonly settlePendingSeedAppend?: () => Promise<void>;
}): Promise<void> {
  if (!input.resume) {
    return;
  }
  if (!input.settlePendingSeedAppend) {
    throw new OpenPError(
      'resumed backend execution requires pending seed settlement',
      EXIT_CODES.protocolViolation,
    );
  }
  await input.settlePendingSeedAppend();
}
