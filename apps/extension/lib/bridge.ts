/**
 * The bridge, as bridge.content.ts runs it in the isolated world. It relays
 * requests from this wallet's provider in the page (lib/page-provider.ts) to
 * the background worker, and the worker's events back. It accepts only
 * messages from this same window tagged with this wallet's channel
 * (messageTargets with the wallet's rdns, docs/adr/0010), so with Weft and
 * Weft Experimental both installed, each bridge answers only its own
 * wallet's provider.
 */

import { messageTargets, type PageToWalletMessage, type WalletToPageMessage } from "@weftwallet/protocol";
import type { ProviderEventMessage, ProviderRequest, ProviderResponse } from "./messages";

/** The page's window, as far as the bridge uses it. A fake one in tests. */
export interface BridgeWindow {
  readonly location: { readonly origin: string };
  readonly document: { addEventListener(type: string, listener: () => void): void };
  addEventListener(type: string, listener: (event: Event) => void): void;
  postMessage(message: unknown, targetOrigin: string): void;
}

/** The extension's runtime, as far as the bridge uses it. */
export interface BridgeRuntime {
  readonly id?: string;
  sendMessage(message: ProviderRequest): Promise<unknown>;
  onMessage: { addListener(listener: (message: unknown) => void): void };
}

/**
 * Starts relaying for the wallet named by `rdns`. `browser` is read on each
 * use, because once Weft is updated or reloaded its runtime is gone.
 * Returns a function that stops the check for that.
 */
export function installBridge(win: BridgeWindow, rdns: string, browser: { readonly runtime?: BridgeRuntime }): () => void {
  const targets = messageTargets(rdns);
  const origin = win.location.origin;
  const post = (message: WalletToPageMessage) => win.postMessage(message, origin);

  // When Weft is updated or reloaded, Chrome cuts this script off from it:
  // no more events, and requests fail. Nothing tells the page, so it would
  // keep showing "connected". Notice it and say so once.
  let cutOff = false;
  const stillAttached = () => {
    try {
      return Boolean(browser.runtime?.id);
    } catch {
      return false;
    }
  };
  const checkAttached = () => {
    if (cutOff || stillAttached()) return;
    cutOff = true;
    clearInterval(timer);
    post({ target: targets.toPage, kind: "event", event: "disconnect", payload: { reason: "wallet-updated" } });
  };
  const timer = setInterval(checkAttached, 2000);
  win.document.addEventListener("visibilitychange", checkAttached);
  win.addEventListener("focus", checkAttached);

  win.addEventListener("message", (e: Event) => {
    const event = e as MessageEvent;
    if (event.source !== win || event.origin !== origin) return;
    const data = event.data as Partial<PageToWalletMessage> | null;
    // Another wallet's requests carry its own tag: its own bridge answers them.
    if (data?.target !== targets.toWallet || typeof data.id !== "string" || !data.method) return;

    const request: ProviderRequest = { channel: "weft-provider", method: data.method, params: data.params };
    const id = data.id;
    // Promise.resolve().then: once cut off, sendMessage throws synchronously.
    Promise.resolve()
      .then(() => browser.runtime!.sendMessage(request) as Promise<ProviderResponse | undefined>)
      .then((response) => {
        if (!response) {
          post({ target: targets.toPage, kind: "response", id, error: { code: -32603, message: "Weft did not respond." } });
        } else if ("error" in response) {
          post({ target: targets.toPage, kind: "response", id, error: response.error });
        } else {
          post({ target: targets.toPage, kind: "response", id, result: response.result });
        }
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "Weft is unavailable.";
        post({
          target: targets.toPage,
          kind: "response",
          id,
          error: {
            code: -32603,
            // After Weft is updated or reloaded, this page's old connection
            // to it is dead until the page reloads.
            message:
              cutOff || /context invalidated|undefined/i.test(message) || !stillAttached()
                ? "Weft was updated. Reload this page to keep using it."
                : message,
          },
        });
      });
  });

  browser.runtime?.onMessage.addListener((message: unknown) => {
    const m = message as Partial<ProviderEventMessage & { origins: string[] }>;
    if (m.channel !== "weft-provider-event" || !m.event) return;
    // Only connected sites hear about identity changes.
    if (!m.origins?.includes(origin)) return;
    post({ target: targets.toPage, kind: "event", event: m.event as never, payload: m.payload });
  });

  return () => clearInterval(timer);
}
