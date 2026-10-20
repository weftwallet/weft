/**
 * Typed messages between the extension's own pages (popup, approval window)
 * and the background worker. Page-to-wallet provider traffic is separate and
 * goes through the bridge content script.
 */

import type { ContractCall, IdentitySummary, OrgInvite, WeftErrorShape, WeftMethod } from "@weftwallet/protocol";
import { browser } from "wxt/browser";
import type { ActivityRecord, NetworkRecord, Settings, SiteRecord } from "./db";
import type { VaultStatus } from "./vault";

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
}

export type NetworkInput = Omit<NetworkRecord, "id">;

export interface ApprovalView {
  id: string;
  origin: string;
  method: Extract<WeftMethod, "weft_connect" | "weft_evaluate" | "weft_submit" | "weft_addNetwork">;
  call: ContractCall | null;
  identity: IdentityView | null;
  /** weft_addNetwork only: the resolved HTTPS URL of the invite. */
  inviteUrl?: string;
}

export type ApprovalOutcome =
  | { status: "approved"; activityId: string | null }
  | { status: "failed"; activityId: string | null; title: string; detail: string }
  | { status: "rejected" };

/** Every UI request: name -> [payload, result]. */
export interface UiApi {
  state: [undefined, WalletState];
  activity: [undefined, ActivityRecord[]];
  activityItem: [{ id: string }, ActivityRecord | null];
  setActive: [{ identityId: string; channel?: string }, WalletState];
  setChannel: [{ channel: string }, WalletState];
  fetchInvite: [{ link: string }, OrgInvite];
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
  approvalDecide: [{ id: string; approved: boolean }, ApprovalOutcome];
  /** Changes where Weft reaches a network, or its channels. */
  updateNetwork: [
    { networkId: string; patch: Partial<Pick<NetworkRecord, "name" | "organization" | "relayUrl" | "caUrl" | "caName" | "channels">> },
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
}

export type UiMethod = keyof UiApi;

export interface UiRequest<M extends UiMethod = UiMethod> {
  channel: "weft-ui";
  method: M;
  payload: UiApi[M][0];
}

export type UiResponse<T> = { ok: true; value: T } | { ok: false; error: string };

/** Calls the background worker from an extension page. */
export async function ui<M extends UiMethod>(
  method: M,
  ...payload: UiApi[M][0] extends undefined ? [] : [UiApi[M][0]]
): Promise<UiApi[M][1]> {
  const request: UiRequest<M> = { channel: "weft-ui", method, payload: payload[0] as UiApi[M][0] };
  const response = (await browser.runtime.sendMessage(request)) as UiResponse<UiApi[M][1]> | undefined;
  if (!response) throw new Error("The wallet did not respond. Try reopening it.");
  if (!response.ok) throw new Error(response.error);
  return response.value;
}

/* Provider traffic: bridge content script <-> background. */

export interface ProviderRequest {
  channel: "weft-provider";
  method: WeftMethod;
  params?: unknown;
}

export type ProviderResponse = { result: unknown } | { error: WeftErrorShape };

/** Background -> bridge, for events such as identityChanged. */
export interface ProviderEventMessage {
  channel: "weft-provider-event";
  event: string;
  payload: unknown;
}
