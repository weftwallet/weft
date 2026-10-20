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
import { checkCertificates, registerCertificateWatch } from "../lib/certificate-watch";
import * as wallet from "../lib/wallet";

type Handlers = { [M in UiMethod]: (payload: UiApi[M][0]) => Promise<UiApi[M][1]> };

const handlers: Handlers = {
  state: () => wallet.getState(),
  activity: () => db.recentActivity(),
  activityItem: async ({ id }) => (await db.get<ActivityRecord>("activity", id)) ?? null,
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
  approvalDecide: ({ id, approved }) => decideApproval(id, approved),
  keepAlive: async () => null,
};

export default defineBackground(() => {
  const extensionOrigin = new URL(browser.runtime.getURL("/")).origin;
  registerApprovalListeners();
  void migrateSites();
  registerCertificateWatch();

  browser.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    if (sender.id !== browser.runtime.id) return false;
    const m = message as { channel?: string; method?: string; payload?: unknown; params?: unknown };

    // Requests from the extension's own pages (popup, approval window).
    if (m.channel === "weft-ui") {
      const fromExtensionPage = sender.url ? new URL(sender.url).origin === extensionOrigin : false;
      if (!fromExtensionPage || !m.method || !(m.method in handlers)) return false;
      const handler = handlers[m.method as UiMethod] as (payload: unknown) => Promise<unknown>;
      handler(m.payload)
        .then((value) => sendResponse({ ok: true, value } satisfies UiResponse<unknown>))
        .catch((error: unknown) =>
          sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) } satisfies UiResponse<unknown>),
        );
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
