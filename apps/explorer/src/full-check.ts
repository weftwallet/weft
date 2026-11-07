/**
 * The full check of a private election (docs/adr/0007), from published data
 * only: the key ceremony, every ballot, the totals, the decryption shares
 * and the tally. The browser runs it in Web Workers (full-check-worker.ts,
 * bundled to dist/worker/full-check.js), and the indexer runs the same code
 * as it reads each block (private-elections.ts). Every check is
 * @weftwallet/tally's verifying half, the code the contract's Go verifiers
 * are held to by the test vectors, and each refusal carries the contract's
 * own message where the contract has one.
 *
 * Nothing here reads the DOM, the network or a clock, so the worker, Node
 * and the tests run it alike.
 */

import { electionContext, electionFingerprint, fromHex, toHex, voterTagX509, type Election, type ElectionSetup } from "@weftwallet/tally";
import {
  TallyError,
  addTotals,
  checkBallot,
  checkConfirmation,
  checkDecryptionShare,
  checkRound1,
  checkRound2,
  electionKeys,
  recoverTally,
  type Ledger,
  type Round1,
} from "@weftwallet/tally/verify";

/** What the check needs of an election: the setup CreateElection fixed, and what its record says the ceremony fixed. */
export interface CheckedElection extends ElectionSetup {
  publicKey: string | null;
  verifyingShares: readonly string[] | null;
  context: string | null;
  fingerprint: string | null;
}

/** One ballot, as the explorer publishes it. */
export interface PublishedBallot {
  /** Its place in ledger order, from 0. */
  index: number;
  txId: string;
  block: number;
  tracking: string;
  voterTag: string;
  ballot: unknown;
  /** Only when the explorer shows submitters: the MSP ID and id_bytes (base64), from which the tag is worked out again. */
  creator?: { mspId: string; idBytes: string } | null;
}

export interface BallotFailure {
  index: number;
  txId: string;
  block: number;
  tracking: string;
  message: string;
}

/** A refusal's message: a TallyError's is the contract's own; anything else is a fault in the data. */
export function messageOf(error: unknown): string {
  if (error instanceof TallyError) return error.message;
  if (error instanceof Error) return `The data doesn't decode: ${error.message}`;
  return String(error);
}

/** The election as @weftwallet/tally's verifiers take it, once the key exists. */
export function electionFrom(e: CheckedElection): Election | null {
  if (!e.publicKey || !e.verifyingShares) return null;
  return {
    channel: e.channel,
    chaincode: e.chaincode,
    electionId: e.electionId,
    options: e.options,
    threshold: e.threshold,
    trustees: e.trustees,
    publicKey: e.publicKey,
    verifyingShares: e.verifyingShares,
  };
}

/** Base64 to bytes, in Node and in a worker. */
function base64(text: string): Uint8Array {
  const raw = atob(text);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Each trustee's ceremony posts, in the order of the trustee list, as the contract stored them. */
export interface CeremonyPosts {
  round1: unknown | null;
  round2: unknown | null;
  confirmation: unknown | null;
}

/**
 * The key ceremony: every round 1 proof of knowledge, every round 2 post's
 * shape, the key and verifying shares worked out again from the round 1
 * commitments, the context and fingerprint worked out again from the record,
 * and every confirmation. Returns the first failure's message, or null.
 */
export function checkCeremony(e: CheckedElection, posts: readonly CeremonyPosts[]): string | null {
  try {
    const round1: Round1[] = [];
    for (const [i, msp] of e.trustees.entries()) {
      const p = posts[i];
      if (!p?.round1) return `Round 1 from ${msp} isn't on the ledger.`;
      round1.push(checkRound1(e, i, JSON.stringify(p.round1)));
    }
    for (const [i, msp] of e.trustees.entries()) {
      const p = posts[i]!;
      if (!p.round2) return `Round 2 from ${msp} isn't on the ledger.`;
      checkRound2(e, i, JSON.stringify(p.round2));
    }
    const keys = electionKeys(e, round1);
    if (keys.publicKey !== e.publicKey || keys.verifyingShares.some((s, i) => s !== e.verifyingShares?.[i])) {
      return "The election key on the ledger isn't the one the trustees' round 1 commitments give.";
    }
    const election: Election = { ...e, ...keys };
    if (toHex(electionContext(election)) !== e.context) return "The election's context on the ledger isn't the one its record gives.";
    if (electionFingerprint(election) !== e.fingerprint) return "The election fingerprint on the ledger isn't the one its record gives.";
    for (const [i, msp] of e.trustees.entries()) {
      const p = posts[i]!;
      if (!p.confirmation) return `The confirmation from ${msp} isn't on the ledger.`;
      checkConfirmation(election, i, JSON.stringify(p.confirmation));
    }
    return null;
  } catch (error) {
    return messageOf(error);
  }
}

/**
 * One ballot, from what is published: its voter tag (worked out again from
 * the submitter's certificate when that is published), its proofs as the
 * contract checks them, and its tracking code. Ballots that repeat a voter
 * tag or a ciphertext are found across ballots, by the caller.
 */
export function checkOneBallot(e: Election, b: PublishedBallot, ledger?: Ledger): string | null {
  try {
    const tag = fromHex(b.voterTag, 32);
    if (!tag) return "Its voter tag isn't 32 bytes of lowercase hex.";
    if (b.creator) {
      const own = toHex(voterTagX509(e.channel, e.electionId, b.creator.mspId, base64(b.creator.idBytes)));
      if (own !== b.voterTag) return "Its voter tag isn't the one its submitter's certificate gives.";
    }
    const checked = checkBallot(e, tag, JSON.stringify(b.ballot), ledger);
    if (checked.tracking !== b.tracking) return "Its tracking code isn't the one the ballot gives.";
    return null;
  } catch (error) {
    return messageOf(error);
  }
}

/** A run of ballots in ledger order, stopping at the first failure. `progress` is called every few ballots. */
export function checkBallots(e: Election, ballots: readonly PublishedBallot[], progress?: (done: number) => void): { done: number; failure: BallotFailure | null } {
  for (const [n, b] of ballots.entries()) {
    const message = checkOneBallot(e, b);
    if (message) return { done: n, failure: { index: b.index, txId: b.txId, block: b.block, tracking: b.tracking, message } };
    if (progress && (n + 1) % 5 === 0) progress(n + 1);
  }
  return { done: ballots.length, failure: null };
}

/**
 * The checks that span ballots, as the contract's steps 6 and 7 make them:
 * the first ballot, in ledger order, that repeats a voter tag or a
 * ciphertext already on the ledger. Plain string comparisons: the points
 * are canonical, so equal hex is an equal point.
 */
export function firstRepeat(ballots: readonly PublishedBallot[]): { index: number; message: string } | null {
  const tags = new Set<string>();
  const as = new Set<string>();
  for (const b of ballots) {
    const cts = (b.ballot as { ciphertexts?: { a?: unknown }[] } | null)?.ciphertexts ?? [];
    const own = cts.map((c) => String(c?.a));
    if (own.some((a) => as.has(a))) return { index: b.index, message: "A ciphertext in this ballot is already on the ledger." };
    if (tags.has(b.voterTag)) return { index: b.index, message: "This identity has already voted in this election." };
    own.forEach((a) => as.add(a));
    tags.add(b.voterTag);
  }
  return null;
}

export interface CountCheck {
  /** Every ballot's ciphertexts, in option order. */
  ciphertexts: readonly (readonly { a: string; b: string }[])[];
  /** What the record says once voting has closed. */
  recordBallots: number | null;
  totals: readonly { a: string; b: string }[] | null;
  /** Each posted decryption share, with its trustee's index in the trustee list. */
  shares: readonly { index: number; share: unknown }[];
  /** The published counts, in option order, once counted. */
  counts: readonly number[] | null;
}

export interface CountResult {
  totals: string | null;
  shares: string | null;
  tally: string | null;
}

/** The totals added up again, every decryption share's proofs, and the counts found again from the shares. */
export function checkCount(e: Election, c: CountCheck): CountResult {
  const result: CountResult = { totals: null, shares: null, tally: null };
  if (!c.totals || c.recordBallots === null) return result;
  try {
    if (c.recordBallots !== c.ciphertexts.length) {
      result.totals = `The record says ${c.recordBallots} ${c.recordBallots === 1 ? "ballot was" : "ballots were"} counted, and ${c.ciphertexts.length} ${c.ciphertexts.length === 1 ? "is" : "are"} published.`;
      return result;
    }
    const added = addTotals(e.options.length, c.ciphertexts).totals;
    if (added.length !== c.totals.length || added.some((t, j) => t.a !== c.totals![j]?.a || t.b !== c.totals![j]?.b)) {
      result.totals = `The totals on the ledger aren't the sum of the ${c.ciphertexts.length} ${c.ciphertexts.length === 1 ? "ballot" : "ballots"}.`;
      return result;
    }
  } catch (error) {
    result.totals = messageOf(error);
    return result;
  }
  try {
    for (const s of c.shares) checkDecryptionShare(e, c.totals, s.index, JSON.stringify(s.share));
  } catch (error) {
    result.shares = messageOf(error);
    return result;
  }
  if (!c.counts) return result;
  try {
    const posted = c.shares.map((s) => ({ index: s.index, share: s.share as { shares: { d: string; c: string; z: string }[] } }));
    const found = recoverTally(e, c.totals, c.recordBallots, posted);
    if (found.counts.length !== c.counts.length || found.counts.some((n, j) => n !== c.counts![j])) {
      result.tally = "The published counts aren't the ones the decryption shares give.";
    }
  } catch (error) {
    result.tally = messageOf(error);
  }
  return result;
}
