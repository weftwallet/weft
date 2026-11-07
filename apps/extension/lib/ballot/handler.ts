/**
 * Experimental (docs/adr/0007): weft_castBallot in the background worker.
 *
 * The params are checked before any window opens. Everything else happens
 * with the window open, because reading the election is a signed request and
 * Weft may be locked: the window unlocks, then asks for the read
 * (ballotRead), shows the election, and sends the voter's choice with its
 * decision. A failure that settles the request (4300, 4301, 4400) answers
 * the site at once, and the window explains it until it is closed. A relay
 * that doesn't answer, or a channel an older invite doesn't list, keeps the
 * request waiting, for Try again or Refresh from invite.
 *
 * Reached only from code behind EXPERIMENTAL, so the normal build has none of
 * it, nor @weftwallet/tally.
 */

import { RelayClient, certificateHealth, summarizeIdentity, utf8 } from "@weftwallet/core";
import {
  ErrorCode,
  RECEIPT_TYPE,
  WeftError,
  type BallotReceiptResultV2,
  type BallotReceiptV2,
  type CastBallotParams,
  type CastBallotResult,
} from "@weftwallet/protocol";
import { encryptBallot, voterTagX509, type Election } from "@weftwallet/tally/client";
import { db, newId, type ActivityRecord, type IdentityRecord, type NetworkRecord, type ReceiptRecordV2 } from "../db";
import type { ApprovalOutcome, ApprovalView, BallotElectionView, BallotReadView, ReceiptOutcome } from "../messages";
import { notifyNetworkChanged } from "../sites";
import * as vault from "../vault";
import { activeIdentity, identityView, refreshInvite, signerFor, updateNetwork } from "../wallet";
import { castBallotCall, readElection, returnedTracking, type BallotRelay } from "./cast";
import { castFailure, identityFailures, readFailure, stateFailure, type CastStage, type FailureContext, type ReadFailure } from "./failures";
import { checkCastBallotParams } from "./params";
import type { ElectionRecord } from "./read";

/** What the window decided. Only the window sets keepReceipt and choice. */
export interface BallotDecision {
  approved: boolean;
  keepReceipt: boolean;
  choice?: number;
}

/** The approval machinery of lib/provider.ts, passed in so this module doesn't import it. */
export interface ApprovalHost<A extends { view: ApprovalView; decision: { promise: Promise<BallotDecision> } }> {
  open(view: ApprovalView): Promise<A>;
  finish(approval: A, outcome: ApprovalOutcome): void;
  saveActivity(record: ActivityRecord, quiet?: boolean): Promise<void>;
  announceActivity(): void;
}

interface Session {
  origin: string;
  params: CastBallotParams;
  /** Settles with the site's error when a failure settles the request before the vote. */
  early: { promise: Promise<WeftError>; resolve: (e: WeftError) => void };
  /** The last read's failure, shown again if the window asks again after the site has its answer. */
  settled: ReadFailure | null;
  /** What Reject or closing the window fails with while the request waits: 5002 or 4300. */
  pending: WeftError | null;
  /** The last successful read. */
  read: {
    identityId: string;
    networkId: string;
    record: ElectionRecord;
    election: Election;
    idBytes: Uint8Array;
    view: BallotElectionView;
  } | null;
  /** A read is running: a second press of Try again waits for it. */
  reading: Promise<BallotReadView> | null;
}

const sessions = new Map<string, Session>();

/** For tests: replaces the relay the flows use. */
let relayFor: (url: string) => BallotRelay = (url) => new RelayClient(url);
export function setRelayForTests(make: (url: string) => BallotRelay): void {
  relayFor = make;
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** weft_castBallot, from the site's request to its answer. */
export async function castBallot<A extends { view: ApprovalView; decision: { promise: Promise<BallotDecision> } }>(
  origin: string,
  rawParams: unknown,
  host: ApprovalHost<A>,
): Promise<CastBallotResult> {
  const params = checkCastBallotParams(rawParams);
  const active = await activeIdentity();
  const view: ApprovalView = {
    id: newId(),
    origin,
    method: "weft_castBallot",
    call: null,
    identity: active ? await identityView(active.record.id) : null,
    ballot: params,
  };
  const approval = await host.open(view);
  let resolveEarly!: (e: WeftError) => void;
  const session: Session = {
    origin,
    params,
    early: { promise: new Promise<WeftError>((r) => (resolveEarly = r)), resolve: (e) => resolveEarly(e) },
    settled: null,
    pending: null,
    read: null,
    reading: null,
  };
  sessions.set(view.id, session);

  const first = await Promise.race([approval.decision.promise, session.early.promise]);
  if (first instanceof WeftError) {
    // The site has its answer now. The window says what happened until the voter closes it.
    void approval.decision.promise.then(() => {
      host.finish(approval, { status: "rejected" });
      sessions.delete(view.id);
    });
    throw first;
  }
  const decision = first;
  const read = session.read;
  if (!decision.approved || !read || decision.choice === undefined) {
    host.finish(approval, { status: "rejected" });
    sessions.delete(view.id);
    throw session.pending ?? new WeftError(ErrorCode.UserRejected, "The user rejected the request.");
  }
  sessions.delete(view.id);
  return cast(approval, session, read, decision, host);
}

function failureContext(session: Session, relayUrl: string, title?: string): FailureContext {
  return { params: session.params, siteHost: hostOf(session.origin), relayHost: hostOf(relayUrl), ...(title ? { title } : {}) };
}

/** Settles a failure: the site gets a final error at once; a waiting one is kept for Reject. */
function fail(session: Session, failure: ReadFailure): BallotReadView {
  if (failure.view.kind === "final") {
    session.settled = failure;
    session.pending = null;
    if (failure.error) session.early.resolve(failure.error);
  } else {
    session.pending = failure.error;
  }
  return { status: "failed", failure: failure.view };
}

/** The window asks for the election once it is unlocked, and again for Try again. */
export async function ballotRead(id: string): Promise<BallotReadView> {
  const session = sessions.get(id);
  if (!session) throw new Error("This request has ended.");
  if (session.settled) return { status: "failed", failure: session.settled.view };
  session.reading ??= readFor(session).finally(() => (session.reading = null));
  return session.reading;
}

async function readFor(session: Session): Promise<BallotReadView> {
  const { params } = session;
  const active = await activeIdentity();
  if (!active) return fail(session, identityFailures.none({ params, siteHost: hostOf(session.origin), relayHost: "" }));
  const ctx = failureContext(session, active.network.relayUrl);
  const summary = await summarizeIdentity(active.record);
  if (certificateHealth(summary).state === "expired") return fail(session, identityFailures.expired(ctx, summary.name, summary.notAfter));
  if (!active.network.channels.includes(params.channel)) {
    return fail(
      session,
      active.network.inviteUrl ? identityFailures.channelPending(ctx, active.network.name, active.network.inviteUrl) : identityFailures.channel(ctx, active.network.name, false),
    );
  }
  const signer = { mspId: active.record.mspId, certificate: active.record.certificate };
  let read;
  try {
    const sign = await signerFor(active.record);
    read = await readElection(relayFor(active.network.relayUrl), signer, params, sign, active.record.caChain ?? null);
  } catch (error) {
    return fail(session, readFailure(error, ctx));
  }
  const record = read.record;
  const titled = { ...ctx, title: record.title };
  if (record.state !== "open" || !read.open) return fail(session, stateFailure(record, titled));
  if (record.voters.kind !== "x509") return fail(session, identityFailures.credentials(titled, record.voters.msp));
  if (!record.voters.msps.includes(active.record.mspId)) {
    return fail(session, identityFailures.notVoter(titled, record.voters.msps, summary.name, active.record.mspId));
  }
  const view: BallotElectionView = {
    title: record.title,
    electionId: record.id,
    channel: params.channel,
    chaincode: params.chaincode,
    options: record.options,
    closesAt: record.closesAt,
    pastClosing: Date.parse(record.closesAt) <= Date.now(),
    trustees: record.trustees.map((t) => t.msp),
    threshold: record.threshold,
    fingerprint: read.open.fingerprint,
    voter: { name: summary.name, mspId: active.record.mspId },
    relayHost: hostOf(active.network.relayUrl),
    peerChecked: read.peerChecked,
    alreadyVoted: await earlierBallot(active.record.id, params),
  };
  session.pending = null;
  session.read = { identityId: active.record.id, networkId: active.network.id, record, election: read.open.election, idBytes: read.idBytes, view };
  return { status: "ready", election: view };
}

/** This identity's committed ballot in this election, from Weft's own activity. The contract still decides. */
async function earlierBallot(identityId: string, params: CastBallotParams): Promise<BallotElectionView["alreadyVoted"]> {
  const all = await db.all<ActivityRecord>("activity");
  const found = all.find(
    (a) =>
      a.identityId === identityId &&
      a.status === "committed" &&
      a.call.fn === "CastBallot" &&
      a.call.channel === params.channel &&
      a.call.chaincode === params.chaincode &&
      a.call.args?.[0] === params.electionId,
  );
  return found ? { blockNumber: found.blockNumber ?? null } : null;
}

/**
 * Refresh from invite, for a channel the network's invite didn't list: the
 * window has already asked for access to the invite's host. Adds the
 * invite's channels to the network, then reads again.
 */
export async function ballotRefreshInvite(id: string): Promise<BallotReadView> {
  const session = sessions.get(id);
  if (!session) throw new Error("This request has ended.");
  if (session.settled) return { status: "failed", failure: session.settled.view };
  const active = await activeIdentity();
  if (!active) return ballotRead(id);
  const invite = await refreshInvite(active.network.id);
  if (!invite.channels.includes(session.params.channel)) {
    return fail(session, identityFailures.channel(failureContext(session, active.network.relayUrl), active.network.name, true));
  }
  await updateNetwork(active.network.id, { channels: [...new Set([...active.network.channels, ...invite.channels])] });
  await notifyNetworkChanged();
  return ballotRead(id);
}

/** After Sign and vote: encrypt and prove, check, sign, submit, wait for the commit, and keep the receipt if asked. */
async function cast<A extends { view: ApprovalView; decision: { promise: Promise<BallotDecision> } }>(
  approval: A,
  session: Session,
  read: NonNullable<Session["read"]>,
  decision: BallotDecision,
  host: ApprovalHost<A>,
): Promise<CastBallotResult> {
  const { params } = session;
  const choice = decision.choice!;
  const options = read.record.options;
  const identity = await db.get<IdentityRecord>("identities", read.identityId);
  const network = await db.get<NetworkRecord>("networks", read.networkId);
  const base: Omit<ActivityRecord, "status"> = {
    id: newId(),
    at: Date.now(),
    origin: session.origin,
    identityId: read.identityId,
    kind: "submit",
    call: { channel: params.channel, chaincode: params.chaincode, fn: "CastBallot", args: [params.electionId] },
  };
  const ctx = { ...failureContext(session, network?.relayUrl ?? ""), title: read.record.title, voterName: read.view.voter.name, tracking: null as string | null };
  let stage: CastStage = null;
  try {
    if (!Number.isInteger(choice) || choice < 0 || choice >= options.length) throw new Error(`Option ${choice} isn't one of the election's options.`);
    if (!identity || !network) throw new Error("The identity that read the election is no longer in Weft.");
    // The note is sealed now, while the vault key is in hand, so Weft
    // locking during the commit loses nothing: writing needs no key.
    const sealed = decision.keepReceipt ? await vault.sealReceipt(base.id, utf8(JSON.stringify({ option: options[choice] }))) : null;
    const sign = await signerFor(identity);
    const signer = { mspId: identity.mspId, certificate: identity.certificate };
    // The voter tag is made from the creator's id_bytes exactly as the relay
    // builds them, which castBallotCall checks again before signing.
    const tag = voterTagX509(params.channel, params.electionId, identity.mspId, read.idBytes);
    // The encryption randomness never leaves encryptBallot.
    const ballot = encryptBallot(read.election, tag, choice);
    ctx.tracking = ballot.tracking;
    base.call = { ...base.call, args: [params.electionId, ballot.json] };
    const result = await castBallotCall(relayFor(network.relayUrl), signer, base.call, sign, read.idBytes, { onStage: (s) => void (stage = s) });

    const committed: ActivityRecord = { ...base, status: "committed", transactionId: result.transactionId, blockNumber: result.blockNumber, code: result.status };
    const receipt: BallotReceiptV2 = {
      type: RECEIPT_TYPE,
      version: 2,
      channel: params.channel,
      electionId: params.electionId,
      txId: result.transactionId,
      blockNumber: Number(result.blockNumber),
      tracking: ballot.tracking,
    };
    const returned = returnedTracking(result.text);
    const kept = await keepReceipt(committed, receipt, returned, sealed, host);
    if (!kept.result.kept) await host.saveActivity(committed, kept.outcome.kept === false && kept.outcome.reason === "storage");
    host.finish(approval, {
      status: "approved",
      activityId: base.id,
      blockNumber: result.blockNumber,
      transactionId: result.transactionId,
      ...(network.explorerUrl ? { explorerUrl: network.explorerUrl } : {}),
      receipt: kept.outcome,
      tracking: ballot.tracking,
    });
    return { transactionId: result.transactionId, blockNumber: result.blockNumber, status: "VALID", receipt: kept.result };
  } catch (error) {
    const failure = castFailure(error, stage, ctx);
    const o = failure.outcome;
    await host
      .saveActivity({ ...base, status: "failed", code: o.code ?? "INTERNAL", title: o.title, detail: [o.detail, o.next].filter(Boolean).join(" "), ...(o.raw ? { raw: o.raw } : {}) })
      .catch(() => {});
    host.finish(approval, { ...o, activityId: base.id });
    throw failure.error;
  }
}

/**
 * Keeps the receipt with its activity record when the voter asked and the
 * contract's tracking code is the one Weft computed; both are written, or
 * neither. The site gets the receipt whatever happens.
 */
async function keepReceipt<A extends { view: ApprovalView; decision: { promise: Promise<BallotDecision> } }>(
  committed: ActivityRecord,
  receipt: BallotReceiptV2,
  returned: string | null,
  sealed: Awaited<ReturnType<typeof vault.sealReceipt>> | null,
  host: ApprovalHost<A>,
): Promise<{ result: BallotReceiptResultV2; outcome: ReceiptOutcome }> {
  if (!sealed) return { result: { kept: false, reason: "declined", receipt }, outcome: { kept: false, reason: "declined" } };
  if (returned !== receipt.tracking) {
    return { result: { kept: false, reason: "mismatch", receipt }, outcome: { kept: false, reason: "mismatch", expected: receipt.tracking, returned } };
  }
  const record: ReceiptRecordV2 = {
    id: committed.id,
    identityId: committed.identityId,
    origin: committed.origin,
    type: RECEIPT_TYPE,
    version: 2,
    channel: receipt.channel,
    electionId: receipt.electionId,
    txId: receipt.txId,
    blockNumber: receipt.blockNumber,
    tracking: receipt.tracking,
    sealed,
    keptAt: Date.now(),
  };
  try {
    await db.putWithReceipt({ ...committed, receipt: true }, record);
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return { result: { kept: false, reason: "storage", receipt }, outcome: { kept: false, reason: "storage", receipt, error: message } };
  }
  host.announceActivity();
  const locked = await vault.status().then((v) => v.state !== "unlocked", () => false);
  return { result: { kept: true, receipt }, outcome: { kept: true, locked } };
}
