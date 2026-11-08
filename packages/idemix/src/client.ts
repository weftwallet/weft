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
}

/** Starts the module in the worker and resolves once it can be called. */
export function startIdemixWorker({ worker, wasmUrl, wasmExecUrl }: StartOptions): Promise<IdemixWorker> {
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let next = 1;
  const send = (message: ToWorker) => worker.postMessage(message);
  return new Promise((resolveStart, rejectStart) => {
    worker.onerror = (event) => {
      const error = new IdemixError(`The idemix module's worker failed: ${event.message || "no message"}`);
      rejectStart(error);
      for (const p of pending.values()) p.reject(error);
      pending.clear();
    };
    worker.onmessage = (event: MessageEvent<FromWorker>) => {
      const msg = event.data;
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
    send({ type: "start", wasmUrl, wasmExecUrl });
  });
}
