/** The JSON shapes of the contract's arguments and records, with points and scalars as lowercase hex. */

export interface Ciphertext {
  a: string;
  b: string;
}

export interface BitProof {
  c0: string;
  c1: string;
  z0: string;
  z1: string;
}

export interface SumProof {
  c: string;
  z: string;
}

export interface Ballot {
  v: 1;
  electionId: string;
  ciphertexts: Ciphertext[];
  bitProofs: BitProof[];
  sumProof: SumProof;
}

/** PostCommitments: k commitments, noble's 64-byte proof of knowledge (R || z) and the one-time ceremony key. */
export interface Round1Post {
  commitments: string[];
  proof: string;
  ceremonyKey: string;
}

/** PostShares: one encrypted share for each other trustee. */
export interface Round2Post {
  shares: { to: string; nonce: string; box: string }[];
}

/** ConfirmShares: the proof that the trustee holds the secret behind its verifying share. */
export interface ConfirmationPost {
  c: string;
  z: string;
}

/** PostDecryptionShare: one entry per option. */
export interface DecryptionSharePost {
  shares: { d: string; c: string; z: string }[];
}

/** The ballot JSON with its fields in the order the specification lists them. */
export function ballotJson(b: Ballot): string {
  return JSON.stringify({
    v: b.v,
    electionId: b.electionId,
    ciphertexts: b.ciphertexts.map(({ a, b }) => ({ a, b })),
    bitProofs: b.bitProofs.map(({ c0, c1, z0, z1 }) => ({ c0, c1, z0, z1 })),
    sumProof: { c: b.sumProof.c, z: b.sumProof.z },
  });
}
