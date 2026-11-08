/**
 * Weft Experimental only (docs/adr/0008): the idemix module's dedicated
 * worker, bundled from @weftwallet/idemix's own. module.ts starts it from
 * the page that needs it and terminates it when that page is done.
 */
import "@weftwallet/idemix/worker";
