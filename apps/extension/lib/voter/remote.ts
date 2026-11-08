/**
 * Weft Experimental only (docs/adr/0008): the background worker signs an
 * anonymous ballot through the approval window's idemix worker.
 *
 * The window opens the voter credential, starts the module in its own
 * worker and connects a port named "weft-idemix:<approval ID>". The
 * background worker, which makes the relay calls and checks every message,
 * asks over the port for a one-off identity, the pseudonym, the pseudonym
 * proof and each signature, by handle. The credential and its secret key stay
 * in the window and its worker; only identities, signatures and proofs cross
 * the port. Five calls are served, and nothing else the module can do.
 */
import { fromBase64, toBase64 } from "@weftwallet/core";
import type { IdemixApi, IdentityResult, PseudonymProof, VoterCredentialSecret } from "@weftwallet/idemix";

export const PORT_PREFIX = "weft-idemix:";

/** What the background worker can ask the window's module. Bytes cross as base64. */
export interface AnonymousSigner {
  newIdentity(): Promise<IdentityResult>;
  sign(handle: number, message: Uint8Array): Promise<Uint8Array>;
  pseudonym(handle: number, channel: string, electionId: string): Promise<string>;
  pseudonymProof(handle: number, channel: string, electionId: string, tracking: string): Promise<PseudonymProof>;
  dispose(handle: number): Promise<void>;
}

type Method = keyof AnonymousSigner;
const METHODS: readonly Method[] = ["newIdentity", "sign", "pseudonym", "pseudonymProof", "dispose"];

interface Request {
  id: number;
  method: Method;
  args: (string | number)[];
}
interface Response {
  id: number;
  ok?: unknown;
  error?: string;
}

/** The part of a runtime port this uses, so tests can pass a pair of fakes. */
export interface PortLike {
  postMessage(message: unknown): void;
  onMessage: { addListener(fn: (message: unknown) => void): void };
  onDisconnect: { addListener(fn: () => void): void };
  disconnect(): void;
}

/** The window's module refused a call or failed. */
export class ModuleCallError extends Error {
  override name = "ModuleCallError";
}

/** The window's module stopped answering: its window closed, or it took too long. */
export class SignerGoneError extends ModuleCallError {
  override name = "SignerGoneError";
}

/** The background worker's side: calls over the port, with a timeout for each. */
export function portSigner(port: PortLike, timeoutMs = 30_000): AnonymousSigner & { gone: boolean } {
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  let next = 1;
  const state = { gone: false };
  port.onMessage.addListener((message) => {
    const m = message as Response;
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    clearTimeout(p.timer);
    if (m.error !== undefined) p.reject(new ModuleCallError(m.error));
    else p.resolve(m.ok);
  });
  port.onDisconnect.addListener(() => {
    state.gone = true;
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(new SignerGoneError("The approval window closed, and its voting module with it."));
    }
    pending.clear();
  });
  const call = <T>(method: Method, ...args: (string | number)[]) =>
    new Promise<T>((resolve, reject) => {
      if (state.gone) return reject(new SignerGoneError("The approval window closed, and its voting module with it."));
      const id = next++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new SignerGoneError(`The voting module didn't answer ${method} within ${timeoutMs / 1000} seconds.`));
      }, timeoutMs);
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      port.postMessage({ id, method, args } satisfies Request);
    });
  return {
    get gone() {
      return state.gone;
    },
    newIdentity: () => call<IdentityResult>("newIdentity"),
    sign: async (handle, message) => fromBase64(await call<string>("sign", handle, toBase64(message))),
    pseudonym: (handle, channel, electionId) => call<string>("pseudonym", handle, channel, electionId),
    pseudonymProof: (handle, channel, electionId, tracking) => call<PseudonymProof>("pseudonymProof", handle, channel, electionId, tracking),
    dispose: async (handle) => void (await call<string>("dispose", handle)),
  };
}

/**
 * The window's side: answers the five calls with its module and the
 * credential it opened. Every identity it made and didn't dispose of is
 * disposed of when the port closes.
 */
export function serveSigner(port: PortLike, idemix: Pick<IdemixApi, "newIdentity" | "sign" | "pseudonym" | "pseudonymProof" | "dispose">, credential: VoterCredentialSecret, mspId: string): void {
  const live = new Set<number>();
  const handle = (v: unknown) => {
    if (typeof v !== "number" || !live.has(v)) throw new Error("That identity isn't one this window made, or it was disposed of.");
    return v;
  };
  const text = (v: unknown) => {
    if (typeof v !== "string") throw new Error("An argument isn't a string.");
    return v;
  };
  const run = async (m: Request): Promise<unknown> => {
    if (!METHODS.includes(m.method)) throw new Error(`The voting module doesn't offer ${String(m.method)} to the background worker.`);
    const a = m.args ?? [];
    switch (m.method) {
      case "newIdentity": {
        const id = await idemix.newIdentity(credential, mspId);
        live.add(id.handle);
        return id;
      }
      case "sign":
        return idemix.sign(handle(a[0]), text(a[1]));
      case "pseudonym":
        return idemix.pseudonym(handle(a[0]), text(a[1]), text(a[2]));
      case "pseudonymProof":
        return idemix.pseudonymProof(handle(a[0]), text(a[1]), text(a[2]), text(a[3]));
      case "dispose": {
        const h = handle(a[0]);
        live.delete(h);
        return idemix.dispose(h);
      }
    }
  };
  port.onMessage.addListener((message) => {
    const m = message as Request;
    run(m).then(
      (ok) => port.postMessage({ id: m.id, ok } satisfies Response),
      (error: unknown) => port.postMessage({ id: m.id, error: error instanceof Error ? error.message : String(error) } satisfies Response),
    );
  });
  port.onDisconnect.addListener(() => {
    for (const h of live) void idemix.dispose(h).catch(() => {});
    live.clear();
  });
}
