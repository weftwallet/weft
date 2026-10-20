/**
 * Which sites are connected to which identities, and the events they hear.
 *
 * A site connects to one identity at a time and only ever learns about the
 * identities the user approved for it. Switching to an identity a site isn't
 * connected to disconnects it (reason "identity-changed"); it has to ask
 * again, like MetaMask asking per account.
 */

import { summarizeIdentity } from "@weftwallet/core";
import type { DisconnectReason, WeftEvent, WeftEvents } from "@weftwallet/protocol";
import { browser } from "wxt/browser";
import { db, type SiteRecord } from "./db";
import type { ProviderEventMessage } from "./messages";
import { activeIdentity } from "./wallet";

function identityIdsOf(site: SiteRecord, _activeId?: string | null): string[] {
  return site.identityIds ?? [];
}

/**
 * Sites saved before connections were per identity have no list. Pin them to
 * the identity that was active, once, at startup.
 */
export async function migrateSites(): Promise<void> {
  const current = await activeId();
  for (const site of await db.all<SiteRecord>("sites")) {
    if (site.identityIds) continue;
    if (current) await db.put<SiteRecord>("sites", { ...site, identityIds: [current] });
    else await db.delete("sites", site.origin);
  }
}

async function activeId(): Promise<string | null> {
  return (await db.settings()).activeIdentityId;
}

/** Origins connected to this identity. */
export async function originsConnectedTo(identityId: string | null): Promise<string[]> {
  if (!identityId) return [];
  const current = await activeId();
  return (await db.all<SiteRecord>("sites"))
    .filter((s) => identityIdsOf(s, current).includes(identityId))
    .map((s) => s.origin);
}

/** True when the site may use the active identity. */
export async function isConnected(origin: string): Promise<boolean> {
  const current = await activeId();
  const site = await db.get<SiteRecord>("sites", origin);
  return Boolean(site && current && identityIdsOf(site, current).includes(current));
}

/** Identity IDs this site has been approved for. */
export async function connectedIdentityIds(origin: string): Promise<string[]> {
  const site = await db.get<SiteRecord>("sites", origin);
  return site ? identityIdsOf(site, await activeId()) : [];
}

export async function connectSite(origin: string, identityId: string): Promise<void> {
  const site = await db.get<SiteRecord>("sites", origin);
  const ids = site ? identityIdsOf(site, await activeId()) : [];
  await db.put<SiteRecord>("sites", {
    origin,
    connectedAt: site?.connectedAt ?? Date.now(),
    identityIds: Array.from(new Set([...ids, identityId])),
  });
}

/** Sends an event to these sites' tabs only. The bridge drops it in any other origin. */
export async function sendTo<E extends WeftEvent>(origins: string[], event: E, payload: WeftEvents[E]): Promise<void> {
  if (origins.length === 0) return;
  const message: ProviderEventMessage & { origins: string[] } = { channel: "weft-provider-event", event, payload, origins };
  for (const tab of await browser.tabs.query({})) {
    if (tab.id === undefined) continue;
    browser.tabs.sendMessage(tab.id, message).catch(() => {
      /* Tab without our content script. */
    });
  }
}

/** Sends an event to the sites connected to the active identity. */
export async function sendToActiveSites<E extends WeftEvent>(event: E, payload: WeftEvents[E]): Promise<void> {
  await sendTo(await originsConnectedTo(await activeId()), event, payload);
}

/** Forgets sites entirely and tells their open tabs. */
export async function disconnectSites(origins: string[], reason: DisconnectReason): Promise<void> {
  for (const origin of origins) await db.delete("sites", origin);
  await sendTo(origins, "disconnect", { reason });
}

/** Removes an identity from every site's list, dropping sites left with none. */
export async function forgetIdentity(identityId: string): Promise<void> {
  const current = await activeId();
  for (const site of await db.all<SiteRecord>("sites")) {
    const ids = identityIdsOf(site, current);
    if (!ids.includes(identityId)) continue;
    const rest = ids.filter((id) => id !== identityId);
    if (rest.length === 0) await db.delete("sites", site.origin);
    else await db.put<SiteRecord>("sites", { ...site, identityIds: rest });
  }
}

export async function notifyNetworkChanged(origins?: string[]): Promise<void> {
  const active = await activeIdentity();
  if (!active?.channel) return;
  const payload = { networkId: active.network.id, channel: active.channel };
  if (origins) await sendTo(origins, "networkChanged", payload);
  else await sendToActiveSites("networkChanged", payload);
}

/**
 * Runs a change that may switch the active identity, then tells sites what
 * changed for them: the new identity if they're connected to it, or a
 * disconnect if they were connected to the old one and not the new one.
 */
export async function withActiveChange<T>(change: () => Promise<T>): Promise<T> {
  const previousId = await activeId();
  const before = new Set(await originsConnectedTo(previousId));
  const result = await change();
  const currentId = await activeId();
  if (currentId === previousId) return result;

  const now = await originsConnectedTo(currentId);
  const active = await activeIdentity();
  if (active && now.length > 0) {
    await sendTo(now, "identityChanged", await summarizeIdentity(active.record));
    await notifyNetworkChanged(now);
  }
  const lost = [...before].filter((origin) => !now.includes(origin));
  await sendTo(lost, "disconnect", { reason: currentId ? "identity-changed" : "no-identity" });
  return result;
}
