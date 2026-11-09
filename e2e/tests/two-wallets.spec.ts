/**
 * Weft and Weft Experimental in one browser profile (docs/adr/0010). Each
 * announces its own provider, window.weft is defined once, a request
 * through one provider opens one approval window, in that wallet, and each
 * wallet's events reach only its own provider.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { BUILDS, clickToClose, expect, launchBothWallets, stack, test, type Build, type Wallet } from "../support/fixtures.ts";

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

/** Presses `button` on the page, checks that exactly one approval window opened, in `wallet`, and approves the connection there. */
async function connectFrom(page: Page, button: string, wallet: Wallet) {
  const opened: Page[] = [];
  const onPage = (p: Page) => opened.push(p);
  wallet.context.on("page", onPage);
  await page.locator(button).click();
  await expect.poll(() => opened.length, { timeout: 15_000 }).toBeGreaterThan(0);
  const win = opened[0]!;
  await win.waitForLoadState();
  expect(win.url().startsWith(wallet.url("approve.html"))).toBe(true);
  // The other wallet would open its window at about the same moment.
  await page.waitForTimeout(1500);
  expect(opened.map((p) => new URL(p.url()).host)).toEqual([wallet.id]);
  await win.locator("footer").getByRole("button", { name: "Connect" }).click();
  wallet.context.off("page", onPage);
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

      // The Playground shows the Private election section, which casts with Weft Experimental, or offers to switch to it.
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

  test("Weft Playground uses the wallet the visitor chooses, and remembers it", async ({ site }, testInfo) => {
    const { sites, inviteUrl, users } = stack();
    test.skip(!sites.playground, "Build the playground first (WEFT_PRODUCTS=dev pnpm --filter @weftwallet/playground build).");
    const wallets = await launchBothWallets(site, testInfo.outputPath("profile"));
    const context = wallets.normal.context;
    try {
      await wallets.normal.enroll("alice", users.alice!);
      await wallets.experimental.enroll("bob", users.bob!);
      for (const page of context.pages()) if (page.url().startsWith("chrome-extension://")) await page.close();

      const page = await context.newPage();
      await page.goto(`${sites.playground}/?invite=${encodeURIComponent(inviteUrl)}`);
      const pill = page.locator("#pg-weft");
      await expect(pill).toHaveAttribute("data-state", "ok");

      // Both wallets show, each with the mark it announced.
      const choice = page.locator("#pg-wallets");
      await expect(choice).toBeVisible();
      await expect(choice.locator("legend")).toHaveText("This browser has Weft and Weft Experimental. Choose the one this page uses.");
      const radio = { normal: page.getByRole("radio", { name: "Weft", exact: true }), experimental: page.getByRole("radio", { name: "Weft Experimental" }) };
      const option = (build: Build) => page.locator(`label.pg-wallet[data-rdns="${build === "normal" ? WEFT : EXPERIMENTAL}"]`);
      for (const build of ["normal", "experimental"] as const) await expect(option(build).locator("img")).toHaveAttribute("src", /^data:image\/svg\+xml,/);
      const NAME: Record<Build, string> = { normal: "Weft", experimental: "Weft Experimental" };

      // The default is window.weft's wallet.
      const first: Build = (await page.evaluate(() => (window as any).weft.features.includes("castBallot"))) ? "experimental" : "normal";
      const other: Build = first === "normal" ? "experimental" : "normal";
      await expect(radio[first]).toBeChecked();
      await expect(pill).toHaveText(`Using ${NAME[first]} 0.1.0`);

      /** Chooses a wallet, and checks the page says so, forgets the other wallet's connection, and logs the switch. */
      const use = async (build: Build) => {
        await option(build).click();
        await expect(radio[build]).toBeChecked();
        await expect(pill).toHaveText(`Using ${NAME[build]} 0.1.0`);
        await expect(page.locator("#pg-join")).toHaveText(`Join with ${NAME[build]}`);
        await expect(page.locator("#pg-log")).toContainText(`switched to ${NAME[build]}`);
      };
      const IDENTITY: Record<Build, string> = { normal: "alice", experimental: "bob" };

      // Each choice sends weft_connect to that wallet only: one approval window, in that wallet.
      for (const build of [other, first]) {
        await use(build);
        await expect(page.locator("#pg-conn")).toHaveText("Not connected");
        await connectFrom(page, "#pg-connect", wallets[build]);
        await expect(page.locator("#pg-conn")).toHaveText("Connected");
        await expect(page.locator("#pg-id-name")).toHaveText(IDENTITY[build]);
        await expect(page.locator("#pg-log")).toContainText(`weft_connect · ${NAME[build]}`);
      }
      // The code the page shows asks the SDK for that wallet.
      await page.locator("#pg-evaluate").click();
      await expect(page.locator("#pg-code")).toContainText(`getWeft({ rdns: "${first === "normal" ? WEFT : EXPERIMENTAL}" })`);

      // With Weft chosen, the Private election section offers to switch the page to Weft Experimental.
      const section = page.locator("#pg-private");
      await use("normal");
      await expect(section).toBeVisible();
      await expect(section.locator("#pg-pe-wallet-text")).toHaveText("This page uses Weft, which doesn't offer private elections. Weft Experimental does, and it's in this browser too.");
      await section.getByRole("button", { name: "Use Weft Experimental" }).click();
      await expect(radio.experimental).toBeChecked();
      await expect(section.locator("#pg-pe-wallet-text")).toHaveText("This page now uses Weft Experimental, which offers private elections.");
      await expect(section.getByRole("button", { name: "Use Weft Experimental" })).toBeHidden();
      // bob connected this page to Weft Experimental earlier, so it is connected again at once.
      await expect(page.locator("#pg-conn")).toHaveText("Connected");

      // The choice survives a reload, though window.weft is the other wallet.
      await use(other);
      await page.reload();
      await expect(pill).toHaveAttribute("data-state", "ok");
      await expect(radio[other]).toBeChecked();
      await expect(pill).toHaveText(`Using ${NAME[other]} 0.1.0`);
      await expect(page.locator("#pg-id-name")).toHaveText(IDENTITY[other]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    } finally {
      await context.close();
    }
  });
});
