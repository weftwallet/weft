/**
 * Voter tags. The contract computes the tag from the transaction's creator,
 * for one election on one channel, so one certificate has a different tag in
 * every election.
 */
import { utf8 } from "./encoding.ts";
import { LABELS, digest } from "./hash.ts";

/** v = SHA-256(frame(["weft-voter x509 v1", channel, electionId, mspId, idBytes])) */
export function voterTagX509(channel: string, electionId: string, mspId: string, idBytes: Uint8Array): Uint8Array {
  return digest(LABELS.voterX509, [channel, electionId, mspId, idBytes]);
}

/** v = SHA-256(frame(["weft-voter idemix v1", channel, electionId, mspId, P])), with the 64-byte per-election pseudonym P. */
export function voterTagIdemix(channel: string, electionId: string, mspId: string, pseudonym: Uint8Array): Uint8Array {
  if (pseudonym.length !== 64) throw new RangeError("the per-election pseudonym is 64 bytes");
  return digest(LABELS.voterIdemix, [channel, electionId, mspId, pseudonym]);
}

/** idBytes for a PEM certificate, exactly as Fabric carries it in SerializedIdentity.id_bytes. */
export function pemIdBytes(pem: string): Uint8Array {
  return utf8(pem);
}
