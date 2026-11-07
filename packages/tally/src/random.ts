/**
 * Where randomness comes from. Production code uses systemRandom, which reads
 * crypto.getRandomValues. Only the test path (testing.ts) passes any other
 * source, so the vectors can fix every value that would otherwise be drawn.
 */
import { Fn, scalarFromLE } from "./group.ts";

export interface RandomSource {
  bytes(n: number): Uint8Array;
}

export const systemRandom: RandomSource = Object.freeze({
  bytes(n: number): Uint8Array {
    const out = new Uint8Array(n);
    // getRandomValues fills at most 65,536 bytes a call.
    for (let o = 0; o < n; o += 65536) globalThis.crypto.getRandomValues(out.subarray(o, Math.min(n, o + 65536)));
    return out;
  },
});

/** 64 random bytes read as a little-endian integer and reduced modulo l, drawn again if 0. */
export function randomScalar(rand: RandomSource): bigint {
  for (;;) {
    const s = scalarFromLE(rand.bytes(64));
    if (!Fn.is0(s)) return s;
  }
}

/** The rng function noble's FROST DKG takes. */
export function nobleRng(rand: RandomSource): (n?: number) => Uint8Array {
  return (n = 32) => rand.bytes(n);
}
