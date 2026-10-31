import { browser } from "wxt/browser";
import { UiError } from "./messages";

/**
 * Asks the user for access to the hosts Weft needs for a network: its CA and
 * relay, or the server an invite comes from. Must run inside a click handler
 * (browsers require a user gesture). `what` names them for the message shown
 * if access is refused, for example "your organisation's CA and relay".
 */
export async function requestHostAccess(urls: string[], what = "your organisation's CA and relay"): Promise<void> {
  let parsed: URL[];
  try {
    parsed = urls.filter(Boolean).map((u) => new URL(u));
  } catch {
    throw new UiError("One of the addresses isn't a valid URL. Check it starts with https://.", urls.join(", "));
  }
  if (parsed.length === 0) return;
  const hosts = Array.from(new Set(parsed.map((u) => u.host))).join(" and ");
  // Weft can only ask for https:// hosts, and plain http:// on this machine.
  // Checked before asking, with no await, so the user gesture is kept.
  const plain = parsed.filter((u) => u.protocol === "http:" && u.hostname !== "localhost" && u.hostname !== "127.0.0.1");
  if (plain.length) {
    throw new UiError(`${plain.map((u) => u.host).join(" and ")} must use https://. Plain http:// works only for localhost.`);
  }
  // Each host is asked for without its port, so the grant covers the host
  // on any port. Chrome would accept a port, but Firefox reads
  // "localhost:8787" as a different host from the manifest's "localhost"
  // and refuses it as undeclared.
  const origins = Array.from(new Set(parsed.map((u) => `${u.protocol}//${u.hostname}/*`)));
  // Already-granted origins resolve without a prompt.
  let granted: boolean;
  try {
    granted = await browser.permissions.request({ origins });
  } catch (error) {
    // A browser can refuse to ask for a host it already has, as in a dev
    // build, where WXT makes the hosts required to reload content scripts.
    // Access is what matters, so check for it before calling this a failure.
    if (await browser.permissions.contains({ origins }).catch(() => false)) return;
    // Not the address: the browser itself refused, and its reason is in the details.
    throw new UiError(`The browser wouldn't let Weft ask for access to ${hosts}. Close this window, open Weft from the toolbar and try again.`, error instanceof Error ? error.message : String(error));
  }
  if (!granted) {
    throw new UiError(`Weft needs access to ${what} (${hosts}) to continue. Try again and choose Allow.`);
  }
}
