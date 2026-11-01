import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { LIVE } from "./pages.ts";

/**
 * Runs a live page's script (LIVE in pages.ts) against the few parts of a
 * page it touches: the note, its text and Check now. `online` decides
 * whether the explorer answers.
 */
function livePage() {
  const page = { online: true, said: [] as string[], busy: [] as boolean[], intervals: 0, fetched: [] as string[] };
  const element = (id: string) => {
    const attrs: Record<string, string> = {};
    const classes = new Set<string>();
    const listeners: Record<string, () => void> = {};
    return {
      id,
      hidden: true,
      textContent: "",
      classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c), contains: (c: string) => classes.has(c) },
      getAttribute: (n: string) => attrs[n] ?? null,
      setAttribute: (n: string, v: string) => void (attrs[n] = String(v)),
      removeAttribute: (n: string) => void delete attrs[n],
      hasAttribute: (n: string) => n in attrs,
      addEventListener: (type: string, f: () => void) => void (listeners[type] = f),
      contains: (other: unknown): boolean => other === note || other === button,
      focus: () => void (document.activeElement = h1),
      press: () => listeners.click?.(),
    };
  };
  const note = element("live-note");
  const text = element("live-note-text");
  const button = element("live-check");
  const h1 = element("h1");
  const byId: Record<string, unknown> = { "live-note": note, "live-note-text": text, "live-check": button };
  const document = {
    hidden: false,
    activeElement: null as unknown,
    getElementById: (id: string) => byId[id] ?? null,
    querySelector: (s: string) => (s === "main h1" ? h1 : null),
    querySelectorAll: () => [],
    addEventListener: () => {},
  };
  const fetch = (url: string) => {
    page.fetched.push(url);
    if (!page.online) return Promise.reject(new Error("offline"));
    return Promise.resolve({ ok: true, json: async () => ({ channels: [{ channel: "mychannel", height: 86, state: "live", peerHeight: 86 }] }), text: async () => "<html></html>" });
  };
  runInNewContext(LIVE, {
    document,
    location: { search: "", href: "http://explorer.test/" },
    fetch,
    AbortSignal: { timeout: () => undefined },
    setInterval: () => ++page.intervals,
    DOMParser: class {
      parseFromString() {
        return { querySelector: () => null, querySelectorAll: () => [] };
      }
    },
    weftSay: (t: string) => page.said.push(t),
    weftBusy: (b: ReturnType<typeof element>, on: boolean) => {
      page.busy.push(on);
      if (on) b.setAttribute("aria-disabled", "true");
      else b.removeAttribute("aria-disabled");
    },
    weftRelative: () => {},
    scrollY: 0,
  });
  const settle = () => new Promise((r) => setTimeout(r, 0));
  return { page, note, text, button, h1, document, settle };
}

/** Three failed checks, each from a press, so the note shows. */
async function goOffline(live: ReturnType<typeof livePage>) {
  live.page.online = false;
  for (let i = 0; i < 3; i++) {
    live.button.press();
    await live.settle();
  }
}

describe("a live page's Check now", () => {
  it("shows the note after three failed checks, with when it stopped", async () => {
    const live = livePage();
    await live.settle();
    expect(live.note.hidden).toBe(true);
    await goOffline(live);
    expect(live.note.hidden).toBe(false);
    expect(live.note.classList.contains("is-open")).toBe(true);
    expect(live.page.said).toContain("This page has stopped updating. It checks again every 4 seconds.");
  });

  it("retries at once, busy while it tries, and says so when the explorer still doesn't answer", async () => {
    const live = livePage();
    await live.settle();
    await goOffline(live);
    const checks = live.page.fetched.length;
    live.button.press();
    expect(live.button.getAttribute("aria-disabled")).toBe("true");
    // A second press while it tries is ignored.
    live.button.press();
    await live.settle();
    expect(live.page.fetched.length).toBe(checks + 1);
    expect(live.button.getAttribute("aria-disabled")).toBe(null);
    expect(live.note.hidden).toBe(false);
    expect(live.text.textContent).toMatch(/^This page stopped updating at \d\d:\d\d\. Checked again at \d\d:\d\d and the explorer didn't answer\. It checks again every 4 seconds\.$/);
  });

  it("on success the note leaves, focus goes to the heading and the page catches up", async () => {
    const live = livePage();
    await live.settle();
    await goOffline(live);
    live.page.online = true;
    live.page.fetched.length = 0;
    live.document.activeElement = live.button;
    live.button.press();
    await live.settle();
    await live.settle();
    expect(live.note.hidden).toBe(true);
    expect(live.note.classList.contains("is-open")).toBe(false);
    expect(live.document.activeElement).toBe(live.h1);
    expect(live.h1.getAttribute("tabindex")).toBe("-1");
    expect(live.page.fetched).toEqual(["/api/v1/status", "http://explorer.test/"]);
    expect(live.page.said.at(-1)).toBe("This page is updating again.");
    expect(live.page.busy).toEqual([true, false, true, false, true, false, true, false]);
  });
});
