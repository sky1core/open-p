export const MAX_SESSION_ID_BYTES = 200;

export function isSafeSessionId(value: string): boolean {
  if (!value || value.trim() !== value || Buffer.byteLength(value, 'utf8') > MAX_SESSION_ID_BYTES) {
    return false;
  }
  if (value.includes('/') || value.includes('\\')) {
    return false;
  }
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) {
      return false;
    }
  }
  return true;
}
