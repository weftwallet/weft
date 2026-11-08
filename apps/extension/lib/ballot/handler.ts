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
 * For an election with voter credentials (docs/adr/0008), Weft picks the
 * credential it holds for the election's channel, contract and ID, and the
 * approval window opens it in its own idemix worker and connects a port
 * (attachVoterPort). The read and the vote are signed through that port by
 * one-off identities of the credential, and go through the relay the voter
 * invite names; the read is checked against the invite's CA chains for the
 * trustee organisations, every endorsement (D9). The ballot's voter tag is
 * made from the credential's per-election pseudonym, and the pseudonym proof
 * is bound to the ballot's tracking code. Its activity and receipt are
 * sealed (lib/voter/activity.ts).
 *
 * Reached only from code behind EXPERIMENTAL, so the normal build has none of
 * it, nor @weftwallet/tally.
 */

import { RelayClient, certificateHealth, fromBase64, summarizeIdentity, utf8 } from "@weftwallet/core";
import {
  ErrorCode,
  RECEIPT_TYPE,
  WeftError,
  type BallotReceiptResultV2,
  type BallotReceiptV2,
  type CastBallotParams,
  type CastBallotResult,
} from "@weftwallet/protocol";
import { TallyError, encryptBallot, enrolmentId, fromHex, toHex, voterTagIdemix, voterTagX509, type Election } from "@weftwallet/tally/client";
import { db, newId, type ActivityRecord, type IdentityRecord, type NetworkRecord, type ReceiptRecordV2 } from "../db";
import type { ApprovalOutcome, ApprovalView, BallotElectionView, BallotReadView, ReceiptOutcome } from "../messages";
import { notifyNetworkChanged } from "../sites";
import * as vault from "../vault";
import { activeIdentity, identityView, refreshInvite, signerFor, updateNetwork } from "../wallet";
import { castBallotCall, readElection, returnedTracking, type BallotRelay } from "./cast";
import { anonymousEntries, saveAnonymous, votedWith } from "../voter/activity";
import { ModuleCallError, portSigner, type AnonymousSigner, type PortLike } from "../voter/remote";
import { voterKey } from "../voter/seal";
import { credentialFor, rememberTitle, voterCredentials } from "../voter/store";
import type { VoterCredentialRecord } from "../voter/types";
import { castFailure, identityFailures, moduleFailure, readFailure, stateFailure, type CastStage, type FailureContext, type ReadFailure } from "./failures";
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
    /** For an X.509 voter: the enrolment ID the voter tag is made from. */
    enrolmentId: string;
    view: BallotElectionView;
    /** For an election with voter credentials: the credential that read it, and votes. */
    credential?: VoterCredentialRecord;
  } | null;
  /** A read is running: a second press of Try again waits for it. */
  reading: Promise<BallotReadView> | null;
  /**
   * Weft Experimental (docs/adr/0008): the voter credential for this
   * election, and the window's idemix worker once its port has connected.
   */
  voter: {
    credential: VoterCredentialRecord;
    signer: (AnonymousSigner & { gone: boolean }) | null;
    waiting: ((signer: AnonymousSigner & { gone: boolean }) => void)[];
  } | null;
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
  // A voter credential for this election votes, and no identity is named (docs/adr/0008).
  const credential = await credentialFor(params);
  const active = credential ? null : await activeIdentity();
  const view: ApprovalView = {
    id: newId(),
    origin,
    method: "weft_castBallot",
    call: null,
    identity: active ? await identityView(active.record.id) : null,
    ballot: params,
    ...(credential ? { ballotCredential: credential.id } : {}),
  };
  let resolveEarly!: (e: WeftError) => void;
  const session: Session = {
    origin,
    params,
    early: { promise: new Promise<WeftError>((r) => (resolveEarly = r)), resolve: (e) => resolveEarly(e) },
    settled: null,
    pending: null,
    read: null,
    reading: null,
    voter: credential ? { credential, signer: null, waiting: [] } : null,
  };
  sessions.set(view.id, session);
  let approval: A;
  try {
    approval = await host.open(view);
  } catch (error) {
    sessions.delete(view.id);
    throw error;
  }

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

/**
 * Weft Experimental (docs/adr/0008): the approval window's idemix worker has
 * connected. False when no request with a voter credential has that ID.
 */
export function attachVoterPort(id: string, port: PortLike): boolean {
  const voter = sessions.get(id)?.voter;
  if (!voter || (voter.signer && !voter.signer.gone)) return false;
  const signer = portSigner(port);
  voter.signer = signer;
  for (const w of voter.waiting.splice(0)) w(signer);
  return true;
}

/** The window's voting module didn't start: the request fails with -32603, and the window says so. */
export async function ballotModuleFailed(id: string, error: string): Promise<BallotReadView> {
  const session = sessions.get(id);
  if (!session) throw new Error("This request has ended.");
  if (session.settled) return { status: "failed", failure: session.settled.view };
  return fail(session, moduleFailure(failureContext(session, session.voter?.credential.invite.relayUrl ?? ""), error));
}

/** How long the worker waits for the window's voting module to connect. */
const SIGNER_WAIT_MS = 30_000;

function signerOf(session: Session): Promise<AnonymousSigner & { gone: boolean }> {
  const voter = session.voter!;
  if (voter.signer && !voter.signer.gone) return Promise.resolve(voter.signer);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new ModuleCallError(`The approval window's voting module didn't connect within ${SIGNER_WAIT_MS / 1000} seconds.`)), SIGNER_WAIT_MS);
    voter.waiting.push((signer) => {
      clearTimeout(timer);
      resolve(signer);
    });
  });
}

async function readFor(session: Session): Promise<BallotReadView> {
  const { params } = session;
  if (session.voter) return readAnonymous(session, session.voter.credential);
  const active = await activeIdentity();
  if (!active) {
    const ctx = { params, siteHost: hostOf(session.origin), relayHost: "" };
    // Voter credentials for other elections can't read this one.
    return fail(session, (await voterCredentials()).length > 0 ? identityFailures.onlyCredentials(ctx) : identityFailures.none(ctx));
  }
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
  if (record.voters.kind !== "x509") return fail(session, identityFailures.noCredential(titled, record.voters.msp));
  if (!record.voters.msps.includes(active.record.mspId)) {
    return fail(session, identityFailures.notVoter(titled, record.voters.msps, summary.name, active.record.mspId));
  }
  // The voter tag is made from the enrolment ID in the certificate the relay
  // put in the read's proposal, as the contract reads it.
  let voterId: string;
  try {
    voterId = enrolmentId(read.idBytes);
  } catch (error) {
    if (error instanceof TallyError) return fail(session, identityFailures.noEnrolmentId(titled, summary.name, error.message));
    throw error;
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
  session.read = { identityId: active.record.id, networkId: active.network.id, record, election: read.open.election, idBytes: read.idBytes, enrolmentId: voterId, view };
  return { status: "ready", election: view };
}

/**
 * Reads an election with a one-off identity of the voter credential, through
 * the relay its invite names, checked against the invite's trustee CA chains.
 * The pseudonym is the same for every identity of the credential in the
 * election, so the window can show the ballot's voter tag before the vote.
 */
async function readAnonymous(session: Session, credential: VoterCredentialRecord): Promise<BallotReadView> {
  const { params } = session;
  const invite = credential.invite;
  const ctx: FailureContext = { ...failureContext(session, invite.relayUrl), endorsers: invite.endorsers.map((e) => e.mspId) };
  const moduleFailed = (error: unknown) => fail(session, moduleFailure(ctx, error instanceof Error ? error.message : String(error)));
  let signer: AnonymousSigner & { gone: boolean };
  let identity;
  try {
    signer = await signerOf(session);
    identity = await signer.newIdentity();
  } catch (error) {
    return moduleFailed(error);
  }
  let read;
  let pseudonym: string;
  try {
    const relaySigner = { mspId: invite.mspId, idemixIdentity: identity.idBytes };
    read = await readElection(relayFor(invite.relayUrl), relaySigner, params, (m) => signer.sign(identity.handle, m), { endorsers: invite.endorsers });
    pseudonym = await signer.pseudonym(identity.handle, params.channel, params.electionId);
  } catch (error) {
    return error instanceof ModuleCallError ? moduleFailed(error) : fail(session, readFailure(error, ctx));
  } finally {
    void signer.dispose(identity.handle).catch(() => {});
  }
  const record = read.record;
  const titled = { ...ctx, title: record.title };
  if (record.state !== "open" || !read.open) return fail(session, stateFailure(record, titled));
  if (record.voters.kind !== "idemix") return fail(session, identityFailures.notCredentialElection(titled, record.voters.msps, invite.mspId));
  if (record.voters.msp !== invite.mspId) return fail(session, identityFailures.notCredentialElection(titled, [record.voters.msp], invite.mspId));
  if (record.voters.issuerKeyHash !== invite.issuerKeyHash) {
    return fail(session, identityFailures.wrongKey(titled, invite.mspId, invite.issuerKeyHash, record.voters.issuerKeyHash));
  }
  await rememberTitle(credential.id, record.title).catch(() => {});
  const P = fromHex(pseudonym, 64);
  if (!P) return moduleFailed(new Error("The voting module's pseudonym isn't 64 bytes of hex."));
  const tag = toHex(voterTagIdemix(params.channel, params.electionId, invite.mspId, P));
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
    voter: { name: "", mspId: invite.mspId },
    relayHost: hostOf(invite.relayUrl),
    peerChecked: read.peerChecked,
    alreadyVoted: votedWith(await anonymousEntries(), credential.id, params.electionId),
    anonymous: { mspId: invite.mspId, affiliation: record.voters.affiliation, role: record.voters.role, pseudonym: tag, relayOperator: invite.relayOperator, checked: read.checked },
  };
  session.pending = null;
  session.read = { identityId: credential.id, networkId: "", record, election: read.open.election, idBytes: new Uint8Array(), enrolmentId: "", view, credential };
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
  if (read.credential) return castAnonymous(approval, session, read, decision, host);
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
    // The voter tag is made from the enrolment ID in the certificate the
    // relay put in the read's proposal. castBallotCall checks that the
    // proposal it signs carries that certificate, byte for byte.
    const tag = voterTagX509(params.channel, params.electionId, identity.mspId, read.enrolmentId);
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
    // The ballot is on the ledger whatever the browser does now: a refused
    // write is said in the window, which keeps the receipt, and isn't a failure.
    const unsaved = kept.result.kept ? null : await host.saveActivity(committed).then(() => null, refused);
    host.finish(approval, {
      status: "approved",
      activityId: unsaved ? null : base.id,
      blockNumber: result.blockNumber,
      transactionId: result.transactionId,
      ...(network.explorerUrl ? { explorerUrl: network.explorerUrl } : {}),
      receipt: kept.outcome,
      tracking: ballot.tracking,
      ...(unsaved ? { unsaved: { receipt, error: unsaved } } : {}),
    });
    return { transactionId: result.transactionId, blockNumber: result.blockNumber, status: "VALID", receipt: kept.result };
  } catch (error) {
    const failure = castFailure(error, stage, ctx);
    const o = failure.outcome;
    // The window says the details are in the activity only when they are.
    const saved = await host
      .saveActivity({ ...base, status: "failed", code: o.code ?? "INTERNAL", title: o.title, detail: [o.detail, o.next].filter(Boolean).join(" "), ...(o.raw ? { raw: o.raw } : {}) })
      .then(
        () => true,
        () => false,
      );
    host.finish(approval, { ...o, activityId: saved ? base.id : null });
    throw failure.error;
  }
}

/**
 * After Sign and vote, for a voter credential: a new identity from the
 * window's worker, the pseudonym and the voter tag made from it, the ballot,
 * the pseudonym proof bound to its tracking code, then the relay flows with
 * the identity's signatures, checked as for any ballot and against the
 * identity Weft made. The identity is disposed of after the commit status.
 * The activity, and the receipt when the voter keeps it, are sealed.
 */
async function castAnonymous<A extends { view: ApprovalView; decision: { promise: Promise<BallotDecision> } }>(
  approval: A,
  session: Session,
  read: NonNullable<Session["read"]>,
  decision: BallotDecision,
  host: ApprovalHost<A>,
): Promise<CastBallotResult> {
  const { params } = session;
  const credential = read.credential!;
  const invite = credential.invite;
  const anonymous = read.view.anonymous!;
  const choice = decision.choice!;
  const options = read.record.options;
  const base: Omit<ActivityRecord, "status"> = {
    id: newId(),
    at: Date.now(),
    origin: session.origin,
    identityId: credential.id,
    kind: "submit",
    call: { channel: params.channel, chaincode: params.chaincode, fn: "CastAnonymousBallot", args: [params.electionId] },
    anonymous: { credentialId: credential.id, mspId: invite.mspId, affiliation: anonymous.affiliation, role: anonymous.role, pseudonym: anonymous.pseudonym },
  };
  const ctx = { ...failureContext(session, invite.relayUrl), title: read.record.title, voterName: "your voter credential", tracking: null as string | null, anonymous: true };
  let stage: CastStage = null;
  // Taken before the vote, so the activity can be sealed even if Weft locks while it waits for the block.
  let key: CryptoKey | null = null;
  try {
    if (!Number.isInteger(choice) || choice < 0 || choice >= options.length) throw new Error(`Option ${choice} isn't one of the election's options.`);
    key = await voterKey();
    const signer = await signerOf(session);
    const identity = await signer.newIdentity();
    let result;
    let tracking: string;
    try {
      const P = fromHex(await signer.pseudonym(identity.handle, params.channel, params.electionId), 64);
      if (!P) throw new Error("The voting module's pseudonym isn't 64 bytes of hex.");
      const tag = voterTagIdemix(params.channel, params.electionId, invite.mspId, P);
      if (toHex(tag) !== anonymous.pseudonym) throw new Error("The credential's pseudonym isn't the one Weft read the election with.");
      // The encryption randomness never leaves encryptBallot.
      const ballot = encryptBallot(read.election, tag, choice);
      tracking = ballot.tracking;
      ctx.tracking = tracking;
      const proof = await signer.pseudonymProof(identity.handle, params.channel, params.electionId, tracking);
      const pseudonymJson = JSON.stringify({ pseudonym: proof.pseudonym, c: proof.c, ssk: proof.ssk, sr: proof.sr });
      base.call = { ...base.call, args: [params.electionId, ballot.json, pseudonymJson] };
      const relaySigner = { mspId: invite.mspId, idemixIdentity: identity.idBytes };
      result = await castBallotCall(relayFor(invite.relayUrl), relaySigner, base.call, (m) => signer.sign(identity.handle, m), fromBase64(identity.idBytes), {
        onStage: (s) => void (stage = s),
      });
    } finally {
      void signer.dispose(identity.handle).catch(() => {});
    }

    const committed: ActivityRecord = { ...base, status: "committed", transactionId: result.transactionId, blockNumber: result.blockNumber, code: result.status };
    const receipt: BallotReceiptV2 = {
      type: RECEIPT_TYPE,
      version: 2,
      channel: params.channel,
      electionId: params.electionId,
      txId: result.transactionId,
      blockNumber: Number(result.blockNumber),
      tracking,
    };
    const returned = returnedTracking(result.text);
    let kept: { result: BallotReceiptResultV2; outcome: ReceiptOutcome };
    if (!decision.keepReceipt) kept = { result: { kept: false, reason: "declined", receipt }, outcome: { kept: false, reason: "declined" } };
    else if (returned !== tracking) {
      kept = { result: { kept: false, reason: "mismatch", receipt }, outcome: { kept: false, reason: "mismatch", expected: tracking, returned } };
    } else {
      try {
        await saveAnonymous(key, { activity: committed, receipt: { ...receipt, option: options[choice]!, keptAt: Date.now() } });
        const locked = await vault.status().then((v) => v.state !== "unlocked", () => false);
        kept = { result: { kept: true, receipt }, outcome: { kept: true, locked } };
      } catch (error) {
        const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        kept = { result: { kept: false, reason: "storage", receipt }, outcome: { kept: false, reason: "storage", receipt, error: message } };
      }
    }
    const unsaved = kept.result.kept ? null : await saveAnonymous(key, { activity: committed, receipt: null }).then(() => null, refused);
    if (!unsaved) host.announceActivity();
    host.finish(approval, {
      status: "approved",
      activityId: unsaved ? null : base.id,
      blockNumber: result.blockNumber,
      transactionId: result.transactionId,
      ...(invite.explorerUrl ? { explorerUrl: invite.explorerUrl } : {}),
      receipt: kept.outcome,
      tracking,
      ...(unsaved ? { unsaved: { receipt, error: unsaved } } : {}),
    });
    return { transactionId: result.transactionId, blockNumber: result.blockNumber, status: "VALID", receipt: kept.result };
  } catch (error) {
    const failure = castFailure(error, stage, ctx);
    const o = failure.outcome;
    let saved = false;
    if (key) {
      const failed: ActivityRecord = { ...base, status: "failed", code: o.code ?? "INTERNAL", title: o.title, detail: [o.detail, o.next].filter(Boolean).join(" "), ...(o.raw ? { raw: o.raw } : {}) };
      saved = await saveAnonymous(key, { activity: failed, receipt: null }).then(() => true, () => false);
      if (saved) host.announceActivity();
    }
    host.finish(approval, { ...o, activityId: saved ? base.id : null });
    throw failure.error;
  }
}

/** A refused write's error, as the window's Details show it. */
const refused = (error: unknown): string => (error instanceof Error ? `${error.name}: ${error.message}` : String(error));

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
