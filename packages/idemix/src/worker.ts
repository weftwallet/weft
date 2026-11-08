/**
 * The idemix module's dedicated worker. A page that needs the module (the
 * popup to enrol, the approval window to vote) starts this worker, sends it
 * "start" with the URLs of the module and wasm_exec.js, calls the module's
 * functions through client.ts, and terminates it when it is done, which
 * frees every copy of the secret key the module made (docs/adr/0008). The
 * background worker never runs the module: Chrome's extension service worker
 * can't start a worker, and may stop during the module's start.
 *
 * Bundle it as a module worker:
 *   new Worker(new URL("@weftwallet/idemix/worker", import.meta.url), { type: "module" })
 */
import { IdemixError, METHODS, startModule, sha256Hex, type IdemixApi, type Method } from "./module.ts";
import { PINNED } from "./pinned.ts";
import type { FromWorker, ToWorker } from "./messages.ts";

interface WorkerScope {
  onmessage: ((event: MessageEvent<ToWorker>) => void) | null;
  postMessage(message: FromWorker): void;
}
const scope = globalThis as unknown as WorkerScope;

let api: IdemixApi | null = null;

async function start(wasmUrl: string, wasmExecUrl: string): Promise<FromWorker> {
  const started = performance.now();
  const execText = await (await fetch(wasmExecUrl)).arrayBuffer();
  if ((await sha256Hex(execText)) !== PINNED.wasmExecSha256) {
    throw new IdemixError("wasm_exec.js isn't the one pinned with the idemix module, so Weft didn't start it.");
  }
  await import(/* @vite-ignore */ wasmExecUrl);
  const fetched = performance.now();
  const bytes = new Uint8Array(await (await fetch(wasmUrl)).arrayBuffer());
  const fetchMs = performance.now() - fetched;
  const out = await startModule(bytes);
  api = out.api;
  return { type: "started", timings: { ...out.timings, fetch: fetchMs, total: performance.now() - started } };
}

scope.onmessage = (event) => {
  const msg = event.data;
  const reply = async (): Promise<FromWorker> => {
    if (msg.type === "start") return start(msg.wasmUrl, msg.wasmExecUrl);
    if (!api) throw new IdemixError("The idemix module hasn't started.");
    if (!METHODS.includes(msg.method)) throw new IdemixError(`The idemix module has no function ${msg.method}.`);
    const fn = api[msg.method as Method] as (...args: unknown[]) => Promise<unknown>;
    return { type: "result", id: msg.id, ok: await fn(...msg.args) };
  };
  reply().then(
    (out) => scope.postMessage(out),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      scope.postMessage(msg.type === "start" ? { type: "failed", error: message } : { type: "result", id: msg.id, error: message });
    },
  );
};
