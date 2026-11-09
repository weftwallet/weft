/**
 * The toolbar popup, in every browser, moves a step that needs a new host to
 * a tab, where the permission prompt shows in front and the page stays open:
 * Chrome closes the popup when its prompt opens, and Firefox opens the prompt
 * behind it (Mozilla bug 1798454). The popup asks in place for a host it
 * already holds, and tabs and windows always ask in place.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  requested: [] as string[][],
  tabs: [] as string[],
  closed: 0,
  held: [] as string[],
  /** What browser.extension.getViews({ type: "popup" }) returns, or throws. */
  popups: (): unknown[] => [],
}));

vi.mock("wxt/browser", () => ({
  browser: {
    permissions: {
      request: async ({ origins }: { origins: string[] }) => {
        calls.requested.push(origins);
        return true;
      },
      contains: async () => false,
      getAll: async () => ({ origins: calls.held }),
      onAdded: { addListener: () => {} },
      onRemoved: { addListener: () => {} },
    },
    tabs: {
      create: async ({ url }: { url: string }) => {
        calls.tabs.push(url);
        return {};
      },
    },
    runtime: { getURL: (path: string) => `moz-extension://weft${path}` },
    extension: { getViews: ({ type }: { type: string }) => (type === "popup" ? calls.popups() : []) },
  },
}));

const page = { close: () => (calls.closed += 1) };

/** The page at `url`, open as the toolbar popup or not. */
function at(url: string, { toolbar }: { toolbar: boolean }) {
  const u = new URL(url);
  vi.stubGlobal("location", { pathname: u.pathname, search: u.search, hash: u.hash });
  vi.stubGlobal("window", page);
  calls.popups = () => (toolbar ? [page] : []);
}

async function load() {
  vi.resetModules();
  return import("./permissions");
}

beforeEach(() => {
  calls.requested = [];
  calls.tabs = [];
  calls.closed = 0;
  calls.held = [];
  calls.popups = () => [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe.each([
  { browser: "Chrome", url: "chrome-extension://weft/popup.html" },
  { browser: "Firefox", url: "moz-extension://weft/popup.html" },
])("in $browser's toolbar popup", ({ url }) => {
  beforeEach(() => {
    at(url, { toolbar: true });
  });

  it("opens the step in a tab, with the screen and the link, instead of asking", async () => {
    const p = await load();
    expect(p.inToolbarPopup()).toBe(true);
    await p.primeHostAccess();
    p.setTabRoute({ name: "join" });
    p.setTabLink("http://localhost:8787/.well-known/weft-voter-invite/chair-2027.json");
    const moved = p.requestHostAccess(["http://localhost:8787/x.json"]);
    await expect(moved).rejects.toBeInstanceOf(p.MovedToTab);
    await expect(moved).rejects.toThrow("Weft opened this step in a tab, because the browser can't ask for access over this popup.");
    await vi.waitFor(() => expect(calls.closed).toBe(1));
    expect(calls.requested).toEqual([]);
    expect(calls.tabs).toHaveLength(1);
    const tab = new URL(calls.tabs[0]!);
    expect(tab.pathname).toBe("/popup.html");
    expect(tab.searchParams.has("tab")).toBe(true);
    expect(JSON.parse(decodeURIComponent(tab.hash.slice(1)))).toEqual({
      name: "join",
      link: "http://localhost:8787/.well-known/weft-voter-invite/chair-2027.json",
    });
  });

  it("asks in place for a host Weft already holds", async () => {
    calls.held = ["http://localhost/*"];
    const p = await load();
    await p.primeHostAccess();
    await p.requestHostAccess(["http://localhost:7080"]);
    expect(calls.requested).toEqual([["http://localhost/*"]]);
    expect(calls.tabs).toEqual([]);
  });

  it("moves to a tab when it hasn't read what Weft holds yet", async () => {
    const p = await load();
    await expect(p.requestHostAccess(["https://ca.example.com"])).rejects.toBeInstanceOf(p.MovedToTab);
  });
});

describe("popup.html opened in a tab by hand, as the end-to-end tests open it", () => {
  it("isn't the toolbar popup, so it asks in place", async () => {
    at("chrome-extension://weft/popup.html", { toolbar: false });
    const p = await load();
    expect(p.inToolbarPopup()).toBe(false);
    expect(p.inPopupTab()).toBe(false);
    await p.requestHostAccess(["https://ca.example.com"]);
    expect(calls.requested).toEqual([["https://ca.example.com/*"]]);
    expect(calls.tabs).toEqual([]);
  });

  it("counts as the toolbar popup when the browser can't say which pages are popups", async () => {
    at("chrome-extension://weft/popup.html", { toolbar: false });
    calls.popups = () => {
      throw new Error("getViews isn't available");
    };
    const p = await load();
    expect(p.inToolbarPopup()).toBe(true);
  });
});

describe("in the tab the popup opened", () => {
  it("starts on the screen and link it came from, and asks in place", async () => {
    const route = { name: "join", link: "http://localhost:8787/a.json" };
    // The browser lists no popup here, but the address alone says it's a tab.
    at(`moz-extension://weft/popup.html?tab=1#${encodeURIComponent(JSON.stringify(route))}`, { toolbar: true });
    const p = await load();
    expect(p.inPopupTab()).toBe(true);
    expect(p.inToolbarPopup()).toBe(false);
    expect(p.tabStart().route).toEqual(route);
    await p.requestHostAccess(["https://ca.example.com"]);
    expect(calls.requested).toEqual([["https://ca.example.com/*"]]);
  });

  it("starts at home when the address part isn't a screen", async () => {
    at("moz-extension://weft/popup.html?tab=1#not-json", { toolbar: false });
    const p = await load();
    expect(p.tabStart().route).toBeNull();
  });
});

describe("in an approval window", () => {
  it("asks in place", async () => {
    at("chrome-extension://weft/approve.html?id=req", { toolbar: false });
    const p = await load();
    expect(p.inToolbarPopup()).toBe(false);
    await p.requestHostAccess(["https://ca.example.com"]);
    expect(calls.requested).toEqual([["https://ca.example.com/*"]]);
    expect(calls.tabs).toEqual([]);
  });
});
