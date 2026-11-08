/**
 * The ballot prover, with its randomness as an argument. client.ts draws the
 * randomness from crypto.getRandomValues and discards it; testing.ts passes
 * fixed values for the test vectors. Nothing else calls this module.
 *
 * A slot does the same group operations whether it holds 0 or 1: both
 * candidates for b_j and for the simulated branch's target are computed,
 * and the message picks between them by indexing, so no multiplication,
 * addition or subtraction depends on the vote (the specification's
 * constant-time rule). Every secret scalar goes through noble's
 * constant-time multiply.
 */
import { toHex } from "./encoding.ts";
import { Fn, G, ZERO, mulSecret, type Pt } from "./group.ts";
import { Hs, LABELS } from "./hash.ts";
import { prepare, type Election } from "./election.ts";
import { randomScalar, type RandomSource } from "./random.ts";
import { trackingCode } from "./tracking.ts";
import type { Ballot, BitProof, Ciphertext } from "./types.ts";

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

/** One slot's ciphertext and 0-or-1 proof, and the parts the sum proof adds up. */
export interface ProvedSlot {
  ciphertext: Ciphertext;
  proof: BitProof;
  a: Pt;
  b: Pt;
}

/**
 * Encrypts m in slot j and proves it is 0 or 1. For m of 0 or 1 the work is
 * the same: a = r·G, rH = r·H, then both rH + G and rH - G, so that
 * b = [rH, rH + G][m] and the simulated branch's target
 * Y_(1-m) = b - (1 - m)·G = [rH - G, rH + G][m]. The real and simulated
 * commitments, challenges and responses are placed by indexing with m.
 *
 * Any other m is for negative test vectors only: b = r·H + m·G, and the
 * real branch is taken as 0, so the proof fails.
 */
export function proveSlot(H: Pt, ctx: Uint8Array, voterTag: Uint8Array, j: number, m: number, r: bigint, cs: bigint, zs: bigint, w: bigint): ProvedSlot {
  const a = mulSecret(G, r);
  const rH = mulSecret(H, r);
  const plus = rH.add(G);
  const minus = rH.subtract(G);
  let bit = m & 1;
  let b = [rH, plus][bit]!;
  let target = [minus, plus][bit]!;
  if (m !== 0 && m !== 1) {
    // Test vectors only: no ballot Weft makes has another message.
    bit = 0;
    b = rH.add(mulSecret(G, BigInt(m)));
    target = b.subtract(G);
  }
  // The simulated branch: its challenge and response chosen, its commitments solved for.
  const As = mulSecret(G, zs).subtract(mulSecret(a, cs));
  const Bs = mulSecret(H, zs).subtract(mulSecret(target, cs));
  const Ar = mulSecret(G, w);
  const Br = mulSecret(H, w);
  // Branch k's commitments: the real ones at k = m, the simulated ones at 1 - m.
  const commitments = [
    [Ar, Br, As, Bs],
    [As, Bs, Ar, Br],
  ][bit]!;
  const [A0, B0, A1, B1] = commitments as [Pt, Pt, Pt, Pt];
  const c = Hs(LABELS.bit, [ctx, voterTag, j, a.toBytes(), b.toBytes(), A0.toBytes(), B0.toBytes(), A1.toBytes(), B1.toBytes()]);
  const cr = Fn.sub(c, cs);
  const zr = Fn.add(w, Fn.mul(cr, r));
  const cz = [
    [cr, cs, zr, zs],
    [cs, cr, zs, zr],
  ][bit]!;
  const [c0, c1, z0, z1] = cz.map(shex) as [string, string, string, string];
  return { ciphertext: { a: hexOf(a), b: hexOf(b) }, proof: { c0, c1, z0, z1 }, a, b };
}

/**
 * Encrypts m_j in each slot and proves it. With every m_j in {0, 1} and
 * exactly one 1, the ballot verifies. Other messages are for negative test
 * vectors, whose proofs fail.
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
    const slot = proveSlot(H, ctx, voterTag, j, m[j]!, r, cs, zs, w);
    ciphertexts.push(slot.ciphertext);
    bitProofs.push(slot.proof);
    A = A.add(slot.a);
    B = B.add(slot.b);
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
