/**
 * @weftwallet/idemix: IBM's idemix library, built to WebAssembly from Go
 * source, for Weft Experimental's voter credentials (docs/adr/0008).
 * Unreviewed, and in no build of normal Weft.
 */
export { PINNED } from "./pinned.ts";
export { IdemixError, METHODS, sha256Hex, startModule } from "./module.ts";
export type { CredentialRequestResult, IdemixApi, IdemixInfo, IdentityResult, Method, PseudonymProof, StartTimings, VoterCredentialSecret } from "./module.ts";
export { startIdemixWorker } from "./client.ts";
export type { IdemixWorker, StartOptions } from "./client.ts";
export type { FromWorker, ToWorker } from "./messages.ts";
