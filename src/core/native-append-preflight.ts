import type { NativeSessionTurn, NativeTurnIds, NativeWrittenTurn, SeedWriteTurn } from './backend.js';
import { EXIT_CODES, OpenPError } from './errors.js';

export function assertNativeAppendCandidate(input: {
  readonly backend: string;
  readonly before: readonly NativeSessionTurn[];
  readonly candidate: readonly NativeSessionTurn[];
  readonly requested: readonly SeedWriteTurn[];
  readonly written: readonly NativeWrittenTurn[];
}): void {
  if (input.written.length !== input.requested.length ||
    input.candidate.length !== input.before.length + input.requested.length) {
    throwInvalidCandidate(input.backend);
  }
  for (let index = 0; index < input.before.length; index += 1) {
    if (!sameNativeTurn(input.before[index]!, input.candidate[index]!)) {
      throwInvalidCandidate(input.backend);
    }
  }
  for (let index = 0; index < input.requested.length; index += 1) {
    const requested = input.requested[index]!;
    const written = input.written[index]!;
    const candidate = input.candidate[input.before.length + index]!;
    if (written.logicalId !== requested.logicalId || written.contentDigest !== requested.contentDigest ||
      candidate.userText !== requested.userText || candidate.assistantText !== requested.assistantText ||
      !sameNativeIds(candidate.nativeIds, written.nativeIds)) {
      throwInvalidCandidate(input.backend);
    }
  }
}

function sameNativeTurn(a: NativeSessionTurn, b: NativeSessionTurn): boolean {
  return a.userText === b.userText && a.assistantText === b.assistantText && sameNativeIds(a.nativeIds, b.nativeIds);
}

function sameNativeIds(a: NativeTurnIds, b: NativeTurnIds): boolean {
  return a.userId === b.userId && a.completionId === b.completionId &&
    a.assistantIds.length === b.assistantIds.length &&
    a.assistantIds.every((id, index) => id === b.assistantIds[index]);
}

function throwInvalidCandidate(backend: string): never {
  throw new OpenPError(
    `${backend} native history append would not preserve the existing logical prefix and exact written suffix`,
    EXIT_CODES.protocolViolation,
  );
}
