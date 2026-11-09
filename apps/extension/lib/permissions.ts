import { browser } from "wxt/browser";
import { UiError } from "./messages";
import { saveCarry } from "./tab-carry";

/*
 * A toolbar popup can't keep a permission prompt in view. Chrome closes the
 * popup when its prompt opens, so the step that asked is lost. Firefox opens
 * the prompt behind the popup (Mozilla bug 1798454), so the popup waits,
 * blank, for an answer to a prompt nobody can see. So in the toolbar popup,
 * in every browser, a step that needs a host Weft doesn't hold yet is moved
 * to a tab, where the prompt shows in front and the page stays open.
 * Approval windows and tabs ask in place. Deciding that must not wait on the
 * browser, or the click no longer counts as one, so the popup keeps the
 * origins it holds (primeHostAccess) and checks them at once.
 */

/** Origins Weft holds, as the popup last read them. Null until read. */
let held: Set<string> | null = null;

/** The screen to reopen in a tab, set by the popup as it changes screen, and the invite link typed on it. */
let tabRoute: { name: string } | null = null;
let tabLink = "";

/**
 * True in the toolbar popup, false in a tab (popup.html opened in one, by the
 * popup or by hand) or a window. The browser says which pages are open as
 * its popup. Where it can't, popup.html without ?tab counts as the popup.
 */
export function inToolbarPopup(): boolean {
  if (!location.pathname.endsWith("/popup.html") || new URLSearchParams(location.search).has("tab")) return false;
  try {
    const popups = browser.extension.getViews({ type: "popup" });
    return popups.includes(window);
  } catch {
    return true;
  }
}

/** Reads the origins Weft holds, and keeps them up to date while the page is open. Called once when the popup starts. */
export async function primeHostAccess(): Promise<void> {
  const read = async () => {
    const all = await browser.permissions.getAll().catch(() => ({ origins: [] as string[] }));
    held = new Set(all.origins ?? []);
  };
  await read();
  browser.permissions.onAdded?.addListener(() => void read());
  browser.permissions.onRemoved?.addListener(() => void read());
}

/** The popup's current screen, to reopen in a tab. */
export function setTabRoute(route: { name: string }): void {
  tabRoute = route;
}

/** The invite link typed on Join from an invite, carried to the tab. */
export function setTabLink(link: string): void {
  tabLink = link;
}

/**
 * The tab's address part after popup.html?tab=1: the screen, the link when
 * there is one, and the id of the other fields saved for the tab
 * (lib/tab-carry.ts). The fields themselves never go in the address.
 */
function tabHash(route: { name: string } | null, link: string, carry: string | null): string {
  if (!route) return "";
  return `#${encodeURIComponent(JSON.stringify({ ...route, ...(link ? { link } : {}), ...(carry ? { carry } : {}) }))}`;
}

/** The screen a tab opened by the popup starts on, or null, and the id its fields were saved under, or null. */
export function tabStart(): { route: { name: string; [key: string]: unknown } | null; carry: string | null } {
  if (!new URLSearchParams(location.search).has("tab") || location.hash.length < 2) return { route: null, carry: null };
  try {
    const parsed = JSON.parse(decodeURIComponent(location.hash.slice(1))) as unknown;
    if (!parsed || typeof parsed !== "object" || typeof (parsed as { name?: unknown }).name !== "string") return { route: null, carry: null };
    const { carry, ...route } = parsed as { name: string; carry?: unknown };
    return { route, carry: typeof carry === "string" && carry !== "" ? carry : null };
  } catch {
    return { route: null, carry: null };
  }
}

/** True in a tab the popup opened. */
export function inPopupTab(): boolean {
  return location.pathname.endsWith("/popup.html") && new URLSearchParams(location.search).has("tab");
}

/** Whether the popup knows it holds every origin. Unknown counts as no. */
function holdsAll(origins: string[]): boolean {
  return held !== null && origins.every((o) => held!.has(o) || held!.has("<all_urls>"));
}

/** The error a popup step ends with once it has moved itself to a tab. */
export class MovedToTab extends UiError {
  constructor() {
    super("Weft opened this step in a tab, because the browser can't ask for access over this popup.");
    this.name = "MovedToTab";
  }
}

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
  // The toolbar popup can't keep the prompt in view (above): continue in a
  // tab instead, with the screen's other fields saved for it first. Secrets
  // stay behind (lib/tab-carry.ts).
  if (inToolbarPopup() && !holdsAll(origins)) {
    const route = tabRoute;
    const link = tabLink;
    void saveCarry()
      .then((carry) => browser.tabs.create({ url: `${browser.runtime.getURL("/popup.html")}?tab=1${tabHash(route, link, carry)}` }))
      .then(() => window.close());
    throw new MovedToTab();
  }
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
