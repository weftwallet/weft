/**
 * Finding Weft (docs/adr/0010): detectProviders, detectProvider with and
 * without a preferred rdns, and getWeft's info. The tests run in Node, with
 * an EventTarget for `window` and fake wallets that announce themselves as
 * the extension's provider does (apps/extension/lib/page-provider.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ANNOUNCE_PROVIDER_EVENT,
  REQUEST_PROVIDER_EVENT,
  WEFT_EXPERIMENTAL_RDNS,
  WEFT_RDNS,
  WeftClient,
  WeftNotInstalledError,
  detectProvider,
  detectProviders,
  getWeft,
  type WeftProvider,
  type WeftProviderDetail,
} from "./index.ts";

type FakeWindow = EventTarget & { weft?: WeftProvider };
let win: FakeWindow;

const provider = (): WeftProvider =>
  Object.freeze({ isWeft: true as const, version: "0.1.0", features: [], request: vi.fn(), on: vi.fn(), off: vi.fn() }) as WeftProvider;

/** A wallet in the page: it answers weft:requestProvider from `win`, as the extension does. */
function wallet(name: string, rdns: string, { defineWeft = false, uuid = crypto.randomUUID() } = {}): WeftProviderDetail {
  const detail: WeftProviderDetail = Object.freeze({ info: Object.freeze({ uuid, name, rdns, icon: "data:image/svg+xml,%3Csvg%2F%3E" }), provider: provider() });
  const announce = () => win.dispatchEvent(new CustomEvent(ANNOUNCE_PROVIDER_EVENT, { detail }));
  win.addEventListener(REQUEST_PROVIDER_EVENT, announce);
  if (defineWeft && !win.weft) {
    win.weft = detail.provider;
    win.dispatchEvent(new Event("weft#initialized"));
  }
  announce();
  return detail;
}

beforeEach(() => {
  win = new EventTarget();
  vi.stubGlobal("window", win);
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("detectProviders", () => {
  it("lists every wallet that announces itself, in the order they answered", async () => {
    const weft = wallet("Weft", WEFT_RDNS, { defineWeft: true });
    const experimental = wallet("Weft Experimental", WEFT_EXPERIMENTAL_RDNS);
    const found = detectProviders();
    await vi.advanceTimersByTimeAsync(500);
    expect(await found).toEqual([weft, experimental]);
  });

  it("lists a wallet once however often it announces itself", async () => {
    const weft = wallet("Weft", WEFT_RDNS);
    const found = detectProviders({ waitMs: 200 });
    win.dispatchEvent(new CustomEvent(ANNOUNCE_PROVIDER_EVENT, { detail: weft }));
    win.dispatchEvent(new Event(REQUEST_PROVIDER_EVENT));
    await vi.advanceTimersByTimeAsync(200);
    expect(await found).toEqual([weft]);
  });

  it("keeps two wallets with the same rdns apart, by their uuid", async () => {
    const real = wallet("Weft", WEFT_RDNS);
    const claimed = wallet("Weft", WEFT_RDNS);
    const found = detectProviders();
    await vi.advanceTimersByTimeAsync(500);
    expect((await found).map((d) => d.info.uuid)).toEqual([real.info.uuid, claimed.info.uuid]);
  });

  it("hears a wallet that announces itself while it listens, and none after", async () => {
    const found = detectProviders({ waitMs: 300 });
    await vi.advanceTimersByTimeAsync(100);
    const late = wallet("Weft", WEFT_RDNS);
    await vi.advanceTimersByTimeAsync(200);
    wallet("Weft Experimental", WEFT_EXPERIMENTAL_RDNS);
    expect(await found).toEqual([late]);
  });

  it("ignores announcements without a provider's shape", async () => {
    const found = detectProviders();
    win.dispatchEvent(new CustomEvent(ANNOUNCE_PROVIDER_EVENT, { detail: { info: { name: "Weft" }, provider: {} } }));
    win.dispatchEvent(new CustomEvent(ANNOUNCE_PROVIDER_EVENT, { detail: null }));
    await vi.advanceTimersByTimeAsync(500);
    expect(await found).toEqual([]);
  });

  it("resolves with an empty list when no Weft is here", async () => {
    const found = detectProviders();
    await vi.advanceTimersByTimeAsync(500);
    expect(await found).toEqual([]);
  });
});

describe("detectProvider", () => {
  it("without an rdns, resolves with window.weft as before", async () => {
    const weft = wallet("Weft", WEFT_RDNS, { defineWeft: true });
    wallet("Weft Experimental", WEFT_EXPERIMENTAL_RDNS);
    await expect(detectProvider()).resolves.toBe(weft.provider);
  });

  it("still takes the timeout as a number, and waits for weft#initialized", async () => {
    const found = detectProvider(1000);
    await vi.advanceTimersByTimeAsync(400);
    const weft = wallet("Weft", WEFT_RDNS, { defineWeft: true });
    await expect(found).resolves.toBe(weft.provider);
  });

  it("rejects with WeftNotInstalledError when no Weft appears in time", async () => {
    const found = detectProvider({ timeoutMs: 1000 });
    const failed = expect(found).rejects.toBeInstanceOf(WeftNotInstalledError);
    await vi.advanceTimersByTimeAsync(1000);
    await failed;
  });

  it("with an rdns, prefers that wallet over window.weft", async () => {
    wallet("Weft", WEFT_RDNS, { defineWeft: true });
    const experimental = wallet("Weft Experimental", WEFT_EXPERIMENTAL_RDNS);
    await expect(detectProvider({ rdns: WEFT_EXPERIMENTAL_RDNS })).resolves.toBe(experimental.provider);
  });

  it("with an rdns, waits for that wallet when it loads after another", async () => {
    wallet("Weft", WEFT_RDNS, { defineWeft: true });
    const found = detectProvider({ rdns: WEFT_EXPERIMENTAL_RDNS });
    await vi.advanceTimersByTimeAsync(300);
    const experimental = wallet("Weft Experimental", WEFT_EXPERIMENTAL_RDNS);
    await expect(found).resolves.toBe(experimental.provider);
  });

  it("with an rdns no wallet has, falls back to window.weft half a second after finding it", async () => {
    const weft = wallet("Weft", WEFT_RDNS, { defineWeft: true });
    let settled = false;
    const found = detectProvider({ rdns: WEFT_EXPERIMENTAL_RDNS, timeoutMs: 3000 }).finally(() => (settled = true));
    await vi.advanceTimersByTimeAsync(499);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(found).resolves.toBe(weft.provider);
  });

  it("with an rdns, falls back to window.weft from a Weft that doesn't announce itself", async () => {
    const found = detectProvider({ rdns: WEFT_EXPERIMENTAL_RDNS });
    const old = provider();
    win.weft = old;
    win.dispatchEvent(new Event("weft#initialized"));
    await vi.advanceTimersByTimeAsync(500);
    await expect(found).resolves.toBe(old);
  });

  it("with an rdns, rejects when no Weft appears in time", async () => {
    const found = detectProvider({ rdns: WEFT_RDNS, timeoutMs: 800 });
    const failed = expect(found).rejects.toBeInstanceOf(WeftNotInstalledError);
    await vi.advanceTimersByTimeAsync(800);
    await failed;
  });
});

describe("getWeft", () => {
  it("gives the client the announced info of window.weft", async () => {
    const weft = wallet("Weft", WEFT_RDNS, { defineWeft: true });
    wallet("Weft Experimental", WEFT_EXPERIMENTAL_RDNS);
    const client = await getWeft();
    expect(client.provider).toBe(weft.provider);
    expect(client.info).toBe(weft.info);
  });

  it("gives the client the preferred wallet's info", async () => {
    wallet("Weft", WEFT_RDNS, { defineWeft: true });
    const experimental = wallet("Weft Experimental", WEFT_EXPERIMENTAL_RDNS);
    const client = await getWeft({ rdns: WEFT_EXPERIMENTAL_RDNS });
    expect(client.provider).toBe(experimental.provider);
    expect(client.info?.name).toBe("Weft Experimental");
  });

  it("has no info for a Weft that doesn't announce itself", async () => {
    win.weft = provider();
    expect((await getWeft()).info).toBeUndefined();
  });

  it("WeftClient takes an announcement's provider and info", () => {
    const detail = wallet("Weft Experimental", WEFT_EXPERIMENTAL_RDNS);
    const client = new WeftClient(detail.provider, detail.info);
    expect(client.info?.rdns).toBe(WEFT_EXPERIMENTAL_RDNS);
    expect(new WeftClient(detail.provider).info).toBeUndefined();
  });
});
