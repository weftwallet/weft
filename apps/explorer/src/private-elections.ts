/**
 * Private elections on the private-ballot contract (docs/adr/0007), for the
 * experimental track (docs/adr/0009): indexed only when the explorer runs
 * with WEFT_EXPERIMENTAL=1 and a channel's policy names privateElections.
 *
 * The indexer reads each valid transaction of the contract from the block:
 * the election record and every post from the write set, as the endorsing
 * peers wrote them, and each ballot's argument as the contract read it. It
 * decodes every argument and value the way the Go contract does
 * (go-utf8.ts), checks what it can as it goes (full-check.ts: each ballot's
 * proofs, each ceremony post, the key, the totals, each decryption share
 * and the tally) and records the result with each one. It works out each
 * ballot's voter tag from the transaction's creator, compares it with the
 * one the contract wrote, and publishes the tag even when the policy hides
 * submitters, because every ballot proof is bound to it. The creator's
 * certificate is stored only when the policy shows submitters.
 *
 * In an election with voter credentials (docs/adr/0008), each ballot comes
 * from CastAnonymousBallot, signed by a voter credential's one-off identity.
 * The voter tag is made from the ballot's pseudonym, and the indexer checks
 * the creator's proof against the election's pinned issuer key and the
 * pseudonym proof against the creator's Nym with the idemix WebAssembly
 * module, in this process, as it reads the block. It stores the anonymous
 * creator and the pseudonym proof whatever the policy says of submitters:
 * they name no one, and the browser's full check needs them (D12).
 *
 * Nothing here is secret: the ledger holds ciphertexts, proofs and posts
 * that anyone in the channel can read, and no ballot can be decrypted here.
 */

import { createHash } from "node:crypto";
import type { IdemixSync, PseudonymProof } from "@weftwallet/idemix";
import { electionContext, electionFingerprint, fromHex, toHex, trackingCode, voterTagIdemix, voterTagX509, type Ballot, type Election, type ElectionSetup } from "@weftwallet/tally";
import { checkBallot, checkConfirmation, checkDecryptionShare, checkRound1, checkRound2, electionKeys, type Round1 } from "@weftwallet/tally/verify";
import type { DecodedBlock, DecodedTransaction } from "./decode.ts";
import type { ExplorerDb, PrivateBallotRow, PrivateStepRow } from "./db.ts";
import { splitKey } from "./elections.ts";
import { checkAnonymousBallot, checkCeremony, checkCount, electionFrom, messageOf, type AnonymousCreator, type AnonymousVoters, type CeremonyPosts, type CheckedElection } from "./full-check.ts";
import { goJsonParse, goString } from "./go-utf8.ts";
import type { Policy } from "./policy.ts";

/** The election record, as contract-api.md describes it. */
export interface PrivateRecord {
  v: number;
  id: string;
  title: string;
  options: string[];
  closesAt: string;
  creatorMsp: string;
  trustees: { id: string; msp: string }[];
  threshold: number;
  /**
   * Who votes: X.509 identities of msps (kind "x509"), or voter credentials
   * (kind "idemix") of the idemix organisation msp with the OU affiliation
   * and the role member, under the pinned issuer key (base64) whose SHA-256
   * is issuerKeyHash.
   */
  voters: { kind: string; msps?: string[]; msp?: string; affiliation?: string; role?: string; issuerPublicKey?: string; issuerKeyHash?: string; curve?: string };
  state: "keygen" | "open" | "decrypting" | "counted" | "failed" | "cancelled";
  publicKey?: string;
  verifyingShares?: string[];
  context?: string;
  fingerprint?: string;
  ballots?: number;
  totals?: { a: string; b: string }[];
  closedBy?: string[];
  tally?: { counts: Record<string, number>; total: number };
  reportedBy?: string;
}

/** How long indexing has spent checking ballots, and anonymous ballots' creators and pseudonyms, for the timings in prototype-results.md. */
const stats = { ballots: 0, ms: 0, anonymous: 0, anonymousMs: 0 };
export const indexStats = () => ({ ...stats });
export const resetIndexStats = () => {
  stats.ballots = 0;
  stats.ms = 0;
  stats.anonymous = 0;
  stats.anonymousMs = 0;
};

/** The voters of an election with voter credentials, or null for X.509 voters. */
export function anonymousVoters(r: PrivateRecord): AnonymousVoters | null {
  const v = r.voters;
  return v.kind === "idemix" && v.msp && v.issuerPublicKey ? { msp: v.msp, affiliation: v.affiliation ?? "", issuerPublicKey: v.issuerPublicKey } : null;
}

/** What the verifiers need of a record before the key exists. */
export function setupOf(r: PrivateRecord, channel: string, chaincode: string): ElectionSetup {
  return { channel, chaincode, electionId: r.id, options: r.options, threshold: r.threshold, trustees: r.trustees.map((t) => t.msp) };
}

export function checkedOf(r: PrivateRecord, channel: string, chaincode: string): CheckedElection {
  return {
    ...setupOf(r, channel, chaincode),
    publicKey: r.publicKey ?? null,
    verifyingShares: r.verifyingShares ?? null,
    context: r.context ?? null,
    fingerprint: r.fingerprint ?? null,
    anonymous: anonymousVoters(r),
  };
}

/**
 * The election as the verifiers take it, cached by its context, so the key's
 * table (precomputed for every ballot) is built once per election.
 */
const elections = new Map<string, Election>();
function electionOf(r: PrivateRecord, channel: string, chaincode: string): Election | null {
  const key = `${channel}\u0000${chaincode}\u0000${r.id}\u0000${r.context ?? ""}\u0000${r.publicKey ?? ""}`;
  const cached = elections.get(key);
  if (cached) return cached;
  const e = electionFrom(checkedOf(r, channel, chaincode));
  if (e) {
    if (elections.size > 64) elections.clear();
    elections.set(key, e);
  }
  return e;
}

function parseRecord(text: string): PrivateRecord | null {
  try {
    const r = goJsonParse(text) as PrivateRecord;
    if (!r || typeof r !== "object" || typeof r.id !== "string" || !Array.isArray(r.options) || !Array.isArray(r.trustees)) return null;
    return r;
  } catch {
    return null;
  }
}

const parse = (text: string): unknown => {
  try {
    return goJsonParse(text);
  } catch {
    return null;
  }
};

/**
 * Indexes the private-ballot transactions of a block, for a channel whose
 * policy names privateElections. `idemix` is the idemix module, started in
 * this process, which checks anonymous ballots; without it, each anonymous
 * ballot is recorded as unchecked, with a message that says why.
 */
export function indexPrivateBlock(db: ExplorerDb, policy: Policy, block: DecodedBlock, idemix: IdemixSync | null = null): void {
  const c = policy.channels[block.channel];
  const contract = c?.privateElections;
  if (!c || !contract || c.level === "hidden") return;
  for (const tx of block.transactions) {
    if (tx.type !== "endorser" || tx.chaincode !== contract || tx.validation !== "VALID") continue;
    indexTransaction(db, { channel: block.channel, contract, showSubmitter: c.submitter === "show", idemix }, block, tx);
  }
}

interface Where {
  channel: string;
  contract: string;
  showSubmitter: boolean;
  idemix: IdemixSync | null;
}

function indexTransaction(db: ExplorerDb, where: Where, block: DecodedBlock, tx: DecodedTransaction): void {
  const { channel, contract } = where;
  const args = tx.args.map(goString);
  const writes = tx.writes
    .filter((w) => w.namespace === contract && !w.isDelete)
    .flatMap((w) => {
      const key = splitKey(w.key);
      return key ? [{ type: key.type, attrs: key.attrs, value: goString(w.value) }] : [];
    });
  const written = writes.find((w) => w.type === "election");
  const id = written?.attrs[0] ?? args[0];
  if (!id) return;
  const before = db.privateElection(channel, id);
  const record = written ? parseRecord(written.value) : ((before?.record as PrivateRecord | undefined) ?? null);
  if (!record) return;
  if (written) db.putPrivateElection(channel, id, record as unknown as Record<string, unknown>, block.number);
  const step = (kind: PrivateStepRow["kind"], trustee: string, body: unknown, check: string | null | undefined = undefined) =>
    db.addPrivateStep({
      channel,
      election: id,
      kind,
      trustee,
      txId: tx.txId,
      block: block.number,
      index: tx.index,
      timestamp: tx.timestamp,
      body,
      verified: check === undefined ? null : check === null,
      error: check ?? null,
    });
  const steps = () => db.privateSteps(channel, id);
  const postsOf = (r: PrivateRecord): CeremonyPosts[] => {
    const all = steps();
    const body = (kind: string, msp: string) => all.find((s) => s.kind === kind && s.trustee === msp)?.body ?? null;
    return r.trustees.map((t) => ({ round1: body("round1", t.msp), round2: body("round2", t.msp), confirmation: body("confirm", t.msp) }));
  };
  const indexOf = (msp: string) => record.trustees.findIndex((t) => t.msp === msp);

  switch (tx.fn) {
    case "CreateElection":
      step("create", record.creatorMsp, null);
      return;
    case "PostCommitments":
    case "PostShares":
    case "ConfirmShares": {
      const type = { PostCommitments: "ceremony1", PostShares: "ceremony2", ConfirmShares: "confirm" }[tx.fn];
      const kind = ({ PostCommitments: "round1", PostShares: "round2", ConfirmShares: "confirm" } as const)[tx.fn];
      const w = writes.find((x) => x.type === type);
      if (!w) return;
      const msp = w.attrs[1] ?? "";
      const body = parse(w.value);
      const i = indexOf(msp);
      step(kind, msp, body, checkPost(record, channel, contract, kind, i, body, postsOf(record)));
      return;
    }
    case "ReportBadShare": {
      const from = record.trustees.find((t) => t.id === args[1])?.msp ?? eventField(tx, "fromTrustee");
      step("report", record.reportedBy ?? "", { fromTrustee: from ?? null });
      return;
    }
    case "CancelElection":
      step("cancel", record.creatorMsp, null);
      return;
    case "OpenElection": {
      // The key, the verifying shares, the context and the fingerprint follow
      // from the round 1 commitments; the record's must be those.
      const problem = checkCeremony(checkedOf(record, channel, contract), postsOf(record));
      step("open", "", null, problem);
      return;
    }
    case "CastBallot":
      indexBallot(db, where, block, tx, record, args, writes);
      return;
    case "CastAnonymousBallot":
      indexAnonymousBallot(db, where, block, tx, record, args, writes);
      return;
    case "CloseElection": {
      const request = writes.find((w) => w.type === "close");
      if (request) step("close", request.attrs[1] ?? "", null);
      if (written && record.state === "decrypting") {
        const e = electionOf(record, channel, contract);
        const result = e ? checkCount(e, { ciphertexts: ciphertextsOf(db, channel, id), recordBallots: record.ballots ?? null, totals: record.totals ?? null, shares: [], counts: null }) : null;
        step("closed", "", { closedBy: record.closedBy ?? [], ballots: record.ballots ?? null }, result ? result.totals : "This explorer has no key for this election.");
      }
      return;
    }
    case "PostDecryptionShare": {
      const w = writes.find((x) => x.type === "dshare");
      if (!w) return;
      const msp = w.attrs[1] ?? "";
      const body = parse(w.value);
      const e = electionOf(record, channel, contract);
      // Only the share's own proofs: the totals were checked when voting closed.
      const problem = !e || !record.totals ? "This explorer has no key or totals for this election." : shareProblem(e, record.totals, indexOf(msp), body);
      step("dshare", msp, body, problem);
      return;
    }
    case "PublishTally": {
      const e = electionOf(record, channel, contract);
      let problem: string | null = "This explorer has no key for this election.";
      if (e) {
        const shares = steps()
          .filter((s) => s.kind === "dshare")
          .map((s) => ({ index: indexOf(s.trustee), share: s.body }))
          .sort((a, b) => a.index - b.index);
        const counts = record.tally ? record.options.map((o) => record.tally!.counts[o] ?? -1) : null;
        const result = checkCount(e, { ciphertexts: ciphertextsOf(db, channel, id), recordBallots: record.ballots ?? null, totals: record.totals ?? null, shares, counts });
        problem = result.totals ?? result.shares ?? result.tally;
      }
      step("publish", "", null, problem);
      return;
    }
    default:
      return;
  }
}

/** Every indexed ballot's ciphertexts, in ledger order. */
const ciphertextsOf = (db: ExplorerDb, channel: string, id: string) =>
  db.privateBallots(channel, id).map((b) => (b.ballot as { ciphertexts: { a: string; b: string }[] }).ciphertexts);

function shareProblem(e: Election, totals: { a: string; b: string }[], index: number, body: unknown): string | null {
  if (index < 0) return "The share is from an organisation that isn't one of the election's trustees.";
  try {
    checkDecryptionShare(e, totals, index, JSON.stringify(body));
    return null;
  } catch (error) {
    return messageOf(error);
  }
}

function eventField(tx: DecodedTransaction, field: string): string | null {
  if (!tx.event) return null;
  const v = (parse(goString(tx.event.payload)) as Record<string, unknown> | null)?.[field];
  return typeof v === "string" ? v : null;
}

/**
 * A ceremony post's own check, as PostCommitments, PostShares and
 * ConfirmShares make it: round 1 and round 2 against the setup, and a
 * confirmation against the verifying share the round 1 commitments give,
 * since the record has no key until OpenElection.
 */
function checkPost(record: PrivateRecord, channel: string, contract: string, kind: "round1" | "round2" | "confirm", index: number, body: unknown, posts: CeremonyPosts[]): string | null {
  if (index < 0) return "The post is from an organisation that isn't one of the election's trustees.";
  const setup = checkedOf(record, channel, contract);
  try {
    if (kind === "round1") checkRound1(setup, index, JSON.stringify(body));
    else if (kind === "round2") checkRound2(setup, index, JSON.stringify(body));
    else {
      const round1: Round1[] = posts.map((p, i) => {
        if (!p.round1) throw new Error(`round 1 from ${setup.trustees[i]} isn't indexed`);
        return checkRound1(setup, i, JSON.stringify(p.round1));
      });
      const e: Election = { ...setup, ...electionKeys(setup, round1) };
      checkConfirmation(e, index, JSON.stringify(body));
    }
    return null;
  } catch (error) {
    return messageOf(error);
  }
}

/**
 * A ballot, checked as the contract checks it (the specification's steps 2
 * to 7) against what this explorer has indexed, with the voter tag worked
 * out from the transaction's creator.
 */
function indexBallot(
  db: ExplorerDb,
  where: Where,
  block: DecodedBlock,
  tx: DecodedTransaction,
  record: PrivateRecord,
  args: string[],
  writes: { type: string; attrs: string[]; value: string }[],
): void {
  const { channel, contract } = where;
  const w = writes.find((x) => x.type === "ballot");
  if (!w) return;
  const stored = parse(w.value) as { tracking?: unknown; ballot?: unknown } | null;
  const ballot = stored && typeof stored.ballot === "object" && stored.ballot ? (stored.ballot as Record<string, unknown>) : {};
  const tracking = typeof stored?.tracking === "string" ? stored.tracking : "";
  const written = writes.find((x) => x.type === "voted")?.attrs[1] ?? null;
  const own = tx.creator ? toHex(voterTagX509(channel, record.id, tx.creator.mspId, tx.creator.idBytes)) : null;
  const voterTag = written ?? own ?? "";
  const started = performance.now();
  let error: string | null = null;
  let ciphertexts: string[] = [];
  const e = electionOf(record, channel, contract);
  if (!e) error = "This explorer has no key for this election.";
  else if (!own) error = "The transaction has no creator, so this explorer can't work out its voter tag.";
  else if (written && written !== own) error = "The voter tag the contract wrote isn't the one the submitter's certificate gives.";
  else {
    try {
      const checked = checkBallot(e, fromHex(own, 32)!, args[1] ?? "", {
        hasCiphertext: (a) => db.privateCiphertextSeen(channel, record.id, a, tx.txId),
        hasVoted: (tag) => db.privateTagSeen(channel, record.id, tag, tx.txId),
      });
      ciphertexts = checked.ciphertexts;
      const same = (x: unknown) => JSON.stringify({ c: (x as Record<string, unknown>).ciphertexts, b: (x as Record<string, unknown>).bitProofs, s: (x as Record<string, unknown>).sumProof });
      if (checked.tracking !== tracking) error = "The tracking code the contract wrote isn't the one this ballot gives.";
      else if (same(checked.ballot) !== same(ballot)) error = "The ballot the contract stored isn't the one the transaction sent.";
    } catch (failure) {
      error = messageOf(failure);
    }
  }
  stats.ballots += 1;
  stats.ms += performance.now() - started;
  if (ciphertexts.length === 0) {
    ciphertexts = ((ballot.ciphertexts as { a?: unknown }[] | undefined) ?? []).map((c) => String(c?.a ?? ""));
  }
  const row: PrivateBallotRow = {
    channel,
    election: record.id,
    txId: tx.txId,
    block: block.number,
    index: tx.index,
    timestamp: tx.timestamp,
    tracking,
    voterTag,
    ballot,
    verified: error === null,
    error,
    creator: where.showSubmitter && tx.creator ? { mspId: tx.creator.mspId, idBytes: Buffer.from(tx.creator.idBytes).toString("base64") } : null,
  };
  db.addPrivateBallot(row, ciphertexts);
}

/**
 * An anonymous ballot (docs/adr/0008), checked as CastAnonymousBallot checks
 * it: the creator is a one-off identity of the voter organisation whose
 * proof checks out against the pinned issuer key, with the affiliation and
 * the role member; the voter tag is made from the ballot's pseudonym P;
 * the pseudonym proof ties the creator's Nym to P and to the ballot's
 * tracking code; then the ballot's own proofs, and that no ciphertext and no
 * pseudonym repeats.
 */
function indexAnonymousBallot(
  db: ExplorerDb,
  where: Where,
  block: DecodedBlock,
  tx: DecodedTransaction,
  record: PrivateRecord,
  args: string[],
  writes: { type: string; attrs: string[]; value: string }[],
): void {
  const { channel, contract } = where;
  const w = writes.find((x) => x.type === "ballot");
  if (!w) return;
  const stored = parse(w.value) as { tracking?: unknown; ballot?: unknown; pseudonym?: unknown } | null;
  const ballot = stored && typeof stored.ballot === "object" && stored.ballot ? (stored.ballot as Record<string, unknown>) : {};
  const tracking = typeof stored?.tracking === "string" ? stored.tracking : "";
  const written = writes.find((x) => x.type === "voted")?.attrs[1] ?? null;
  const proof = pseudonymOf(parse(args[2] ?? ""));
  const voters = anonymousVoters(record);
  const idemix = tx.creator?.idemix ?? null;
  const creator: AnonymousCreator | null =
    tx.creator && idemix ? { mspId: tx.creator.mspId, ou: idemix.ou, role: idemix.role, nym: idemix.nym, idBytes: Buffer.from(tx.creator.idBytes).toString("base64") } : null;
  const p = proof ? fromHex(proof.pseudonym, 64) : null;
  const own = p && voters ? toHex(voterTagIdemix(channel, record.id, voters.msp, p)) : null;
  const voterTag = written ?? own ?? "";
  const started = performance.now();
  let error: string | null = null;
  let ciphertexts: string[] = [];
  const e = electionOf(record, channel, contract);
  if (!e) error = "This explorer has no key for this election.";
  else if (!voters) error = "The contract accepted an anonymous ballot in an election whose voters aren't voter credentials.";
  else if (!creator) error = "The transaction's creator isn't an idemix identity, so it isn't a voter credential's.";
  else if (!proof || !own) error = "The ballot's pseudonym proof doesn't decode, so this explorer can't work out its voter tag.";
  else if (written && written !== own) error = "The voter tag the contract wrote isn't the one the ballot's pseudonym gives.";
  else {
    try {
      // The tracking code the pseudonym proof is bound to, from the ballot as
      // sent; checkBallot below finds it again with the ballot's proofs.
      const sent = goJsonParse(args[1] ?? "") as Ballot;
      const bound = trackingCode(e, fromHex(own, 32)!, sent);
      if (!where.idemix) error = "This explorer couldn't start the idemix module, so it can't check this ballot's creator or pseudonym.";
      else {
        const t = performance.now();
        error = checkAnonymousBallot(where.idemix, e, voters, { index: -1, txId: tx.txId, block: block.number, tracking: bound, voterTag: own, ballot: sent, pseudonym: proof, anonymousCreator: creator });
        stats.anonymous += 1;
        stats.anonymousMs += performance.now() - t;
      }
      if (!error) {
        const checked = checkBallot(e, fromHex(own, 32)!, args[1] ?? "", {
          hasCiphertext: (a) => db.privateCiphertextSeen(channel, record.id, a, tx.txId),
          hasVoted: (tag) => db.privateTagSeen(channel, record.id, tag, tx.txId),
        }, "idemix");
        ciphertexts = checked.ciphertexts;
        const same = (x: unknown) => JSON.stringify({ c: (x as Record<string, unknown>).ciphertexts, b: (x as Record<string, unknown>).bitProofs, s: (x as Record<string, unknown>).sumProof });
        if (checked.tracking !== tracking) error = "The tracking code the contract wrote isn't the one this ballot gives.";
        else if (same(checked.ballot) !== same(ballot)) error = "The ballot the contract stored isn't the one the transaction sent.";
        else if (JSON.stringify(pseudonymOf(stored?.pseudonym)) !== JSON.stringify(proof)) error = "The pseudonym proof the contract stored isn't the one the transaction sent.";
      }
    } catch (failure) {
      error = messageOf(failure);
    }
  }
  stats.ballots += 1;
  stats.ms += performance.now() - started;
  if (ciphertexts.length === 0) {
    ciphertexts = ((ballot.ciphertexts as { a?: unknown }[] | undefined) ?? []).map((c) => String(c?.a ?? ""));
  }
  db.addPrivateBallot(
    {
      channel,
      election: record.id,
      txId: tx.txId,
      block: block.number,
      index: tx.index,
      timestamp: tx.timestamp,
      tracking,
      voterTag,
      ballot,
      verified: error === null,
      error,
      creator: null,
      anonymous: creator && proof ? { creator, pseudonym: proof } : null,
    },
    ciphertexts,
  );
}

/** pseudonymJson's four fields, as strings, or null. */
function pseudonymOf(x: unknown): PseudonymProof | null {
  const o = x as Record<string, unknown> | null;
  if (!o || typeof o !== "object") return null;
  const { pseudonym, c, ssk, sr } = o;
  return typeof pseudonym === "string" && typeof c === "string" && typeof ssk === "string" && typeof sr === "string" ? { pseudonym, c, ssk, sr } : null;
}

/* Views, for the pages and the API ------------------------------------- */

export type Phase = "round1" | "round2" | "round3" | "opening" | "open" | "late" | "counting" | "counted" | "failed" | "cancelled";

export interface StepView {
  txId: string;
  block: number;
  timestamp: number | null;
  /** What the contract stored, as published. */
  body: unknown;
  /** This explorer's check of it as it indexed the block, or null when there is nothing to check. */
  verified: boolean | null;
  error: string | null;
}

export interface TrusteeView {
  /** The trustee's identifier, as the record writes it. */
  id: string;
  msp: string;
  round1: StepView | null;
  round2: StepView | null;
  confirmation: StepView | null;
  closeRequest: StepView | null;
  share: StepView | null;
}

export interface PrivateElectionView {
  channel: string;
  contract: string;
  id: string;
  title: string;
  options: string[];
  closesAt: string;
  creatorMsp: string;
  threshold: number;
  voters: PrivateRecord["voters"];
  /** The contract's state, and what the explorer shows. */
  state: PrivateRecord["state"];
  phase: Phase;
  trustees: TrusteeView[];
  publicKey: string | null;
  verifyingShares: string[] | null;
  context: string | null;
  /** The record's fingerprint, 20 lowercase hex characters, and whether it is the one worked out here from the record. */
  fingerprint: string | null;
  fingerprintMatches: boolean | null;
  created: StepView | null;
  opened: StepView | null;
  /** The transaction that closed voting, and whether that was before closesAt by its timestamp. */
  closed: (StepView & { early: boolean; closedBy: string[] }) | null;
  recordBallots: number | null;
  totals: { a: string; b: string }[] | null;
  /** The published counts, in option order. */
  tally: { counts: number[]; total: number } | null;
  published: StepView | null;
  failed: (StepView & { reportedBy: string; fromTrustee: string | null }) | null;
  cancelled: StepView | null;
  /** The ballots this explorer has indexed, and how many failed its check. */
  ballots: { total: number; failed: number };
  /** Whether this explorer publishes each ballot's submitter, so the browser works out each voter tag again itself. */
  submitters: "show" | "hide";
  /** An election with voter credentials (docs/adr/0008): its voters, and its pinned issuer key compared with the channel's configuration. */
  anonymous: AnonymousView | null;
}

export interface AnonymousView {
  /** The voter MSP ID, the affiliation and the role every ballot's credential must have. */
  msp: string;
  affiliation: string;
  role: string;
  /** SHA-256 of the pinned issuer key, as the record gives it, and whether it is SHA-256 of the key the record holds. */
  issuerKeyHash: string;
  hashMatchesKey: boolean;
  /** The voter MSP's issuer key hash in the channel's latest configuration, or null when that has no idemix organisation by this ID. */
  channelKeyHash: string | null;
  /** The block of that configuration, when known. */
  configBlock: number | null;
}

const view = (s: PrivateStepRow | undefined): StepView | null =>
  s ? { txId: s.txId, block: s.block, timestamp: s.timestamp, body: s.body, verified: s.verified, error: s.error } : null;

/** One election as the pages and the API show it. `now` decides whether an open election is past its planned closing time. */
export function electionView(db: ExplorerDb, policy: Policy, channel: string, id: string, now = Date.now()): PrivateElectionView | null {
  const contract = policy.channels[channel]?.privateElections;
  const row = contract ? db.privateElection(channel, id) : null;
  if (!contract || !row) return null;
  const r = row.record as unknown as PrivateRecord;
  const steps = db.privateSteps(channel, id);
  const of = (kind: PrivateStepRow["kind"], msp?: string) => steps.find((s) => s.kind === kind && (msp === undefined || s.trustee === msp));
  const trustees: TrusteeView[] = r.trustees.map((t) => ({
    id: t.id,
    msp: t.msp,
    round1: view(of("round1", t.msp)),
    round2: view(of("round2", t.msp)),
    confirmation: view(of("confirm", t.msp)),
    closeRequest: view(of("close", t.msp)),
    share: view(of("dshare", t.msp)),
  }));
  let phase: Phase;
  switch (r.state) {
    case "keygen":
      phase = trustees.some((t) => !t.round1) ? "round1" : trustees.some((t) => !t.round2) ? "round2" : trustees.some((t) => !t.confirmation) ? "round3" : "opening";
      break;
    case "open":
      phase = now >= Date.parse(r.closesAt) ? "late" : "open";
      break;
    case "decrypting":
      phase = "counting";
      break;
    default:
      phase = r.state;
  }
  const closedStep = of("closed");
  const closed = closedStep
    ? {
        ...view(closedStep)!,
        early: closedStep.timestamp !== null && closedStep.timestamp < Date.parse(r.closesAt),
        closedBy: r.closedBy ?? ((closedStep.body as { closedBy?: string[] } | null)?.closedBy ?? []),
      }
    : null;
  const report = of("report");
  let fingerprintMatches: boolean | null = null;
  if (r.fingerprint && r.publicKey && r.verifyingShares) {
    try {
      fingerprintMatches = electionFingerprint({ ...setupOf(r, channel, contract), publicKey: r.publicKey, verifyingShares: r.verifyingShares }) === r.fingerprint;
    } catch {
      fingerprintMatches = false;
    }
  }
  return {
    channel,
    contract,
    id: r.id,
    title: r.title,
    options: r.options,
    closesAt: r.closesAt,
    creatorMsp: r.creatorMsp,
    threshold: r.threshold,
    voters: r.voters,
    state: r.state,
    phase,
    trustees,
    publicKey: r.publicKey ?? null,
    verifyingShares: r.verifyingShares ?? null,
    context: r.context ?? null,
    fingerprint: r.fingerprint ?? null,
    fingerprintMatches,
    created: view(of("create")),
    opened: view(of("open")),
    closed,
    recordBallots: r.ballots ?? null,
    totals: r.totals ?? null,
    tally: r.tally ? { counts: r.options.map((o) => r.tally!.counts[o] ?? 0), total: r.tally.total } : null,
    published: view(of("publish")),
    failed: r.state === "failed" ? { ...(view(report) ?? { txId: "", block: row.lastBlock, timestamp: null, body: null, verified: null, error: null }), reportedBy: r.reportedBy ?? report?.trustee ?? "", fromTrustee: (report?.body as { fromTrustee?: string | null } | null)?.fromTrustee ?? null } : null,
    cancelled: r.state === "cancelled" ? view(of("cancel")) : null,
    ballots: db.privateBallotCount(channel, id),
    submitters: policy.channels[channel]?.submitter ?? "hide",
    anonymous: anonymousView(db, channel, r),
  };
}

function anonymousView(db: ExplorerDb, channel: string, r: PrivateRecord): AnonymousView | null {
  const v = r.voters;
  if (v.kind !== "idemix" || !v.msp) return null;
  let hashMatchesKey = false;
  try {
    hashMatchesKey = createHash("sha256").update(Buffer.from(v.issuerPublicKey ?? "", "base64")).digest("hex") === v.issuerKeyHash;
  } catch {
    /* not base64: no match */
  }
  const config = db.configSummary(channel);
  const org = config?.organisations.find((o) => o.mspId === v.msp && o.kind === "idemix");
  return {
    msp: v.msp,
    affiliation: v.affiliation ?? "",
    role: v.role ?? "member",
    issuerKeyHash: v.issuerKeyHash ?? "",
    hashMatchesKey,
    channelKeyHash: org?.issuerKeyHash ?? null,
    configBlock: config?.block ?? null,
  };
}

export interface PrivateElectionSummary {
  id: string;
  title: string;
  closesAt: string;
  state: PrivateRecord["state"];
  phase: Phase;
  ballots: number;
  fingerprint: string | null;
  /** Whether its voters vote anonymously, with voter credentials. */
  anonymous: boolean;
}

/** A channel's private elections, newest first. */
export function electionList(db: ExplorerDb, policy: Policy, channel: string, now = Date.now()): PrivateElectionSummary[] {
  if (!policy.channels[channel]?.privateElections) return [];
  return db
    .privateElections(channel)
    .reverse()
    .flatMap((row) => {
      const v = electionView(db, policy, channel, row.id, now);
      return v ? [{ id: v.id, title: v.title, closesAt: v.closesAt, state: v.state, phase: v.phase, ballots: v.ballots.total, fingerprint: v.fingerprint, anonymous: v.anonymous !== null }] : [];
    });
}

/**
 * A ballot as the API publishes it: everything the browser's full check
 * needs, the submitter only when the policy shows it, and an anonymous
 * ballot's pseudonym proof and creator always (D12).
 */
export function publishedBallot(b: PrivateBallotRow, index: number) {
  return {
    index,
    txId: b.txId,
    block: b.block,
    position: b.index,
    timestamp: b.timestamp,
    tracking: b.tracking,
    voterTag: b.voterTag,
    verified: b.verified,
    error: b.error,
    ballot: b.ballot,
    ...(b.creator ? { creator: b.creator } : {}),
    ...(b.anonymous ? { pseudonym: b.anonymous.pseudonym, anonymousCreator: b.anonymous.creator } : {}),
  };
}

/** The context the record holds, worked out again; exported for the tests. */
export function contextOf(r: PrivateRecord, channel: string, contract: string): string | null {
  if (!r.publicKey || !r.verifyingShares) return null;
  return toHex(electionContext({ ...setupOf(r, channel, contract), publicKey: r.publicKey, verifyingShares: r.verifyingShares }));
}
