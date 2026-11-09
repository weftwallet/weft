/**
 * Weft Experimental only (docs/adr/0008): the idemix module's dedicated
 * worker, bundled from @weftwallet/idemix's own. lib/voter/module.ts starts
 * it from the page that needs it and terminates it when that page is done.
 *
 * It is an extension file of its own, /idemix-worker.js, built by WXT as an
 * unlisted script, so the worker always loads from the extension's origin.
 * A worker bundled with the page (new URL(..., import.meta.url)) would load
 * from the Vite dev server in a dev build, and browsers refuse to start a
 * worker from another origin. WXT builds this file to disk in dev too, and
 * rebuilds it when its code changes. wxt.config.ts leaves it out of the
 * normal build.
 */
import "@weftwallet/idemix/worker";
import { defineUnlistedScript } from "wxt/utils/define-unlisted-script";

// The worker's code runs as the import above loads: it answers the page's
// messages from then on, so there is nothing more to start.
export default defineUnlistedScript(() => {});
