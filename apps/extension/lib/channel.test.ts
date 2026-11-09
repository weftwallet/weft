/**
 * Weft and Weft Experimental in one page (docs/adr/0010): each wallet's
 * provider (page-provider.ts) and bridge (bridge.ts) talk on their own
 * channel, so a request reaches one wallet, and each wallet's responses and
 * events reach only its own provider. One fake window carries both wallets'
 * scripts, as a page with both extensions does.
 */
import {
  ANNOUNCE_PROVIDER_EVENT,
  REQUEST_PROVIDER_EVENT,
  WEFT_EXPERIMENTAL_RDNS,
  WEFT_RDNS,
  messageTargets,
  type WeftProvider,
  type WeftProviderDetail,
} from "@weftwallet/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installBridge, type BridgeRuntime } from "./bridge";
import { installPageProvider } from "./page-provider";

const ORIGIN = "https://app.example.com";

/** A window whose postMessage delivers to itself, a task later, as a browser's does. */
function fakeWindow() {
  const win = Object.assign(new EventTarget(), {
    location: { origin: ORIGIN },
    document: new EventTarget(),
    weft: undefined as WeftProvider | undefined,
    postMessage(data: unknown, targetOrigin: string) {
      expect(targetOrigin).toBe(ORIGIN);
      setTimeout(() => win.dispatchEvent(Object.assign(new Event("message"), { data, origin: ORIGIN, source: win })));
    },
  });
  return win;
}
type FakeWindow = ReturnType<typeof fakeWindow>;

/** One extension's runtime: it answers each request with its own name, and can send events to its bridge. */
function fakeRuntime(name: string) {
  const listeners: ((message: unknown) => void)[] = [];
  const runtime = {
    id: name as string | undefined,
    sendMessage: vi.fn(async (request: { method: string }) => ({ result: `${name} answered ${request.method}` })),
    onMessage: { addListener: (listener: (message: unknown) => void) => listeners.push(listener) },
    /** The background worker sends an event to the sites in `origins`. */
    emit: (event: string, payload: unknown, origins = [ORIGIN]) => listeners.forEach((l) => l({ channel: "weft-provider-event", event, payload, origins })),
  };
  return runtime satisfies BridgeRuntime;
}

const settle = () => new Promise((r) => setTimeout(r, 10));
const announcements: WeftProviderDetail[] = [];
let win: FakeWindow;
const stops: (() => void)[] = [];

/** Installs one wallet's two content scripts in `win`, as inpage.content.ts and bridge.content.ts do. */
function install(name: string, rdns: string) {
  const runtime = fakeRuntime(name);
  stops.push(installBridge(win, rdns, { runtime }));
  const detail = installPageProvider(win, { name, rdns, icon: "data:image/svg+xml,%3Csvg%2F%3E", features: ["receipts"] });
  return { runtime, detail };
}

beforeEach(() => {
  win = fakeWindow();
  announcements.length = 0;
  win.addEventListener(ANNOUNCE_PROVIDER_EVENT, (e) => announcements.push((e as CustomEvent<WeftProviderDetail>).detail));
});
afterEach(() => stops.splice(0).forEach((stop) => stop()));

describe("two wallets in one page", () => {
  it("each announces itself, with its own info, and the first keeps window.weft", () => {
    const initialized = vi.fn();
    win.addEventListener("weft#initialized", initialized);
    const weft = install("Weft", WEFT_RDNS);
    const experimental = install("Weft Experimental", WEFT_EXPERIMENTAL_RDNS);

    expect(announcements.map((d) => [d.info.name, d.info.rdns])).toEqual([
      ["Weft", WEFT_RDNS],
      ["Weft Experimental", WEFT_EXPERIMENTAL_RDNS],
    ]);
    expect(announcements[0]!.info.uuid).not.toBe(announcements[1]!.info.uuid);
    expect(Object.isFrozen(weft.detail) && Object.isFrozen(weft.detail.info)).toBe(true);
    expect(win.weft).toBe(weft.detail.provider);
    expect(win.weft).not.toBe(experimental.detail.provider);
    expect(Object.getOwnPropertyDescriptor(win, "weft")).toMatchObject({ writable: false, configurable: false });
    expect(initialized).toHaveBeenCalledTimes(1);
  });

  it("each announces itself again, with the same uuid, when the page asks", () => {
    install("Weft", WEFT_RDNS);
    install("Weft Experimental", WEFT_EXPERIMENTAL_RDNS);
    const first = announcements.splice(0);
    win.dispatchEvent(new Event(REQUEST_PROVIDER_EVENT));
    expect(announcements).toEqual(first);
  });

  it("sends a request to its own wallet only", async () => {
    const weft = install("Weft", WEFT_RDNS);
    const experimental = install("Weft Experimental", WEFT_EXPERIMENTAL_RDNS);

    await expect(experimental.detail.provider.request({ method: "weft_connect" })).resolves.toBe("Weft Experimental answered weft_connect");
    expect(experimental.runtime.sendMessage).toHaveBeenCalledTimes(1);
    expect(weft.runtime.sendMessage).not.toHaveBeenCalled();

    await expect(weft.detail.provider.request({ method: "weft_identity" })).resolves.toBe("Weft answered weft_identity");
    expect(weft.runtime.sendMessage).toHaveBeenCalledTimes(1);
    expect(experimental.runtime.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("delivers each wallet's events to its own provider only", async () => {
    const weft = install("Weft", WEFT_RDNS);
    const experimental = install("Weft Experimental", WEFT_EXPERIMENTAL_RDNS);
    const heardByWeft = vi.fn();
    const heardByExperimental = vi.fn();
    weft.detail.provider.on("networkChanged", heardByWeft);
    experimental.detail.provider.on("networkChanged", heardByExperimental);

    experimental.runtime.emit("networkChanged", { networkId: "x", channel: "privatevote" });
    await settle();
    expect(heardByExperimental).toHaveBeenCalledWith({ networkId: "x", channel: "privatevote" });
    expect(heardByWeft).not.toHaveBeenCalled();

    weft.runtime.emit("networkChanged", { networkId: "y", channel: "mychannel" });
    await settle();
    expect(heardByWeft).toHaveBeenCalledWith({ networkId: "y", channel: "mychannel" });
    expect(heardByExperimental).toHaveBeenCalledTimes(1);
  });
});

describe("the bridge", () => {
  it("ignores a request on another wallet's channel, and the old untagged one", async () => {
    const runtime = fakeRuntime("Weft");
    stops.push(installBridge(win, WEFT_RDNS, { runtime }));
    win.postMessage({ target: messageTargets(WEFT_EXPERIMENTAL_RDNS).toWallet, id: "1", method: "weft_connect" }, ORIGIN);
    win.postMessage({ target: "weft:to-wallet", id: "2", method: "weft_connect" }, ORIGIN);
    await settle();
    expect(runtime.sendMessage).not.toHaveBeenCalled();

    win.postMessage({ target: messageTargets(WEFT_RDNS).toWallet, id: "3", method: "weft_connect" }, ORIGIN);
    await settle();
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("ignores a request from another window", async () => {
    const runtime = fakeRuntime("Weft");
    stops.push(installBridge(win, WEFT_RDNS, { runtime }));
    win.dispatchEvent(Object.assign(new Event("message"), { data: { target: messageTargets(WEFT_RDNS).toWallet, id: "1", method: "weft_connect" }, origin: ORIGIN, source: {} }));
    await settle();
    expect(runtime.sendMessage).not.toHaveBeenCalled();
  });

  it("tags the disconnect it sends after Weft is updated with its own channel", async () => {
    const runtime = fakeRuntime("Weft");
    stops.push(installBridge(win, WEFT_RDNS, { runtime }));
    const posted: unknown[] = [];
    win.addEventListener("message", (e) => posted.push((e as MessageEvent).data));
    runtime.id = undefined;
    win.dispatchEvent(new Event("focus"));
    await settle();
    expect(posted).toEqual([{ target: messageTargets(WEFT_RDNS).toPage, kind: "event", event: "disconnect", payload: { reason: "wallet-updated" } }]);
  });
});

describe("the provider", () => {
  it("ignores responses and events on another wallet's channel", async () => {
    // A provider without its bridge: only the messages below answer it.
    const { provider } = installPageProvider(win, { name: "Weft", rdns: WEFT_RDNS, icon: "", features: [] });
    const own = messageTargets(WEFT_RDNS);
    const other = messageTargets(WEFT_EXPERIMENTAL_RDNS).toPage;
    // The request's ID, from what the provider posts.
    const ids: string[] = [];
    win.addEventListener("message", (e) => {
      const data = (e as MessageEvent).data as { target?: string; id?: string };
      if (data.target === own.toWallet) ids.push(data.id!);
    });
    const heard = vi.fn();
    provider.on("disconnect", heard);
    const settled = vi.fn();
    const answer = provider.request({ method: "weft_identity" }).then(settled);
    await settle();
    const id = ids[0]!;

    win.postMessage({ target: other, kind: "response", id, result: "from the other wallet" }, ORIGIN);
    win.postMessage({ target: other, kind: "event", event: "disconnect", payload: { reason: "user" } }, ORIGIN);
    win.postMessage({ target: "weft:to-page", kind: "response", id, result: "untagged" }, ORIGIN);
    await settle();
    expect(settled).not.toHaveBeenCalled();
    expect(heard).not.toHaveBeenCalled();

    win.postMessage({ target: own.toPage, kind: "response", id, result: "from Weft" }, ORIGIN);
    await answer;
    expect(settled).toHaveBeenCalledWith("from Weft");
  });

  it("leaves a window.weft the page made itself, and still announces itself", () => {
    Object.defineProperty(win, "weft", { value: { isWeft: false }, writable: false, configurable: false });
    const { detail } = install("Weft", WEFT_RDNS);
    expect(win.weft).toEqual({ isWeft: false });
    expect(announcements).toEqual([detail]);
  });
});
