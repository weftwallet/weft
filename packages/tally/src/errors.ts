/**
 * Every refusal the verifiers make, with the contract's exact message from
 * the error table in contract-api.md. The Go verifiers in
 * examples/private-ballot-contract/internal/tally build the same strings, and
 * the negative test vectors hold them.
 */

/** A refusal with the contract's message. */
export class TallyError extends Error {
  override name = "TallyError";
}

/** "1 ciphertext", "3 ciphertexts". */
export function count(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** The kinds of JSON argument, as the messages name them. */
export type Thing = "The ballot" | "The round 1 post" | "The round 2 post" | "The confirmation" | "The decryption share";

export const messages = {
  notJson: (t: Thing) => `${t} isn't JSON.`,
  notObject: (t: Thing) => `${t} isn't a JSON object.`,
  missing: (t: Thing, path: string) => `${t} isn't in the version 1 format: ${path} is missing.`,
  unknownField: (t: Thing, path: string) => `${t} isn't in the version 1 format: it has an unknown field, ${path}.`,
  wrongType: (t: Thing, path: string, kind: string) => `${t} isn't in the version 1 format: ${path} isn't ${kind}.`,
  notPoint: (t: Thing, path: string) => `${t}'s ${path} isn't a canonical point.`,
  notScalar: (t: Thing, path: string) => `${t}'s ${path} isn't a canonical scalar.`,
  notBytes: (t: Thing, path: string, n: number) => `${t}'s ${path} isn't ${n} bytes of lowercase hex.`,

  wrongElection: () => "The ballot isn't for this election.",
  ciphertextCount: (n: number, L: number) => `The ballot has ${count(n, "ciphertext")}; this election has ${L} options.`,
  bitProofCount: (n: number, L: number) => `The ballot has ${count(n, "bit proof")}; this election has ${L} options.`,
  noRandomness: (j: number) => `Ciphertext ${j} has no randomness.`,
  notBit: (j: number) => `Ciphertext ${j} is not a 0 or a 1.`,
  notOne: () => "The ballot does not choose exactly one option.",
  repeated: () => "A ciphertext in this ballot is already on the ledger.",
  repeatedInBallot: (i: number, j: number) => `Ciphertexts ${i} and ${j} have the same randomness.`,
  identityVoted: () => "This identity has already voted in this election.",
  notX509Voter: () => "This identity can't vote in this election: it isn't an X.509 identity.",
  certificate: () => "This identity can't vote in this election: its certificate doesn't parse.",
  noEnrolmentId: () => "This identity can't vote in this election: its certificate has no enrolment ID.",
  credentialVoted: () => "This credential has already voted in this election.",

  commitmentCount: (msp: string, n: number, k: number) =>
    `Round 1 from ${msp} has ${count(n, "commitment")}; this election's threshold is ${k}.`,
  identityCommitment: (msp: string, t: number) => `Commitment ${t} from ${msp} is the identity point.`,
  identityCeremonyKey: (msp: string) => `The one-time key from ${msp} is the identity point.`,
  proofOfKnowledge: (msp: string) => `The proof of knowledge from ${msp} doesn't verify.`,
  shareRecipients: (msp: string) => `Round 2 from ${msp} doesn't send exactly one share to each other trustee.`,
  confirmation: (msp: string) => `The confirmation from ${msp} doesn't match its verifying share.`,

  shareCount: (n: number, L: number) => `The decryption share has ${n === 1 ? "1 entry" : `${n} entries`}; this election has ${L} options.`,
  share: (j: number, msp: string) => `Share ${j} from ${msp} does not match its key.`,
  tooFewShares: (k: number, m: number) => `The tally needs ${k} decryption shares; ${m} ${m === 1 ? "has" : "have"} been posted.`,
  countTooLarge: () => "A count is larger than the number of ballots, so the totals or shares are wrong.",
  countsSum: (s: number, n: number) => `The counts add up to ${s}, not to the ${count(n, "ballot")}, so the totals or shares are wrong.`,
} as const;
