/**
 * Weft Experimental only (docs/adr/0008): sealing a voter credential's
 * secrets and an anonymous ballot's activity.
 *
 * The key is derived from the vault key with HKDF-SHA-256, info
 * "weft voter credentials v1", for AES-GCM. Each sealed value is bound to
 * its record's ID and the field's name as additional data, so it can't be
 * moved onto another record or field. The popup seals a new credential and
 * the approval window opens one, each in its own page, so the secret key
 * never passes through the background worker; the background worker seals
 * the activity of the ballots it casts.
 */
import { fromBase64, toBase64 } from "@weftwallet/core";
import type { VoterCredentialSecret } from "@weftwallet/idemix";
import * as vault from "../vault";
import type { SealedText, VoterCredentialRecord } from "./types";

export const VOTER_KEY_INFO = "weft voter credentials v1";

/** The voter credentials' key. Throws VaultLockedError while Weft is locked. */
export function voterKey(): Promise<CryptoKey> {
  return vault.derivedKey(VOTER_KEY_INFO);
}

const encoder = new TextEncoder();

export async function sealText(key: CryptoKey, bound: string, text: string): Promise<SealedText> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(bound) }, key, encoder.encode(text));
  return { iv: toBase64(iv), data: toBase64(new Uint8Array(data)) };
}

export async function openText(key: CryptoKey, bound: string, sealed: SealedText): Promise<string> {
  const iv = fromBase64(sealed.iv) as Uint8Array<ArrayBuffer>;
  const data = fromBase64(sealed.data) as Uint8Array<ArrayBuffer>;
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(bound) }, key, data);
  return new TextDecoder().decode(plain);
}

const SECRET = (id: string) => `${id} secret`;
const ENROLMENT_ID = (id: string) => `${id} enrolment ID`;

/** Seals what a new credential must keep secret, for the record `id`. */
export async function sealCredential(key: CryptoKey, id: string, secret: VoterCredentialSecret): Promise<VoterCredentialRecord["sealed"]> {
  const { secretKey, credential, cri } = secret;
  return {
    secret: await sealText(key, SECRET(id), JSON.stringify({ secretKey, credential, cri })),
    enrollmentId: await sealText(key, ENROLMENT_ID(id), secret.enrollmentId),
  };
}

/** The credential as the idemix module takes it, opened. */
export async function openCredential(key: CryptoKey, record: VoterCredentialRecord): Promise<VoterCredentialSecret> {
  const { secretKey, credential, cri } = JSON.parse(await openText(key, SECRET(record.id), record.sealed.secret)) as Pick<VoterCredentialSecret, "secretKey" | "credential" | "cri">;
  const enrollmentId = await openEnrollmentId(key, record);
  return { secretKey, credential, cri, ou: record.affiliation, role: 1, enrollmentId };
}

/** Only the enrolment ID, for the credential's detail. */
export function openEnrollmentId(key: CryptoKey, record: Pick<VoterCredentialRecord, "id" | "sealed">): Promise<string> {
  return openText(key, ENROLMENT_ID(record.id), record.sealed.enrollmentId);
}
