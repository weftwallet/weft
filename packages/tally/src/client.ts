/**
 * The voter's side, for Weft Experimental's background worker: encrypt a
 * choice under the election key and prove the ballot. The randomness comes
 * from crypto.getRandomValues and is discarded before this returns, so
 * nothing the caller gets back can show which option was chosen.
 */
import { choiceMessages, drawBallotRandomness, proveBallot } from "./prove.ts";
import { prepare, type Election } from "./election.ts";
import { systemRandom } from "./random.ts";
import { ballotJson, type Ballot } from "./types.ts";

export * from "./index.ts";

export interface EncryptedBallot {
  ballot: Ballot;
  /** The ballotJson argument for CastBallot. */
  json: string;
  /** The tracking code, 64 lowercase hex characters: the receipt. */
  tracking: string;
}

/** Encrypts option `choice` (0-based) for the voter with this tag, with its proofs. */
export function encryptBallot(e: Election, voterTag: Uint8Array, choice: number): EncryptedBallot {
  prepare(e);
  const messages = choiceMessages(e.options.length, choice);
  // The randomness is referenced only here and goes out of scope on return.
  // JavaScript can't wipe a bigint, so nothing more can be done in memory.
  const { ballot, tracking } = proveBallot(e, voterTag, messages, drawBallotRandomness(e.options.length, systemRandom));
  return { ballot, json: ballotJson(ballot), tracking };
}
