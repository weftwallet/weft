/**
 * The ristretto255 group (RFC 9496) from @noble/curves, with the decoding
 * rules of the specification. Secret scalars go through the constant-time
 * multiplication; verification uses the variable-time one on public values.
 */
import { ristretto255 } from "@noble/curves/ed25519.js";

export const Point: (typeof ristretto255)["Point"] = ristretto255.Point;
export type Pt = InstanceType<typeof Point>;
export const Fn = Point.Fn;
export const G: Pt = Point.BASE;
export const ZERO: Pt = Point.ZERO;
/** The group order l = 2^252 + 27742317777372353535851937790883648493. */
export const ORDER: bigint = Fn.ORDER;

/** A canonical RFC 9496 encoding, or null. */
export function decodePoint(b: Uint8Array): Pt | null {
  if (b.length !== 32) return null;
  try {
    return Point.fromBytes(b);
  } catch {
    return null;
  }
}

/** 32 little-endian bytes of a value below l, or null. */
export function decodeScalar(b: Uint8Array): bigint | null {
  if (b.length !== 32) return null;
  let n = 0n;
  for (let i = 31; i >= 0; i--) n = (n << 8n) | BigInt(b[i]!);
  return n < ORDER ? n : null;
}

export function encodePoint(p: Pt): Uint8Array {
  return p.toBytes();
}

export function encodeScalar(s: bigint): Uint8Array {
  return Fn.toBytes(Fn.create(s));
}

/** Reads bytes as a little-endian integer and reduces it modulo l. */
export function scalarFromLE(b: Uint8Array): bigint {
  let n = 0n;
  for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]!);
  return Fn.create(n);
}

/** Variable time: for public points and scalars only. */
export function mulPub(p: Pt, s: bigint): Pt {
  return s === 0n ? ZERO : p.multiplyUnsafe(s);
}

/** Constant time: for secret scalars. */
export function mulSecret(p: Pt, s: bigint): Pt {
  return s === 0n ? ZERO : p.multiply(s);
}

/** A trustee's identifier id_i, the scalar i, as 32 bytes. Indexes are 0-based, identifiers 1-based. */
export function trusteeId(index: number): Uint8Array {
  if (!Number.isInteger(index) || index < 0) throw new RangeError(`bad trustee index ${index}`);
  return encodeScalar(BigInt(index + 1));
}
