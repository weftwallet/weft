// Must load before @peculiar/x509 (via @weftwallet/core), whatever the import order.
import "reflect-metadata";
import { ErrorCode, WeftError } from "@weftwallet/protocol";
import { browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";
import { db, type ActivityRecord } from "../lib/db";
import type { ProviderResponse, UiApi, UiMethod, UiResponse } from "../lib/messages";
import {
  decideApproval,
  getApproval,
  handleProviderRequest,
  pendingApprovals,
  registerApprovalListeners,
} from "../lib/provider";
import {
  disconnectSites,
  forgetIdentity,
  migrateSites,
  notifyNetworkChanged,
  originsConnectedTo,
  sendTo,
  withActiveChange,
} from "../lib/sites";
import { attachVoterPort, ballotModuleFailed, ballotRead, ballotRefreshInvite } from "../lib/ballot/handler";
import { anonymousActivity, anonymousItem, anonymousReceiptView, removeAnonymousReceipt } from "../lib/voter/activity";
import { PORT_PREFIX } from "../lib/voter/remote";
import { addVoterCredential, removeVoterCredential, voterCredential } from "../lib/voter/store";
import { checkCertificates, registerCertificateWatch } from "../lib/certificate-watch";
import * as receipts from "../lib/receipts";
import * as vault from "../lib/vault";
import * as wallet from "../lib/wallet";

/** Requests only Weft Experimental's pages send (docs/adr/0007, 0008). */
type ExperimentalUiMethod = "ballotRead" | "ballotRefreshInvite" | "ballotModuleFailed" | "voterCredentialAdd" | "voterCredential" | "voterCredentialRemove";
type Handler<M extends UiMethod> = (payload: UiApi[M][0]) => Promise<UiApi[M][1]>;
type Handlers = { [M in Exclude<UiMethod, ExperimentalUiMethod>]: Handler<M> } & { [M in ExperimentalUiMethod]?: Handler<M> };

const handlers: Handlers = {
  state: () => wallet.getState(),
  // Weft Experimental's anonymous ballots are sealed, and shown with the rest while Weft is unlocked (docs/adr/0008).
  activity: async () =>
    import.meta.env.WEFT_EXPERIMENTAL === true
      ? [...(await db.recentActivity()), ...(await anonymousActivity())].sort((a, b) => b.at - a.at)
      : db.recentActivity(),
  activityItem: async ({ id }) =>
    (await db.get<ActivityRecord>("activity", id)) ?? (import.meta.env.WEFT_EXPERIMENTAL === true ? await anonymousItem(id) : null) ?? null,
  setActive: async ({ identityId, channel }) => {
    await withActiveChange(() => db.saveSettings({ activeIdentityId: identityId, activeChannel: channel ?? null }));
    await checkCertificates();
    return wallet.getState();
  },
  setChannel: async ({ channel }) => {
    await db.saveSettings({ activeChannel: channel });
    await notifyNetworkChanged();
    return wallet.getState();
  },
  fetchInvite: ({ link }) => wallet.fetchInvite(link),
  // Adding the first identity makes it active, so these can change what sites see.
  joinInvite: ({ invite, enrollmentId, secret, inviteUrl }) =>
    withActiveChange(() => wallet.enroll(wallet.inviteToNetwork(invite, inviteUrl), enrollmentId, secret)),
  enroll: ({ network, enrollmentId, secret }) => withActiveChange(() => wallet.enroll(network, enrollmentId, secret)),
  importIdentity: ({ network, certificate, privateKeyPem }) =>
    withActiveChange(() => wallet.importIdentity(network, certificate, privateKeyPem)),
  createCsr: ({ network, commonName }) => wallet.startCsr(network, commonName),
  completeCsr: ({ pendingId, certificate }) => withActiveChange(() => wallet.completeCsr(pendingId, certificate)),
  reenroll: async ({ identityId }) => {
    const view = await wallet.reenroll(identityId);
    // Sites using this identity get the new certificate.
    const active = await wallet.activeIdentity();
    if (active?.record.id === identityId) {
      const summary = await wallet.activeSummary();
      if (summary) await sendTo(await originsConnectedTo(identityId), "identityChanged", summary);
    }
    return view;
  },
  removeIdentity: async ({ identityId }) => {
    await withActiveChange(async () => {
      await wallet.removeIdentity(identityId);
      await forgetIdentity(identityId);
    });
    vault.forget(identityId);
    return wallet.getState();
  },
  disconnectSite: async ({ origin }) => {
    await disconnectSites([origin], "user");
    return wallet.getState();
  },
  updateNetwork: async ({ networkId, patch }) => {
    await wallet.updateNetwork(networkId, patch);
    // Sites using this network hear about it if their channel changed.
    const active = await wallet.activeIdentity();
    if (active?.network.id === networkId && patch.channels) await notifyNetworkChanged();
    return wallet.getState();
  },
  checkEndpoints: ({ relayUrl, caUrl, caName }) => wallet.checkEndpoints(relayUrl, caUrl, caName),
  refreshInvite: ({ networkId }) => wallet.refreshInvite(networkId),
  approvalGet: async ({ id }) => getApproval(id),
  approvalDecide: ({ id, approved, keepReceipt, choice }) => decideApproval(id, approved, keepReceipt === true, choice),
  // The build constant itself, so the normal build drops the ballot handler (lib/experimental.ts).
  ...(import.meta.env.WEFT_EXPERIMENTAL === true
    ? {
        ballotRead: ({ id }: { id: string }) => ballotRead(id),
        ballotRefreshInvite: ({ id }: { id: string }) => ballotRefreshInvite(id),
        ballotModuleFailed: ({ id, error }: { id: string; error: string }) => ballotModuleFailed(id, error),
        voterCredentialAdd: ({ record }: UiApi["voterCredentialAdd"][0]) => addVoterCredential(record),
        voterCredential: ({ id }: { id: string }) => voterCredential(id),
        voterCredentialRemove: async ({ id }: { id: string }) => (await removeVoterCredential(id), wallet.getState()),
      }
    : {}),
  receiptGet: async ({ id }) =>
    (await receipts.receiptView(id)) ?? (import.meta.env.WEFT_EXPERIMENTAL === true ? await anonymousReceiptView(id) : null),
  receiptRemove: async ({ id }) => {
    if (import.meta.env.WEFT_EXPERIMENTAL === true && (await removeAnonymousReceipt(id))) return null;
    await receipts.removeReceipt(id);
    return null;
  },
  receiptsOf: ({ identityId }) => receipts.receiptsOf(identityId),
  approvalsPending: async () => pendingApprovals(),
  keepAlive: async () => null,
  vaultStatus: () => vault.status(),
  vaultSetup: async ({ password }) => (await vault.setup(password), vault.status()),
  vaultUnlock: async ({ password }) => (await vault.unlockWithPassword(password), vault.status()),
  vaultLock: async () => (await vault.lock(), vault.status()),
  passkeyRequest: () => vault.passkeyRequest(),
  passkeyUnlock: async ({ credentialId, prfOutput }) => (
    await vault.unlockWithPasskey(credentialId, new Uint8Array(prfOutput)), vault.status()
  ),
  passkeyAdd: async ({ credentialId, name, salt, prfOutput }) => (
    await vault.addPasskey({ id: credentialId, name, salt: new Uint8Array(salt), prfOutput: new Uint8Array(prfOutput) }),
    vault.status()
  ),
  passkeyRemove: async ({ credentialId }) => (await vault.removePasskey(credentialId), vault.status()),
  changePassword: async ({ current, next }) => (await vault.changePassword(current, next), vault.status()),
  setAutoLock: async ({ minutes }) => (await vault.setAutoLock(minutes), vault.status()),
  vaultReset: async () => {
    const origins = await wallet.resetWallet();
    await disconnectSites(origins, "no-identity");
    return vault.status();
  },
};

// Using Weft from its own pages counts as activity for the auto-lock, except
// the requests an open window sends on its own.
const PASSIVE: UiMethod[] = ["keepAlive", "state", "vaultStatus", "approvalGet", "approvalsPending"];

export default defineBackground(() => {
  const extensionOrigin = new URL(browser.runtime.getURL("/")).origin;
  registerApprovalListeners();
  void migrateSites();
  registerCertificateWatch();
  vault.registerAutoLock();

  // Weft Experimental (docs/adr/0008): an approval window's idemix worker, which signs an anonymous ballot.
  if (import.meta.env.WEFT_EXPERIMENTAL === true) {
    browser.runtime.onConnect.addListener((port) => {
      if (!port.name.startsWith(PORT_PREFIX)) return;
      const fromExtensionPage = port.sender?.url ? new URL(port.sender.url).origin === extensionOrigin : false;
      if (!fromExtensionPage || port.sender?.id !== browser.runtime.id) return port.disconnect();
      if (!attachVoterPort(port.name.slice(PORT_PREFIX.length), port)) port.disconnect();
    });
  }

  browser.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    if (sender.id !== browser.runtime.id) return false;
    const m = message as { channel?: string; method?: string; payload?: unknown; params?: unknown };

    // Requests from the extension's own pages (popup, approval window).
    if (m.channel === "weft-ui") {
      const fromExtensionPage = sender.url ? new URL(sender.url).origin === extensionOrigin : false;
      if (!fromExtensionPage || !m.method || !(m.method in handlers)) return false;
      const handler = handlers[m.method as keyof Handlers] as (payload: unknown) => Promise<unknown>;
      if (!PASSIVE.includes(m.method as UiMethod)) void vault.touch();
      handler(m.payload)
        .then((value) => sendResponse({ ok: true, value } satisfies UiResponse<unknown>))
        .catch((error: unknown) => {
          const detail = (error as { detail?: unknown } | null)?.detail;
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            ...(typeof detail === "string" && detail ? { detail } : {}),
          } satisfies UiResponse<unknown>);
        });
      return true;
    }

    // Requests from web pages, forwarded by the bridge content script. The
    // origin comes from the browser (sender), never from the message.
    if (m.channel === "weft-provider") {
      const url = sender.url ?? sender.tab?.url;
      const origin = sender.origin ?? (url ? new URL(url).origin : null);
      if (!origin || origin === "null") return false;
      handleProviderRequest(origin, m.method, m.params)
        .then((result) => sendResponse({ result } satisfies ProviderResponse))
        .catch((error: unknown) => {
          const weftError =
            error instanceof WeftError
              ? error
              : new WeftError(ErrorCode.Internal, error instanceof Error ? error.message : String(error));
          sendResponse({ error: weftError.toJSON() } satisfies ProviderResponse);
        });
      return true;
    }
    return false;
  });
});
