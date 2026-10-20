/**
 * Handles `window.weft` requests in the background worker: connection
 * checks, approval windows, and running evaluate/submit through the relay.
 */

import {
  CommitError,
  InviteError,
  resolveInviteUrl,
  RelayClient,
  RelayError,
  VerificationError,
  certificateHealth,
  evaluateCall,
  submitCall,
  summarizeIdentity,
} from "@weftwallet/core";
import {
  ErrorCode,
  WeftError,
  isWeftMethod,
  type ContractCall,
  type NetworkSummary,
  type WeftMethod,
} from "@weftwallet/protocol";
import { browser } from "wxt/browser";
import { db, newId, type ActivityRecord, type NetworkRecord } from "./db";
import type { ApprovalOutcome, ApprovalView } from "./messages";
import { connectSite, connectedIdentityIds, disconnectSites, isConnected } from "./sites";
import { activeIdentity, activeSummary, identityView, signerFor } from "./wallet";

/* ------------------------------------------------------------------ */
/* Approvals                                                           */
/* ------------------------------------------------------------------ */

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

interface PendingApproval {
  view: ApprovalView;
  decision: Deferred<boolean>;
  outcome: Deferred<ApprovalOutcome>;
  windowId?: number;
}

const approvals = new Map<string, PendingApproval>();

/** Closing an approval window counts as rejecting it. Call once at startup. */
export function registerApprovalListeners(): void {
  browser.windows.onRemoved.addListener((windowId) => {
    for (const approval of approvals.values()) {
      if (approval.windowId === windowId) approval.decision.resolve(false);
    }
  });
}

export function getApproval(id: string): ApprovalView | null {
  return approvals.get(id)?.view ?? null;
}

/** Called by the approval window. Resolves once the request has finished running. */
export async function decideApproval(id: string, approved: boolean): Promise<ApprovalOutcome> {
  const approval = approvals.get(id);
  if (!approval) return { status: "rejected" };
  approval.decision.resolve(approved);
  return approval.outcome.promise;
}

/**
 * One waiting approval per site. A second request while one is open brings
 * the open window to the front and fails, so a page can't stack up windows.
 */
async function ensureNoPendingApproval(origin: string): Promise<void> {
  for (const approval of approvals.values()) {
    if (approval.view.origin !== origin) continue;
    if (approval.windowId !== undefined) {
      await browser.windows.update(approval.windowId, { focused: true }).catch(() => {});
    }
    throw new WeftError(
      ErrorCode.RequestPending,
      "This site already has a request waiting in Weft. Approve or reject it first.",
    );
  }
}

async function openApproval(view: ApprovalView): Promise<PendingApproval> {
  await ensureNoPendingApproval(view.origin);
  const approval: PendingApproval = { view, decision: deferred(), outcome: deferred() };
  approvals.set(view.id, approval);
  const created = await browser.windows.create({
    url: browser.runtime.getURL(`/approve.html?id=${encodeURIComponent(view.id)}`),
    type: "popup",
    width: 380,
    height: 680,
    focused: true,
  });
  approval.windowId = created?.id;
  return approval;
}

function finish(approval: PendingApproval, outcome: ApprovalOutcome) {
  approval.outcome.resolve(outcome);
  approvals.delete(approval.view.id);
}

/* ------------------------------------------------------------------ */
/* Sites                                                               */
/* ------------------------------------------------------------------ */

async function requireConnected(origin: string): Promise<void> {
  if (!(await isConnected(origin))) {
    throw new WeftError(ErrorCode.Unauthorized, "Call weft_connect first; this site is not connected.");
  }
}

/* ------------------------------------------------------------------ */
/* Requests                                                            */
/* ------------------------------------------------------------------ */

function parseCall(params: unknown): ContractCall {
  const p = (params ?? {}) as Partial<ContractCall>;
  const bad = (msg: string): never => {
    throw new WeftError(ErrorCode.InvalidParams, msg);
  };
  if (typeof p.channel !== "string" || !p.channel) bad('"channel" is required');
  if (typeof p.chaincode !== "string" || !p.chaincode) bad('"chaincode" is required');
  if (typeof p.fn !== "string" || !p.fn) bad('"fn" is required');
  if (p.contract !== undefined && typeof p.contract !== "string") bad('"contract" must be a string');
  const args = p.args ?? [];
  if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) bad('"args" must be a list of strings');
  if (p.transient !== undefined) {
    const ok =
      typeof p.transient === "object" && p.transient !== null && Object.values(p.transient).every((v) => typeof v === "string");
    if (!ok) bad('"transient" must map names to strings');
  }
  return {
    channel: p.channel!,
    chaincode: p.chaincode!,
    ...(p.contract ? { contract: p.contract } : {}),
    fn: p.fn!,
    args,
    ...(p.transient ? { transient: p.transient } : {}),
    ...(p.endorsingOrganizations ? { endorsingOrganizations: p.endorsingOrganizations } : {}),
  };
}

async function requireUsableIdentity() {
  const active = await activeIdentity();
  if (!active) throw new WeftError(ErrorCode.NoIdentity, "Weft has no identity yet. Open the extension to add one.");
  const summary = await summarizeIdentity(active.record);
  if (certificateHealth(summary).state === "expired") {
    throw new WeftError(ErrorCode.CertificateExpired, "The active certificate has expired. Re-enrol in Weft.");
  }
  return active;
}

async function connect(origin: string) {
  const active = await requireUsableIdentity();
  if (await isConnected(origin)) return summarizeIdentity(active.record);

  const view: ApprovalView = {
    id: newId(),
    origin,
    method: "weft_connect",
    call: null,
    identity: await identityView(active.record.id),
  };
  const approval = await openApproval(view);
  if (!(await approval.decision.promise)) {
    finish(approval, { status: "rejected" });
    throw new WeftError(ErrorCode.UserRejected, "The user declined to connect.");
  }
  await connectSite(origin, active.record.id);
  finish(approval, { status: "approved", activityId: null });
  return summarizeIdentity(active.record);
}

async function runCall(origin: string, method: "weft_evaluate" | "weft_submit", params: unknown) {
  await requireConnected(origin);
  const call = parseCall(params);
  const active = await requireUsableIdentity();

  const view: ApprovalView = {
    id: newId(),
    origin,
    method,
    call,
    identity: await identityView(active.record.id),
  };
  const approval = await openApproval(view);
  const kind = method === "weft_submit" ? "submit" : "evaluate";
  const base = { id: newId(), at: Date.now(), origin, identityId: active.record.id, kind, call } as const;

  if (!(await approval.decision.promise)) {
    finish(approval, { status: "rejected" });
    throw new WeftError(ErrorCode.UserRejected, "The user rejected the request.");
  }

  const relay = new RelayClient(active.network.relayUrl);
  const signer = { mspId: active.record.mspId, certificate: active.record.certificate };
  const sign = signerFor(active.record);

  try {
    if (method === "weft_evaluate") {
      const result = await evaluateCall(relay, signer, call, sign);
      await db.put<ActivityRecord>("activity", { ...base, status: "evaluated" });
      finish(approval, { status: "approved", activityId: base.id });
      return result;
    }
    const result = await submitCall(relay, signer, call, sign);
    await db.put<ActivityRecord>("activity", {
      ...base,
      status: "committed",
      transactionId: result.transactionId,
      blockNumber: result.blockNumber,
      code: result.status,
    });
    finish(approval, { status: "approved", activityId: base.id });
    return result;
  } catch (error) {
    const failure = describeFailure(error);
    await db.put<ActivityRecord>("activity", { ...base, status: "failed", ...failure.record });
    finish(approval, { status: "failed", activityId: base.id, title: failure.record.title, detail: failure.record.detail });
    throw failure.error;
  }
}

function describeFailure(error: unknown): {
  error: WeftError;
  record: Required<Pick<ActivityRecord, "code" | "title" | "detail">> & Partial<ActivityRecord>;
} {
  if (error instanceof CommitError) {
    const e = error.explanation;
    return {
      error: new WeftError(ErrorCode.TransactionFailed, e.title, {
        transactionId: error.transactionId,
        status: error.status,
      }),
      record: { code: error.status, title: e.title, detail: e.detail, transactionId: error.transactionId },
    };
  }
  if (error instanceof RelayError) {
    const e = error.explanation;
    const code = error.kind === "unreachable" ? ErrorCode.NetworkUnavailable : ErrorCode.TransactionFailed;
    return {
      error: new WeftError(code, e.title, { code: e.code, details: error.details }),
      record: { code: e.code, title: e.title, detail: e.detail, ...(error.details ? { endorsers: error.details } : {}) },
    };
  }
  if (error instanceof VerificationError) {
    return {
      error: new WeftError(ErrorCode.Internal, error.message),
      record: {
        code: "VERIFICATION_FAILED",
        title: "Weft refused to sign",
        detail: `${error.message} The relay may be misconfigured or compromised.`,
      },
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    error: new WeftError(ErrorCode.Internal, message),
    record: { code: "INTERNAL", title: "Something went wrong in Weft", detail: message },
  };
}

/**
 * Opens a review window for an organisation's invite. The window fetches the
 * invite and enrols the user; this resolves once they finish or cancel.
 * Like adding a network in MetaMask, it doesn't require the site to be connected.
 */
async function addNetwork(origin: string, params: unknown) {
  const url = (params as { url?: unknown } | undefined)?.url;
  if (typeof url !== "string" || !url) throw new WeftError(ErrorCode.InvalidParams, '"url" is required');
  let inviteUrl: string;
  try {
    inviteUrl = resolveInviteUrl(url);
  } catch (error) {
    throw new WeftError(ErrorCode.InvalidParams, error instanceof InviteError ? error.message : "Invalid invite URL");
  }
  const active = await activeIdentity();
  const view: ApprovalView = {
    id: newId(),
    origin,
    method: "weft_addNetwork",
    call: null,
    identity: active ? await identityView(active.record.id) : null,
    inviteUrl,
  };
  const approval = await openApproval(view);
  // The window enrols through the joinInvite UI call, which tells sites about
  // any change of active identity.
  if (!(await approval.decision.promise)) {
    finish(approval, { status: "rejected" });
    throw new WeftError(ErrorCode.UserRejected, "The user did not add the network.");
  }
  finish(approval, { status: "approved", activityId: null });
  return { added: true as const };
}

export async function handleProviderRequest(origin: string, method: unknown, params: unknown): Promise<unknown> {
  if (!isWeftMethod(method)) {
    throw new WeftError(ErrorCode.UnsupportedMethod, `Unknown method ${String(method)}`);
  }
  switch (method) {
    case "weft_connect":
      return connect(origin);
    case "weft_identity":
      return (await isConnected(origin)) ? activeSummary() : null;
    case "weft_networks":
      return networksFor(origin);
    case "weft_evaluate":
    case "weft_submit":
      return runCall(origin, method, params);
    case "weft_addNetwork":
      return addNetwork(origin, params);
    case "weft_disconnect":
      if ((await connectedIdentityIds(origin)).length > 0) await disconnectSites([origin], "site");
      return null;
  }
}

/**
 * The networks of the identities this site is connected to, active first.
 * Never the user's other networks: those would reveal organisations the site
 * wasn't shown.
 */
async function networksFor(origin: string): Promise<NetworkSummary[]> {
  await requireConnected(origin);
  const active = await activeIdentity();
  const ids = await connectedIdentityIds(origin);
  const identities = await Promise.all(ids.map((id) => identityView(id)));
  const out = new Map<string, NetworkSummary>();
  for (const identity of identities) {
    if (!identity || out.has(identity.networkId)) continue;
    const network = await db.get<NetworkRecord>("networks", identity.networkId);
    if (!network) continue;
    out.set(network.id, {
      id: network.id,
      name: network.name,
      mspId: network.mspId,
      channels: network.channels,
      active: network.id === active?.network.id,
    });
  }
  return [...out.values()].sort((a, b) => Number(b.active) - Number(a.active));
}
