/**
 * The browser's full check of a private election, in a Web Worker. The
 * election page (private-pages.ts) starts up to four, hands each batches of
 * ballots in ledger order, and gives one the key ceremony and the count.
 * scripts/build-worker.mjs bundles this file, with @weftwallet/tally and
 * noble, to dist/worker/full-check.js, which the explorer serves as
 * /assets/full-check.js when it runs with WEFT_EXPERIMENTAL=1.
 *
 * Messages in, each with an id that the answer repeats:
 *   { type: "ceremony", election, posts }
 *   { type: "ballots", election, ballots }   answered with "progress" messages, then "done"
 *   { type: "count", election, count }
 */

import type { Election } from "@weftwallet/tally";
import { checkBallots, checkCeremony, checkCount, electionFrom, messageOf, type CeremonyPosts, type CheckedElection, type CountCheck, type PublishedBallot } from "./full-check.ts";

type In =
  | { id: number; type: "ceremony"; election: CheckedElection; posts: CeremonyPosts[] }
  | { id: number; type: "ballots"; election: CheckedElection; ballots: PublishedBallot[] }
  | { id: number; type: "count"; election: CheckedElection; count: CountCheck };

interface WorkerScope {
  onmessage: ((event: { data: In }) => void) | null;
  postMessage(message: unknown): void;
}
const scope = globalThis as unknown as WorkerScope;

/** One Election object per election, so the key's table is precomputed once in each worker. */
let cached: { key: string; election: Election } | null = null;
function election(e: CheckedElection): Election {
  const key = `${e.channel}\u0000${e.chaincode}\u0000${e.electionId}\u0000${e.context}`;
  if (cached?.key !== key) {
    const made = electionFrom(e);
    if (!made) throw new Error("The election has no key yet.");
    cached = { key, election: made };
  }
  return cached.election;
}

scope.onmessage = (event) => {
  const m = event.data;
  try {
    if (m.type === "ceremony") {
      scope.postMessage({ id: m.id, type: "done", failure: checkCeremony(m.election, m.posts) });
    } else if (m.type === "ballots") {
      const e = election(m.election);
      const result = checkBallots(e, m.ballots, (done) => scope.postMessage({ id: m.id, type: "progress", done }));
      scope.postMessage({ id: m.id, type: "done", done: result.done, failure: result.failure });
    } else if (m.type === "count") {
      scope.postMessage({ id: m.id, type: "done", result: checkCount(election(m.election), m.count) });
    }
  } catch (error) {
    scope.postMessage({ id: m.id, type: "error", message: messageOf(error) });
  }
};
