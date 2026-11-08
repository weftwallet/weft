/**
 * Voter tags. The contract computes the tag from the transaction's creator,
 * for one election on one channel, so one voter has a different tag in
 * every election.
 */
import { LABELS, digest } from "./hash.ts";
import { enrolmentId } from "./x509.ts";

/**
 * v = SHA-256(frame(["weft-voter x509 v2", channel, electionId, mspId, enrolmentId])),
 * with the enrolment ID from the creator's certificate (see `enrolmentId`).
 */
export function voterTagX509(channel: string, electionId: string, mspId: string, enrolmentId: string): Uint8Array {
  return digest(LABELS.voterX509, [channel, electionId, mspId, enrolmentId]);
}

/**
 * The X.509 voter tag for a creator's id_bytes, a PEM certificate: the
 * enrolment ID read as the contract reads it, or the contract's refusal as
 * a TallyError.
 */
export function voterTagFromCertificate(channel: string, electionId: string, mspId: string, idBytes: Uint8Array): Uint8Array {
  return voterTagX509(channel, electionId, mspId, enrolmentId(idBytes));
}

/** v = SHA-256(frame(["weft-voter idemix v1", channel, electionId, mspId, P])), with the 64-byte per-election pseudonym P. */
export function voterTagIdemix(channel: string, electionId: string, mspId: string, pseudonym: Uint8Array): Uint8Array {
  if (pseudonym.length !== 64) throw new RangeError("the per-election pseudonym is 64 bytes");
  return digest(LABELS.voterIdemix, [channel, electionId, mspId, pseudonym]);
}
