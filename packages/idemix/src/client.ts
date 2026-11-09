/**
 * The page's side of the idemix module's worker: start it, call it, and
 * terminate it when the page is done with the credential.
 */
import { IdemixError, type IdemixApi, type Method, type StartTimings } from "./module.ts";
import type { FromWorker, ToWorker } from "./messages.ts";

export interface IdemixWorker extends IdemixApi {
  /** How long the start took, in milliseconds. */
  readonly timings: StartTimings & { fetch: number; total: number };
  /** Ends the worker, and with it every copy of a secret in the module. */
  terminate(): void;
}

export interface StartOptions {
  /** The worker, made by the page's bundler from "@weftwallet/idemix/worker". */
  worker: Worker;
  /** The module's URL, an extension-local file. */
  wasmUrl: string;
  /** wasm_exec.js's URL, from the same build. */
  wasmExecUrl: string;
  /** How long to wait for the worker's script to load and say "loaded". */
  loadTimeoutMs?: number;
  /** Called once the worker's script has loaded, as "start" is sent. */
  onLoaded?: () => void;
}

/** How long startIdemixWorker waits for the worker's "loaded" by default. */
export const LOAD_TIMEOUT_MS = 3_000;

/** The worker's script didn't say "loaded" in time, so nothing was sent to it. */
export class IdemixWorkerLoadError extends IdemixError {
  constructor(ms: number) {
    super(`The idemix module's worker didn't load within ${ms / 1000} seconds, so nothing was sent to it.`);
    this.name = "IdemixWorkerLoadError";
  }
}

/**
 * Starts the module in the worker and resolves once it can be called. The
 * worker says "loaded" as its script starts (worker.ts), and only then is
 * "start" sent. Without "loaded" within loadTimeoutMs, the worker is
 * terminated and the start rejects with IdemixWorkerLoadError: a worker
 * whose script never loads can fail without an error event.
 */
export function startIdemixWorker({ worker, wasmUrl, wasmExecUrl, loadTimeoutMs = LOAD_TIMEOUT_MS, onLoaded }: StartOptions): Promise<IdemixWorker> {
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let next = 1;
  const send = (message: ToWorker) => worker.postMessage(message);
  return new Promise((resolveStart, rejectStart) => {
    let loadTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => fail(new IdemixWorkerLoadError(loadTimeoutMs)), loadTimeoutMs);
    const loaded = () => {
      clearTimeout(loadTimer);
      loadTimer = undefined;
    };
    // A worker that can't load (a refused or missing script) or that throws
    // fires `error`: the start, and every call waiting, fails at once rather
    // than waiting for an answer that can't come.
    const fail = (error: IdemixError) => {
      loaded();
      worker.terminate();
      rejectStart(error);
      for (const p of pending.values()) p.reject(error);
      pending.clear();
    };
    worker.onerror = (event: ErrorEvent | Event) => {
      const message = "message" in event && event.message ? event.message : "";
      fail(new IdemixError(`The idemix module's worker stopped with an error${message ? `: ${message}` : ", and the browser gave no reason. Its script may have failed to load."}`));
    };
    worker.onmessageerror = () => fail(new IdemixError("The idemix module's worker sent a message the page couldn't read."));
    worker.onmessage = (event: MessageEvent<FromWorker>) => {
      const msg = event.data;
      if (msg.type === "loaded") {
        if (loadTimer === undefined) return;
        loaded();
        onLoaded?.();
        send({ type: "start", wasmUrl, wasmExecUrl });
        return;
      }
      // Anything else from the worker means its script has loaded too.
      loaded();
      if (msg.type === "failed") {
        worker.terminate();
        rejectStart(new IdemixError(msg.error));
        return;
      }
      if (msg.type === "started") {
        const call = <T>(method: Method, ...args: unknown[]) =>
          new Promise<T>((resolve, reject) => {
            const id = next++;
            pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
            send({ type: "call", id, method, args });
          });
        resolveStart({
          timings: msg.timings,
          terminate: () => {
            worker.terminate();
            const error = new IdemixError("The idemix module's worker was terminated.");
            for (const p of pending.values()) p.reject(error);
            pending.clear();
          },
          info: () => call("info"),
          loadIssuerKey: (ipk) => call("loadIssuerKey", ipk),
          credentialRequest: (nonce) => call("credentialRequest", nonce),
          checkCredential: (cred) => call("checkCredential", cred),
          newIdentity: (cred, mspId) => call("newIdentity", cred, mspId),
          sign: (handle, message) => call("sign", handle, message),
          pseudonym: (handle, channel, electionId) => call("pseudonym", handle, channel, electionId),
          pseudonymProof: (handle, channel, electionId, tracking) => call("pseudonymProof", handle, channel, electionId, tracking),
          verifyIdentity: (idBytes) => call("verifyIdentity", idBytes),
          verifyPseudonym: (nym, channel, electionId, tracking, proof) => call("verifyPseudonym", nym, channel, electionId, tracking, proof),
          dispose: (handle) => call("dispose", handle),
          wipe: () => call("wipe"),
        });
        return;
      }
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error !== undefined) p.reject(new IdemixError(msg.error));
      else p.resolve(msg.ok);
    };
  });
}
