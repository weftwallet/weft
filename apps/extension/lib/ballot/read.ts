/**
 * Experimental (docs/adr/0007): reading a private election before a vote.
 *
 * Weft reads GetElection by endorsing it without submitting. The relay
 * returns the prepared transaction, which carries each endorsing peer's
 * signed response. Weft checks that the response answers the proposal it
 * signed, that a peer of its own organisation signed it (where Weft kept the
 * CA chain at enrolment), and that the record's context and fingerprint are
 * the ones it computes itself from the record's fields.
 *
 * Pure apart from WebCrypto, so it is tested without a browser.
 */

import { Message, parseCertificate, readRole } from "@weftwallet/core";
import { certificateProblem, derSignatureToP1363, type MemberCas } from "@weftwallet/core/chain";
import { electionContext, electionFingerprint, toHex, trusteeId, type Election } from "@weftwallet/tally";

/* ------------------------------------------------------------------ */
/* The record                                                          */
/* ------------------------------------------------------------------ */

export type ElectionState = "keygen" | "open" | "decrypting" | "counted" | "failed" | "cancelled";

/** The election record GetElection returns, as contract-api.md defines it. */
export interface ElectionRecord {
  v: 1;
  id: string;
  title: string;
  options: string[];
  closesAt: string;
  creatorMsp: string;
  trustees: { id: string; msp: string }[];
  threshold: number;
  voters:
    | { kind: "x509"; msps: string[] }
    | { kind: "idemix"; msp: string; affiliation: string; role: string; issuerKeyHash: string; curve: string };
  state: ElectionState;
  publicKey?: string;
  verifyingShares?: string[];
  context?: string;
  fingerprint?: string;
  reportedBy?: string;
}

/** Why Weft won't use what it read. Each becomes 4400 ElectionUnavailable. */
export class RecordError extends Error {
  override name = "RecordError";
  constructor(
    readonly reason: "unreadable" | "mismatch" | "signature",
    message: string,
    readonly extra: { computed?: string; recorded?: string; field?: "context" | "fingerprint" } = {},
  ) {
    super(message);
  }
}

const STATES: readonly ElectionState[] = ["keygen", "open", "decrypting", "counted", "failed", "cancelled"];
const HEX = (n: number) => new RegExp(`^[0-9a-f]{${n}}$`);

/**
 * Reads the record's JSON. Anything Weft doesn't read as a version 1 record
 * of this election is a RecordError, so a contract that isn't the private
 * ballot contract can't get a vote cast.
 */
export function parseElectionRecord(text: string, electionId: string): ElectionRecord {
  const bad = (what: string): never => {
    throw new RecordError("unreadable", what);
  };
  let r: Record<string, unknown>;
  try {
    r = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return bad("The contract's answer isn't JSON.");
  }
  if (typeof r !== "object" || r === null || Array.isArray(r)) bad("The contract's answer isn't a JSON object.");
  if (r.v !== 1) bad("The record isn't in the version 1 format.");
  if (r.id !== electionId) bad(`The record is for ${JSON.stringify(r.id)}, not ${electionId}.`);
  const str = (k: string) => (typeof r[k] === "string" ? (r[k] as string) : bad(`The record's ${k} isn't a string.`));
  const strings = (k: string, v: unknown) =>
    Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : bad(`The record's ${k} isn't a list of strings.`);
  const title = str("title");
  const options = strings("options", r.options);
  if (options.length < 2) bad("The record has fewer than two options.");
  const closesAt = str("closesAt");
  if (Number.isNaN(Date.parse(closesAt))) bad("The record's closesAt isn't a time.");
  const creatorMsp = str("creatorMsp");
  const state = str("state") as ElectionState;
  if (!STATES.includes(state)) bad(`The record's state, ${JSON.stringify(state)}, isn't one Weft knows.`);
  if (!Array.isArray(r.trustees) || r.trustees.length < 2) bad("The record's trustees aren't a list of two or more.");
  const trustees = (r.trustees as unknown[]).map((t, i) => {
    const o = t as { id?: unknown; msp?: unknown } | null;
    if (typeof o?.id !== "string" || typeof o.msp !== "string") return bad(`The record's trustees[${i}] isn't an id and an MSP ID.`);
    // Trustee i (0-based) has the identifier i + 1, which ctx covers.
    if (o.id !== toHex(trusteeId(i))) bad(`The record's trustees[${i}].id isn't the identifier ${i + 1}.`);
    return { id: o.id, msp: o.msp };
  });
  const threshold = r.threshold;
  if (typeof threshold !== "number" || !Number.isInteger(threshold) || threshold < 2 || threshold > trustees.length) {
    bad("The record's threshold isn't from 2 to the number of trustees.");
  }
  const v = r.voters as { kind?: unknown; msps?: unknown; msp?: unknown } | null;
  let voters: ElectionRecord["voters"];
  if (v?.kind === "x509") voters = { kind: "x509", msps: strings("voters.msps", v.msps) };
  else if (v?.kind === "idemix" && typeof v.msp === "string") {
    const iv = v as { affiliation?: unknown; role?: unknown; issuerKeyHash?: unknown; curve?: unknown };
    const field = (k: "affiliation" | "role" | "issuerKeyHash" | "curve") => (typeof iv[k] === "string" ? (iv[k] as string) : bad(`The record's voters.${k} isn't a string.`));
    voters = { kind: "idemix", msp: v.msp, affiliation: field("affiliation"), role: field("role"), issuerKeyHash: field("issuerKeyHash"), curve: field("curve") };
    if (!HEX(64).test(voters.issuerKeyHash)) bad("The record's voters.issuerKeyHash isn't 64 lowercase hex characters.");
  } else return bad("The record's voters are neither X.509 organisations nor a voter credential organisation.");
  const record: ElectionRecord = { v: 1, id: electionId, title, options, closesAt, creatorMsp, trustees, threshold: threshold as number, voters, state };
  if (typeof r.reportedBy === "string") record.reportedBy = r.reportedBy;
  if (state === "keygen" || state === "failed" || state === "cancelled") return record;
  // From open on, the key and its checks are there.
  record.publicKey = str("publicKey");
  record.verifyingShares = strings("verifyingShares", r.verifyingShares);
  record.context = str("context");
  record.fingerprint = str("fingerprint");
  if (!HEX(64).test(record.publicKey)) bad("The record's publicKey isn't 64 lowercase hex characters.");
  if (record.verifyingShares.length !== trustees.length || !record.verifyingShares.every((s) => HEX(64).test(s))) {
    bad("The record doesn't have one verifying share per trustee.");
  }
  if (!HEX(64).test(record.context)) bad("The record's context isn't 64 lowercase hex characters.");
  if (!HEX(20).test(record.fingerprint)) bad("The record's fingerprint isn't 20 lowercase hex characters.");
  return record;
}

/**
 * The election as @weftwallet/tally encrypts under it, from an open record,
 * with the channel and contract the site named. Weft computes the context
 * and fingerprint itself and refuses a record whose own differ, so a key or
 * option list the record doesn't commit to is never used.
 */
export function electionFrom(record: ElectionRecord, channel: string, chaincode: string): { election: Election; fingerprint: string } {
  const election: Election = {
    channel,
    chaincode,
    electionId: record.id,
    options: record.options,
    threshold: record.threshold,
    trustees: record.trustees.map((t) => t.msp),
    publicKey: record.publicKey!,
    verifyingShares: record.verifyingShares!,
  };
  let context: string;
  let fingerprint: string;
  try {
    context = toHex(electionContext(election));
    fingerprint = electionFingerprint(election);
  } catch (error) {
    throw new RecordError("unreadable", `The record's key doesn't decode: ${error instanceof Error ? error.message : String(error)}.`);
  }
  if (context !== record.context) {
    throw new RecordError("mismatch", "The record's context isn't the one Weft computed from its fields.", { field: "context", computed: context, recorded: record.context! });
  }
  if (fingerprint !== record.fingerprint) {
    throw new RecordError("mismatch", "The record's fingerprint isn't the one Weft computed from its fields.", { field: "fingerprint", computed: fingerprint, recorded: record.fingerprint! });
  }
  return { election, fingerprint };
}

/* ------------------------------------------------------------------ */
/* The signed answer                                                   */
/* ------------------------------------------------------------------ */

const sha256 = async (bytes: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
const varint = (n: number) => {
  const out: number[] = [];
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
  return out;
};

/**
 * The creator's SerializedIdentity.id_bytes in a proposal Weft is asked to
 * sign, unchanged: for an X.509 identity, the PEM certificate exactly as the
 * relay put it there, with or without a trailing newline. The contract makes
 * the voter tag from these bytes, so Weft does too.
 */
export function creatorIdBytes(proposalBytes: Uint8Array): Uint8Array {
  // Proposal.header = 1 -> Header.signature_header = 2 -> SignatureHeader.creator = 1 -> SerializedIdentity.id_bytes = 2
  return new Message(proposalBytes).message(1).message(2).message(1).bytes(2);
}

/**
 * The hash a peer puts in its proposal response: SHA-256 of the channel
 * header, the signature header and the chaincode proposal payload without
 * its transient map, as Fabric's endorser computes it.
 */
export async function proposalHash(proposalBytes: Uint8Array): Promise<Uint8Array> {
  const proposal = new Message(proposalBytes);
  const header = proposal.message(1);
  const input = proposal.message(2).bytes(1);
  const payload = new Uint8Array([0x0a, ...varint(input.length), ...input]);
  return sha256(concat(header.bytes(1), header.bytes(2), payload));
}

export interface Endorsement {
  mspId: string;
  /** The endorser's PEM certificate. */
  certificate: string;
  /** What the peer signed: the proposal response payload, then the serialised endorser. */
  signed: Uint8Array;
  /** DER ECDSA. */
  signature: Uint8Array;
}

export interface EndorsedAnswer {
  /** ProposalResponsePayload.proposal_hash. */
  proposalHash: Uint8Array;
  chaincode: string;
  status: number;
  /** The contract's answer, from inside the bytes the peers signed. */
  payload: Uint8Array;
  endorsements: Endorsement[];
}

/** Decodes the endorsed answer in a prepared transaction (fabric-gateway's Transaction.getBytes()). */
export function decodeEndorsedAnswer(prepared: Uint8Array): EndorsedAnswer {
  // PreparedTransaction.envelope = 2 -> Envelope.payload = 1 -> Payload.data = 2 (Transaction)
  const transaction = new Message(new Message(prepared).message(2).bytes(1)).message(2);
  // Transaction.actions = 1 -> TransactionAction.payload = 2 -> ChaincodeActionPayload.action = 2 (ChaincodeEndorsedAction)
  const actions = transaction.repeatedBytes(1);
  if (actions.length !== 1) throw new RecordError("signature", `The answer has ${actions.length} actions, not one.`);
  const endorsed = new Message(new Message(actions[0]!).bytes(2)).message(2);
  const prp = endorsed.bytes(1);
  // ProposalResponsePayload: proposal_hash = 1, extension = 2 (ChaincodeAction)
  const responsePayload = new Message(prp);
  const action = responsePayload.message(2);
  // ChaincodeAction: response = 3 (Response: status = 1, payload = 3), chaincode_id = 4 (ChaincodeID: name = 2)
  const response = action.message(3);
  const endorsements = endorsed.repeatedBytes(2).map((bytes) => {
    // Endorsement: endorser = 1 (SerializedIdentity bytes), signature = 2
    const e = new Message(bytes);
    const endorser = e.bytes(1);
    const identity = new Message(endorser);
    return { mspId: identity.string(1), certificate: identity.string(2), signed: concat(prp, endorser), signature: e.bytes(2) };
  });
  return {
    proposalHash: responsePayload.bytes(1),
    chaincode: action.message(4).string(2),
    status: Number(response.varint(1)),
    payload: response.bytes(3),
    endorsements,
  };
}

/** A CA chain as Fabric CA returns it at enrolment: self-signed certificates are roots, the rest intermediates. */
export function chainCas(mspId: string, chainPem: string): MemberCas {
  const pems = chainPem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
  const roots: string[] = [];
  const intermediates: string[] = [];
  for (const pem of pems) {
    const cert = parseCertificate(pem);
    (cert.subject === cert.issuer ? roots : intermediates).push(pem);
  }
  return { mspId, rootCerts: roots, intermediateCerts: intermediates };
}

const CURVE_SIZES: Record<string, number> = { "P-256": 32, "P-384": 48 };

/** Whether `e` is a signature by a peer certificate of `cas`'s organisation, over what it says it signed. */
async function peerSigned(e: Endorsement, cas: MemberCas, now: Date): Promise<string | null> {
  let cert;
  try {
    cert = parseCertificate(e.certificate);
  } catch {
    return "its certificate can't be read";
  }
  if (readRole(cert) !== "peer") return "its certificate isn't a peer's";
  const problem = await certificateProblem(cert, cas, now);
  if (problem === "expired") return "its certificate has expired";
  if (problem) return `its certificate wasn't issued by ${cas.mspId}'s CA`;
  const algorithm = cert.publicKey.algorithm as { name: string; namedCurve: string };
  const size = CURVE_SIZES[algorithm.namedCurve];
  if (algorithm.name !== "ECDSA" || !size) return "its key isn't an ECDSA key Weft can check";
  try {
    const key = await cert.publicKey.export({ name: "ECDSA", namedCurve: algorithm.namedCurve }, ["verify"]);
    const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, derSignatureToP1363(e.signature, size), e.signed as Uint8Array<ArrayBuffer>);
    return ok ? null : "its signature doesn't verify";
  } catch {
    return "its signature doesn't verify";
  }
}

/** The trustee organisations' CA chains, from a voter invite (docs/adr/0008, D9). */
export type Endorsers = { mspId: string; caChain: string }[];

/**
 * Checks the answer: it is for the proposal Weft signed, from the contract
 * the site named, successful, and signed as `expect` says. With `chain`,
 * by a peer of the voter's own organisation whose certificate chains to that
 * CA. With `endorsers`, for a voter credential, whose organisation has no
 * peers: there is at least one endorsement, and every endorsement is by a
 * peer of an organisation the voter invite names, whose certificate chains to
 * the CA chain the invite pins for it (D9). Returns the contract's answer as
 * text, and the organisations whose signatures Weft checked. Throws
 * RecordError("signature") otherwise.
 */
export async function checkAnswer(
  answer: EndorsedAnswer,
  expect: { proposal: Uint8Array; chaincode: string; mspId: string; chain: string | null; endorsers?: Endorsers; now?: Date },
): Promise<{ text: string; peerChecked: boolean; checked: string[] }> {
  if (!sameBytes(answer.proposalHash, await proposalHash(expect.proposal))) {
    throw new RecordError("signature", "The peers' answer isn't for the proposal Weft signed.");
  }
  if (answer.chaincode !== expect.chaincode) {
    throw new RecordError("signature", `The answer is from the contract ${answer.chaincode}, not ${expect.chaincode}.`);
  }
  if (answer.status !== 200) throw new RecordError("signature", `The answer's status is ${answer.status}, not 200.`);
  if (expect.endorsers) {
    if (answer.endorsements.length === 0) throw new RecordError("signature", "No peer signed the answer.");
    const checked: string[] = [];
    for (const e of answer.endorsements) {
      const pinned = expect.endorsers.find((p) => p.mspId === e.mspId);
      if (!pinned) throw new RecordError("signature", `The endorsement from ${e.mspId} isn't from an organisation the voter invite names.`);
      const cas = chainCas(e.mspId, pinned.caChain);
      if (cas.rootCerts.length === 0) throw new RecordError("signature", `The voter invite's CA chain for ${e.mspId} has no root certificate.`);
      const problem = await peerSigned(e, cas, expect.now ?? new Date());
      if (problem) {
        const said = problem === `its certificate wasn't issued by ${e.mspId}'s CA` ? "its certificate doesn't chain to the CA certificate in the voter invite" : problem;
        throw new RecordError("signature", `The endorsement from ${e.mspId} doesn't check out: ${said}.`);
      }
      if (!checked.includes(e.mspId)) checked.push(e.mspId);
    }
    return { text: utf8Text(answer.payload), peerChecked: true, checked };
  }
  if (expect.chain) {
    const cas = chainCas(expect.mspId, expect.chain);
    if (cas.rootCerts.length === 0) throw new RecordError("signature", `The CA chain Weft kept for ${expect.mspId} has no root certificate.`);
    const own = answer.endorsements.filter((e) => e.mspId === expect.mspId);
    if (own.length === 0) throw new RecordError("signature", `No peer of ${expect.mspId} signed the answer.`);
    const problems: string[] = [];
    for (const e of own) {
      const problem = await peerSigned(e, cas, expect.now ?? new Date());
      if (!problem) return { text: utf8Text(answer.payload), peerChecked: true, checked: [expect.mspId] };
      problems.push(problem);
    }
    throw new RecordError("signature", `${expect.mspId}'s endorsement doesn't check out: ${problems.join("; ")}.`);
  }
  return { text: utf8Text(answer.payload), peerChecked: false, checked: [] };
}

function utf8Text(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new RecordError("unreadable", "The contract's answer isn't UTF-8 text.");
  }
}
