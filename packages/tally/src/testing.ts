/**
 * The test-only path: the provers with their randomness as an argument, and
 * a seeded source for the test vectors. Production code never imports this
 * entry point; client.ts and trustee.ts draw from crypto.getRandomValues.
 *
 * The seeded source is a stream of SHA-512 blocks:
 *   block_i = SHA-512(frame(["weft-tally test rng v1", seed, i])), i = 0, 1, ...
 * and each draw takes the next bytes of the stream.
 */
import { sha512 } from "@noble/hashes/sha2.js";
import { frame } from "./encoding.ts";
import type { RandomSource } from "./random.ts";

export * from "./index.ts";
export { drawBallotRandomness, proveBallot, choiceMessages, type BallotRandomness } from "./prove.ts";
export {
  round1With,
  round2With,
  round3With,
  decryptionShareWith,
  proveConfirmation,
  shareInfo,
  shareKey,
  sealShare,
  openShare,
  BadShareError,
  type KeyShare,
  type TrusteeSecret,
} from "./ceremony.ts";
export { randomScalar, type RandomSource } from "./random.ts";
export { ATTR, STRING, certificatePem, fabricSubject, pem, testCertificate, type Attribute, type CertificateOptions, type Name } from "./certificates.ts";

/** A deterministic RandomSource for the test vectors, never for real elections. */
export function seededRandom(seed: string): RandomSource & { readonly drawn: number } {
  let block = new Uint8Array(0);
  let used = 0;
  let counter = 0;
  let drawn = 0;
  return {
    get drawn() {
      return drawn;
    },
    bytes(n: number): Uint8Array {
      const out = new Uint8Array(n);
      for (let o = 0; o < n; ) {
        if (used === block.length) {
          block = sha512(frame(["weft-tally test rng v1", seed, counter++]));
          used = 0;
        }
        const take = Math.min(n - o, block.length - used);
        out.set(block.subarray(used, used + take), o);
        used += take;
        o += take;
      }
      drawn += n;
      return out;
    },
  };
}
