/**
 * Test support for weft_castBallot: an organisation's CA with a peer and a
 * voter, and a relay that builds real Fabric Gateway messages around a fake
 * private-ballot contract, with switches for every way a relay could lie.
 */
import "reflect-metadata";
import { BasicConstraintsExtension, KeyUsageFlags, KeyUsagesExtension, X509CertificateGenerator } from "@peculiar/x509";
import { CommitError, Message, RelayError, fromBase64, generateKeyPair, signForFabric, toBase64, utf8 } from "@weftwallet/core";
import type { ContractCall, RelayCommitStatusResponse, RelaySigner, X509Signer } from "@weftwallet/protocol";
import { electionContext, electionFingerprint, fromHex, toHex, trusteeId, voterTagFromCertificate, voterTagIdemix, type Election } from "@weftwallet/tally";
import { TallyError, checkBallot } from "@weftwallet/tally/verify";
import type { BallotRelay } from "../cast";

/* ------------------------------------------------------------------ */
/* Protobuf, written                                                   */
/* ------------------------------------------------------------------ */

const varint = (n: number | bigint) => {
  let v = BigInt(n);
  const out: number[] = [];
  while (v > 0x7fn) {
    out.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  out.push(Number(v));
  return out;
};
export const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
/** A length-delimited field. */
export const f = (n: number, v: Uint8Array | string) => {
  const b = typeof v === "string" ? utf8(v) : v;
  return new Uint8Array([...varint((n << 3) | 2), ...varint(b.length), ...b]);
};
/** A varint field. */
export const fv = (n: number, v: number) => new Uint8Array([...varint(n << 3), ...varint(v)]);

const sha256 = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", b as Uint8Array<ArrayBuffer>));

/* ------------------------------------------------------------------ */
/* Organisations                                                       */
/* ------------------------------------------------------------------ */

let serial = 1;

async function issue(subject: string, issuer: { name: string; key: CryptoKey }, validFor = 365 * 86_400_000) {
  const keys = await generateKeyPair("P-256", { extractable: true });
  const cert = await X509CertificateGenerator.create({
    serialNumber: (serial++).toString(16).padStart(4, "0"),
    subject,
    issuer: issuer.name,
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + validFor),
    signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
    publicKey: keys.publicKey,
    signingKey: issuer.key,
  });
  // Fabric CA's PEM ends with a newline.
  return { keys, pem: `${cert.toString("pem")}\n` };
}

export interface Org {
  mspId: string;
  /** The CA chain Fabric CA returns at enrolment. */
  chain: string;
  peer: { keys: CryptoKeyPair; pem: string };
  voter: { keys: CryptoKeyPair; pem: string };
  /** A client of the same CA: it can sign, but it isn't a peer. */
  client: { keys: CryptoKeyPair; pem: string };
}

export async function makeOrg(mspId: string): Promise<Org> {
  const keys = await generateKeyPair("P-256", { extractable: true });
  const name = `CN=ca.${mspId.toLowerCase()}`;
  const ca = await X509CertificateGenerator.createSelfSigned({
    serialNumber: (serial++).toString(16).padStart(4, "0"),
    name,
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 2 * 365 * 86_400_000),
    signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
    keys,
    extensions: [new BasicConstraintsExtension(true, undefined, true), new KeyUsagesExtension(KeyUsageFlags.keyCertSign, true)],
  });
  const issuer = { name: ca.subject, key: keys.privateKey };
  return {
    mspId,
    chain: `${ca.toString("pem")}\n`,
    peer: await issue("CN=peer0,OU=peer", issuer),
    voter: await issue("CN=alice,OU=client", issuer),
    client: await issue("CN=mallory,OU=client", issuer),
  };
}

/* ------------------------------------------------------------------ */
/* An election                                                         */
/* ------------------------------------------------------------------ */

/** The vectors' key setup (packages/tally/vectors/v1/context.json), with two trustees. */
export function testElection(channel = "privatevote-budget-2027", chaincode = "private-ballot"): Election {
  return {
    channel,
    chaincode,
    electionId: "budget-2027",
    options: ["Plan A", "Plan B", "Plan C"],
    threshold: 2,
    trustees: ["Org1MSP", "Org2MSP"],
    publicKey: "4c2fbc16961b3d17af934eaa88cba3476f83fc7610cb793d2ebe82a9bf103101",
    verifyingShares: [
      "82ca014e2614d34036767fad6f2ef98c971e0df04d71121fe75c82cb2430380e",
      "1cffce95bd7fd57a5acaa8ed264565430a7e0793f2cd5452011ede4461a0d702",
    ],
  };
}

/** The record the contract stores for `e`, open, with its context and fingerprint. */
export function recordOf(e: Election, patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    id: e.electionId,
    title: "Budget 2027",
    options: e.options,
    closesAt: "2027-01-31T17:00:00.000Z",
    creatorMsp: "Org1MSP",
    trustees: e.trustees.map((msp, i) => ({ id: toHex(trusteeId(i)), msp })),
    threshold: e.threshold,
    voters: { kind: "x509", msps: ["Org1MSP", "Org2MSP"] },
    state: "open",
    publicKey: e.publicKey,
    verifyingShares: e.verifyingShares,
    context: toHex(electionContext(e)),
    fingerprint: electionFingerprint(e),
    ...patch,
  };
}

/* ------------------------------------------------------------------ */
/* The relay                                                           */
/* ------------------------------------------------------------------ */

export interface Lies {
  /** The proposal carries other arguments than Weft asked for. */
  args?: (args: string[]) => string[];
  /** The creator's id_bytes in the proposal. */
  creator?: (pem: string) => string;
  /** The peers' answer is for another proposal. */
  otherProposal?: boolean;
  /** The record the answer carries, whatever the ledger holds. */
  record?: Record<string, unknown>;
  /** Who signs the answer: the peer (default), a client of the same CA, or another CA's peer. */
  signer?: "peer" | "client" | "stranger" | "none";
  /** The signature is over other bytes. */
  badSignature?: boolean;
  /** The contract's answer to CastBallot carries this tracking code. */
  tracking?: string;
  /** CastAnonymousBallot's pseudonym proof is refused, as the contract refuses one that doesn't verify. */
  badProof?: boolean;
}

interface Stored {
  channelHeader: Uint8Array;
  signatureHeader: Uint8Array;
  input: Uint8Array;
  txId: string;
  call: ContractCall;
  creator: { mspId: string; idBytes: Uint8Array };
  result: Uint8Array | null;
  error: string | null;
}

/**
 * A relay in front of a fake private-ballot contract. It holds one election
 * record and the ballots cast, checks each ballot as the contract does
 * (@weftwallet/tally/verify, with the voter tag from the creator's id_bytes),
 * and signs the peers' answers with the organisations' peer keys.
 */
export class FakeRelay implements BallotRelay {
  record: Record<string, unknown>;
  readonly ballots: { txId: string; tracking: string; ballot: string; tag: string }[] = [];
  readonly calls: string[] = [];
  lies: Lies = {};
  /** Paths that fail as if the relay didn't answer. */
  down = new Set<string>();
  /** CommitStatus's answer instead of VALID. */
  commitStatusCode: string | null = null;
  block = 41;
  private readonly stored = new Map<string, Stored>();
  private tx = 0;

  readonly election: Election;
  readonly orgs: Org[];
  readonly stranger: Org | undefined;

  constructor(election: Election, orgs: Org[], stranger?: Org) {
    this.election = election;
    this.orgs = orgs;
    this.stranger = stranger;
    this.record = recordOf(election);
  }

  private unreachable(path: string) {
    if (this.down.has(path)) throw new RelayError(0, { kind: "unreachable", message: `http://localhost:8787${path}: TypeError: fetch failed` }, "http://localhost:8787", path);
  }

  /** The signers the relay was given, in order: what the relay learns about who signs. */
  readonly signers: RelaySigner[] = [];

  async propose(signer: RelaySigner, call: ContractCall) {
    this.calls.push(`propose ${call.fn}`);
    this.signers.push(signer);
    this.unreachable("/v1/proposals");
    const txId = `tx${++this.tx}`.padEnd(64, "0");
    const args = this.lies.args ? this.lies.args(call.args ?? []) : (call.args ?? []);
    // As the relay does: the certificate, trimmed, or the idemix identity's bytes, are the creator's id_bytes.
    const idemix = "idemixIdentity" in signer;
    const given = idemix ? (signer as { idemixIdentity: string }).idemixIdentity : (signer as X509Signer).certificate;
    const pem = this.lies.creator ? this.lies.creator(given) : idemix ? given : given.trim();
    const idBytes = idemix ? fromBase64(pem) : utf8(pem);
    const creator = cat(f(1, signer.mspId), f(2, idBytes));
    const channelHeader = cat(f(4, call.channel), f(5, txId));
    const signatureHeader = f(1, creator);
    const spec = cat(f(2, f(2, call.chaincode)), f(3, cat(...[call.fn, ...args].map((a) => f(1, a)))));
    // ChaincodeInvocationSpec { chaincode_spec = 1 }
    const input = f(1, spec);
    const proposal = cat(f(1, cat(f(1, channelHeader), f(2, signatureHeader))), f(2, f(1, input)));
    this.stored.set(txId, { channelHeader, signatureHeader, input, txId, call: { ...call, args }, creator: { mspId: signer.mspId, idBytes }, result: null, error: null });
    const proposed = cat(f(1, txId), f(2, f(1, proposal)));
    return { proposal: toBase64(proposed), transactionId: txId };
  }

  private run(s: Stored): { payload: Uint8Array } | { error: string } {
    const { fn, args = [] } = s.call;
    if (fn === "GetElection") {
      if (args[0] !== this.record.id) return { error: `There's no election ${args[0]}.` };
      return { payload: utf8(JSON.stringify(this.lies.record ?? this.record)) };
    }
    if (fn === "CastBallot") {
      if (this.record.state !== "open") return { error: this.record.state === "decrypting" || this.record.state === "counted" ? "Voting has closed." : `The election isn't open: it is in ${String(this.record.state)}.` };
      try {
        const tag = voterTagFromCertificate(this.election.channel, this.election.electionId, s.creator.mspId, s.creator.idBytes);
        if (this.ballots.some((b) => b.tag === toHex(tag))) return { error: "This identity has already voted in this election." };
        const checked = checkBallot(this.election, tag, args[1] ?? "");
        const tracking = this.lies.tracking ?? checked.tracking;
        this.ballots.push({ txId: s.txId, tracking: checked.tracking, ballot: args[1]!, tag: toHex(tag) });
        return { payload: utf8(JSON.stringify({ electionId: args[0], txId: s.txId, tracking })) };
      } catch (error) {
        if (error instanceof TallyError) return { error: error.message };
        throw error;
      }
    }
    if (fn === "CastAnonymousBallot") {
      const voters = this.record.voters as { kind: string; msp?: string };
      if (this.record.state !== "open") return { error: this.record.state === "decrypting" || this.record.state === "counted" ? "Voting has closed." : `The election isn't open: it is in ${String(this.record.state)}.` };
      if (voters.kind !== "idemix") return { error: "This election has X.509 voters, so its ballots are cast with CastBallot." };
      if (s.creator.mspId !== voters.msp) return { error: `This identity can't vote in this election: ${s.creator.mspId} isn't one of its voter organisations.` };
      let proof: { pseudonym?: string };
      try {
        proof = JSON.parse(args[2] ?? "") as { pseudonym?: string };
      } catch {
        return { error: "The pseudonym proof isn't JSON." };
      }
      const P = fromHex(proof.pseudonym ?? "", 64);
      if (!P) return { error: "The pseudonym proof's pseudonym isn't a canonical point." };
      const tag = voterTagIdemix(this.election.channel, this.election.electionId, s.creator.mspId, P);
      if (this.lies.badProof) return { error: "The pseudonym proof is not valid." };
      if (this.ballots.some((b) => b.tag === toHex(tag))) return { error: "This credential has already voted in this election." };
      try {
        const checked = checkBallot(this.election, tag, args[1] ?? "");
        const tracking = this.lies.tracking ?? checked.tracking;
        this.ballots.push({ txId: s.txId, tracking: checked.tracking, ballot: args[1]!, tag: toHex(tag) });
        return { payload: utf8(JSON.stringify({ electionId: args[0], txId: s.txId, tracking })) };
      } catch (error) {
        if (error instanceof TallyError) return { error: error.message };
        throw error;
      }
    }
    return { error: `The contract has no function ${fn}.` };
  }

  async endorse(signer: RelaySigner, proposalB64: string, _signature: string) {
    this.calls.push("endorse");
    this.unreachable("/v1/proposals/endorse");
    const txId = new Message(fromBase64(proposalB64)).string(1);
    const s = this.stored.get(txId)!;
    const out = this.run(s);
    if ("error" in out) {
      throw new RelayError(
        500,
        { kind: "proposals_endorse", message: "failed to endorse transaction", details: [{ mspId: "Org1MSP", address: "peer0.org1.example.com:7051", message: `chaincode response 500, ${out.error}` }] },
        "http://localhost:8787",
        "/v1/proposals/endorse",
      );
    }
    s.result = out.payload;
    const header = cat(f(1, s.channelHeader), f(2, s.signatureHeader));
    // Fabric's endorser: SHA-256 of the channel header, the signature header and the payload without transient data.
    const hash = this.lies.otherProposal ? await sha256(utf8("another proposal")) : await sha256(cat(s.channelHeader, s.signatureHeader, f(1, s.input)));
    const action = cat(fv(1, 0), f(3, cat(fv(1, 200), f(3, out.payload))), f(4, f(2, s.call.chaincode)));
    const prp = cat(f(1, hash), f(2, action));
    const endorsements: Uint8Array[] = [];
    const who = this.lies.signer ?? "peer";
    for (const org of who === "stranger" && this.stranger ? [{ ...this.stranger, mspId: this.orgs[0]!.mspId }, ...this.orgs.slice(1)] : this.orgs) {
      if (who === "none" && org.mspId === signer.mspId) continue;
      const id = who === "client" && org.mspId === signer.mspId ? org.client : org.peer;
      const endorser = cat(f(1, org.mspId), f(2, id.pem));
      const signed = this.lies.badSignature ? cat(prp, utf8("x")) : cat(prp, endorser);
      endorsements.push(f(2, cat(f(1, endorser), f(2, await signForFabric(id.keys.privateKey, signed)))));
    }
    const endorsed = cat(f(1, prp), ...endorsements);
    const transaction = f(1, cat(f(1, header), f(2, cat(f(1, utf8("cpp")), f(2, endorsed)))));
    const payload = cat(f(1, header), f(2, transaction));
    const prepared = cat(f(1, txId), f(2, f(1, payload)));
    return { transaction: toBase64(prepared), transactionId: txId, result: toBase64(out.payload) };
  }

  async submit(_signer: RelaySigner, transaction: string, _signature: string) {
    this.calls.push("submit");
    this.unreachable("/v1/transactions/submit");
    const txId = new Message(fromBase64(transaction)).string(1);
    const s = this.stored.get(txId)!;
    return { commit: toBase64(f(1, cat(f(1, txId), f(2, s.call.channel)))) };
  }

  async commitStatus(_signer: RelaySigner, commit: string, _signature: string): Promise<RelayCommitStatusResponse> {
    this.calls.push("commitStatus");
    this.unreachable("/v1/commits/status");
    const txId = new Message(fromBase64(commit)).message(1).string(1);
    const status = this.commitStatusCode ?? "VALID";
    return { transactionId: txId, blockNumber: String(this.block), status, successful: status === "VALID" };
  }
}

export { CommitError };
