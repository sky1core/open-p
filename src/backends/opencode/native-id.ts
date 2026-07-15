export type OpenCodeNativeIdKind = 'msg' | 'prt';

const NATIVE_ID_RE = /^(msg|prt)_([0-9a-f]{12})[0-9A-Za-z]{14}$/;

export function parseOpenCodeNativeId(
  value: unknown,
  expectedKind?: OpenCodeNativeIdKind,
): { readonly kind: OpenCodeNativeIdKind; readonly segment: bigint } | null {
  if (typeof value !== 'string') return null;
  const match = value.match(NATIVE_ID_RE);
  if (!match) return null;
  const kind = match[1] as OpenCodeNativeIdKind;
  if (expectedKind !== undefined && kind !== expectedKind) return null;
  return { kind, segment: BigInt(`0x${match[2]!}`) };
}
