// Must load before @peculiar/x509 (via @weftwallet/core), whatever the import order.
import "reflect-metadata";
import { ErrorCode, WeftError } from "@weftwallet/protocol";
import { browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";
import { db, type ActivityRecord } from "../lib/db";
import type { ProviderResponse, UiApi, UiMethod, UiResponse } from "../lib/messages";
import {
  broadcast,
  decideApproval,
  disconnectSites,
  getApproval,
  handleProviderRequest,
  registerApprovalListeners,
} from "../lib/provider";
import * as wallet from "../lib/wallet";

type Handlers = { [M in UiMethod]: (payload: UiApi[M][0]) => Promise<UiApi[M][1]> };

async function notifyIdentityChanged() {
  await broadcast("identityChanged", await wallet.activeSummary());
}

async function notifyNetworkChanged() {
  const active = await wallet.activeIdentity();
  if (!active) return;
  const { activeChannel } = await db.settings();
  const channel = activeChannel && active.network.channels.includes(activeChannel) ? activeChannel : active.network.channels[0];
  if (channel) await broadcast("networkChanged", { networkId: active.network.id, channel });
}

const handlers: Handlers = {
  state: () => wallet.getState(),
  activity: () => db.recentActivity(),
  activityItem: async ({ id }) => (await db.get<ActivityRecord>("activity", id)) ?? null,
  setActive: async ({ identityId, channel }) => {
    await db.saveSettings({ activeIdentityId: identityId, activeChannel: channel ?? null });
    await notifyIdentityChanged();
    await notifyNetworkChanged();
    return wallet.getState();
  },
  setChannel: async ({ channel }) => {
    await db.saveSettings({ activeChannel: channel });
    await notifyNetworkChanged();
    return wallet.getState();
  },
  fetchInvite: ({ link }) => wallet.fetchInvite(link),
  joinInvite: ({ invite, enrollmentId, secret }) => wallet.enroll(wallet.inviteToNetwork(invite), enrollmentId, secret),
  enroll: ({ network, enrollmentId, secret }) => wallet.enroll(network, enrollmentId, secret),
  importIdentity: ({ network, certificate, privateKeyPem }) => wallet.importIdentity(network, certificate, privateKeyPem),
  createCsr: ({ network, commonName }) => wallet.startCsr(network, commonName),
  completeCsr: ({ pendingId, certificate }) => wallet.completeCsr(pendingId, certificate),
  reenroll: async ({ identityId }) => {
    const view = await wallet.reenroll(identityId);
    await notifyIdentityChanged();
    return view;
  },
  removeIdentity: async ({ identityId }) => {
    await wallet.removeIdentity(identityId);
    const state = await wallet.getState();
    if (state.identities.length === 0) {
      // Nothing left to sign with: connected sites would only get errors.
      await disconnectSites(state.sites.map((s) => s.origin), "no-identity");
      return wallet.getState();
    }
    await notifyIdentityChanged();
    await notifyNetworkChanged();
    return state;
  },
  disconnectSite: async ({ origin }) => {
    await disconnectSites([origin], "user");
    return wallet.getState();
  },
  approvalGet: async ({ id }) => getApproval(id),
  approvalDecide: ({ id, approved }) => decideApproval(id, approved),
};

export default defineBackground(() => {
  const extensionOrigin = new URL(browser.runtime.getURL("/")).origin;
  registerApprovalListeners();

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
