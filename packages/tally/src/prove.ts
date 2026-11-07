/**
 * The ballot prover, with its randomness as an argument. client.ts draws the
 * randomness from crypto.getRandomValues and discards it; testing.ts passes
 * fixed values for the test vectors. Nothing else calls this module.
 */
import { toHex } from "./encoding.ts";
import { Fn, G, ZERO, mulSecret, type Pt } from "./group.ts";
import { Hs, LABELS } from "./hash.ts";
import { prepare, type Election } from "./election.ts";
import { randomScalar, type RandomSource } from "./random.ts";
import { trackingCode } from "./tracking.ts";
import type { Ballot, BitProof } from "./types.ts";

/** Every value a ballot draws: r_j, and for each slot the simulated branch (c_s, z_s) and the real nonce w, then the sum proof's w. */
export interface BallotRandomness {
  r: bigint[];
  bits: { cs: bigint; zs: bigint; w: bigint }[];
  w: bigint;
}

/** Draws in the order r_0, c_s0, z_s0, w_0, r_1, ..., then the sum proof's w. */
export function drawBallotRandomness(L: number, rand: RandomSource): BallotRandomness {
  const r: bigint[] = [];
  const bits: BallotRandomness["bits"] = [];
  for (let j = 0; j < L; j++) {
    r.push(randomScalar(rand));
    bits.push({ cs: randomScalar(rand), zs: randomScalar(rand), w: randomScalar(rand) });
  }
  return { r, bits, w: randomScalar(rand) };
}

const hexOf = (p: Pt) => toHex(p.toBytes());
const shex = (s: bigint) => toHex(Fn.toBytes(s));

/**
 * Encrypts m_j in each slot and proves it. With every m_j in {0, 1} and
 * exactly one 1, the ballot verifies. Other messages are for negative test
 * vectors: the real branch is then taken as m_j = 1, and the proof fails.
 */
export function proveBallot(e: Election, voterTag: Uint8Array, m: readonly number[], rnd: BallotRandomness): { ballot: Ballot; tracking: string } {
  const { H, ctx } = prepare(e);
  const L = e.options.length;
  if (m.length !== L || rnd.r.length !== L || rnd.bits.length !== L) throw new RangeError("one message and one set of randomness per option");
  const ciphertexts: Ballot["ciphertexts"] = [];
  const bitProofs: BitProof[] = [];
  let A = ZERO;
  let B = ZERO;
  let R = 0n;
  for (let j = 0; j < L; j++) {
    const r = rnd.r[j]!;
    const { cs, zs, w } = rnd.bits[j]!;
    const a = mulSecret(G, r);
    const b = mulSecret(H, r).add(mulSecret(G, BigInt(m[j]!)));
    const real = m[j] === 1 ? 1 : 0;
    const Y = (t: number) => (t === 0 ? b : b.subtract(G));
    // The simulated branch: choose its challenge and response, solve for its commitments.
    const As = mulSecret(G, zs).subtract(mulSecret(a, cs));
    const Bs = mulSecret(H, zs).subtract(mulSecret(Y(1 - real), cs));
    const Ar = mulSecret(G, w);
    const Br = mulSecret(H, w);
    const [A0, B0, A1, B1] = real === 0 ? [Ar, Br, As, Bs] : [As, Bs, Ar, Br];
    const c = Hs(LABELS.bit, [ctx, voterTag, j, a.toBytes(), b.toBytes(), A0.toBytes(), B0.toBytes(), A1.toBytes(), B1.toBytes()]);
    const cr = Fn.sub(c, cs);
    const zr = Fn.add(w, Fn.mul(cr, r));
    bitProofs.push(real === 0 ? { c0: shex(cr), c1: shex(cs), z0: shex(zr), z1: shex(zs) } : { c0: shex(cs), c1: shex(cr), z0: shex(zs), z1: shex(zr) });
    ciphertexts.push({ a: hexOf(a), b: hexOf(b) });
    A = A.add(a);
    B = B.add(b);
    R = Fn.add(R, r);
  }
  const c = Hs(LABELS.sum, [ctx, voterTag, A.toBytes(), B.toBytes(), mulSecret(G, rnd.w).toBytes(), mulSecret(H, rnd.w).toBytes()]);
  const z = Fn.add(rnd.w, Fn.mul(c, R));
  const ballot: Ballot = { v: 1, electionId: e.electionId, ciphertexts, bitProofs, sumProof: { c: shex(c), z: shex(z) } };
  return { ballot, tracking: trackingCode(e, voterTag, ballot) };
}

/** The 0-or-1 messages for a choice of option c (0-based). */
export function choiceMessages(L: number, choice: number): number[] {
  if (!Number.isInteger(choice) || choice < 0 || choice >= L) throw new RangeError(`choice ${choice} is not an option of this election`);
  return Array.from({ length: L }, (_, j) => (j === choice ? 1 : 0));
}
