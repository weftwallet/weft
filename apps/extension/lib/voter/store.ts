/**
 * Weft Experimental only (docs/adr/0008): voter credentials in the
 * background worker. Weft keeps one per election. A voter credential is
 * never an identity: it isn't in the identities store, so it is never the
 * active identity, never offered to weft_connect, weft_identity,
 * weft_signIn, weft_submit or weft_evaluate, and the certificate watch never
 * sees it. Only weft_castBallot uses it, for the election it was issued for.
 */
import { db } from "../db";
import { anonymousEntries, votedWith } from "./activity";
import { credentialView, type VoterCredentialRecord, type VoterCredentialView } from "./types";

export async function voterCredentials(): Promise<VoterCredentialRecord[]> {
  return (await db.all<VoterCredentialRecord>("voterCredentials")).sort((a, b) => a.createdAt - b.createdAt);
}

export async function voterCredential(id: string): Promise<VoterCredentialRecord | null> {
  return (await db.get<VoterCredentialRecord>("voterCredentials", id)) ?? null;
}

/** The credential Weft holds for an election, by its channel, contract and ID. */
export async function credentialFor(params: { channel: string; chaincode: string; electionId: string }): Promise<VoterCredentialRecord | null> {
  return (
    (await voterCredentials()).find((c) => c.invite.channel === params.channel && c.invite.chaincode === params.chaincode && c.invite.electionId === params.electionId) ??
    null
  );
}

/** The views for the popup, with whether each has voted, which is known only while Weft is unlocked. */
export async function voterCredentialViews(): Promise<VoterCredentialView[]> {
  const [records, entries] = await Promise.all([voterCredentials(), anonymousEntries()]);
  return records.map((r) => credentialView(r, votedWith(entries, r.id, r.invite.electionId)));
}

const PEM = /-----BEGIN CERTIFICATE-----/;
const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Saves a credential the popup sealed. Refuses a second credential for the
 * same election, and a record that isn't shaped as one: the popup made it,
 * but the store is the background worker's.
 */
export async function addVoterCredential(record: VoterCredentialRecord): Promise<VoterCredentialView> {
  const i = record.invite;
  const shaped =
    typeof record.id === "string" &&
    record.id.length > 0 &&
    i?.weftVoterInvite === 1 &&
    HEX64.test(i.issuerKeyHash) &&
    (i.title === undefined || typeof i.title === "string") &&
    Array.isArray(i.endorsers) &&
    i.endorsers.length > 0 &&
    i.endorsers.every((e) => PEM.test(e.caChain)) &&
    typeof record.issuerPublicKey === "string" &&
    record.role === "member" &&
    typeof record.sealed?.secret?.data === "string" &&
    typeof record.sealed?.enrollmentId?.data === "string";
  if (!shaped) throw new Error("Weft refused to save this voter credential: its record is incomplete.");
  const held = await credentialFor(i);
  if (held) {
    throw new Error(`Weft already holds a voter credential for ${i.electionId}. It keeps one per election.`);
  }
  await db.put("voterCredentials", record);
  return credentialView(record, null);
}

/**
 * Deletes the credential. Its sealed activity stays, as an identity's
 * activity stays when the identity is removed: the ballot is on the ledger.
 */
export async function removeVoterCredential(id: string): Promise<void> {
  await db.delete("voterCredentials", id);
}

/** Keeps the election's title once Weft has read it. It is public, and the same for every voter. */
export async function rememberTitle(id: string, title: string): Promise<void> {
  const record = await voterCredential(id);
  if (record && record.title !== title) await db.put("voterCredentials", { ...record, title });
}
