import { createHash } from 'node:crypto';
import { Buffer, isUtf8 } from 'node:buffer';
import { EXIT_CODES, OpenPError } from './errors.js';

export function digestNativeState(format: string, components: readonly Uint8Array[]): string {
  const hash = createHash('sha256')
    .update('openp.native-state.v1')
    .update('\0')
    .update(format)
    .update('\0');
  for (const component of components) {
    const bytes = Buffer.from(component.buffer, component.byteOffset, component.byteLength);
    hash.update(String(bytes.length)).update(':').update(bytes).update('\0');
  }
  return hash.digest('hex');
}

export function decodeNativeStateUtf8(bytes: Uint8Array, source: string): string {
  if (!isUtf8(bytes)) {
    throw new OpenPError(`${source} is not valid UTF-8`, EXIT_CODES.protocolViolation);
  }
  // Buffer.toString preserves an optional BOM as U+FEFF, matching the previous readFile(...,
  // 'utf8') behavior. JSON parsers remain responsible for accepting or rejecting that character.
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8');
}

export function isNativeStateDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}
