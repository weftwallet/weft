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
 *   { type: "pseudonyms", election, ballots, wasmUrl, wasmExecUrl }   the same, with startMs
 *   { type: "count", election, count }
 *
 * "pseudonyms" is for an election with voter credentials (docs/adr/0008):
 * the first one starts the idemix module in this worker, from the explorer's
 * /assets/idemix/, refusing a module or wasm_exec.js whose SHA-256 isn't the
 * pinned one, and checks each ballot's one-off identity against the pinned
 * issuer key and its pseudonym proof against that identity. The page sends
 * every pseudonym to one worker, so the module starts once.
 */

import { PINNED, sha256Hex, startModule, type IdemixSync } from "@weftwallet/idemix";
import type { Election } from "@weftwallet/tally";
import {
  checkBallots,
  checkCeremony,
  checkCount,
  checkPseudonyms,
  electionFrom,
  messageOf,
  type CeremonyPosts,
  type CheckedElection,
  type CountCheck,
  type PublishedBallot,
} from "./full-check.ts";

type In =
  | { id: number; type: "ceremony"; election: CheckedElection; posts: CeremonyPosts[] }
  | { id: number; type: "ballots"; election: CheckedElection; ballots: PublishedBallot[] }
  | { id: number; type: "pseudonyms"; election: CheckedElection; ballots: PublishedBallot[]; wasmUrl: string; wasmExecUrl: string }
  | { id: number; type: "count"; election: CheckedElection; count: CountCheck };

interface WorkerScope {
  onmessage: ((event: { data: In }) => void) | null;
  postMessage(message: unknown): void;
  importScripts(...urls: string[]): void;
}
const scope = globalThis as unknown as WorkerScope;

/** The idemix module, once started in this worker, and how long its start took. */
let idemix: { sync: IdemixSync; startMs: number } | null = null;
async function startIdemix(wasmUrl: string, wasmExecUrl: string): Promise<{ sync: IdemixSync; startMs: number; started: boolean }> {
  if (idemix) return { ...idemix, started: false };
  const t = performance.now();
  const exec = await (await fetch(wasmExecUrl)).arrayBuffer();
  if ((await sha256Hex(exec)) !== PINNED.wasmExecSha256) throw new Error("The explorer's wasm_exec.js isn't the one pinned with the idemix module, so this browser didn't start it.");
  scope.importScripts(wasmExecUrl);
  const response = await fetch(wasmUrl);
  if (!response.ok) throw new Error(`The explorer didn't serve the idemix module (HTTP ${response.status}).`);
  const { sync } = await startModule(new Uint8Array(await response.arrayBuffer()));
  idemix = { sync, startMs: performance.now() - t };
  return { ...idemix, started: true };
}

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
  if (m.type === "pseudonyms") {
    startIdemix(m.wasmUrl, m.wasmExecUrl).then(
      ({ sync, startMs, started }) => {
        try {
          const voters = m.election.anonymous;
          if (!voters) throw new Error("The election has no voter credentials.");
          const result = checkPseudonyms(sync, m.election, voters, m.ballots, (done) => scope.postMessage({ id: m.id, type: "progress", done }));
          scope.postMessage({ id: m.id, type: "done", done: result.done, failure: result.failure, startMs: started ? startMs : 0 });
        } catch (error) {
          scope.postMessage({ id: m.id, type: "error", message: messageOf(error) });
        }
      },
      (error: unknown) => scope.postMessage({ id: m.id, type: "error", message: `The idemix module didn't start: ${error instanceof Error ? error.message : String(error)}` }),
    );
    return;
  }
  try {
    if (m.type === "ceremony") {
      scope.postMessage({ id: m.id, type: "done", failure: checkCeremony(m.election, m.posts) });
    } else if (m.type === "ballots") {
      const e = election(m.election);
      const result = checkBallots(e, m.ballots, (done) => scope.postMessage({ id: m.id, type: "progress", done }), m.election.anonymous ?? null);
      scope.postMessage({ id: m.id, type: "done", done: result.done, failure: result.failure });
    } else if (m.type === "count") {
      scope.postMessage({ id: m.id, type: "done", result: checkCount(election(m.election), m.count) });
    }
  } catch (error) {
    scope.postMessage({ id: m.id, type: "error", message: messageOf(error) });
  }
};
