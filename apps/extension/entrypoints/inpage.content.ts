/**
 * Main-world content script: this wallet's provider for web pages
 * (lib/page-provider.ts). It announces the provider with
 * weft:announceProvider, and defines `window.weft` when it is the first Weft
 * in the page (docs/adr/0010). It has no extension privileges; every request
 * goes through the bridge.
 */

import MARK_MAIN from "@weftwallet/brand/logo/mark.svg?raw";
import MARK_EXPERIMENTAL from "@weftwallet/brand/logo/products/experimental.svg?raw";
import { defineContentScript } from "wxt/utils/define-content-script";
import { EXPERIMENTAL, FEATURES, PRODUCT_NAME, PRODUCT_RDNS } from "../lib/experimental";
import { installPageProvider, svgDataUri } from "../lib/page-provider";

export default defineContentScript({
  matches: ["https://*/*", "http://localhost/*", "http://127.0.0.1/*"],
  runAt: "document_start",
  world: "MAIN",
  main() {
    installPageProvider(window, {
      name: PRODUCT_NAME,
      rdns: PRODUCT_RDNS,
      // Each product's own mark: Weft Experimental's has its pinked edge.
      icon: svgDataUri(EXPERIMENTAL ? MARK_EXPERIMENTAL : MARK_MAIN),
      features: FEATURES,
    });
  },
});
