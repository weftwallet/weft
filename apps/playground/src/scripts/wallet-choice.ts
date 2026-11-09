/**
 * The wallet this page uses (docs/adr/0010). With one Weft in the browser it
 * is window.weft, as before. With Weft and Weft Experimental both installed,
 * the visitor chooses one in step 1 (Playground.astro), and every step, the
 * Private election section (PrivateElection.astro) and the provider log use
 * that one.
 *
 * The default is window.weft's wallet, found among the announcements by
 * provider identity. A visitor's choice is kept by rdns in localStorage, and
 * used on the next visit when that wallet is in the browser.
 */
import type { WeftProvider, WeftProviderInfo } from "@weftwallet/sdk";
import { onWallets, wallets, type WeftProviderDetail } from "@weftwallet/ui/wallets";

const KEY = "weft-playground-wallet";

export interface Choice {
  provider: WeftProvider;
  /** Its announcement, when it made one. */
  info: WeftProviderInfo | null;
}

/** What changed: the wallet now in use, the one before it, and whether the visitor chose it. */
export interface ChoiceChange {
  current: Choice;
  previous: Choice | null;
  byVisitor: boolean;
}

let current: Choice | null = null;
/** Whether the visitor has chosen on this page, so a late announcement doesn't override them. */
let visitorChose = false;
const listeners = new Set<(change: ChoiceChange) => void>();

function windowWeft(): WeftProvider | null {
  const weft = (window as { weft?: WeftProvider }).weft;
  return weft?.isWeft ? weft : null;
}

function remembered(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

function remember(rdns: string) {
  try {
    localStorage.setItem(KEY, rdns);
  } catch {
    /* storage blocked: the choice lasts until the page reloads */
  }
}

/** The wallets that have announced themselves, Weft first. */
export const found = (): WeftProviderDetail[] => wallets();

/** Whether the browser has more than one Weft, so the page names the wallet it uses. */
export const several = (): boolean => wallets().length > 1;

/** The wallet in use, or null before the page has looked or when there is none. */
export const chosen = (): Choice | null => current;

/**
 * The wallet in use, or before the page has looked (Playground.astro waits
 * a moment to say whether Weft is installed), the one it will choose. For
 * the parts of the page that don't wait, such as the Private election
 * section, so they don't show another wallet's state first.
 */
export const inUse = (): Choice | null => current ?? preferred();

/** The wallet in use's name when the browser has more than one Weft, for the log and the page's sentences; null with one. */
export const chosenName = (): string | null => (several() && current?.info ? current.info.name : null);

/**
 * The options for the SDK's getWeft() that reach the wallet in use, as code:
 * `{ rdns: "…" }` when the browser has more than one Weft, and nothing with one.
 */
export const sdkOptions = (): string => {
  const info = inUse()?.info;
  return several() && info ? `{ rdns: ${JSON.stringify(info.rdns)} }` : "";
};

/** The wallet the page uses unless the visitor says otherwise: the one they chose last time, or else window.weft's. */
function preferred(): Choice | null {
  const list = wallets();
  const weft = windowWeft();
  const rdns = remembered();
  const pick = (rdns ? list.find((d) => d.info.rdns === rdns) : undefined) ?? (weft ? list.find((d) => d.provider === weft) : undefined);
  if (pick) return { provider: pick.provider, info: pick.info };
  if (weft) return { provider: weft, info: null };
  return list[0] ? { provider: list[0].provider, info: list[0].info } : null;
}

function set(next: Choice, byVisitor: boolean) {
  if (current?.provider === next.provider) return;
  const previous = current;
  current = next;
  for (const listener of listeners) listener({ current: next, previous, byVisitor });
}

/** Chooses the default wallet, once, and returns it; null when the browser has no Weft. */
export function resolve(): Choice | null {
  if (current) return current;
  const pick = preferred();
  if (pick) set(pick, false);
  return current;
}

/** The visitor chose the wallet that announced itself with `uuid`: the page uses it, and remembers it by rdns. */
export function choose(uuid: string) {
  const pick = wallets().find((d) => d.info.uuid === uuid);
  if (!pick) return;
  visitorChose = true;
  remember(pick.info.rdns);
  set({ provider: pick.provider, info: pick.info }, true);
}

/** Calls `listener` each time the wallet in use changes, the first choice included. Returns a function that stops it. */
export function onChoice(listener: (change: ChoiceChange) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// A wallet that announces itself after the page chose: when it is the one
// the visitor chose last time, the page switches to it, unless they have
// chosen on this page already. Otherwise the page records the announcement
// of the wallet in use (current.info), so it can name it.
onWallets((list) => {
  if (!current || visitorChose) return;
  const pick = preferred();
  if (pick && pick.provider !== current.provider) set(pick, false);
  else if (!current.info) {
    const mine = list.find((d) => d.provider === current!.provider);
    if (mine) current = { provider: mine.provider, info: mine.info };
  }
});
