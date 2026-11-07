/**
 * Experimental (docs/adr/0007): what weft_castBallot tells the window and the
 * site when something stops it. Each failure says what happened first, then
 * what it means for the ledger and what to do, with anything technical for
 * Details. Pure, so every case is tested.
 */

import { CommitError, RelayError, VaultLockedError, VerificationError, explainStatus } from "@weftwallet/core";
import { ErrorCode, ExperimentalErrorCode, WeftError, type CastBallotParams } from "@weftwallet/protocol";
import type { ApprovalOutcome, BallotFailureView } from "../messages";
import { RecordError, type ElectionRecord } from "./read";

/** What a failure before the vote leads to: the window's view, and the site's error when it gets one now. */
export interface ReadFailure {
  view: BallotFailureView;
  /** final: the site's error, sent at once. unreachable and noChannel: what Reject or closing the window fails with. */
  error: WeftError | null;
}

export interface FailureContext {
  params: CastBallotParams;
  /** The site's host, as the browser reports it. */
  siteHost: string;
  relayHost: string;
  /** The election's title, once read. */
  title?: string;
}

const NO_BALLOT = "No ballot was cast.";

/** "Org1MSP", "Org1MSP and Org2MSP", "Org1MSP, Org2MSP and Org3MSP". */
export function listOf(items: readonly string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** The contract's own sentence from a refused endorsement, or null when the failure isn't one. */
export function contractMessage(error: unknown): string | null {
  const e = error as { details?: { message?: string }[] | undefined; message?: string } | null;
  for (const text of [...(e?.details ?? []).map((d) => d.message ?? ""), e?.message ?? ""]) {
    const m = text.match(/chaincode response \d+, ([\s\S]*)$/);
    if (m) return m[1]!.trim();
  }
  return null;
}

const final = (code: number, siteMessage: string, view: Omit<BallotFailureView, "kind">, data?: unknown): ReadFailure => ({
  view: { kind: "final", ...view },
  error: new WeftError(code as WeftError["code"], siteMessage, data),
});

const unreadable = (ctx: FailureContext, title: string, detail: string, technical: string, siteMessage: string): ReadFailure =>
  final(ExperimentalErrorCode.ElectionUnavailable, siteMessage, { title, detail, technical: `4400 ElectionUnavailable. ${technical}` });

/** A failure while Weft reads the election, before the voter sees it. */
export function readFailure(error: unknown, ctx: FailureContext): ReadFailure {
  const { electionId, channel, chaincode } = ctx.params;
  if (error instanceof VaultLockedError) {
    return { view: { kind: "locked", title: "Weft locked", detail: "Unlock Weft to read the election." }, error: null };
  }
  if (error instanceof RelayError) {
    const relayDown = error.kind === "unreachable" || error.kind === "timeout" || error.kind === "http";
    // The relay answered, but no peer did: Try again may work too.
    const peers = !relayDown && error.explanation.code === "UNAVAILABLE";
    if (relayDown || peers) {
      return {
        view: {
          kind: "unreachable",
          title: peers ? "The network didn't answer" : "Weft couldn't reach the relay",
          detail: peers
            ? `The relay at ${ctx.relayHost} answered, but no peer did, so Weft couldn't read ${electionId} from the ledger. ${NO_BALLOT}`
            : `The relay at ${ctx.relayHost} didn't answer, so Weft couldn't read ${electionId} from the ledger. ${NO_BALLOT}`,
          technical: `5002 NetworkUnavailable. ${error.detail}`,
        },
        error: new WeftError(ErrorCode.NetworkUnavailable, `The relay at ${ctx.relayHost} didn't answer, so Weft couldn't read ${electionId}.`),
      };
    }
    const said = contractMessage(error);
    if (said === `There's no election ${electionId}.`) {
      return unreadable(
        ctx,
        `There's no election ${electionId}`,
        `The contract ${chaincode} on ${channel} has no election with that ID. ${NO_BALLOT} Check the election on ${ctx.siteHost}.`,
        said,
        `There's no election ${electionId} on ${channel}.`,
      );
    }
    if (error.explanation.code === "CHAINCODE_NOT_FOUND") {
      return unreadable(ctx, "Weft couldn't read this election", `The channel ${channel} has no contract named ${chaincode}. ${NO_BALLOT}`, error.detail, `The channel ${channel} has no contract ${chaincode}.`);
    }
    if (error.explanation.code === "ACCESS_DENIED") {
      return unreadable(
        ctx,
        "Weft couldn't read this election",
        `The network refused to let your identity read ${channel}. Your organisation may not be a member of it. ${NO_BALLOT}`,
        error.detail,
        `The network refused the voter's read of ${channel}.`,
      );
    }
    return unreadable(
      ctx,
      "Weft couldn't read this election",
      `The contract refused to return ${electionId}. ${NO_BALLOT} The details show what it said.`,
      said ?? error.detail,
      said ?? `The contract refused GetElection for ${electionId}.`,
    );
  }
  if (error instanceof RecordError) {
    if (error.reason === "mismatch") {
      const detail =
        error.extra.field === "fingerprint"
          ? `The election's record doesn't match its own fields. Weft worked out the fingerprint ${group(error.extra.computed!)}, and the record gives ${group(error.extra.recorded!)}. ${NO_BALLOT} Tell your administrator.`
          : `The election's record doesn't match its own fields: Weft worked out its context from them, and the record gives another. ${NO_BALLOT} Tell your administrator.`;
      return unreadable(ctx, "Weft won't cast a ballot in this election", detail, error.message, `${electionId}'s record has a ${error.extra.field} that isn't the one Weft computed.`);
    }
    if (error.reason === "signature") {
      return unreadable(
        ctx,
        "Weft won't trust what it read",
        `What the relay at ${ctx.relayHost} returned for ${electionId} doesn't carry a valid signature from a peer of your organisation, so it may have been changed on the way. ${NO_BALLOT} Tell your administrator.`,
        error.message,
        `The answer to GetElection for ${electionId} doesn't verify: ${error.message}`,
      );
    }
    return unreadable(
      ctx,
      "Weft can't read this election",
      `The contract ${chaincode} on ${channel} returned a record that Weft doesn't read as a private election. ${NO_BALLOT} Tell your administrator.`,
      error.message,
      `${electionId}'s record isn't one Weft reads: ${error.message}`,
    );
  }
  if (error instanceof VerificationError) {
    return final(ErrorCode.Internal, error.message, {
      title: "Weft refused to sign",
      detail: `The relay at ${ctx.relayHost} sent back a request to read something other than ${electionId}, so Weft didn't sign it. The relay may be misconfigured or compromised.`,
      technical: error.message,
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  return final(ErrorCode.Internal, message, {
    title: "Weft had an unexpected error",
    detail: `${NO_BALLOT} Try again from ${ctx.siteHost}, and if it happens again, report it with the details.`,
    technical: message,
  });
}

/** "3f9a61c208de77b1c4e0" as "3f9a 61c2 08de 77b1 c4e0". */
const group = (hex: string) => hex.match(/.{1,4}/g)?.join(" ") ?? hex;

/** An election Weft read that isn't open. */
export function stateFailure(record: ElectionRecord, ctx: FailureContext): ReadFailure {
  const title = record.title;
  const views: Record<Exclude<ElectionRecord["state"], "open">, Omit<BallotFailureView, "kind" | "technical">> = {
    keygen: { title: `${title} isn't open yet`, detail: `Its trustees are still making the election key, so there's nothing to encrypt a ballot under. ${NO_BALLOT}` },
    decrypting: { title: `${title} has closed`, detail: `Its trustees closed voting, and the votes are being counted. ${NO_BALLOT}` },
    counted: { title: `${title} has closed`, detail: `Its trustees closed voting and published the count. ${NO_BALLOT}` },
    failed: {
      title: `${title} can't open`,
      detail: `Its key ceremony failed${record.reportedBy ? `: ${record.reportedBy} reported a bad key share` : ""}. ${NO_BALLOT}`,
    },
    cancelled: { title: `${title} was cancelled`, detail: `It was cancelled during its key ceremony. ${NO_BALLOT}` },
  };
  const state = record.state as Exclude<ElectionRecord["state"], "open">;
  return final(
    ExperimentalErrorCode.ElectionUnavailable,
    `${ctx.params.electionId} isn't open: it is in ${state}.`,
    { ...views[state], technical: `4400 ElectionUnavailable. The election is in ${state}.` },
    { state },
  );
}

export const identityFailures = {
  none: (ctx: FailureContext): ReadFailure =>
    final(ErrorCode.NoIdentity, "Weft has no identity yet.", {
      title: "Weft has no identity yet",
      detail: `Join your organisation's network from its invite, then vote again from ${ctx.siteHost}.`,
      technical: "4300 NoIdentity.",
    }),
  expired: (ctx: FailureContext, name: string, notAfter: string): ReadFailure =>
    final(ErrorCode.CertificateExpired, "The certificate of the identity that would vote has expired.", {
      title: "Your certificate has expired",
      detail: `${name}'s certificate expired on ${new Date(notAfter).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}. Renew it in Weft, then vote again from ${ctx.siteHost}. ${NO_BALLOT}`,
      technical: "4301 CertificateExpired.",
    }),
  /** The network may list the channel in a newer invite: the request waits for Refresh from invite. */
  channelPending: (ctx: FailureContext, networkName: string, inviteUrl: string): ReadFailure => ({
    view: {
      kind: "noChannel",
      title: "Your network doesn't list this election's channel",
      detail: `Your invite for ${networkName} doesn't list ${ctx.params.channel}. Each election has a channel of its own, so an invite published before the election won't have it. Refresh from invite to check the latest one.`,
      technical: `Reject fails the request with 4300 NoIdentity. The invite: ${inviteUrl}`,
      inviteUrl,
    },
    error: new WeftError(ErrorCode.NoIdentity, `None of the voter's networks has the channel ${ctx.params.channel}.`),
  }),
  channel: (ctx: FailureContext, networkName: string, refreshed: boolean): ReadFailure =>
    final(ErrorCode.NoIdentity, `None of the voter's networks has the channel ${ctx.params.channel}.`, {
      title: "None of your identities can vote here",
      detail: `${refreshed ? `The latest invite for ${networkName} still doesn't list` : `Your network ${networkName} doesn't have`} the channel ${ctx.params.channel}. Ask your administrator whether your organisation votes in this election. ${NO_BALLOT}`,
      technical: "4300 NoIdentity.",
    }),
  notVoter: (ctx: FailureContext, voterMsps: string[], name: string, mspId: string): ReadFailure =>
    final(
      ErrorCode.NoIdentity,
      `${mspId} isn't one of ${ctx.params.electionId}'s voter organisations.`,
      {
        title: "None of your identities can vote here",
        detail: `${ctx.title ?? ctx.params.electionId}'s voters are ${listOf(voterMsps)} identities, and ${name} is in ${mspId}. Make an identity of a voter organisation active in Weft, then vote again from ${ctx.siteHost}. ${NO_BALLOT}`,
        technical: `4300 NoIdentity. data.voterMsps: ${listOf(voterMsps)}.`,
      },
      { voterMsps },
    ),
  credentials: (ctx: FailureContext, msp: string): ReadFailure =>
    final(
      ErrorCode.NoIdentity,
      `${ctx.params.electionId}'s voters use voter credentials, which this Weft can't hold yet.`,
      {
        title: "This election needs a voter credential",
        detail: `${ctx.title ?? ctx.params.electionId}'s voters vote with credentials from ${msp}, which this version of Weft Experimental can't hold yet. ${NO_BALLOT}`,
        technical: `4300 NoIdentity. data.voterMsps: ${msp}.`,
      },
      { voterMsps: [msp] },
    ),
};

export type CastStage = "proposing" | "endorsing" | "submitting" | "committing" | "done" | null;

/** True when the ballot may already be on its way to the ledger: the relay took it, or the failure came while waiting for the commit. */
export function mayHaveCommitted(stage: CastStage, error: unknown): boolean {
  if (error instanceof CommitError) return false;
  if (stage === "committing") return true;
  if (stage !== "submitting") return false;
  return !(error instanceof RelayError) || error.kind === "unreachable" || error.kind === "timeout";
}

export interface CastFailure {
  outcome: Extract<ApprovalOutcome, { status: "failed" }>;
  error: WeftError;
}

const shortHex = (v: string) => (v.length <= 17 ? v : `${v.slice(0, 8)}…${v.slice(-8)}`);

/** A failure once the voter pressed Sign and vote. `tracking` is set once the ballot is made. */
export function castFailure(
  error: unknown,
  stage: CastStage,
  ctx: FailureContext & { title: string; voterName: string; tracking: string | null },
): CastFailure {
  const nothing = "Nothing was written to the ledger.";
  const out = (
    o: { title: string; detail: string; next: string; code: string; raw?: string; uncertain?: boolean; retryable?: boolean },
    site: WeftError,
  ): CastFailure => ({
    outcome: {
      status: "failed",
      activityId: null,
      title: o.title,
      detail: o.detail,
      next: o.next,
      code: o.code,
      ...(o.raw ? { raw: o.raw } : {}),
      retryable: o.retryable ?? false,
      uncertain: o.uncertain ?? false,
    },
    error: site,
  });
  const closed = { title: "Voting closed before your ballot arrived", next: nothing };

  if (error instanceof CommitError) {
    if (error.status === "MVCC_READ_CONFLICT") {
      return out(
        { ...closed, detail: `${ctx.title}'s trustees closed voting before your ballot was committed, so the network refused it.`, code: error.status },
        new WeftError(ErrorCode.TransactionFailed, "The ballot failed validation with MVCC_READ_CONFLICT: the election closed before it committed.", {
          transactionId: error.transactionId,
          status: error.status,
        }),
      );
    }
    const e = explainStatus(error.status);
    return out(
      { title: e.title, detail: e.detail, next: "", code: error.status, retryable: e.retryable },
      new WeftError(ErrorCode.TransactionFailed, e.title, { transactionId: error.transactionId, status: error.status }),
    );
  }
  if (error instanceof RelayError) {
    const unreachable = error.kind === "unreachable" || error.kind === "timeout" || error.kind === "http";
    if (unreachable && mayHaveCommitted(stage, error)) {
      return out(
        {
          title: "Weft couldn't tell if your ballot was committed",
          detail: `The relay at ${ctx.relayHost} stopped answering after Weft sent your signed ballot.`,
          next: ctx.tracking
            ? `Check tracking code ${shortHex(ctx.tracking)} in the explorer before you vote again. If the ballot was committed, the contract refuses a second one, so voting again is safe.`
            : "Check the explorer before you vote again.",
          code: error.explanation.code,
          raw: error.detail,
          uncertain: true,
        },
        new WeftError(ErrorCode.NetworkUnavailable, `The relay at ${ctx.relayHost} stopped answering after the ballot was sent.`, {
          ...(ctx.tracking ? { tracking: ctx.tracking } : {}),
        }),
      );
    }
    if (unreachable) {
      return out(
        {
          title: "Weft couldn't reach the relay",
          detail: `The relay at ${ctx.relayHost} didn't answer, so your ballot wasn't sent.`,
          next: `${nothing} You can vote again from ${ctx.siteHost}.`,
          code: error.explanation.code,
          raw: error.detail,
          retryable: true,
        },
        new WeftError(ErrorCode.NetworkUnavailable, `The relay at ${ctx.relayHost} didn't answer.`),
      );
    }
    const said = contractMessage(error);
    const data = { code: "ENDORSE_FAILED", ...(said ? { contract: said } : {}), details: error.details };
    if (said === "This identity has already voted in this election.") {
      return out(
        { title: `You've already voted in ${ctx.title}`, detail: `The contract refused a second ballot from ${ctx.voterName}.`, next: `${nothing} Your first ballot stands.`, code: "ENDORSE_FAILED", raw: said },
        new WeftError(ErrorCode.TransactionFailed, said, data),
      );
    }
    if (said === "Voting has closed." || said?.startsWith("The election isn't open")) {
      return out(
        { ...closed, detail: `${ctx.title}'s trustees closed voting while this window was open.`, code: "ENDORSE_FAILED", raw: said },
        new WeftError(ErrorCode.TransactionFailed, said, data),
      );
    }
    if (said) {
      return out(
        { title: "The contract refused your ballot", detail: "The contract refused your ballot. The details show what it said.", next: `${nothing} Tell the site's developer.`, code: "ENDORSE_FAILED", raw: said },
        new WeftError(ErrorCode.TransactionFailed, said, data),
      );
    }
    const e = error.explanation;
    return out(
      { title: e.title, detail: e.detail, next: "", code: e.code, raw: error.detail, retryable: e.retryable },
      new WeftError(ErrorCode.TransactionFailed, e.title, data),
    );
  }
  if (error instanceof VerificationError) {
    return out(
      {
        title: "Weft refused to sign your ballot",
        detail: "What the relay sent back to sign wasn't exactly the ballot Weft made, so Weft didn't sign it. The relay may be misconfigured or compromised.",
        next: nothing,
        code: "VERIFICATION_FAILED",
        raw: error.message,
      },
      new WeftError(ErrorCode.Internal, error.message),
    );
  }
  if (error instanceof VaultLockedError) {
    return out(
      { title: "Weft locked before signing", detail: "Weft locked before it could sign your ballot.", next: `${nothing} Unlock Weft, then vote again from ${ctx.siteHost}.`, code: "LOCKED", retryable: true },
      new WeftError(ErrorCode.UserRejected, "Weft locked before it could sign."),
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  const uncertain = mayHaveCommitted(stage, error);
  return out(
    {
      title: uncertain ? "Weft couldn't tell if your ballot was committed" : "Weft had an unexpected error",
      detail: uncertain ? "Weft failed after it sent your signed ballot." : "Something inside Weft failed while it made your ballot.",
      next: uncertain ? (ctx.tracking ? `Check tracking code ${shortHex(ctx.tracking)} in the explorer before you vote again.` : "Check the explorer before you vote again.") : `${nothing} Try again from ${ctx.siteHost}, and if it happens again, report it with the details.`,
      code: "INTERNAL",
      raw: message,
      uncertain,
    },
    new WeftError(ErrorCode.Internal, message),
  );
}
