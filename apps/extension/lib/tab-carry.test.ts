/**
 * The fields the toolbar popup carries to the tab it opens when a step needs
 * a new host: saved in browser.storage.session under a one-time id, never
 * with a secret, read once by the tab and gone after CARRY_TTL_MS.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  /** False to stand for a browser without storage.session. */
  hasSession: true,
  tabs: [] as string[],
  held: [] as string[],
}));

vi.mock("wxt/browser", () => {
  const session = {
    get: async (key: string) => (key in store.data ? { [key]: structuredClone(store.data[key]) } : {}),
    set: async (items: Record<string, unknown>) => {
      Object.assign(store.data, structuredClone(items));
    },
    remove: async (key: string | string[]) => {
      for (const k of Array.isArray(key) ? key : [key]) delete store.data[k];
    },
  };
  return {
    browser: {
      storage: {
        get session() {
          return store.hasSession ? session : undefined;
        },
      },
      permissions: {
        request: async () => true,
        contains: async () => false,
        getAll: async () => ({ origins: store.held }),
        onAdded: { addListener: () => {} },
        onRemoved: { addListener: () => {} },
      },
      tabs: {
        create: async ({ url }: { url: string }) => {
          store.tabs.push(url);
          return {};
        },
      },
      runtime: { getURL: (path: string) => `chrome-extension://weft${path}` },
      extension: { getViews: () => [page] },
    },
  };
});

const page = { close: () => {} };

async function load() {
  vi.resetModules();
  return import("./tab-carry");
}

/** The entries saved in browser.storage.session, by id. */
const saved = () => (store.data.tabCarry ?? {}) as Record<string, { expires: number; screens: Record<string, { fields: Record<string, string>; leftOut: string[] }> }>;

beforeEach(() => {
  store.data = {};
  store.hasSession = true;
  store.tabs = [];
  store.held = [];
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("saving in the popup", () => {
  it("saves the non-secret fields and only the names of the secrets typed", async () => {
    const c = await load();
    c.registerCarry("enroll", () => ({
      fields: { enrollmentId: "alice", caUrl: "https://ca.example.com", caName: "" },
      secrets: { secret: true },
    }));
    const id = await c.saveCarry(1000);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const entry = saved()[id!]!;
    expect(entry.expires).toBe(1000 + c.CARRY_TTL_MS);
    expect(entry.screens).toEqual({
      enroll: { fields: { enrollmentId: "alice", caUrl: "https://ca.example.com", caName: "" }, leftOut: ["secret"] },
    });
  });

  it("never saves a secret's value, even one handed over by mistake", async () => {
    const c = await load();
    c.registerCarry("join", () => ({ fields: { enrollmentId: "alice" }, secrets: { secret: "s3cret-value" as unknown as boolean } }));
    const id = await c.saveCarry();
    expect(saved()[id!]!.screens.join!.leftOut).toEqual(["secret"]);
    expect(JSON.stringify(store.data)).not.toContain("s3cret-value");
  });

  it("lists a secret only when something was typed in it", async () => {
    const c = await load();
    c.registerCarry("import", () => ({ fields: { certificate: "-----BEGIN CERTIFICATE-----" }, secrets: { privateKey: false } }));
    const id = await c.saveCarry();
    expect(saved()[id!]!.screens.import!.leftOut).toEqual([]);
  });

  it("saves nothing, and gives no id, when nothing was typed", async () => {
    const c = await load();
    c.registerCarry("enroll", () => ({ fields: { enrollmentId: "", caUrl: "" }, secrets: { secret: false } }));
    expect(await c.saveCarry()).toBeNull();
    expect(store.data).toEqual({});
  });

  it("carries nothing extra where the browser has no storage.session", async () => {
    store.hasSession = false;
    const c = await load();
    c.registerCarry("enroll", () => ({ fields: { enrollmentId: "alice" } }));
    expect(await c.saveCarry()).toBeNull();
  });

  it("stops carrying a screen once it has closed", async () => {
    const c = await load();
    const stop = c.registerCarry("csr", () => ({ fields: { commonName: "alice" } }));
    stop();
    expect(c.snapshot()).toEqual({});
  });

  it("drops entries that have expired as it saves a new one", async () => {
    store.data.tabCarry = { old: { expires: 500, screens: { csr: { fields: { commonName: "bob" }, leftOut: [] } } } };
    const c = await load();
    c.registerCarry("csr", () => ({ fields: { commonName: "alice" } }));
    const id = await c.saveCarry(1000);
    expect(Object.keys(saved())).toEqual([id]);
  });
});

describe("reading in the tab", () => {
  const entry = (expires: number) => ({ expires, screens: { enroll: { fields: { enrollmentId: "alice" }, leftOut: ["secret"] } } });

  it("reads the fields once and deletes them", async () => {
    store.data.tabCarry = { one: entry(Date.now() + 60_000) };
    const c = await load();
    await c.loadCarry("one");
    expect(store.data.tabCarry).toBeUndefined();
    expect(c.takeCarried("enroll")).toEqual({ fields: { enrollmentId: "alice" }, leftOut: ["secret"] });
    // A screen opened again later starts empty.
    await new Promise((r) => setTimeout(r, 0));
    expect(c.takeCarried("enroll")).toEqual({ fields: {}, leftOut: [] });
    // A second tab with the same id, or the same tab reloaded, finds nothing.
    const again = await load();
    await again.loadCarry("one");
    expect(again.takeCarried("enroll")).toEqual({ fields: {}, leftOut: [] });
  });

  it("gives the same fields to a screen built twice as it opens", async () => {
    store.data.tabCarry = { one: entry(Date.now() + 60_000) };
    const c = await load();
    await Promise.all([c.loadCarry("one"), c.loadCarry("one")]);
    expect(c.takeCarried("enroll").fields).toEqual({ enrollmentId: "alice" });
    expect(c.takeCarried("enroll").fields).toEqual({ enrollmentId: "alice" });
  });

  it("keeps other tabs' entries", async () => {
    store.data.tabCarry = { one: entry(Date.now() + 60_000), two: entry(Date.now() + 60_000) };
    const c = await load();
    await c.loadCarry("one");
    expect(Object.keys(saved())).toEqual(["two"]);
  });

  it("fills nothing from an entry that has expired, and deletes it", async () => {
    vi.useFakeTimers({ now: 0 });
    const c = await load();
    c.registerCarry("enroll", () => ({ fields: { enrollmentId: "alice" }, secrets: { secret: true } }));
    const id = await c.saveCarry();
    vi.setSystemTime(c.CARRY_TTL_MS + 1);
    const tab = await load();
    await tab.loadCarry(id!);
    expect(tab.takeCarried("enroll")).toEqual({ fields: {}, leftOut: [] });
    expect(store.data.tabCarry).toBeUndefined();
  });

  it("fills an entry read before it expires", async () => {
    vi.useFakeTimers({ now: 0 });
    const c = await load();
    c.registerCarry("enroll", () => ({ fields: { enrollmentId: "alice" } }));
    const id = await c.saveCarry();
    vi.setSystemTime(c.CARRY_TTL_MS - 1);
    const tab = await load();
    await tab.loadCarry(id!);
    expect(tab.takeCarried("enroll").fields).toEqual({ enrollmentId: "alice" });
  });

  it("says why a secret has to be typed again", async () => {
    const c = await load();
    expect(c.secretAgain("Enter the enrolment secret again.")).toBe("Enter the enrolment secret again. Weft doesn't carry secrets between windows.");
  });
});

describe("moving from the toolbar popup to a tab", () => {
  it("puts only the id in the tab's address, and the fields in session storage", async () => {
    vi.stubGlobal("location", { pathname: "/popup.html", search: "", hash: "" });
    vi.stubGlobal("window", page);
    vi.resetModules();
    const c = await import("./tab-carry");
    const p = await import("./permissions");
    await p.primeHostAccess();
    p.setTabRoute({ name: "enroll" });
    c.registerCarry("enroll", () => ({
      fields: { enrollmentId: "alice-enrolment", caUrl: "https://ca.example.com" },
      secrets: { secret: true },
    }));
    await expect(p.requestHostAccess(["https://ca.example.com"])).rejects.toBeInstanceOf(p.MovedToTab);
    await vi.waitFor(() => expect(store.tabs).toHaveLength(1));
    const tab = new URL(store.tabs[0]!);
    expect(tab.search).toBe("?tab=1");
    const hash = JSON.parse(decodeURIComponent(tab.hash.slice(1))) as { name: string; carry: string };
    expect(Object.keys(hash).sort()).toEqual(["carry", "name"]);
    expect(hash.name).toBe("enroll");
    expect(store.tabs[0]).not.toContain("alice-enrolment");
    expect(saved()[hash.carry]!.screens.enroll!.fields.enrollmentId).toBe("alice-enrolment");

    // The tab starts on the screen, without the id in its route.
    vi.stubGlobal("location", { pathname: "/popup.html", search: tab.search, hash: tab.hash });
    expect(p.tabStart()).toEqual({ route: { name: "enroll" }, carry: hash.carry });
  });
});
