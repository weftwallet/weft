/**
 * The checks the indexer makes of each private-ballot ballot that need no
 * index (docs/adr/0007 and 0008): a ballot's proofs, its tracking code and
 * what the contract stored, and for an anonymous ballot its creator and
 * pseudonym proof with the idemix module. They are the slow part of
 * indexing a ballot, and pure, so the indexer runs them in a pool of worker
 * threads (check-pool.ts, check-worker.ts), several ballots of a block at
 * once, and keeps the server's main thread for requests. The checks across
 * ballots (a repeated ciphertext, a repeated voter tag) need the index, and
 * private-elections.ts makes them on the main thread, in ledger order.
 *
 * A result splits the ballot's own checks around those: `before` is what
 * checkBallot would have refused before it looked at the ledger, and `after`
 * what the indexer compares once checkBallot has passed. The ledger's check
 * goes between them, so each ballot gets the same first failure as when all
 * of it ran in one place.
 */

import type { IdemixSync, PseudonymProof } from "@weftwallet/idemix";
import { fromHex, trackingCode, type Ballot, type Election } from "@weftwallet/tally";
import { checkBallot, emptyLedger } from "@weftwallet/tally/verify";
import { checkAnonymousBallot, electionFrom, messageOf, type AnonymousCreator, type AnonymousVoters, type CheckedElection } from "./full-check.ts";
import { goJsonParse } from "./go-utf8.ts";

/** One ballot to check, as plain data, so it can be posted to a worker thread. */
export type BallotTask =
  | {
      kind: "x509";
      election: CheckedElection;
      /** The voter tag worked out from the transaction's creator, in lowercase hex. */
      voterTag: string;
      /** The ballot argument, as the contract read it. */
      ballotJson: string;
      /** The tracking code and the ballot the contract stored. */
      tracking: string;
      stored: unknown;
    }
  | {
      kind: "idemix";
      election: CheckedElection;
      voters: AnonymousVoters;
      /** The voter tag made from the ballot's pseudonym, in lowercase hex. */
      voterTag: string;
      ballotJson: string;
      tracking: string;
      stored: unknown;
      /** The pseudonym proof the transaction sent, and the one the contract stored. */
      proof: PseudonymProof;
      storedProof: PseudonymProof | null;
      creator: AnonymousCreator;
      txId: string;
      block: number;
    };

export interface BallotResult {
  /** The first failure before the ledger's check, or null. */
  before: string | null;
  /** The ballot's a_j, when its proofs checked out. */
  ciphertexts: string[];
  /** The first failure after the ledger's check, or null. */
  after: string | null;
  /** How long the whole check took, and the creator and pseudonym part of it (null when that didn't run). */
  ms: number;
  anonymousMs: number | null;
}

/** A key for a task's inputs, so a check started early is used only for the same ballot and election. */
export function taskKey(t: BallotTask): string {
  const e = t.election;
  return [t.kind, e.channel, e.chaincode, e.electionId, e.context ?? "", e.publicKey ?? "", t.voterTag, t.ballotJson, t.tracking].join("\u0000");
}

const sameBallot = (x: unknown) => {
  const o = (x ?? {}) as Record<string, unknown>;
  return JSON.stringify({ c: o.ciphertexts, b: o.bitProofs, s: o.sumProof });
};

/**
 * The verifiers' Election for a task, made once per election and key in
 * each thread, so the key's table is precomputed once.
 */
export function electionCache(limit = 64): (e: CheckedElection) => Election | null {
  const cache = new Map<string, Election>();
  return (e) => {
    const key = `${e.channel}\u0000${e.chaincode}\u0000${e.electionId}\u0000${e.context ?? ""}\u0000${e.publicKey ?? ""}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const made = electionFrom(e);
    if (made) {
      if (cache.size >= limit) cache.clear();
      cache.set(key, made);
    }
    return made;
  };
}

/** Runs one task. `idemix` is the module in this thread, or null when it didn't start. */
export function runBallotTask(t: BallotTask, electionOf: (e: CheckedElection) => Election | null, idemix: IdemixSync | null): BallotResult {
  const started = performance.now();
  const out: BallotResult = { before: null, ciphertexts: [], after: null, ms: 0, anonymousMs: null };
  const e = electionOf(t.election);
  if (!e) out.before = "This explorer has no key for this election.";
  else {
    try {
      const tag = fromHex(t.voterTag, 32)!;
      if (t.kind === "idemix") {
        // The tracking code the pseudonym proof is bound to, from the ballot
        // as sent; checkBallot below finds it again with the ballot's proofs.
        const sent = goJsonParse(t.ballotJson) as Ballot;
        const bound = trackingCode(e, tag, sent);
        if (!idemix) out.before = "This explorer couldn't start the idemix module, so it can't check this ballot's creator or pseudonym.";
        else {
          const a = performance.now();
          out.before = checkAnonymousBallot(idemix, e, t.voters, {
            index: -1,
            txId: t.txId,
            block: t.block,
            tracking: bound,
            voterTag: t.voterTag,
            ballot: sent,
            pseudonym: t.proof,
            anonymousCreator: t.creator,
          });
          out.anonymousMs = performance.now() - a;
        }
      }
      if (!out.before) {
        const checked = checkBallot(e, tag, t.ballotJson, emptyLedger, t.kind);
        out.ciphertexts = checked.ciphertexts;
        if (checked.tracking !== t.tracking) out.after = "The tracking code the contract wrote isn't the one this ballot gives.";
        else if (sameBallot(checked.ballot) !== sameBallot(t.stored)) out.after = "The ballot the contract stored isn't the one the transaction sent.";
        else if (t.kind === "idemix" && JSON.stringify(t.storedProof) !== JSON.stringify(t.proof)) {
          out.after = "The pseudonym proof the contract stored isn't the one the transaction sent.";
        }
      }
    } catch (failure) {
      out.before = messageOf(failure);
      out.ciphertexts = [];
    }
  }
  out.ms = performance.now() - started;
  return out;
}
