/**
 * Byte encodings from the private tally specification: framing, strict
 * lowercase hex and UTF-8. Nothing here is secret or random.
 */

/** A part of a framed hash input: bytes, a string (UTF-8) or an integer (4 bytes, big-endian). */
export type Part = Uint8Array | string | number;

const encoder = new TextEncoder();

/** The UTF-8 bytes of a string. */
export function utf8(s: string): Uint8Array {
  return encoder.encode(s);
}

/** An integer from 0 to 2^32 - 1 as 4 big-endian bytes. */
export function u32(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new RangeError(`not a 32-bit unsigned integer: ${n}`);
  return Uint8Array.of(n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
}

function partBytes(p: Part): Uint8Array {
  if (typeof p === "string") return utf8(p);
  if (typeof p === "number") return u32(p);
  return p;
}

/** frame([p_1, ..., p_m]) = len(p_1) || p_1 || ... || len(p_m) || p_m, each len 4 bytes big-endian. */
export function frame(parts: readonly Part[]): Uint8Array {
  const bufs = parts.map(partBytes);
  const out = new Uint8Array(bufs.reduce((n, b) => n + 4 + b.length, 0));
  let o = 0;
  for (const b of bufs) {
    out.set(u32(b.length), o);
    out.set(b, o + 4);
    o += 4 + b.length;
  }
  return out;
}

const HEX = "0123456789abcdef";

/** Lowercase hex. */
export function toHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += HEX[x >> 4]! + HEX[x & 15]!;
  return s;
}

/**
 * Strict lowercase hex: refuses uppercase, odd lengths and, when `length` is
 * given, any other number of bytes. Returns null instead of throwing.
 */
export function fromHex(h: string, length?: number): Uint8Array | null {
  if (typeof h !== "string" || h.length % 2 !== 0) return null;
  if (length !== undefined && h.length !== length * 2) return null;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) {
    const hi = HEX.indexOf(h[2 * i]!);
    const lo = HEX.indexOf(h[2 * i + 1]!);
    if (hi < 0 || lo < 0) return null;
    out[i] = (hi << 4) | lo;
  }
  return out;
}

/** Like fromHex, for values this code wrote itself: throws on bad input. */
export function hexBytes(h: string, length?: number): Uint8Array {
  const b = fromHex(h, length);
  if (!b) throw new TypeError(`not ${length ?? "some"} bytes of lowercase hex: ${h}`);
  return b;
}

/** Byte-wise comparison, as Go compares strings. */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}

/** Sorts strings by the byte order of their UTF-8 encodings. */
export function sortUtf8(xs: readonly string[]): string[] {
  return [...xs].sort((a, b) => compareBytes(utf8(a), utf8(b)));
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && compareBytes(a, b) === 0;
}
