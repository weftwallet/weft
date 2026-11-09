/**
 * Every Weft in this browser, for Weft's own pages (docs/adr/0010). Each
 * wallet announces its provider with weft:announceProvider; this keeps one
 * entry per wallet, by its uuid, asks every wallet to announce itself once,
 * and tells the page each time the list grows. With Weft and Weft
 * Experimental both installed, the list has two.
 *
 * An announcement's info is what the announcer claims. Any script on the
 * page can announce a provider named "Weft", which is the same trust as
 * window.weft.
 */
import { ANNOUNCE_PROVIDER_EVENT, REQUEST_PROVIDER_EVENT, type WeftProvider, type WeftProviderDetail } from "@weftwallet/protocol";

export type { WeftProvider, WeftProviderDetail };

const found: WeftProviderDetail[] = [];
const listeners = new Set<(wallets: WeftProviderDetail[]) => void>();
let listening = false;

/** By name, so Weft comes before Weft Experimental however they loaded. */
const sorted = () => [...found].sort((a, b) => a.info.name.localeCompare(b.info.name, "en"));

function listen() {
  if (listening) return;
  listening = true;
  window.addEventListener(ANNOUNCE_PROVIDER_EVENT, (event) => {
    const detail = (event as CustomEvent<Partial<WeftProviderDetail> | null>).detail;
    if (typeof detail?.info?.uuid !== "string" || typeof detail.info.name !== "string" || detail.provider?.isWeft !== true) return;
    if (found.some((d) => d.info.uuid === detail.info!.uuid)) return;
    found.push(detail as WeftProviderDetail);
    const list = sorted();
    for (const listener of listeners) listener(list);
  });
  window.dispatchEvent(new Event(REQUEST_PROVIDER_EVENT));
}

/** The wallets that have announced themselves so far. */
export function wallets(): WeftProviderDetail[] {
  listen();
  return sorted();
}

/** Calls `listener` with the whole list each time a wallet announces itself for the first time. Returns a function that stops it. */
export function onWallets(listener: (wallets: WeftProviderDetail[]) => void): () => void {
  listen();
  listeners.add(listener);
  return () => listeners.delete(listener);
}
