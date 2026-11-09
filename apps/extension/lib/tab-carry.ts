import { useEffect, useRef, useState } from "react";
import { browser } from "wxt/browser";

/*
 * What the toolbar popup carries to the tab it opens when a step needs a
 * host Weft doesn't hold yet (lib/permissions.ts). The screen and an invite
 * link go in the tab's address. The other fields typed on the screen go in
 * browser.storage.session, which is in memory and cleared when the browser
 * closes, under a one-time id. Only that id goes in the address. The tab
 * reads the fields once and deletes them, and they expire after
 * CARRY_TTL_MS, so a tab opened later finds nothing.
 *
 * Secrets are never saved: enrolment secrets, passwords, private keys and
 * any other key material. A screen lists them separately, as whether each
 * was typed, so the tab can ask for them again.
 */

/** How long carried fields wait for their tab. */
export const CARRY_TTL_MS = 10 * 60 * 1000;

/** The browser.storage.session key that holds every carried entry, by id. */
export const CARRY_KEY = "tabCarry";

/** What one screen hands over when the popup moves to a tab. */
export interface CarrySnapshot {
  /** Non-secret fields, by name, as typed. */
  fields: Record<string, string>;
  /** Secret fields, by name: true when something was typed in it. Their values are never read here. */
  secrets?: Record<string, boolean>;
}

/** What a screen gets back in the tab. */
export interface CarriedScreen {
  /** The fields typed in the popup, by name. Empty when nothing was carried. */
  fields: Record<string, string>;
  /** The secret fields that were typed in the popup and left out. */
  leftOut: string[];
}

interface Entry {
  expires: number;
  screens: Record<string, CarriedScreen>;
}

/** The screens open in the popup, each with how to read its fields now. */
const registered = new Map<string, () => CarrySnapshot>();

/** The screens read from storage in the tab, until each screen takes its own. */
let arrived: Record<string, CarriedScreen> = {};

const NOTHING: CarriedScreen = { fields: {}, leftOut: [] };

/** The session storage area, or null where the browser has none. */
function session() {
  try {
    return (browser.storage as Partial<typeof browser.storage> | undefined)?.session ?? null;
  } catch {
    return null;
  }
}

/** Lets a popup screen's fields be carried. Returns the function that stops it. */
export function registerCarry(screenKey: string, read: () => CarrySnapshot): () => void {
  registered.set(screenKey, read);
  return () => {
    if (registered.get(screenKey) === read) registered.delete(screenKey);
  };
}

/** Reads every registered screen now: its non-secret fields, and the names of the secrets typed. */
export function snapshot(): Record<string, CarriedScreen> {
  const screens: Record<string, CarriedScreen> = {};
  for (const [key, read] of registered) {
    let taken: CarrySnapshot;
    try {
      taken = read();
    } catch {
      continue;
    }
    // Empty fields are kept, since a field emptied on purpose differs from
    // one left as it was, but a screen with nothing typed isn't saved.
    const fields: Record<string, string> = {};
    for (const [name, value] of Object.entries(taken.fields)) {
      if (typeof value === "string") fields[name] = value;
    }
    const leftOut = Object.entries(taken.secrets ?? {})
      .filter(([, typed]) => Boolean(typed))
      .map(([name]) => name);
    if (Object.values(fields).some((v) => v !== "") || leftOut.length > 0) screens[key] = { fields, leftOut };
  }
  return screens;
}

const live = (all: Record<string, Entry>, now: number) => Object.fromEntries(Object.entries(all).filter(([, e]) => e && typeof e.expires === "number" && e.expires > now));

/**
 * Saves the popup's fields for the tab it's about to open, and returns the id
 * to put in the tab's address. Null when there's nothing to carry or nowhere
 * to keep it, so the tab carries nothing extra. Never throws. The fields are
 * read before anything is awaited, so they're the ones typed at the click.
 */
export async function saveCarry(now = Date.now()): Promise<string | null> {
  const screens = snapshot();
  if (Object.keys(screens).length === 0) return null;
  const area = session();
  if (!area) return null;
  try {
    const id = crypto.randomUUID();
    const stored = ((await area.get(CARRY_KEY))[CARRY_KEY] ?? {}) as Record<string, Entry>;
    await area.set({ [CARRY_KEY]: { ...live(stored, now), [id]: { expires: now + CARRY_TTL_MS, screens } } });
    return id;
  } catch {
    return null;
  }
}

/**
 * In the tab: reads the fields saved under `id`, once, and deletes them along
 * with any that have expired. Each screen then takes its own with
 * takeCarried. Never rejects.
 */
export function loadCarry(id: string, now = Date.now()): Promise<void> {
  // Asked twice for the same id (React runs a page's first effects twice in
  // development), it reads once.
  let load = loads.get(id);
  if (!load) {
    load = readCarry(id, now);
    loads.set(id, load);
  }
  return load;
}

const loads = new Map<string, Promise<void>>();

async function readCarry(id: string, now: number): Promise<void> {
  arrived = {};
  const area = session();
  if (!area) return;
  try {
    const stored = ((await area.get(CARRY_KEY))[CARRY_KEY] ?? {}) as Record<string, Entry>;
    const entry = stored[id];
    const rest = live(stored, now);
    delete rest[id];
    if (Object.keys(rest).length > 0) await area.set({ [CARRY_KEY]: rest });
    else await area.remove(CARRY_KEY);
    if (entry && entry.expires > now && entry.screens && typeof entry.screens === "object") arrived = entry.screens;
  } catch {
    arrived = {};
  }
}

/**
 * The fields carried for one screen. A screen takes them as it first opens in
 * the tab; opened again later, it starts empty. They stay for the rest of
 * the current task, because React may build a screen twice as it opens.
 */
export function takeCarried(screenKey: string): CarriedScreen {
  const screen = arrived[screenKey];
  if (!screen) return NOTHING;
  setTimeout(() => {
    if (arrived[screenKey] === screen) delete arrived[screenKey];
  }, 0);
  return {
    fields: screen.fields && typeof screen.fields === "object" ? screen.fields : {},
    leftOut: Array.isArray(screen.leftOut) ? screen.leftOut : [],
  };
}

/**
 * For a popup screen: `read` gives its fields as they are now, read only when
 * the popup moves to a tab. Returns what was carried for this screen in a
 * tab, for its fields' first values and to say which secrets to type again.
 */
export function useCarriedFields(screenKey: string, read: () => CarrySnapshot): CarriedScreen {
  const [carried] = useState(() => takeCarried(screenKey));
  const latest = useRef(read);
  latest.current = read;
  useEffect(() => registerCarry(screenKey, () => latest.current()), [screenKey]);
  return carried;
}

/**
 * The line shown by a secret field in the tab when the popup had it typed and
 * left it out: `ask` says what to do, for example "Enter the enrolment secret
 * again.", and the line says why.
 */
export function secretAgain(ask: string): string {
  return `${ask} Weft doesn't carry secrets between windows.`;
}
