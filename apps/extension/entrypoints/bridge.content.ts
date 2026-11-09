/**
 * Isolated-world content script. Relays requests from this wallet's provider
 * in the page (inpage.content.ts) to the background worker, and events back.
 * Only messages from this same window tagged with this wallet's channel are
 * accepted (lib/bridge.ts, docs/adr/0010).
 */

import { browser } from "wxt/browser";
import { defineContentScript } from "wxt/utils/define-content-script";
import { installBridge } from "../lib/bridge";
import { PRODUCT_RDNS } from "../lib/experimental";

export default defineContentScript({
  matches: ["https://*/*", "http://localhost/*", "http://127.0.0.1/*"],
  runAt: "document_start",
  allFrames: false,
  main() {
    installBridge(window, PRODUCT_RDNS, browser);
  },
});
