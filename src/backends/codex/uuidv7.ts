import { randomBytes } from 'node:crypto';

// UUIDv7 (RFC 9562): a 48-bit big-endian Unix-millisecond timestamp, version nibble 7, and the
// 10xx variant, with the remaining bits random. Codex stamps rollout turn ids as UUIDv7, so seeded
// turns must match that shape. Kept dependency-free and local to the codex backend.
export function uuidv7(nowMs: number = Date.now()): string {
  const bytes = randomBytes(16);
  const ms = Math.max(0, Math.floor(nowMs));
  // 48-bit timestamp across bytes 0..5 (most significant byte first).
  bytes[0] = Math.floor(ms / 0x10000000000) & 0xff;
  bytes[1] = Math.floor(ms / 0x100000000) & 0xff;
  bytes[2] = Math.floor(ms / 0x1000000) & 0xff;
  bytes[3] = Math.floor(ms / 0x10000) & 0xff;
  bytes[4] = Math.floor(ms / 0x100) & 0xff;
  bytes[5] = ms & 0xff;
  bytes[6] = (bytes[6]! & 0x0f) | 0x70; // version 7 in the high nibble of byte 6
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant 10 in the high bits of byte 8
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
