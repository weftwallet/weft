/**
 * Weft and Weft Experimental (docs/adr/0009): two builds of one extension.
 * The normal build offers exactly ["receipts"] and carries no experimental
 * code. The experimental build has its own name, ID and storage.
 */

import { chromium, type Worker } from "@playwright/test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BUILDS, expect, stack, test, type Wallet } from "../support/fixtures.ts";

const built = existsSync(join(BUILDS.experimental, "manifest.json"));
const needsExperimental = "Build Weft Experimental's test build first (pnpm --filter @weftwallet/extension build:e2e:experimental).";

/** Every text file in a build, with its path. */
function files(dir: string): { path: string; text: string }[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && /\.(js|html|json|css)$/.test(e.name))
    .map((e) => ({ path: join(e.parentPath, e.name), text: readFileSync(join(e.parentPath, e.name), "utf8") }));
}

/** Opens the Playground, when it's built, and says whether its "Private election" section shows. */
async function privateElectionShown(wallet: Wallet): Promise<boolean | null> {
  const playground = stack().sites.playground;
  if (!playground) return null;
  const page = await wallet.context.newPage();
  await page.goto(playground);
  await expect(page.locator("#pg-weft")).toHaveAttribute("data-state", "ok");
  const shown = await page.locator("#pg-private").isVisible();
  await page.close();
  return shown;
}

test.describe("Weft", () => {
  test("offers exactly the receipts feature, under its own name", async ({ wallet }) => {
    const dapp = await wallet.dapp();
    expect(await dapp.page.evaluate(() => (window as any).weft.features)).toEqual(["receipts"]);
    expect(await wallet.worker.evaluate(() => (globalThis as any).chrome.runtime.getManifest().name)).toBe("Weft Wallet");

    const popup = await wallet.popup();
    await expect(popup).toHaveTitle("Weft");
    await expect(popup.locator(".build-tag")).toHaveCount(0);
    expect(await privateElectionShown(wallet)).not.toBe(true);
  });

  test("contains none of Weft Experimental's code", () => {
    const found = files(BUILDS.normal).filter((f) => /Weft Experimental|castBallot|voterCredentials|experimental@weft/.test(f.text));
    expect(found.map((f) => f.path)).toEqual([]);
  });
});

test.describe("Weft Experimental", () => {
  test.skip(!built, needsExperimental);
  test.use({ build: "experimental" });

  test("has its own name, and the features it offers so far", async ({ wallet }) => {
    expect(await wallet.worker.evaluate(() => (globalThis as any).chrome.runtime.getManifest().name)).toBe("Weft Experimental");
    const dapp = await wallet.dapp();
    // Each experimental feature adds its name here when it's built.
    expect(await dapp.page.evaluate(() => (window as any).weft.features)).toEqual(["receipts"]);
    expect(await dapp.page.evaluate(() => (window as any).weft.version)).toBe("0.1.0");

    const welcome = await wallet.popup();
    await expect(welcome).toHaveTitle("Weft Experimental");
    await expect(welcome.getByRole("heading", { level: 1 })).toHaveText("weft Experimental");
    await expect(welcome.getByText("This is Weft Experimental, a separate build")).toBeVisible();
    await welcome.close();

    // The approval window names the build in its title and its header.
    await wallet.approve(
      () => dapp.request("weft_addNetwork", { url: stack().inviteUrl }),
      async (win) => {
        await expect(win).toHaveTitle("Weft Experimental · Approve request");
        await expect(win.locator(".brand")).toHaveText("Weft Experimental");
        await win.getByRole("button", { name: "Reject" }).click();
      },
    );

    await wallet.join(dapp, "alice", stack().users.alice!);
    const popup = await wallet.popup();
    await expect(popup.getByRole("heading", { name: "Weft Experimental" })).toBeAttached();
    await expect(popup.locator(".header .build-tag")).toHaveText("Experimental");
    // No build lists castBallot yet, so the Playground keeps the section hidden.
    expect(await privateElectionShown(wallet)).not.toBe(true);
  });

  test("installs alongside Weft, with its own ID and storage", async ({}, testInfo) => {
    const both = `${BUILDS.normal},${BUILDS.experimental}`;
    const context = await chromium.launchPersistentContext(testInfo.outputPath("profile"), {
      channel: "chromium",
      headless: true,
      args: [`--disable-extensions-except=${both}`, `--load-extension=${both}`],
    });
    try {
      // Each build's background worker; Chromium can run workers of its own too.
      const backgrounds = () => context.serviceWorkers().filter((w) => w.url().endsWith("/background.js"));
      while (backgrounds().length < 2) await context.waitForEvent("serviceworker");
      // A worker that has only just started may not have its extension APIs yet.
      const nameOf = async (w: Worker) => {
        let name: string | undefined;
        await expect.poll(async () => (name = await w.evaluate(() => (globalThis as any).chrome?.runtime?.getManifest?.().name))).toBeTruthy();
        return name!;
      };
      const named = await Promise.all(backgrounds().map(async (w: Worker) => ({ worker: w, id: new URL(w.url()).host, name: await nameOf(w) })));
      const weft = named.find((n) => n.name === "Weft Wallet")!;
      const experimental = named.find((n) => n.name === "Weft Experimental")!;
      expect(weft).toBeTruthy();
      expect(experimental).toBeTruthy();
      expect(experimental.id).not.toBe(weft.id);

      await weft.worker.evaluate(() => (globalThis as any).chrome.storage.local.set({ e2eProbe: "weft" }));
      expect(await experimental.worker.evaluate(() => (globalThis as any).chrome.storage.local.get("e2eProbe"))).toEqual({});
    } finally {
      await context.close();
    }
  });
});
