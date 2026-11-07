/**
 * @weftwallet/tally: the private tally of ADR 0007, as the specification in
 * apps/docs/src/content/docs/experimental/private-tally-spec.md defines it.
 * Unreviewed cryptography, for Weft Experimental only.
 *
 * This entry point has what every side shares: encodings, the election
 * context and fingerprint, voter tags, the JSON shapes and the contract's
 * error messages. The sides have their own entry points:
 *
 * - "@weftwallet/tally/client": encrypting and proving a ballot (Weft).
 * - "@weftwallet/tally/trustee": the key ceremony and decryption shares (weft-trustee).
 * - "@weftwallet/tally/verify": every check the contract runs (the explorer).
 * - "@weftwallet/tally/testing": fixed randomness for the test vectors. Never in production.
 */
export { frame, toHex, fromHex, utf8, type Part } from "./encoding.ts";
export { Hs, digest, challengeBytes, DST, LABELS } from "./hash.ts";
export { trusteeId } from "./group.ts";
export {
  electionContext,
  electionFingerprint,
  formatFingerprint,
  contextParts,
  fingerprintInput,
  type Election,
  type ElectionKeys,
  type ElectionSetup,
} from "./election.ts";
export { voterTagX509, voterTagIdemix, pemIdBytes } from "./voter.ts";
export { trackingCode } from "./tracking.ts";
export { TallyError, messages, count } from "./errors.ts";
export * from "./types.ts";
