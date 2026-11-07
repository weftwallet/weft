/**
 * The election context ctx, which every proof is bound to, and the election
 * fingerprint that Weft and explorers show.
 */
import { frame, hexBytes, sortUtf8, toHex, utf8, type Part } from "./encoding.ts";
import { Fn, ZERO, decodePoint, mulPub, trusteeId, type Pt } from "./group.ts";
import { LABELS, digest } from "./hash.ts";

/** What CreateElection fixes. Trustee i (0-based) has identifier i + 1. */
export interface ElectionSetup {
  channel: string;
  chaincode: string;
  electionId: string;
  options: readonly string[];
  /** k */
  threshold: number;
  /** The trustees' MSP IDs, in the order of the election's trustee list. */
  trustees: readonly string[];
}

/** What the key ceremony fixes, as lowercase hex. */
export interface ElectionKeys {
  publicKey: string;
  verifyingShares: readonly string[];
}

export type Election = ElectionSetup & ElectionKeys;

/** An election with its points decoded and its context computed, cached per election object. */
export interface Prepared {
  election: Election;
  H: Pt;
  S: Pt[];
  ctx: Uint8Array;
  ids: Uint8Array[];
}

/** Checks the shape of a setup; these are programming errors, not contract refusals. */
export function assertSetup(s: ElectionSetup): void {
  const n = s.trustees.length;
  if (s.options.length < 1) throw new RangeError("an election needs options");
  if (n < 1 || !Number.isInteger(s.threshold) || s.threshold < 1 || s.threshold > n) throw new RangeError("bad threshold");
}

const cache = new WeakMap<Election, Prepared>();

export function prepare(e: Election): Prepared {
  let p = cache.get(e);
  if (p) return p;
  assertSetup(e);
  if (e.verifyingShares.length !== e.trustees.length) throw new RangeError("one verifying share per trustee");
  const point = (h: string) => {
    const pt = decodePoint(hexBytes(h, 32));
    if (!pt) throw new RangeError(`not a point: ${h}`);
    return pt;
  };
  // The key is used in every multiplication of a ballot: precompute its table once.
  const H = point(e.publicKey).precompute(8, false);
  p = { election: e, H, S: e.verifyingShares.map(point), ctx: electionContext(e), ids: e.trustees.map((_, i) => trusteeId(i)) };
  cache.set(e, p);
  return p;
}

/** The framed parts of ctx, for test vectors. */
export function contextParts(e: Election): Part[] {
  const parts: Part[] = [LABELS.context, e.channel, e.chaincode, e.electionId, hexBytes(e.publicKey, 32), e.options.length, ...e.options, e.threshold, e.trustees.length];
  e.trustees.forEach((_, i) => parts.push(trusteeId(i), hexBytes(e.verifyingShares[i]!, 32)));
  return parts;
}

/**
 * ctx = SHA-256(frame(["weft-ballot v1", channel, chaincode, electionId, H, L, option_1, ..., option_L,
 *                      k, n, id_1, S_1, ..., id_n, S_n]))
 */
export function electionContext(e: Election): Uint8Array {
  const [label, ...rest] = contextParts(e);
  return digest(label as string, rest);
}

/** The framed input of the fingerprint's hash, for test vectors. */
export function fingerprintInput(e: Election, ctx = electionContext(e)): Uint8Array {
  return frame([LABELS.fingerprint, ctx, ...sortUtf8(e.trustees).map(utf8)]);
}

/**
 * The first 10 bytes of SHA-256(frame(["weft-election-fingerprint v1", ctx, msp_(1), ..., msp_(n)])),
 * with the trustees' MSP IDs sorted in byte order, as 20 lowercase hex characters.
 */
export function electionFingerprint(e: Election): string {
  return toHex(digest(LABELS.fingerprint, [electionContext(e), ...sortUtf8(e.trustees)]).subarray(0, 10));
}

/** "3f9a61c208de77b1c4e0" as "3f9a 61c2 08de 77b1 c4e0", as Weft and explorers show it. */
export function formatFingerprint(hex: string): string {
  return hex.match(/.{1,4}/g)?.join(" ") ?? hex;
}

/** The key and verifying shares from every trustee's round 1 commitments (C_i0, ..., C_i(k-1)). */
export function keysFromCommitments(setup: ElectionSetup, commitments: readonly (readonly Pt[])[]): { H: Pt; S: Pt[]; keys: ElectionKeys } {
  const n = setup.trustees.length;
  const k = setup.threshold;
  if (commitments.length !== n || commitments.some((c) => c.length !== k)) throw new RangeError("k commitments from each trustee");
  const merged: Pt[] = [];
  for (let t = 0; t < k; t++) merged.push(commitments.reduce((acc, c) => acc.add(c[t]!), ZERO));
  const H = merged[0]!;
  const S: Pt[] = [];
  for (let j = 0; j < n; j++) {
    // S_j = sum over t of (id_j^t)·(sum over i of C_it)
    const id = BigInt(j + 1);
    let pow = 1n;
    let acc = ZERO;
    for (let t = 0; t < k; t++) {
      acc = acc.add(mulPub(merged[t]!, pow));
      pow = Fn.mul(pow, id);
    }
    S.push(acc);
  }
  return { H, S, keys: { publicKey: toHex(H.toBytes()), verifyingShares: S.map((s) => toHex(s.toBytes())) } };
}
