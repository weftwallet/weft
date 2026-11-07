/**
 * The trustees' side, with randomness as an argument: the three rounds of
 * the key ceremony over noble's FROST DKG, the share boxes (HKDF-SHA-256 and
 * AES-256-GCM), the confirmation proof and decryption shares. trustee.ts
 * passes crypto.getRandomValues; testing.ts passes fixed values.
 */
import { ristretto255_FROST as FROST } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { frame, hexBytes, toHex } from "./encoding.ts";
import { Fn, G, ZERO, decodePoint, decodeScalar, mulPub, mulSecret, trusteeId, type Pt } from "./group.ts";
import { Hs, LABELS } from "./hash.ts";
import { assertSetup, prepare, type Election, type ElectionKeys, type ElectionSetup } from "./election.ts";
import { nobleRng, randomScalar, type RandomSource } from "./random.ts";
import { checkRound1, checkRound2, electionKeys, type Round1 } from "./verify.ts";
import type { Ciphertext, ConfirmationPost, DecryptionSharePost, Round1Post, Round2Post } from "./types.ts";

/** What a trustee keeps between rounds 1 and 3. Secret: the trustee tool stores it encrypted. */
export interface TrusteeSecret {
  v: 1;
  channel: string;
  electionId: string;
  index: number;
  /** a_i0, ..., a_i(k-1) */
  coefficients: string[];
  /** e_i, the one-time ceremony key, deleted after round 3. */
  ceremonyKey: string;
}

/** What a trustee keeps after round 3. Secret: any k of these decrypt any ballot. */
export interface KeyShare {
  v: 1;
  channel: string;
  electionId: string;
  index: number;
  /** s_j */
  share: string;
}

/** A received share that doesn't open, or doesn't match its sender's commitments. */
export class BadShareError extends Error {
  override name = "BadShareError";
  /** The sender's 0-based index. */
  readonly from: number;
  constructor(from: number, msp: string) {
    super(`The share from ${msp} doesn't match ${msp}'s round 1 commitments.`);
    this.from = from;
  }
}

const shex = (s: bigint) => toHex(Fn.toBytes(s));
const scalar = (h: string) => {
  const s = decodeScalar(hexBytes(h, 32));
  if (s === null) throw new RangeError("not a scalar");
  return s;
};
const ab = (b: Uint8Array) => new Uint8Array(b);

/* ---------- round 1 ---------- */

export function round1With(setup: ElectionSetup, index: number, rand: RandomSource): { post: Round1Post; secret: TrusteeSecret } {
  assertSetup(setup);
  const signers = { min: setup.threshold, max: setup.trustees.length };
  const { public: pub, secret } = FROST.DKG.round1(FROST.Identifier.fromNumber(index + 1), signers, undefined, nobleRng(rand));
  const e = randomScalar(rand);
  const post: Round1Post = {
    commitments: pub.commitment.map(toHex),
    proof: toHex(pub.proofOfKnowledge),
    ceremonyKey: toHex(mulSecret(G, e).toBytes()),
  };
  const coefficients = (secret.coefficients ?? []).map(shex);
  FROST.DKG.clean(secret);
  return { post, secret: { v: 1, channel: setup.channel, electionId: setup.electionId, index, coefficients, ceremonyKey: shex(e) } };
}

/* ---------- the share boxes ---------- */

/** info = frame(["weft-ballot-v1 share", channel, electionId, id_i, id_j]), for a share from trustee i to trustee j. */
export function shareInfo(setup: ElectionSetup, from: number, to: number): Uint8Array {
  return frame([LABELS.shareBox, setup.channel, setup.electionId, trusteeId(from), trusteeId(to)]);
}

/**
 * key = HKDF-SHA-256(ikm = encoding of K, salt = empty, info, 32 bytes), where K = e_i·E_j = e_j·E_i.
 * `mine` is this trustee's one-time secret and `theirs` the other trustee's one-time public key.
 */
export function shareKey(setup: ElectionSetup, from: number, to: number, mine: bigint, theirs: Pt): Uint8Array {
  return hkdf(sha256, mulSecret(theirs, mine).toBytes(), new Uint8Array(0), shareInfo(setup, from, to), 32);
}

async function aes(key: Uint8Array, usage: "encrypt" | "decrypt"): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey("raw", ab(key), { name: "AES-GCM" }, false, [usage]);
}

/** box = AES-256-GCM(key, nonce, aad = info, plaintext = y as 32 bytes): 32 bytes of ciphertext and a 16-byte tag. */
export async function sealShare(key: Uint8Array, info: Uint8Array, nonce: Uint8Array, y: bigint): Promise<Uint8Array> {
  const out = await globalThis.crypto.subtle.encrypt({ name: "AES-GCM", iv: ab(nonce), additionalData: ab(info), tagLength: 128 }, await aes(key, "encrypt"), ab(Fn.toBytes(y)));
  return new Uint8Array(out);
}

/** The share inside a box, or null if it doesn't open or isn't a scalar. */
export async function openShare(key: Uint8Array, info: Uint8Array, nonce: Uint8Array, box: Uint8Array): Promise<bigint | null> {
  try {
    const out = await globalThis.crypto.subtle.decrypt({ name: "AES-GCM", iv: ab(nonce), additionalData: ab(info), tagLength: 128 }, await aes(key, "decrypt"), ab(box));
    return decodeScalar(new Uint8Array(out));
  } catch {
    return null;
  }
}

/* ---------- noble's DKG state ---------- */

function nobleSecret(setup: ElectionSetup, secret: TrusteeSecret) {
  const coefficients = secret.coefficients.map(scalar);
  return {
    identifier: BigInt(secret.index + 1),
    coefficients,
    commitment: coefficients.map((a) => mulSecret(G, a).toBytes()),
    signers: { min: setup.threshold, max: setup.trustees.length },
    step: 1 as const,
  };
}

function nobleRound1(posts: readonly Round1Post[], except: number) {
  return posts
    .map((p, i) => ({ identifier: FROST.Identifier.fromNumber(i + 1), commitment: p.commitments.map((h) => hexBytes(h, 32)), proofOfKnowledge: hexBytes(p.proof, 64) }))
    .filter((_, i) => i !== except);
}

function checkAll(setup: ElectionSetup, secret: TrusteeSecret, posts: readonly Round1Post[]): Round1[] {
  if (secret.channel !== setup.channel || secret.electionId !== setup.electionId) throw new RangeError("this state is for another election");
  if (posts.length !== setup.trustees.length) throw new RangeError("one round 1 post per trustee");
  const r1 = posts.map((p, i) => checkRound1(setup, i, JSON.stringify(p)));
  const mine = secret.coefficients.map((a) => toHex(mulSecret(G, scalar(a)).toBytes()));
  if (mine.some((c, t) => c !== posts[secret.index]!.commitments[t])) throw new RangeError("the ledger's round 1 for this trustee isn't the one this state posted");
  return r1;
}

/* ---------- round 2 ---------- */

/** Encrypts y_ij = f_i(id_j) to every other trustee j's one-time key. Draws one 12-byte nonce per recipient, in trustee order. */
export async function round2With(setup: ElectionSetup, secret: TrusteeSecret, round1: readonly Round1Post[], rand: RandomSource): Promise<Round2Post> {
  const r1 = checkAll(setup, secret, round1);
  const i = secret.index;
  const shares = FROST.DKG.round2(nobleSecret(setup, secret), nobleRound1(round1, i));
  const e = scalar(secret.ceremonyKey);
  const out: Round2Post["shares"] = [];
  for (let j = 0; j < setup.trustees.length; j++) {
    if (j === i) continue;
    const y = scalar(toHex(shares[FROST.Identifier.fromNumber(j + 1)]!.signingShare));
    const info = shareInfo(setup, i, j);
    const key = shareKey(setup, i, j, e, r1[j]!.ceremonyKey);
    const nonce = rand.bytes(12);
    out.push({ to: toHex(trusteeId(j)), nonce: toHex(nonce), box: toHex(await sealShare(key, info, nonce, y)) });
  }
  return { shares: out };
}

/* ---------- round 3 ---------- */

/** z·G = R + c·S_j, with c = Hs("confirm", [ctx, id_j, S_j, R]). */
export function proveConfirmation(e: Election, index: number, s: bigint, w: bigint): ConfirmationPost {
  const { ctx, S, ids } = prepare(e);
  const c = Hs(LABELS.confirm, [ctx, ids[index]!, S[index]!.toBytes(), mulSecret(G, w).toBytes()]);
  return { c: shex(c), z: shex(Fn.add(w, Fn.mul(c, s))) };
}

export interface Round3Result {
  keyShare: KeyShare;
  confirmation: ConfirmationPost;
  keys: ElectionKeys;
}

/**
 * Opens each share sent to this trustee and checks it against its sender's
 * commitments, then sums them into s_j with noble's round 3 and proves that
 * it holds s_j. Throws BadShareError naming the first sender whose share fails.
 */
export async function round3With(
  setup: ElectionSetup,
  secret: TrusteeSecret,
  round1: readonly Round1Post[],
  round2: readonly (Round2Post | null)[],
  rand: RandomSource,
): Promise<Round3Result> {
  const r1 = checkAll(setup, secret, round1);
  const j = secret.index;
  const myId = toHex(trusteeId(j));
  const e = scalar(secret.ceremonyKey);
  const received: { identifier: string; signingShare: Uint8Array }[] = [];
  for (let i = 0; i < setup.trustees.length; i++) {
    if (i === j) continue;
    const post = checkRound2(setup, i, JSON.stringify(round2[i]));
    const entry = post.shares.find((s) => s.to === myId)!;
    const info = shareInfo(setup, i, j);
    const key = shareKey(setup, i, j, e, r1[i]!.ceremonyKey);
    const y = await openShare(key, info, hexBytes(entry.nonce, 12), hexBytes(entry.box, 48));
    // y_ij·G = sum over t of (id_j^t)·C_it
    let expected = ZERO;
    let pow = 1n;
    for (const C of r1[i]!.commitments) {
      expected = expected.add(mulPub(C, pow));
      pow = Fn.mul(pow, BigInt(j + 1));
    }
    if (y === null || !mulSecret(G, y).equals(expected)) throw new BadShareError(i, setup.trustees[i]!);
    received.push({ identifier: FROST.Identifier.fromNumber(i + 1), signingShare: Fn.toBytes(y) });
  }
  const state = nobleSecret(setup, secret);
  const others = nobleRound1(round1, j);
  FROST.DKG.round2(state, others);
  const key = FROST.DKG.round3(state, others, received);
  const s = scalar(toHex(key.secret.signingShare));
  const keys = electionKeys(setup, r1);
  if (toHex(key.public.commitments[0]!) !== keys.publicKey) throw new Error("noble's key differs from the key the contract computes");
  for (let t = 0; t < setup.trustees.length; t++) {
    if (toHex(key.public.verifyingShares[FROST.Identifier.fromNumber(t + 1)]!) !== keys.verifyingShares[t]) throw new Error("noble's verifying shares differ from the contract's");
  }
  const election: Election = { ...setup, ...keys };
  const confirmation = proveConfirmation(election, j, s, randomScalar(rand));
  return { keyShare: { v: 1, channel: setup.channel, electionId: setup.electionId, index: j, share: shex(s) }, confirmation, keys };
}

/* ---------- decryption shares ---------- */

/** For each total, D = s_i·A_j, with c = Hs("share", [ctx, id_i, j, A_j, D, S_i, w·G, w·A_j]) and z = w + c·s_i. Draws one w per option. */
export function decryptionShareWith(e: Election, keyShare: KeyShare, totals: readonly Ciphertext[], rand: RandomSource): DecryptionSharePost {
  const { ctx, S, ids } = prepare(e);
  const i = keyShare.index;
  if (keyShare.channel !== e.channel || keyShare.electionId !== e.electionId) throw new RangeError("this key share is for another election");
  const s = scalar(keyShare.share);
  if (!mulSecret(G, s).equals(S[i]!)) throw new RangeError(`this key share isn't the one behind ${e.trustees[i]}'s verifying share`);
  if (totals.length !== e.options.length) throw new RangeError("one total per option");
  return {
    shares: totals.map(({ a }, j) => {
      const A = decodePoint(hexBytes(a, 32));
      if (!A) throw new RangeError("a total doesn't decode");
      const D = mulSecret(A, s);
      const w = randomScalar(rand);
      const c = Hs(LABELS.share, [ctx, ids[i]!, j, A.toBytes(), D.toBytes(), S[i]!.toBytes(), mulSecret(G, w).toBytes(), mulSecret(A, w).toBytes()]);
      return { d: toHex(D.toBytes()), c: shex(c), z: shex(Fn.add(w, Fn.mul(c, s))) };
    }),
  };
}
