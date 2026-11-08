/**
 * Typed messages between the extension's own pages (popup, approval window)
 * and the background worker. Page-to-wallet provider traffic is separate and
 * goes through the bridge content script.
 */

import type {
  AnyMethod,
  BallotReceipt,
  BallotReceiptV2,
  CastBallotParams,
  ContractCall,
  IdentitySummary,
  OrgInvite,
  VoterInvite,
  WeftErrorShape,
  WeftMethod,
} from "@weftwallet/protocol";
import { browser } from "wxt/browser";
import type { ActivityRecord, NetworkRecord, Settings, SiteRecord } from "./db";
import type { ReceiptAsked } from "./receipt-request";
import type { ReceiptView } from "./receipts";
import type { VaultStatus } from "./vault";
import type { VoterCredentialRecord, VoterCredentialView } from "./voter/types";

export interface IdentityView extends IdentitySummary {
  networkId: string;
  networkName: string;
  organization: string;
  channels: string[];
  enrollmentId: string | null;
  /** Saved before keys were encrypted (docs/adr/0005); re-enrolling fixes it. */
  legacyKey: boolean;
}

export interface PendingCsrView {
  id: string;
  networkId: string;
  networkName: string;
  commonName: string;
  csr: string;
  createdAt: number;
}

export interface WalletState {
  identities: IdentityView[];
  networks: NetworkRecord[];
  pendingCsrs: PendingCsrView[];
  sites: SiteRecord[];
  settings: Settings;
  vault: VaultStatus;
  /** Weft Experimental only (docs/adr/0008): its voter credentials, which are never identities. */
  voterCredentials?: VoterCredentialView[];
}

export type NetworkInput = Omit<NetworkRecord, "id">;

export interface ApprovalView {
  id: string;
  origin: string;
  method: Extract<WeftMethod, "weft_connect" | "weft_evaluate" | "weft_submit" | "weft_addNetwork" | "weft_signIn"> | "weft_castBallot";
  call: ContractCall | null;
  identity: IdentityView | null;
  /** weft_addNetwork only: the resolved HTTPS URL of the invite. */
  inviteUrl?: string;
  /** weft_signIn only: the site's one-line statement. */
  statement?: string;
  /**
   * weft_submit with a ballot receipt (docs/adr/0006), already checked
   * against `call`. `request.salt` is the real salt: one Weft generated is
   * already in `call` too, so the window shows what is signed.
   */
  receipt?: ReceiptAsked;
  /** Weft Experimental's weft_castBallot only: the election the site named (docs/adr/0007). */
  ballot?: CastBallotParams;
  /**
   * Weft Experimental's weft_castBallot only (docs/adr/0008): the voter
   * credential Weft holds for that election, which the window opens in its
   * own idemix worker before the election is read.
   */
  ballotCredential?: string;
}

/** What became of a ballot receipt, for the approval window's status line. */
export type ReceiptOutcome =
  | { kept: true; /** Weft locked while it waited for the block. */ locked: boolean }
  | { kept: false; reason: "declined" }
  /** The browser refused the write. The window holds this copy so the user can save it. */
  | { kept: false; reason: "storage"; receipt: BallotReceipt | BallotReceiptV2; error: string }
  /** The contract's commitment, or for a version 2 receipt its tracking code, isn't the one Weft computed. */
  | { kept: false; reason: "mismatch"; expected: string; returned: string | null };

export type ApprovalOutcome =
  | {
      status: "approved";
      activityId: string | null;
      /** A committed transaction: its block and ID, for the status line and the explorer link. */
      blockNumber?: string;
      transactionId?: string;
      /** The network's explorer, from the invite, when it has one. */
      explorerUrl?: string;
      /** A vote sent with a receipt: whether Weft kept it. */
      receipt?: ReceiptOutcome;
      /** weft_castBallot: the tracking code Weft computed for the ballot. */
      tracking?: string;
      /**
       * The browser refused to store the activity record after the
       * transaction committed. The window stays open and holds what the
       * activity would have: the transaction ID, and the receipt when one was
       * involved (always, for weft_castBallot), so the user can save them
       * before closing.
       */
      unsaved?: { error: string; receipt?: BallotReceipt | BallotReceiptV2 };
    }
  | {
      status: "failed";
      activityId: string | null;
      title: string;
      detail: string;
      /** Fabric or Weft code and the network's own words, for "Details". */
      code?: string;
      raw?: string;
      /** Trying again unchanged has a reasonable chance of working. */
      retryable?: boolean;
      /** It was sent to the network, but Weft didn't learn whether it committed. */
      uncertain?: boolean;
      /** weft_castBallot: what happened to the ledger and what to do next, after `detail`. */
      next?: string;
    }
  | { status: "rejected" };

/**
 * Weft Experimental (docs/adr/0007): the election a weft_castBallot window
 * shows, as Weft read and checked it.
 */
export interface BallotElectionView {
  title: string;
  electionId: string;
  channel: string;
  chaincode: string;
  options: string[];
  /** ISO 8601, the planned closing time. */
  closesAt: string;
  /** The planned closing time has passed, and the trustees haven't closed the election. */
  pastClosing: boolean;
  /** The trustees' MSP IDs, in the order of the trustee list. */
  trustees: string[];
  threshold: number;
  /** 20 lowercase hex characters. */
  fingerprint: string;
  voter: { name: string; mspId: string };
  relayHost: string;
  /** A peer of the voter's organisation signed what Weft read, and Weft checked it against the CA chain. */
  peerChecked: boolean;
  /** This identity's committed ballot in this election, from Weft's activity. */
  alreadyVoted: { blockNumber: string | null } | null;
  /**
   * Weft Experimental (docs/adr/0008): an election with voter credentials,
   * read and signed with one-off identities of the voter's credential. The
   * window then names no one, not even to the voter.
   */
  anonymous?: {
    mspId: string;
    affiliation: string;
    role: string;
    /** The ballot's voter tag, made from the per-election pseudonym, 64 lowercase hex characters. */
    pseudonym: string;
    /** Who runs the election's relay, from the voter invite. */
    relayOperator: string;
    /** The trustee organisations whose peer signatures Weft checked against the invite's CA certificates. */
    checked: string[];
  };
}

/**
 * Weft Experimental: why a weft_castBallot window can't go on. "final": the
 * site already has its error, and the window explains it until closed.
 * "unreachable": the relay didn't answer; Try again. "noChannel": the
 * network's invite may list the channel now; Refresh from invite.
 * "locked": Weft locked; unlock, then read again.
 */
export interface BallotFailureView {
  kind: "final" | "unreachable" | "noChannel" | "locked";
  title: string;
  detail: string;
  /** For Details. */
  technical?: string;
  /** noChannel: the invite to refresh from. */
  inviteUrl?: string;
}

export type BallotReadView = { status: "ready"; election: BallotElectionView } | { status: "failed"; failure: BallotFailureView };

/** Every UI request: name -> [payload, result]. */
export interface UiApi {
  state: [undefined, WalletState];
  activity: [undefined, ActivityRecord[]];
  activityItem: [{ id: string }, ActivityRecord | null];
  setActive: [{ identityId: string; channel?: string }, WalletState];
  setChannel: [{ channel: string }, WalletState];
  /** In Weft Experimental, a voter invite too (docs/adr/0008). */
  fetchInvite: [{ link: string }, OrgInvite | VoterInvite];
  /** inviteUrl: where the invite came from, kept so the network can be refreshed from it later. */
  joinInvite: [{ invite: OrgInvite; enrollmentId: string; secret: string; inviteUrl?: string }, IdentityView];
  enroll: [{ network: NetworkInput; enrollmentId: string; secret: string }, IdentityView];
  importIdentity: [{ network: NetworkInput; certificate: string; privateKeyPem: string }, IdentityView];
  createCsr: [{ network: NetworkInput; commonName: string }, PendingCsrView];
  completeCsr: [{ pendingId: string; certificate: string }, IdentityView];
  reenroll: [{ identityId: string }, IdentityView];
  removeIdentity: [{ identityId: string }, WalletState];
  disconnectSite: [{ origin: string }, WalletState];
  approvalGet: [{ id: string }, ApprovalView | null];
  /**
   * keepReceipt: the user turned on "Keep the receipt in Weft". Only this
   * window can set it. choice: weft_castBallot's option, 0-based, which only
   * the window knows.
   */
  approvalDecide: [{ id: string; approved: boolean; keepReceipt?: boolean; choice?: number }, ApprovalOutcome];
  /** Weft Experimental: reads the election for an open weft_castBallot window (docs/adr/0007). */
  ballotRead: [{ id: string }, BallotReadView];
  /** Weft Experimental: refreshes the network from its invite, for a channel it doesn't list, then reads again. */
  ballotRefreshInvite: [{ id: string }, BallotReadView];
  /** Weft Experimental (docs/adr/0008): the window's voting module didn't start, so the request fails with -32603. */
  ballotModuleFailed: [{ id: string; error: string }, BallotReadView];
  /** Weft Experimental (docs/adr/0008): saves a voter credential the popup sealed. */
  voterCredentialAdd: [{ record: VoterCredentialRecord }, VoterCredentialView];
  /** Weft Experimental: a voter credential's record, with its secrets still sealed, for the page that opens them. */
  voterCredential: [{ id: string }, VoterCredentialRecord | null];
  voterCredentialRemove: [{ id: string }, WalletState];
  /** A kept receipt with its choice and salt. Needs Weft unlocked. */
  receiptGet: [{ id: string }, ReceiptView | null];
  receiptRemove: [{ id: string }, null];
  /** How many receipts an identity's activity keeps, for the sheet that removes it. */
  receiptsOf: [{ identityId: string }, { count: number; elections: string[] }];
  /** The requests waiting in open approval windows, so the popup can say so. */
  approvalsPending: [undefined, ApprovalView["method"][]];
  /** Changes where Weft reaches a network, or its channels. */
  updateNetwork: [
    { networkId: string; patch: Partial<Pick<NetworkRecord, "name" | "organization" | "relayUrl" | "caUrl" | "caName" | "explorerUrl" | "channels">> },
    WalletState,
  ];
  /** Tries a relay and CA before saving them. Each is null when it answered, or the problem. */
  checkEndpoints: [{ relayUrl: string; caUrl: string; caName?: string }, { relay: string | null; ca: string | null }];
  /** Fetches the network's invite again, to compare with what Weft has. */
  refreshInvite: [{ networkId: string }, OrgInvite];
  /** Sent by open approval windows so the worker isn't stopped mid-approval. */
  keepAlive: [undefined, null];

  /* The lock (docs/adr/0005). Byte arrays travel as number[]. */
  vaultStatus: [undefined, VaultStatus];
  vaultSetup: [{ password: string }, VaultStatus];
  vaultUnlock: [{ password: string }, VaultStatus];
  vaultLock: [undefined, VaultStatus];
  /** Credential IDs and PRF salts for navigator.credentials.get. */
  passkeyRequest: [undefined, { id: string; salt: number[] }[]];
  passkeyUnlock: [{ credentialId: string; prfOutput: number[] }, VaultStatus];
  passkeyAdd: [{ credentialId: string; name: string; salt: number[]; prfOutput: number[] }, VaultStatus];
  passkeyRemove: [{ credentialId: string }, VaultStatus];
  changePassword: [{ current: string; next: string }, VaultStatus];
  setAutoLock: [{ minutes: number }, VaultStatus];
  /** For a forgotten password: deletes every key and identity. Networks are kept. */
  vaultReset: [undefined, VaultStatus];
}

export type UiMethod = keyof UiApi;

export interface UiRequest<M extends UiMethod = UiMethod> {
  channel: "weft-ui";
  method: M;
  payload: UiApi[M][0];
}

export type UiResponse<T> = { ok: true; value: T } | { ok: false; error: string; detail?: string };

/** An error from the worker: a plain message, and anything technical for "Details". */
export class UiError extends Error {
  readonly detail: string | undefined;

  constructor(message: string, detail?: string) {
    super(message);
    this.name = "UiError";
    this.detail = detail;
  }
}

/** Sent by the worker to open extension pages when something they show has changed. */
export interface UiEvent {
  channel: "weft-ui-event";
  /** activity: a record was saved; approvals: an approval window opened or finished. */
  event: "activity" | "approvals";
}

/** Calls the background worker from an extension page. */
export async function ui<M extends UiMethod>(
  method: M,
  ...payload: UiApi[M][0] extends undefined ? [] : [UiApi[M][0]]
): Promise<UiApi[M][1]> {
  const request: UiRequest<M> = { channel: "weft-ui", method, payload: payload[0] as UiApi[M][0] };
  const response = (await browser.runtime.sendMessage(request)) as UiResponse<UiApi[M][1]> | undefined;
  if (!response) throw new UiError("Weft's background worker didn't answer. Close this window and open Weft again.");
  if (!response.ok) throw new UiError(response.error, response.detail);
  return response.value;
}

/* Provider traffic: bridge content script <-> background. */

export interface ProviderRequest {
  channel: "weft-provider";
  /** Any method name a page sends; the background worker answers 4200 for one this build doesn't offer. */
  method: AnyMethod;
  params?: unknown;
}

export type ProviderResponse = { result: unknown } | { error: WeftErrorShape };

/** Background -> bridge, for events such as identityChanged. */
export interface ProviderEventMessage {
  channel: "weft-provider-event";
  event: string;
  payload: unknown;
}
