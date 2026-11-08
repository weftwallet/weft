/**
 * Challenges and digests, each under a label of its own.
 *
 * Hs(label, parts) = OS2IP_LE(expand_message_xmd(frame([label, ...parts]), DST, 64)) mod l,
 * with RFC 9380's expand_message_xmd over SHA-512. This is noble's
 * ristretto255_hasher.hashToScalar with the DST below.
 */
import { ristretto255_hasher } from "@noble/curves/ed25519.js";
import { expand_message_xmd } from "@noble/curves/abstract/hash-to-curve.js";
import { sha256, sha512 } from "@noble/hashes/sha2.js";
import { frame, utf8, type Part } from "./encoding.ts";

export const DST = "weft-ballot-v1-challenge";
const DST_BYTES = utf8(DST);

export const LABELS = {
  context: "weft-ballot v1",
  voterX509: "weft-voter x509 v2",
  voterIdemix: "weft-voter idemix v1",
  bit: "bit",
  sum: "sum",
  share: "share",
  confirm: "confirm",
  tracking: "weft-ballot-hash v1",
  fingerprint: "weft-election-fingerprint v1",
  shareBox: "weft-ballot-v1 share",
} as const;

/** The 64 bytes of expand_message_xmd that Hs reduces, for test vectors. */
export function challengeBytes(label: string, parts: readonly Part[]): Uint8Array {
  return expand_message_xmd(frame([label, ...parts]), DST_BYTES, 64, sha512);
}

/** A challenge scalar. */
export function Hs(label: string, parts: readonly Part[]): bigint {
  return ristretto255_hasher.hashToScalar(frame([label, ...parts]), { DST: DST_BYTES });
}

/** SHA-256 of a framed list that starts with its label. */
export function digest(label: string, parts: readonly Part[]): Uint8Array {
  return sha256(frame([label, ...parts]));
}
