/**
 * Weft Experimental only (docs/adr/0008): starting the idemix module in a
 * dedicated worker of the page that needs it, the popup to enrol and the
 * approval window to vote. The background worker never runs it: Chrome's
 * extension service worker can't start a worker, can stop during the
 * module's start, and would keep the secret key in memory between votes.
 * Terminating the worker frees every copy of the secret key the module made.
 *
 * Each start and each use is measured with the User Timing API
 * ("weft-idemix-start", and the names the caller gives), so the timings can
 * be read from the page for the docs.
 */
import { startIdemixWorker, type IdemixWorker } from "@weftwallet/idemix";
import { browser } from "wxt/browser";

/** How long Weft waits for the module to start. */
const START_TIMEOUT_MS = 30_000;

/** The module's files, copied into Weft Experimental's build by wxt.config.ts. */
const asset = (name: string) => browser.runtime.getURL(`/idemix/${name}` as "/");

/**
 * The worker's own extension file (entrypoints/idemix-worker.ts), on the
 * extension's origin in every build. In a dev build the page's scripts come
 * from the Vite dev server, so a worker bundled with them would too, and the
 * browser refuses a worker from another origin.
 */
export const workerUrl = () => browser.runtime.getURL("/idemix-worker.js" as "/");

export async function startVoterModule(): Promise<IdemixWorker> {
  const started = performance.now();
  const worker = new Worker(workerUrl(), { type: "module" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const idemix = await Promise.race([
      startIdemixWorker({ worker, wasmUrl: asset("weft-idemix.wasm"), wasmExecUrl: asset("wasm_exec.js") }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`The voting module didn't start within ${START_TIMEOUT_MS / 1000} seconds.`)), START_TIMEOUT_MS);
      }),
    ]);
    measure("weft-idemix-start", started);
    mark("weft-idemix-timings", idemix.timings);
    return idemix;
  } catch (error) {
    worker.terminate();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Records a span from `start` (a performance.now() value) to now. */
export function measure(name: string, start: number): void {
  try {
    performance.measure(name, { start, end: performance.now() });
  } catch {
    // Timing is for the docs only.
  }
}

/** Records a point with details, such as the module's own start timings. */
export function mark(name: string, detail: unknown): void {
  try {
    performance.mark(name, { detail });
  } catch {
    // Timing is for the docs only.
  }
}
