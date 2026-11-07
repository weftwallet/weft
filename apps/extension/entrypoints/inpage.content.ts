/**
 * Main-world content script: defines `window.weft` for web pages.
 * It has no extension privileges; every request goes through the bridge.
 */

import {
  MESSAGE_TARGET,
  PROVIDER_VERSION,
  WeftError,
  type PageToWalletMessage,
  type AnyMethod,
  type AnyMethods,
  type RequestArgs,
  type WalletToPageMessage,
  type WeftEvent,
  type WeftEvents,
  type WeftProvider,
} from "@weftwallet/protocol";
import { defineContentScript } from "wxt/utils/define-content-script";
import { FEATURES } from "../lib/experimental";

export default defineContentScript({
  matches: ["https://*/*", "http://localhost/*", "http://127.0.0.1/*"],
  runAt: "document_start",
  world: "MAIN",
  main() {
    if (window.weft?.isWeft) return;

    const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
    const listeners = new Map<WeftEvent, Set<(payload: never) => void>>();

    window.addEventListener("message", (event: MessageEvent) => {
      if (event.source !== window || event.origin !== window.location.origin) return;
      const data = event.data as WalletToPageMessage | null;
      if (data?.target !== MESSAGE_TARGET.toPage) return;
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
      features: Object.freeze([...FEATURES]),
      request<M extends AnyMethod>(args: RequestArgs<M>): Promise<AnyMethods[M]["result"]> {
        const id = crypto.randomUUID();
        const message: PageToWalletMessage = { target: MESSAGE_TARGET.toWallet, id, method: args.method, params: args.params };
        return new Promise((resolve, reject) => {
          pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
          window.postMessage(message, window.location.origin);
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

    Object.defineProperty(window, "weft", { value: provider, writable: false, configurable: false });
    window.dispatchEvent(new Event("weft#initialized"));
  },
});
