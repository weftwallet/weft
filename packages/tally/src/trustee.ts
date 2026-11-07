/**
 * The trustees' side, for weft-trustee: the key ceremony's three rounds and
 * decryption shares, with randomness from crypto.getRandomValues. Every
 * value returned as a TrusteeSecret or KeyShare is secret.
 */
import { decryptionShareWith, round1With, round2With, round3With, type KeyShare, type Round3Result, type TrusteeSecret } from "./ceremony.ts";
import type { Election, ElectionSetup } from "./election.ts";
import { systemRandom } from "./random.ts";
import type { Ciphertext, DecryptionSharePost, Round1Post, Round2Post } from "./types.ts";

export * from "./index.ts";
export { BadShareError, type KeyShare, type Round3Result, type TrusteeSecret } from "./ceremony.ts";

/** Round 1: the polynomial, its commitments, the proof of knowledge and the one-time ceremony key. */
export function ceremonyRound1(setup: ElectionSetup, index: number): { post: Round1Post; secret: TrusteeSecret } {
  return round1With(setup, index, systemRandom);
}

/** Round 2, once every trustee has posted round 1: a share for each other trustee, encrypted to its one-time key. */
export function ceremonyRound2(setup: ElectionSetup, secret: TrusteeSecret, round1: readonly Round1Post[]): Promise<Round2Post> {
  return round2With(setup, secret, round1, systemRandom);
}

/**
 * Round 3, once every trustee has posted round 2: opens and checks the
 * shares sent to this trustee, and proves it holds its key share. Throws
 * BadShareError naming the sender of a share that fails, which the trustee
 * reports with ReportBadShare. Delete the TrusteeSecret afterwards.
 */
export function ceremonyRound3(setup: ElectionSetup, secret: TrusteeSecret, round1: readonly Round1Post[], round2: readonly (Round2Post | null)[]): Promise<Round3Result> {
  return round3With(setup, secret, round1, round2, systemRandom);
}

/** This trustee's decryption share of each total, with its proofs. */
export function decryptionShare(e: Election, keyShare: KeyShare, totals: readonly Ciphertext[]): DecryptionSharePost {
  return decryptionShareWith(e, keyShare, totals, systemRandom);
}
