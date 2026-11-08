/**
 * The idemix module's functions, typed, over the string-in, string-out
 * calls cmd/wasm exposes as globalThis.weftIdemix. It runs wherever the
 * module was started: in Weft, in a dedicated worker (worker.ts); in Node,
 * in the process (node.ts).
 */
import { PINNED } from "./pinned.ts";

/** What info() reports about the build. */
export interface IdemixInfo {
  api: number;
  curve: "FP256BN_AMCL";
  go: string;
  idemix: string;
  mathlib: string;
}

/**
 * A voter credential's secret part and its attributes, as Weft keeps them
 * once unsealed. Bytes are base64; role is Fabric CA's Role attribute
 * (1 member, 2 admin).
 */
export interface VoterCredentialSecret {
  secretKey: string;
  credential: string;
  cri: string;
  ou: string;
  role: number;
  enrollmentId: string;
}

export interface CredentialRequestResult {
  /** The new secret key, 32 bytes in base64. Seal it at once. */
  secretKey: string;
  /** The JSON Fabric CA's /api/v1/idemix/credential takes as "request". */
  request: unknown;
}

export interface IdentityResult {
  handle: number;
  /** The SerializedIdemixIdentity, base64: fabric-gateway's credentials. */
  idBytes: string;
  /** The Nym's 32-byte X and Y, in lowercase hex. */
  nym: string;
}

/** The functions, as the worker and the Node loader both offer them. */
export interface IdemixApi {
  info(): Promise<IdemixInfo>;
  loadIssuerKey(issuerPublicKey: string): Promise<{ issuerKeyHash: string; curve: string }>;
  credentialRequest(nonce: string): Promise<CredentialRequestResult>;
  checkCredential(credential: VoterCredentialSecret): Promise<"valid">;
  newIdentity(credential: VoterCredentialSecret, mspId: string): Promise<IdentityResult>;
  sign(handle: number, message: string): Promise<string>;
  dispose(handle: number): Promise<"disposed">;
  wipe(): Promise<"wiped">;
}

export const METHODS = ["info", "loadIssuerKey", "credentialRequest", "checkCredential", "newIdentity", "sign", "dispose", "wipe"] as const;
export type Method = (typeof METHODS)[number];

/** A refusal from the module, or a module that couldn't start. */
export class IdemixError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdemixError";
  }
}

interface GoRuntime {
  importObject: WebAssembly.Imports;
  run(instance: WebAssembly.Instance): Promise<void>;
}
type GoConstructor = new () => GoRuntime;
type RawApi = Record<Method, (...args: string[] | number[] | (string | number)[]) => string>;

export async function sha256Hex(bytes: BufferSource): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Timings of a start, in milliseconds. */
export interface StartTimings {
  hash: number;
  compile: number;
  run: number;
}

/**
 * Starts the module from its bytes, in the current global scope, which must
 * already have Go's wasm_exec.js loaded (globalThis.Go). It refuses bytes
 * whose SHA-256 isn't the pinned one unless expectSha256 says otherwise.
 */
export async function startModule(
  bytes: Uint8Array<ArrayBuffer>,
  expectSha256: string = PINNED.wasmSha256,
): Promise<{ api: IdemixApi; timings: StartTimings }> {
  const Go = (globalThis as { Go?: GoConstructor }).Go;
  if (!Go) throw new IdemixError("Go's wasm_exec.js isn't loaded, so the idemix module can't start.");
  let t = performance.now();
  const hash = await sha256Hex(bytes);
  const hashMs = performance.now() - t;
  if (hash !== expectSha256) {
    throw new IdemixError(`The idemix module's SHA-256 is ${hash}, not the pinned ${expectSha256}, so Weft didn't start it.`);
  }
  t = performance.now();
  const go = new Go();
  const { instance } = await WebAssembly.instantiate(bytes, go.importObject);
  const compileMs = performance.now() - t;
  t = performance.now();
  void go.run(instance);
  const raw = (globalThis as { weftIdemix?: RawApi }).weftIdemix;
  if (!raw) throw new IdemixError("The idemix module started without its functions.");
  const runMs = performance.now() - t;
  return { api: wrap(raw), timings: { hash: hashMs, compile: compileMs, run: runMs } };
}

function call<T>(raw: RawApi, method: Method, args: (string | number)[]): T {
  const fn = raw[method];
  const out = JSON.parse(fn(...args)) as { ok?: T; error?: string };
  if (out.error !== undefined) throw new IdemixError(out.error);
  return out.ok as T;
}

function wrap(raw: RawApi): IdemixApi {
  const c = <T>(method: Method, ...args: (string | number)[]) => Promise.resolve().then(() => call<T>(raw, method, args));
  return {
    info: () => c("info"),
    loadIssuerKey: (ipk) => c("loadIssuerKey", ipk),
    credentialRequest: (nonce) => c("credentialRequest", nonce),
    checkCredential: (cred) => c("checkCredential", JSON.stringify(cred)),
    newIdentity: (cred, mspId) => c("newIdentity", JSON.stringify(cred), mspId),
    sign: (handle, message) => c("sign", handle, message),
    dispose: (handle) => c("dispose", handle),
    wipe: () => c("wipe"),
  };
}
