/**
 * Isolated-world content script. Relays requests from the page's
 * `window.weft` (inpage.content.ts) to the background worker, and events
 * back. Only messages tagged for Weft from this same window are accepted.
 */

import { MESSAGE_TARGET, type PageToWalletMessage, type WalletToPageMessage } from "@weftwallet/protocol";
import { browser } from "wxt/browser";
import { defineContentScript } from "wxt/utils/define-content-script";
import type { ProviderEventMessage, ProviderRequest, ProviderResponse } from "../lib/messages";

export default defineContentScript({
  matches: ["https://*/*", "http://localhost/*", "http://127.0.0.1/*"],
  runAt: "document_start",
  allFrames: false,
  main() {
    const post = (message: WalletToPageMessage) => window.postMessage(message, window.location.origin);

    window.addEventListener("message", (event: MessageEvent) => {
      if (event.source !== window || event.origin !== window.location.origin) return;
      const data = event.data as Partial<PageToWalletMessage> | null;
      if (data?.target !== MESSAGE_TARGET.toWallet || typeof data.id !== "string" || !data.method) return;

      const request: ProviderRequest = { channel: "weft-provider", method: data.method, params: data.params };
      const id = data.id;
      browser.runtime
        .sendMessage(request)
        .then((response: ProviderResponse | undefined) => {
          if (!response) {
            post({ target: MESSAGE_TARGET.toPage, kind: "response", id, error: { code: -32603, message: "Weft did not respond" } });
          } else if ("error" in response) {
            post({ target: MESSAGE_TARGET.toPage, kind: "response", id, error: response.error });
          } else {
            post({ target: MESSAGE_TARGET.toPage, kind: "response", id, result: response.result });
          }
        })
        .catch((error: unknown) => {
          post({
            target: MESSAGE_TARGET.toPage,
            kind: "response",
            id,
            error: { code: -32603, message: error instanceof Error ? error.message : "Weft is unavailable" },
          });
        });
    });

    browser.runtime.onMessage.addListener((message: unknown) => {
      const m = message as Partial<ProviderEventMessage & { origins: string[] }>;
      if (m.channel !== "weft-provider-event" || !m.event) return;
      // Only connected sites hear about identity changes.
      if (!m.origins?.includes(window.location.origin)) return;
      post({ target: MESSAGE_TARGET.toPage, kind: "event", event: m.event as never, payload: m.payload });
    });
  },
});
