/**
 * Weft Experimental only (docs/adr/0008): what Weft keeps for a voter
 * credential, and how pages see it. Reached only from code behind
 * EXPERIMENTAL.
 */
import type { VoterInvite } from "@weftwallet/protocol";

/** AES-GCM output as base64, so a record survives the extension's JSON messages unchanged. */
export interface SealedText {
  iv: string;
  data: string;
}

/**
 * A voter credential, in the voterCredentials store. Everything Weft needs
 * to read the election and vote is readable, and the same for every voter of
 * the election: the invite, the issuer key, the affiliation and the role.
 * The secret key, the credential with its revocation handle, the credential
 * revocation information and the enrolment ID are sealed under a key derived
 * from the vault key (lib/voter/seal.ts).
 */
export interface VoterCredentialRecord {
  id: string;
  /** The voter invite it was enrolled from, as Weft checked it. */
  invite: VoterInvite;
  inviteUrl: string;
  /** The CA's IssuerPublicKey, base64; SHA-256 of its bytes is invite.issuerKeyHash. */
  issuerPublicKey: string;
  /** The CA's IssuerRevocationPublicKey, base64, when it served one. */
  revocationPublicKey: string | null;
  /** The credential's organisational unit and role, which every voter of the election shares. */
  affiliation: string;
  role: "member";
  /** The election's title, once Weft has read the election; until then, its ID is shown. */
  title: string | null;
  sealed: {
    /** { secretKey, credential, cri } as JSON, bound to `${id} secret`. */
    secret: SealedText;
    /** The enrolment ID, bound to `${id} enrolment ID`. */
    enrollmentId: SealedText;
  };
  createdAt: number;
}

/** A voter credential as the popup lists it. Nothing in it names the voter. */
export interface VoterCredentialView {
  id: string;
  electionId: string;
  /** The election's title, or its ID until Weft has read it. */
  title: string;
  channel: string;
  chaincode: string;
  mspId: string;
  affiliation: string;
  role: string;
  issuerKeyHash: string;
  curve: string;
  network: string;
  relayHost: string;
  relayOperator: string;
  caName: string | null;
  explorerUrl: string | null;
  createdAt: number;
  /** A committed ballot from this credential, from Weft's sealed activity. Null while locked or before a vote. */
  voted: { blockNumber: string | null } | null;
}

export const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

export function credentialView(record: VoterCredentialRecord, voted: VoterCredentialView["voted"]): VoterCredentialView {
  const i = record.invite;
  return {
    id: record.id,
    electionId: i.electionId,
    title: record.title ?? i.electionId,
    channel: i.channel,
    chaincode: i.chaincode,
    mspId: i.mspId,
    affiliation: record.affiliation,
    role: record.role,
    issuerKeyHash: i.issuerKeyHash,
    curve: i.curve,
    network: i.network,
    relayHost: hostOf(i.relayUrl),
    relayOperator: i.relayOperator,
    caName: i.caName ?? null,
    explorerUrl: i.explorerUrl ?? null,
    createdAt: record.createdAt,
    voted,
  };
}
