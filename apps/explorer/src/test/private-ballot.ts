/**
 * Private elections for tests (docs/adr/0007): the transactions the
 * private-ballot contract would write, built with @weftwallet/tally, so the
 * indexer and pages can be tested without a network. Each step writes the
 * keys contract-api.md lists, with the values as the Go contract marshals
 * them (fields in the documented order). The end-to-end tests run the real
 * contract.
 */

import { createHash } from "node:crypto";
import type { common } from "@hyperledger/fabric-protos";
import { electionContext, electionFingerprint, toHex, trackingCode, utf8, voterTagX509, type Ballot, type Election, type ElectionSetup } from "@weftwallet/tally";
import { encryptBallot } from "@weftwallet/tally/client";
import { ceremonyRound1, ceremonyRound2, ceremonyRound3, decryptionShare, type KeyShare } from "@weftwallet/tally/trustee";
import { addTotals, recoverTally } from "@weftwallet/tally/verify";
import { chain, type TxSpec } from "./blocks.ts";

export const key = (...parts: string[]) => `\u0000${parts.join("\u0000")}\u0000`;
const txid = (label: string) => createHash("sha256").update(label).digest("hex");
const scalarHex = (i: number) => {
  const b = new Uint8Array(32);
  b[0] = i;
  return toHex(b);
};

/** A trustee's identity: a certificate with weft.trustee=true would be the real one; this is its stand-in. */
export const trusteeCert = (msp: string) => `-----BEGIN CERTIFICATE-----\ntrustee of ${msp}\n-----END CERTIFICATE-----\n`;
/** A voter's id_bytes, a stand-in for the PEM certificate Fabric carries. */
export const voterCert = (n: number) => `-----BEGIN CERTIFICATE-----\nvoter ${n}\n-----END CERTIFICATE-----\n`;

export interface Options {
  channel?: string;
  contract?: string;
  id?: string;
  title?: string;
  options?: string[];
  trustees?: string[];
  closesAt?: string;
  /** Each voter's choice, by option index. */
  choices?: number[];
  /** How far the election gets. */
  until?: "round1" | "round2" | "round3" | "opening" | "open" | "closeRequested" | "counting" | "counted" | "failed" | "cancelled";
  /** A ballot, by its place in `choices`, whose bit proof for this option is changed before the (faulty) contract stores it. */
  tamper?: { ballot: number; option: number };
  /** Ballots per block. */
  perBlock?: number;
}

export interface Fixture {
  channel: string;
  contract: string;
  id: string;
  election: Election | null;
  blocks: common.Block[];
  /** Each ballot's transaction ID and tracking code, in ledger order. */
  ballots: { txId: string; tracking: string; voterTag: string; choice: number }[];
  counts: number[] | null;
}

/** Builds an election's blocks, from CreateElection to as far as `until`. */
export async function privateElection(o: Options = {}): Promise<Fixture> {
  const channel = o.channel ?? "privatevote-budget-2027";
  const contract = o.contract ?? "private-ballot";
  const id = o.id ?? "budget-2027";
  const options = o.options ?? ["Plan A", "Plan B", "Plan C"];
  const msps = o.trustees ?? ["Org1MSP", "Org2MSP"];
  const until = o.until ?? "counted";
  const choices = o.choices ?? [0, 1, 1, 2, 1];
  const setup: ElectionSetup = { channel, chaincode: contract, electionId: id, options, threshold: msps.length, trustees: msps };
  const record: Record<string, unknown> = {
    v: 1,
    id,
    title: o.title ?? "Budget 2027",
    options,
    closesAt: o.closesAt ?? "2027-01-31T17:00:00.000Z",
    creatorMsp: msps[0],
    trustees: msps.map((msp, i) => ({ id: scalarHex(i + 1), msp })),
    threshold: msps.length,
    voters: { kind: "x509", msps },
    state: "keygen",
  };
  const blocks: { txs: TxSpec[] }[] = [{ txs: [{ txId: "c0", chaincode: "", args: [], config: true }] }];
  let n = 0;
  const tx = (fn: string, args: string[], writes: { key: string; value: string }[], creator: string, cert: string, event?: string): TxSpec => ({
    txId: txid(`${id} ${fn} ${n++}`),
    chaincode: contract,
    args: [fn, ...args],
    writes,
    creator,
    creatorCert: cert,
    endorsers: msps,
    ...(event ? { event, eventPayload: JSON.stringify({ electionId: id }) } : {}),
  });
  const one = (t: TxSpec) => blocks.push({ txs: [t] });
  const recordWrite = () => ({ key: key("election", id), value: JSON.stringify(record) });
  const asTrustee = (i: number) => [msps[i]!, trusteeCert(msps[i]!)] as const;
  const done = (): Fixture => ({ channel, contract, id, election: null, blocks: chain(channel, blocks), ballots: [], counts: null });

  one(tx("CreateElection", [JSON.stringify({ id, title: record.title, options, closesAt: record.closesAt, trustees: msps, threshold: msps.length, voters: record.voters })], [recordWrite()], ...asTrustee(0), "ElectionCreated"));

  const r1 = msps.map((_, i) => ceremonyRound1(setup, i));
  const posts1 = r1.map((r) => r.post);
  const last1 = until === "round1" ? 1 : msps.length;
  for (let i = 0; i < last1; i++) one(tx("PostCommitments", [id, JSON.stringify(posts1[i])], [{ key: key("ceremony1", id, msps[i]!), value: JSON.stringify(posts1[i]) }], ...asTrustee(i), "CeremonyStep"));
  if (until === "round1") return done();
  if (until === "cancelled") {
    record.state = "cancelled";
    one(tx("CancelElection", [id], [recordWrite()], ...asTrustee(0), "ElectionCancelled"));
    return done();
  }

  const posts2 = await Promise.all(r1.map((r) => ceremonyRound2(setup, r.secret, posts1)));
  const last2 = until === "round2" ? 1 : msps.length;
  for (let i = 0; i < last2; i++) one(tx("PostShares", [id, JSON.stringify(posts2[i])], [{ key: key("ceremony2", id, msps[i]!), value: JSON.stringify(posts2[i]) }], ...asTrustee(i), "CeremonyStep"));
  if (until === "round2") return done();
  if (until === "failed") {
    record.state = "failed";
    record.reportedBy = msps[1];
    one({ ...tx("ReportBadShare", [id, scalarHex(1)], [recordWrite()], ...asTrustee(1), "ElectionFailed"), eventPayload: JSON.stringify({ electionId: id, reportedBy: msps[1], fromTrustee: msps[0] }) });
    return done();
  }

  const r3 = await Promise.all(r1.map((r) => ceremonyRound3(setup, r.secret, posts1, posts2)));
  const last3 = until === "round3" ? 1 : msps.length;
  for (let i = 0; i < last3; i++) one(tx("ConfirmShares", [id, JSON.stringify(r3[i]!.confirmation)], [{ key: key("confirm", id, msps[i]!), value: JSON.stringify(r3[i]!.confirmation) }], ...asTrustee(i), "CeremonyStep"));
  if (until === "round3" || until === "opening") return done();

  const election: Election = { ...setup, ...r3[0]!.keys };
  Object.assign(record, { state: "open", publicKey: election.publicKey, verifyingShares: election.verifyingShares, context: toHex(electionContext(election)), fingerprint: electionFingerprint(election) });
  one(tx("OpenElection", [id], [recordWrite()], "Org1MSP", voterCert(0), "ElectionOpened"));

  const ballots: Fixture["ballots"] = [];
  const cts: Ballot["ciphertexts"][] = [];
  const per = o.perBlock ?? 3;
  let pending: TxSpec[] = [];
  for (const [v, choice] of choices.entries()) {
    const msp = msps[v % msps.length]!;
    const cert = voterCert(v + 1);
    const tag = voterTagX509(channel, id, msp, utf8(cert));
    const made = encryptBallot(election, tag, choice);
    const ballot = JSON.parse(made.json) as Ballot;
    let tracking = made.tracking;
    if (o.tamper?.ballot === v) {
      // A changed proof value: the faulty contract that stored it worked out its tracking code anyway.
      const p = ballot.bitProofs[o.tamper.option]!;
      p.z0 = p.z0 === p.z1 ? scalarHex(7) : p.z1;
      tracking = trackingCode(election, tag, ballot);
    }
    const t = tx("CastBallot", [id, JSON.stringify(ballot)], [], msp, cert, "BallotCast");
    t.writes = [
      { key: key("ballot", id, t.txId), value: JSON.stringify({ tracking, ballot }) },
      ...ballot.ciphertexts.map((c) => ({ key: key("ciphertext", id, c.a), value: t.txId })),
      { key: key("tracking", id, tracking), value: t.txId },
      { key: key("voted", id, toHex(tag)), value: t.txId },
    ];
    pending.push(t);
    if (pending.length === per) (blocks.push({ txs: pending }), (pending = []));
    ballots.push({ txId: t.txId, tracking, voterTag: toHex(tag), choice });
    cts.push(ballot.ciphertexts);
  }
  if (pending.length) blocks.push({ txs: pending });
  const result = (counts: number[] | null): Fixture => ({ channel, contract, id, election, blocks: chain(channel, blocks), ballots, counts });
  if (until === "open") return result(null);

  one(tx("CloseElection", [id], [{ key: key("close", id, msps[0]!), value: "close" }], ...asTrustee(0), "CloseRequested"));
  if (until === "closeRequested") return result(null);
  const { totals, ballots: N } = addTotals(options.length, cts);
  Object.assign(record, { state: "decrypting", ballots: N, totals, closedBy: msps });
  for (let i = 1; i < msps.length; i++) {
    one(tx("CloseElection", [id], [{ key: key("close", id, msps[i]!), value: "close" }, ...(i === msps.length - 1 ? [recordWrite()] : [])], ...asTrustee(i), i === msps.length - 1 ? "ElectionClosed" : "CloseRequested"));
  }
  const shares = r3.map((r) => decryptionShare(election, r.keyShare as KeyShare, totals));
  const lastShare = until === "counting" ? 1 : msps.length;
  for (let i = 0; i < lastShare; i++) one(tx("PostDecryptionShare", [id, JSON.stringify(shares[i])], [{ key: key("dshare", id, msps[i]!), value: JSON.stringify(shares[i]) }], ...asTrustee(i), "DecryptionSharePosted"));
  if (until === "counting") return result(null);

  const tally = recoverTally(election, totals, N, shares.map((share, index) => ({ index, share })));
  record.state = "counted";
  record.tally = { counts: Object.fromEntries(options.map((opt, j) => [opt, tally.counts[j]])), total: tally.total };
  one(tx("PublishTally", [id], [recordWrite()], "Org1MSP", voterCert(0), "TallyPublished"));
  return result(tally.counts);
}
