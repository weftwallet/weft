/**
 * Weft and Weft Experimental in one browser profile (docs/adr/0010). Each
 * announces its own provider, window.weft is defined once, a request
 * through one provider opens one approval window, in that wallet, and each
 * wallet's events reach only its own provider.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { BUILDS, clickToClose, expect, launchBothWallets, stack, test, type Wallet } from "../support/fixtures.ts";

const built = existsSync(join(BUILDS.experimental, "manifest.json"));
const WEFT = "dev.ifeanyiugwu.weft";
const EXPERIMENTAL = "dev.ifeanyiugwu.weft.experimental";

/** Collects the announcements in the page, keeps each wallet's provider at window.__wallets[rdns], and returns their info. */
async function announced(page: Page) {
  return page.evaluate(
    () =>
      new Promise<{ uuid: string; name: string; rdns: string; icon: string }[]>((resolve) => {
        const w = window as any;
        w.__wallets = {};
        w.__events = {};
        const infos: any[] = [];
        window.addEventListener("weft:announceProvider", (e: any) => {
          if (infos.some((i) => i.uuid === e.detail.info.uuid)) return;
          infos.push({ ...e.detail.info, frozen: Object.isFrozen(e.detail) && Object.isFrozen(e.detail.info) });
          w.__wallets[e.detail.info.rdns] = e.detail.provider;
          w.__events[e.detail.info.rdns] = [];
          for (const name of ["disconnect", "identityChanged", "networkChanged"]) {
            e.detail.provider.on(name, (payload: unknown) => w.__events[e.detail.info.rdns].push({ event: name, payload }));
          }
        });
        window.dispatchEvent(new Event("weft:requestProvider"));
        setTimeout(() => resolve(infos), 500);
      }),
  );
}

/** Calls one wallet's provider; resolves with the result or { code, message }. */
function request(page: Page, rdns: string, method: string) {
  return page.evaluate(
    ([r, m]) => (window as any).__wallets[r].request({ method: m }).then((x: unknown) => x, (e: any) => ({ code: e.code, message: e.message })),
    [rdns, method] as const,
  );
}

/** The events each provider has heard since the last call, after a moment for delivery. */
async function heard(page: Page): Promise<Record<string, { event: string; payload: any }[]>> {
  await page.waitForTimeout(600);
  return page.evaluate(() => {
    const events = (window as any).__events;
    const out: Record<string, unknown[]> = {};
    for (const rdns of Object.keys(events)) out[rdns] = events[rdns].splice(0);
    return out as any;
  });
}

/** Sends weft_connect through `rdns`'s provider, approves it, and checks that exactly one approval window opened, in `wallet`. */
async function connectThrough(page: Page, rdns: string, wallet: Wallet) {
  const opened: Page[] = [];
  const onPage = (p: Page) => opened.push(p);
  wallet.context.on("page", onPage);
  const result = request(page, rdns, "weft_connect");
  await expect.poll(() => opened.length, { timeout: 15_000 }).toBeGreaterThan(0);
  const win = opened[0]!;
  await win.waitForLoadState();
  expect(win.url().startsWith(wallet.url("approve.html"))).toBe(true);
  // The other wallet would open its window at about the same moment.
  await page.waitForTimeout(1500);
  expect(opened.map((p) => new URL(p.url()).host)).toEqual([wallet.id]);
  await win.locator("footer").getByRole("button", { name: "Connect" }).click();
  const identity = await result;
  wallet.context.off("page", onPage);
  return identity;
}

test.describe("Weft and Weft Experimental in one browser", () => {
  test.skip(!built, "Build Weft Experimental's test build first (pnpm --filter @weftwallet/extension build:e2e:experimental).");

  test("each announces itself, one request opens one window, and each hears only its own events", async ({ site }, testInfo) => {
    const wallets = await launchBothWallets(site, testInfo.outputPath("profile"));
    try {
      const s = stack();
      await wallets.normal.enroll("alice", s.users.alice!);
      await wallets.experimental.enroll("bob", s.users.bob!);
      for (const page of wallets.normal.context.pages()) if (page.url().startsWith("chrome-extension://")) await page.close();

      const page = await wallets.normal.context.newPage();
      await page.goto(site.origin);
      await page.waitForFunction(() => (window as any).weft?.isWeft, null, { timeout: 15_000 });

      // Two announcements, one per wallet, with the product's name, rdns and mark.
      const infos = await announced(page);
      expect(infos.map((i) => [i.name, i.rdns]).sort((a, b) => a[1]!.localeCompare(b[1]!))).toEqual([
        ["Weft", WEFT],
        ["Weft Experimental", EXPERIMENTAL],
      ]);
      expect(new Set(infos.map((i) => i.uuid)).size).toBe(2);
      for (const info of infos) {
        expect(info.icon.startsWith("data:image/svg+xml,")).toBe(true);
        expect((info as any).frozen).toBe(true);
      }

      // window.weft is one of the two providers, defined once and fixed.
      const weft = await page.evaluate(() => {
        const w = window as any;
        const d = Object.getOwnPropertyDescriptor(window, "weft");
        return {
          writable: d?.writable,
          configurable: d?.configurable,
          is: Object.entries(w.__wallets).filter(([, p]) => p === w.weft).map(([rdns]) => rdns),
        };
      });
      expect(weft).toMatchObject({ writable: false, configurable: false });
      expect(weft.is).toHaveLength(1);

      // One weft_connect through each provider opens one window, in its own wallet.
      expect(await connectThrough(page, EXPERIMENTAL, wallets.experimental)).toMatchObject({ name: "bob" });
      expect(await connectThrough(page, WEFT, wallets.normal)).toMatchObject({ name: "alice" });
      expect(await request(page, EXPERIMENTAL, "weft_identity")).toMatchObject({ name: "bob" });
      expect(await request(page, WEFT, "weft_identity")).toMatchObject({ name: "alice" });
      await heard(page);

      // Each wallet's events reach only its own provider.
      expect(await request(page, EXPERIMENTAL, "weft_disconnect")).toBeNull();
      let events = await heard(page);
      expect(events[EXPERIMENTAL]!.map((e) => [e.event, e.payload.reason])).toEqual([["disconnect", "site"]]);
      expect(events[WEFT]).toEqual([]);
      expect(await request(page, WEFT, "weft_identity")).toMatchObject({ name: "alice" });

      expect(await request(page, WEFT, "weft_disconnect")).toBeNull();
      events = await heard(page);
      expect(events[WEFT]!.map((e) => [e.event, e.payload.reason])).toEqual([["disconnect", "site"]]);
      expect(events[EXPERIMENTAL]).toEqual([]);
    } finally {
      await wallets.normal.context.close();
    }
  });

  test("Weft's own pages offer each wallet", async ({ site }, testInfo) => {
    const { sites, inviteUrl } = stack();
    test.skip(!sites.site, "Build the Weft site first (WEFT_PRODUCTS=dev pnpm --filter @weftwallet/site build).");
    const wallets = await launchBothWallets(site, testInfo.outputPath("profile"));
    const context = wallets.normal.context;
    try {
      // The invite page: one button per wallet, in place of Open in Weft.
      const join = await context.newPage();
      await join.goto(`${sites.site}/join/?weft-invite=${encodeURIComponent(inviteUrl)}`);
      await expect(join.getByRole("button", { name: "Add to Weft", exact: true })).toBeVisible();
      await expect(join.getByRole("button", { name: "Add to Weft Experimental" })).toBeVisible();
      await expect(join.getByRole("button", { name: "Open in Weft" })).toHaveCount(0);

      // Its button opens that wallet's window, and only that one.
      const opened: Page[] = [];
      context.on("page", (p) => opened.push(p));
      await join.getByRole("button", { name: "Add to Weft Experimental" }).click();
      await expect.poll(() => opened.length, { timeout: 15_000 }).toBeGreaterThan(0);
      const win = opened[0]!;
      await win.waitForLoadState();
      expect(new URL(win.url()).host).toBe(wallets.experimental.id);
      await join.waitForTimeout(1500);
      expect(opened).toHaveLength(1);
      await clickToClose(win, win.getByRole("button", { name: "Reject" }));
      await expect(join.getByText("You rejected the request in Weft Experimental, so the network wasn't added. Add to Weft Experimental again when you're ready.")).toBeVisible();

      // The Playground shows the Private election section, which casts with Weft Experimental.
      if (sites.playground) {
        const playground = await context.newPage();
        await playground.goto(sites.playground);
        await expect(playground.locator("#pg-weft")).toHaveAttribute("data-state", "ok");
        await expect(playground.locator("#pg-private")).toBeVisible();
      }
    } finally {
      await context.close();
    }
  });
});
