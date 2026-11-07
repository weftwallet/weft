/**
 * The verifying half: everything the contract runs, and the explorer's full
 * check. It handles no secret and draws no randomness, so every endorser
 * computes the same result. examples/private-ballot-contract/internal/tally
 * is the same code in Go, and the test vectors hold the two together.
 */
import { sha512 } from "@noble/hashes/sha2.js";
import { concatBytes } from "@noble/hashes/utils.js";
import { fromHex, toHex, utf8 } from "./encoding.ts";
import { Fn, G, ZERO, decodePoint, decodeScalar, mulPub, scalarFromLE, trusteeId, type Pt } from "./group.ts";
import { Hs, LABELS } from "./hash.ts";
import { assertSetup, keysFromCommitments, prepare, type Election, type ElectionKeys, type ElectionSetup } from "./election.ts";
import { TallyError, messages, type Thing } from "./errors.ts";
import { list, num, obj, parseStrict, str } from "./json.ts";
import type { Ballot, Ciphertext, ConfirmationPost, DecryptionSharePost, Round1Post, Round2Post } from "./types.ts";

export { TallyError } from "./errors.ts";
export { trackingCode } from "./tracking.ts";
import { trackingCode } from "./tracking.ts";

/* ---------- decoding ---------- */

function pointAt(thing: Thing, path: string, hex: string): Pt {
  const b = fromHex(hex, 32);
  const p = b && decodePoint(b);
  if (!p) throw new TallyError(messages.notPoint(thing, path));
  return p;
}

function scalarAt(thing: Thing, path: string, hex: string): bigint {
  const b = fromHex(hex, 32);
  const s = b && decodeScalar(b);
  if (s === null || s === undefined) throw new TallyError(messages.notScalar(thing, path));
  return s;
}

function bytesAt(thing: Thing, path: string, hex: string, n: number): Uint8Array {
  const b = fromHex(hex, n);
  if (!b) throw new TallyError(messages.notBytes(thing, path, n));
  return b;
}

const hexOf = (p: Pt) => toHex(p.toBytes());
const shex = (s: bigint) => toHex(Fn.toBytes(s));

/* ---------- ballots ---------- */

const BALLOT = obj([
  ["v", num],
  ["electionId", str],
  ["ciphertexts", list(obj([["a", str], ["b", str]]))],
  ["bitProofs", list(obj([["c0", str], ["c1", str], ["z0", str], ["z1", str]]))],
  ["sumProof", obj([["c", str], ["z", str]])],
]);

export interface DecodedBallot {
  ballot: Ballot;
  a: Pt[];
  b: Pt[];
  bits: { c0: bigint; c1: bigint; z0: bigint; z1: bigint }[];
  c: bigint;
  z: bigint;
}

/**
 * Steps 2 and 3 of what the contract checks: the ballot parses into the
 * version 1 fields, is for this election, has L ciphertexts and L bit
 * proofs, and every point and scalar decodes canonically, in the order the
 * fields appear, with no a_j the identity.
 */
export function parseBallot(e: ElectionSetup, json: string): DecodedBallot {
  const t: Thing = "The ballot";
  const ballot = parseStrict<Ballot>(t, json, BALLOT);
  const L = e.options.length;
  if (ballot.v !== 1 || ballot.electionId !== e.electionId) throw new TallyError(messages.wrongElection());
  if (ballot.ciphertexts.length !== L) throw new TallyError(messages.ciphertextCount(ballot.ciphertexts.length, L));
  if (ballot.bitProofs.length !== L) throw new TallyError(messages.bitProofCount(ballot.bitProofs.length, L));
  const a: Pt[] = [];
  const b: Pt[] = [];
  ballot.ciphertexts.forEach((ct, j) => {
    a.push(pointAt(t, `ciphertexts[${j}].a`, ct.a));
    b.push(pointAt(t, `ciphertexts[${j}].b`, ct.b));
    if (a[j]!.equals(ZERO)) throw new TallyError(messages.noRandomness(j));
  });
  const bits = ballot.bitProofs.map((p, j) => ({
    c0: scalarAt(t, `bitProofs[${j}].c0`, p.c0),
    c1: scalarAt(t, `bitProofs[${j}].c1`, p.c1),
    z0: scalarAt(t, `bitProofs[${j}].z0`, p.z0),
    z1: scalarAt(t, `bitProofs[${j}].z1`, p.z1),
  }));
  const c = scalarAt(t, "sumProof.c", ballot.sumProof.c);
  const z = scalarAt(t, "sumProof.z", ballot.sumProof.z);
  return { ballot, a, b, bits, c, z };
}

/** The commitments and challenges a verifier recomputes, for test vectors. */
export interface ProofTrace {
  bits: { A0: string; B0: string; A1: string; B1: string; c: string }[];
  sum: { A: string; B: string; T1: string; T2: string; c: string };
}

/** Steps 4 and 5: every bit proof, then the sum proof. */
export function verifyBallotProofs(e: Election, voterTag: Uint8Array, d: DecodedBallot): ProofTrace {
  const { H, ctx } = prepare(e);
  const bits: ProofTrace["bits"] = [];
  let A = ZERO;
  let B = ZERO;
  d.a.forEach((a, j) => {
    const b = d.b[j]!;
    const { c0, c1, z0, z1 } = d.bits[j]!;
    const A0 = mulPub(G, z0).subtract(mulPub(a, c0));
    const B0 = mulPub(H, z0).subtract(mulPub(b, c0));
    const A1 = mulPub(G, z1).subtract(mulPub(a, c1));
    const B1 = mulPub(H, z1).subtract(mulPub(b.subtract(G), c1));
    const c = Hs(LABELS.bit, [ctx, voterTag, j, a.toBytes(), b.toBytes(), A0.toBytes(), B0.toBytes(), A1.toBytes(), B1.toBytes()]);
    if (Fn.add(c0, c1) !== c) throw new TallyError(messages.notBit(j));
    bits.push({ A0: hexOf(A0), B0: hexOf(B0), A1: hexOf(A1), B1: hexOf(B1), c: shex(c) });
    A = A.add(a);
    B = B.add(b);
  });
  const T1 = mulPub(G, d.z).subtract(mulPub(A, d.c));
  const T2 = mulPub(H, d.z).subtract(mulPub(B.subtract(G), d.c));
  const c = Hs(LABELS.sum, [ctx, voterTag, A.toBytes(), B.toBytes(), T1.toBytes(), T2.toBytes()]);
  if (c !== d.c) throw new TallyError(messages.notOne());
  return { bits, sum: { A: hexOf(A), B: hexOf(B), T1: hexOf(T1), T2: hexOf(T2), c: shex(c) } };
}

/** The contract's lookups for steps 6 and 7. */
export interface Ledger {
  /** Whether a ciphertext with this first component (lowercase hex) is already on the ledger for this election. */
  hasCiphertext(a: string): boolean;
  /** Whether this voter tag (lowercase hex) has already voted in this election. */
  hasVoted(tag: string): boolean;
}

export const emptyLedger: Ledger = { hasCiphertext: () => false, hasVoted: () => false };

export interface CheckedBallot {
  ballot: Ballot;
  tracking: string;
  /** Each a_j as lowercase hex, for the repeated-ciphertext keys. */
  ciphertexts: string[];
  trace: ProofTrace;
}

/**
 * Steps 2 to 7 of what the contract checks, in order, stopping at the first
 * failure. Step 1, the election's state, is the contract's own.
 */
export function checkBallot(e: Election, voterTag: Uint8Array, json: string, ledger: Ledger = emptyLedger, voter: "x509" | "idemix" = "x509"): CheckedBallot {
  const d = parseBallot(e, json);
  const trace = verifyBallotProofs(e, voterTag, d);
  const ciphertexts = d.ballot.ciphertexts.map((ct) => ct.a);
  // Step 6: no two ciphertexts of the ballot share a_j, which identical
  // ciphertexts also do, and no a_j is on the ledger. The points are
  // canonical, so equal hex is an equal point.
  for (let i = 0; i < ciphertexts.length; i++) {
    for (let j = i + 1; j < ciphertexts.length; j++) {
      if (ciphertexts[i] === ciphertexts[j]) throw new TallyError(messages.repeatedInBallot(i, j));
    }
  }
  if (ciphertexts.some((a) => ledger.hasCiphertext(a))) throw new TallyError(messages.repeated());
  if (ledger.hasVoted(toHex(voterTag))) throw new TallyError(voter === "x509" ? messages.identityVoted() : messages.credentialVoted());
  return { ballot: d.ballot, tracking: trackingCode(e, voterTag, d.ballot), ciphertexts, trace };
}

/** (A_j, B_j), the sum of every accepted ballot's ciphertexts per option, and N. */
export function addTotals(L: number, ballots: readonly (readonly Ciphertext[])[]): { totals: Ciphertext[]; ballots: number } {
  const A: Pt[] = Array.from({ length: L }, () => ZERO);
  const B: Pt[] = Array.from({ length: L }, () => ZERO);
  for (const cts of ballots) {
    if (cts.length !== L) throw new RangeError("a stored ballot has the wrong length");
    cts.forEach((ct, j) => {
      const a = decodePoint(fromHex(ct.a, 32) ?? new Uint8Array());
      const b = decodePoint(fromHex(ct.b, 32) ?? new Uint8Array());
      if (!a || !b) throw new RangeError("a stored ballot doesn't decode");
      A[j] = A[j]!.add(a);
      B[j] = B[j]!.add(b);
    });
  }
  return { totals: A.map((a, j) => ({ a: hexOf(a), b: hexOf(B[j]!) })), ballots: ballots.length };
}

/* ---------- key ceremony ---------- */

/** noble's FROST DKG hash for the round 1 proof: SHA-512 of the prefix and the message, as a little-endian integer mod l. */
const DKG_PREFIX = utf8("FROST-RISTRETTO255-SHA512-v1dkg");

/** c = HDKG(id || C_i0 || R), as in noble 2.4.0's ristretto255_FROST.DKG. */
export function round1Challenge(index: number, C0: Pt, R: Pt): bigint {
  return scalarFromLE(sha512(concatBytes(DKG_PREFIX, trusteeId(index), C0.toBytes(), R.toBytes())));
}

const ROUND1 = obj([["commitments", list(str)], ["proof", str], ["ceremonyKey", str]]);

export interface Round1 {
  commitments: Pt[];
  R: Pt;
  z: bigint;
  ceremonyKey: Pt;
}

/** PostCommitments: k commitments, none the identity, the one-time key, and noble's proof of knowledge of a_i0. */
export function checkRound1(setup: ElectionSetup, index: number, json: string): Round1 {
  assertSetup(setup);
  const t: Thing = "The round 1 post";
  const msp = setup.trustees[index]!;
  const post = parseStrict<Round1Post>(t, json, ROUND1);
  if (post.commitments.length !== setup.threshold) throw new TallyError(messages.commitmentCount(msp, post.commitments.length, setup.threshold));
  const commitments = post.commitments.map((h, i) => {
    const p = pointAt(t, `commitments[${i}]`, h);
    if (p.equals(ZERO)) throw new TallyError(messages.identityCommitment(msp, i));
    return p;
  });
  const ceremonyKey = pointAt(t, "ceremonyKey", post.ceremonyKey);
  if (ceremonyKey.equals(ZERO)) throw new TallyError(messages.identityCeremonyKey(msp));
  const proof = fromHex(post.proof, 64);
  const R = proof && decodePoint(proof.subarray(0, 32));
  const z = proof && decodeScalar(proof.subarray(32));
  if (!R || R.equals(ZERO) || z === null || z === undefined) throw new TallyError(messages.proofOfKnowledge(msp));
  const c = round1Challenge(index, commitments[0]!, R);
  if (!mulPub(G, z).subtract(mulPub(commitments[0]!, c)).equals(R)) throw new TallyError(messages.proofOfKnowledge(msp));
  return { commitments, R, z, ceremonyKey };
}

const ROUND2 = obj([["shares", list(obj([["to", str], ["nonce", str], ["box", str]]))]]);

/** PostShares: one share of the right length for each other trustee. The contract can't read the shares. */
export function checkRound2(setup: ElectionSetup, index: number, json: string): Round2Post {
  assertSetup(setup);
  const t: Thing = "The round 2 post";
  const post = parseStrict<Round2Post>(t, json, ROUND2);
  const to = post.shares.map((s, i) => {
    const id = scalarAt(t, `shares[${i}].to`, s.to);
    bytesAt(t, `shares[${i}].nonce`, s.nonce, 12);
    bytesAt(t, `shares[${i}].box`, s.box, 48);
    return id;
  });
  const n = setup.trustees.length;
  const expected = new Set(setup.trustees.map((_, i) => BigInt(i + 1)).filter((id) => id !== BigInt(index + 1)));
  const seen = new Set<bigint>();
  for (const id of to) {
    if (!expected.has(id) || seen.has(id)) throw new TallyError(messages.shareRecipients(setup.trustees[index]!));
    seen.add(id);
  }
  if (seen.size !== n - 1) throw new TallyError(messages.shareRecipients(setup.trustees[index]!));
  return post;
}

/** OpenElection: H and every S_j from the round 1 commitments, in trustee order. */
export function electionKeys(setup: ElectionSetup, round1: readonly Round1[]): ElectionKeys {
  return keysFromCommitments(setup, round1.map((r) => r.commitments)).keys;
}

const CONFIRM = obj([["c", str], ["z", str]]);

/** ConfirmShares: c = Hs("confirm", [ctx, id_j, S_j, z·G - c·S_j]). */
export function checkConfirmation(e: Election, index: number, json: string): ConfirmationPost {
  const t: Thing = "The confirmation";
  const { ctx, S, ids } = prepare(e);
  const post = parseStrict<ConfirmationPost>(t, json, CONFIRM);
  const c = scalarAt(t, "c", post.c);
  const z = scalarAt(t, "z", post.z);
  const Sj = S[index]!;
  const R = mulPub(G, z).subtract(mulPub(Sj, c));
  if (Hs(LABELS.confirm, [ctx, ids[index]!, Sj.toBytes(), R.toBytes()]) !== c) throw new TallyError(messages.confirmation(e.trustees[index]!));
  return post;
}

/* ---------- decryption ---------- */

const DSHARE = obj([["shares", list(obj([["d", str], ["c", str], ["z", str]]))]]);

/** PostDecryptionShare: for each total, D_ij = s_i·A_j with a proof against S_i. */
export function checkDecryptionShare(e: Election, totals: readonly Ciphertext[], index: number, json: string): DecryptionSharePost {
  const t: Thing = "The decryption share";
  const { ctx, S, ids } = prepare(e);
  const post = parseStrict<DecryptionSharePost>(t, json, DSHARE);
  const L = e.options.length;
  if (post.shares.length !== L) throw new TallyError(messages.shareCount(post.shares.length, L));
  const decoded = post.shares.map((s, j) => ({
    d: pointAt(t, `shares[${j}].d`, s.d),
    c: scalarAt(t, `shares[${j}].c`, s.c),
    z: scalarAt(t, `shares[${j}].z`, s.z),
  }));
  const Si = S[index]!;
  decoded.forEach(({ d, c, z }, j) => {
    const A = decodePoint(fromHex(totals[j]!.a, 32)!)!;
    const T1 = mulPub(G, z).subtract(mulPub(Si, c));
    const T2 = mulPub(A, z).subtract(mulPub(d, c));
    if (Hs(LABELS.share, [ctx, ids[index]!, j, A.toBytes(), d.toBytes(), Si.toBytes(), T1.toBytes(), T2.toBytes()]) !== c) {
      throw new TallyError(messages.share(j, e.trustees[index]!));
    }
  });
  return post;
}

export interface PostedShare {
  /** The trustee's 0-based index; its identifier is index + 1. */
  index: number;
  share: DecryptionSharePost;
}

export interface TallyResult {
  /** The indexes of the k trustees whose shares were combined: the lowest identifiers. */
  quorum: number[];
  /** lambda_i for each trustee in the quorum, as scalars. */
  lambdas: string[];
  /** M_j = t_j·G for each option. */
  M: string[];
  counts: number[];
  total: number;
}

/** Lagrange coefficient at 0 for identifier i among ids. */
export function lagrange(i: bigint, ids: readonly bigint[]): bigint {
  let num = Fn.ONE;
  let den = Fn.ONE;
  for (const m of ids) {
    if (m === i) continue;
    num = Fn.mul(num, m);
    den = Fn.mul(den, Fn.sub(m, i));
  }
  return Fn.div(num, den);
}

/**
 * PublishTally: combines the shares of the k trustees with the lowest
 * identifiers and finds each count t_j in 0 to N by stepping from 0. The
 * shares must already have been checked with checkDecryptionShare.
 */
export function recoverTally(e: Election, totals: readonly Ciphertext[], ballots: number, posted: readonly PostedShare[]): TallyResult {
  const k = e.threshold;
  if (posted.length < k) throw new TallyError(messages.tooFewShares(k, posted.length));
  const quorum = [...posted].sort((x, y) => x.index - y.index).slice(0, k);
  const ids = quorum.map((q) => BigInt(q.index + 1));
  const lambdas = ids.map((id) => lagrange(id, ids));
  const M: Pt[] = totals.map(({ b }, j) => {
    let m = decodePoint(fromHex(b, 32)!)!;
    quorum.forEach((q, n) => {
      m = m.subtract(mulPub(decodePoint(fromHex(q.share.shares[j]!.d, 32)!)!, lambdas[n]!));
    });
    return m;
  });
  const counts = M.map((m) => {
    let cur = ZERO;
    for (let t = 0; t <= ballots; t++) {
      if (cur.equals(m)) return t;
      cur = cur.add(G);
    }
    throw new TallyError(messages.countTooLarge());
  });
  const sum = counts.reduce((x, y) => x + y, 0);
  if (sum !== ballots) throw new TallyError(messages.countsSum(sum, ballots));
  return { quorum: quorum.map((q) => q.index), lambdas: lambdas.map(shex), M: M.map(hexOf), counts, total: sum };
}

export * from "./index.ts";
