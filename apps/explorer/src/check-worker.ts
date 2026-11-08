/**
 * One of the indexer's check threads (check-pool.ts): it runs ballot checks
 * (ballot-checks.ts) off the server's main thread. With an idemix folder in
 * its workerData, it starts the idemix module first, refusing one whose
 * SHA-256 isn't the pinned one, and says "ready" or why it couldn't.
 *
 * Messages in:  { id, task }
 * Messages out: { type: "ready" } or { type: "failed", message } once, then { id, result } or { id, error } per task.
 */

import { parentPort, workerData } from "node:worker_threads";
import type { IdemixSync } from "@weftwallet/idemix";
import { electionCache, runBallotTask, type BallotTask } from "./ballot-checks.ts";

const port = parentPort!;
const { idemixDir } = (workerData ?? {}) as { idemixDir: string | null };
const electionOf = electionCache();
let idemix: IdemixSync | null = null;

try {
  if (idemixDir) {
    const { startIdemixNode } = await import("@weftwallet/idemix/node");
    idemix = (await startIdemixNode(idemixDir)).sync;
  }
  port.postMessage({ type: "ready" });
} catch (error) {
  port.postMessage({ type: "failed", message: error instanceof Error ? error.message : String(error) });
}

port.on("message", (m: { id: number; task: BallotTask }) => {
  try {
    port.postMessage({ id: m.id, result: runBallotTask(m.task, electionOf, idemix) });
  } catch (error) {
    port.postMessage({ id: m.id, error: error instanceof Error ? error.message : String(error) });
  }
});
