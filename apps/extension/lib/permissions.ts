import { browser } from "wxt/browser";
import { UiError } from "./messages";

/**
 * Asks the user for access to the hosts Weft needs for a network: its CA and
 * relay, or the server an invite comes from. Must run inside a click handler
 * (browsers require a user gesture). `what` names them for the message shown
 * if access is refused, e.g. "your organisation's CA and relay".
 */
export async function requestHostAccess(urls: string[], what = "your organisation's CA and relay"): Promise<void> {
  let origins: string[];
  try {
    origins = Array.from(new Set(urls.filter(Boolean).map((u) => `${new URL(u).origin}/*`)));
  } catch {
    throw new UiError("One of the addresses isn't a valid URL. Check it starts with https://.", urls.join(", "));
  }
  if (origins.length === 0) return;
  const hosts = origins.map((o) => new URL(o.slice(0, -2)).host).join(" and ");
  // Call request() first, with no await before it: an earlier await can
  // lose the user gesture. Already-granted origins resolve without a prompt.
  let granted: boolean;
  try {
    granted = await browser.permissions.request({ origins });
  } catch (error) {
    throw new UiError(
      `Weft can't ask for access to ${hosts}. Use an https:// address; plain http:// only works for localhost.`,
      error instanceof Error ? error.message : String(error),
    );
  }
  if (!granted) {
    throw new UiError(`Weft needs access to ${what} (${hosts}) to continue. Try again and choose Allow.`);
  }
}
