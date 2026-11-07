/** The tracking code: the voter's receipt, which Weft, the contract and the explorer all compute. */
import { fromHex, toHex } from "./encoding.ts";
import { LABELS, digest } from "./hash.ts";
import { prepare, type Election } from "./election.ts";
import type { Ballot } from "./types.ts";

/**
 * tracking = SHA-256(frame(["weft-ballot-hash v1", ctx, v, a_0, b_0, c0_0, c1_0, z0_0, z1_0, ..., c, z])),
 * as 64 lowercase hex characters. The ballot must already have decoded.
 */
export function trackingCode(e: Election, voterTag: Uint8Array, ballot: Ballot): string {
  const { ctx } = prepare(e);
  const parts: Uint8Array[] = [ctx, voterTag];
  ballot.ciphertexts.forEach((ct, j) => {
    const p = ballot.bitProofs[j]!;
    for (const h of [ct.a, ct.b, p.c0, p.c1, p.z0, p.z1]) parts.push(fromHex(h, 32)!);
  });
  parts.push(fromHex(ballot.sumProof.c, 32)!, fromHex(ballot.sumProof.z, 32)!);
  return toHex(digest(LABELS.tracking, parts));
}
