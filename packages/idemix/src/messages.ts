/** Messages between a page and the idemix module's worker. */
import type { Method, StartTimings } from "./module.ts";

export type ToWorker =
  | { type: "start"; wasmUrl: string; wasmExecUrl: string }
  | { type: "call"; id: number; method: Method; args: unknown[] };

export type FromWorker =
  | { type: "started"; timings: StartTimings & { fetch: number; total: number } }
  | { type: "failed"; error: string }
  | { type: "result"; id: number; ok?: unknown; error?: string };
