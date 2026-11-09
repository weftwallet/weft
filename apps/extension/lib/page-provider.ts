/**
 * The provider a page talks to, as inpage.content.ts installs it in the
 * page's own world (docs/adr/0003, 0010). It has no extension privileges:
 * every request goes by window.postMessage to this wallet's bridge
 * (lib/bridge.ts), tagged with this wallet's channel, so with Weft and Weft
 * Experimental both installed each provider talks only to its own wallet.
 *
 * It announces itself with weft:announceProvider when it loads and each time
 * the page dispatches weft:requestProvider. The first Weft to load also
 * defines window.weft and fires weft#initialized; a second one leaves
 * window.weft as it is.
 */

import {
  ANNOUNCE_PROVIDER_EVENT,
  PROVIDER_VERSION,
  REQUEST_PROVIDER_EVENT,
  WeftError,
  messageTargets,
  type AnyMethod,
  type AnyMethods,
  type PageToWalletMessage,
  type RequestArgs,
  type WalletToPageMessage,
  type WeftEvent,
  type WeftEvents,
  type WeftProvider,
  type WeftProviderDetail,
} from "@weftwallet/protocol";

/** What the page is told about this wallet. */
export interface PageWallet {
  name: string;
  rdns: string;
  /** An SVG data URI. */
  icon: string;
  features: readonly string[];
}

/** The page's window, as far as the provider uses it. A fake one in tests. */
export interface PageWindow {
  readonly location: { readonly origin: string };
  weft?: WeftProvider;
  addEventListener(type: string, listener: (event: Event) => void): void;
  dispatchEvent(event: Event): boolean;
  postMessage(message: unknown, targetOrigin: string): void;
}

/** The mark as a data URI, for `info.icon`. */
export function svgDataUri(svg: string): string {
  return `data:image/svg+xml,${encodeURIComponent(svg.trim())}`;
}

/**
 * Builds this wallet's provider in `win`, announces it, and defines
 * `win.weft` when no Weft has yet. Returns what it announces.
 */
export function installPageProvider(win: PageWindow, wallet: PageWallet): WeftProviderDetail {
  const targets = messageTargets(wallet.rdns);
  const origin = win.location.origin;
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  const listeners = new Map<WeftEvent, Set<(payload: never) => void>>();

  win.addEventListener("message", (e: Event) => {
    const event = e as MessageEvent;
    if (event.source !== win || event.origin !== origin) return;
    const data = event.data as WalletToPageMessage | null;
    // Another wallet's responses and events carry its own tag.
    if (data?.target !== targets.toPage) return;
    if (data.kind === "response") {
      const entry = pending.get(data.id);
      if (!entry) return;
      pending.delete(data.id);
      if ("error" in data) entry.reject(WeftError.from(data.error));
      else entry.resolve(data.result);
    } else {
      for (const listener of listeners.get(data.event) ?? []) listener(data.payload as never);
    }
  });

  const provider: WeftProvider = Object.freeze({
    isWeft: true as const,
    version: PROVIDER_VERSION,
    features: Object.freeze([...wallet.features]),
    request<M extends AnyMethod>(args: RequestArgs<M>): Promise<AnyMethods[M]["result"]> {
      const id = crypto.randomUUID();
      const message: PageToWalletMessage = { target: targets.toWallet, id, method: args.method, params: args.params };
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
        win.postMessage(message, origin);
      });
    },
    on<E extends WeftEvent>(event: E, listener: (payload: WeftEvents[E]) => void) {
      let set = listeners.get(event);
      if (!set) listeners.set(event, (set = new Set()));
      set.add(listener as (payload: never) => void);
    },
    off<E extends WeftEvent>(event: E, listener: (payload: WeftEvents[E]) => void) {
      listeners.get(event)?.delete(listener as (payload: never) => void);
    },
  });

  const detail: WeftProviderDetail = Object.freeze({
    info: Object.freeze({ uuid: crypto.randomUUID(), name: wallet.name, icon: wallet.icon, rdns: wallet.rdns }),
    provider,
  });
  const announce = () => win.dispatchEvent(new CustomEvent(ANNOUNCE_PROVIDER_EVENT, { detail }));
  win.addEventListener(REQUEST_PROVIDER_EVENT, announce);

  // The first Weft keeps window.weft. If defining it fails (the page made
  // its own, unchangeable), the announcement still reaches the page.
  if (!win.weft?.isWeft) {
    try {
      Object.defineProperty(win, "weft", { value: provider, writable: false, configurable: false });
      win.dispatchEvent(new Event("weft#initialized"));
    } catch {
      /* window.weft is the page's own */
    }
  }
  announce();
  return detail;
}
