/**
 * Weft and Weft Experimental (docs/adr/0009): two builds of one extension.
 * The normal build offers exactly ["receipts"] and carries no experimental
 * code. The experimental build has its own name, ID and storage.
 */

import { chromium, type Worker } from "@playwright/test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { experimentalTraces } from "../../apps/extension/scripts/check-normal-build.mjs";
import { BUILDS, PASSWORD, clickToClose, expect, stack, test, type Wallet } from "../support/fixtures.ts";

const built = existsSync(join(BUILDS.experimental, "manifest.json"));
const needsExperimental = "Build Weft Experimental's test build first (pnpm --filter @weftwallet/extension build:e2e:experimental).";

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
    // The check CI runs on the release builds too (pnpm --filter @weftwallet/extension check:normal).
    expect(experimentalTraces(BUILDS.normal)).toEqual([]);
  });

  test("answers weft_castBallot with 4200, without a window", async ({ wallet }) => {
    const dapp = await wallet.dapp();
    let opened = false;
    wallet.context.on("page", () => (opened = true));
    const result = await dapp.request("weft_castBallot", { channel: "privatevote-budget-2027", chaincode: "private-ballot", electionId: "budget-2027" });
    expect(result).toMatchObject({ code: 4200 });
    expect(opened).toBe(false);
  });
});

test.describe("Weft Experimental", () => {
  test.skip(!built, needsExperimental);
  test.use({ build: "experimental" });

  test("has its own name, and the features it offers so far", async ({ wallet }) => {
    expect(await wallet.worker.evaluate(() => (globalThis as any).chrome.runtime.getManifest().name)).toBe("Weft Experimental");
    const dapp = await wallet.dapp();
    // Each experimental feature adds its name here when it's built.
    expect(await dapp.page.evaluate(() => (window as any).weft.features)).toEqual(["receipts", "castBallot", "voterCredentials"]);
    expect(await dapp.page.evaluate(() => (window as any).weft.version)).toBe("0.1.0");
    // Only Weft Experimental's pages may compile WebAssembly, for the idemix module it carries.
    expect(await wallet.worker.evaluate(() => (globalThis as any).chrome.runtime.getManifest().content_security_policy)).toEqual({
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';",
    });
    expect(existsSync(join(BUILDS.experimental, "idemix", "weft-idemix.wasm"))).toBe(true);

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
        await clickToClose(win, win.getByRole("button", { name: "Reject" }));
      },
    );

    await wallet.join(dapp, "alice", stack().users.alice!);
    const popup = await wallet.popup();
    await expect(popup.getByRole("heading", { name: "Weft Experimental" })).toBeAttached();
    await expect(popup.locator(".header .build-tag")).toHaveText("Experimental");
    // It lists castBallot, so the Playground shows the section (null when the Playground isn't built).
    expect(await privateElectionShown(wallet)).not.toBe(false);
  });

  test("starts the voting module's worker from its own file, on the extension's origin", async ({ wallet }) => {
    // The worker is an extension file of its own, which lib/voter/module.ts
    // starts with runtime.getURL, not a worker bundled with the page: in a
    // dev build that would load from the Vite dev server, which browsers refuse.
    const dir = BUILDS.experimental;
    expect(existsSync(join(dir, "idemix-worker.js"))).toBe(true);
    const files = readdirSync(dir, { recursive: true }).map(String);
    expect(files.filter((f) => /idemix.*worker/.test(f) && f !== "idemix-worker.js")).toEqual([]);
    const pages = files.filter((f) => f.startsWith("chunks/") && f.endsWith(".js")).map((f) => readFileSync(join(dir, f), "utf8"));
    expect(pages.filter((code) => code.includes("getURL(`/idemix-worker.js`)") || code.includes('getURL("/idemix-worker.js")'))).toHaveLength(1);

    const popup = await wallet.popup();
    const out = await popup.evaluate(async () => {
      const chrome = (globalThis as any).chrome;
      const url: string = chrome.runtime.getURL("/idemix-worker.js");
      const worker = new Worker(url, { type: "module" });
      const reply = await new Promise((resolve, reject) => {
        worker.onerror = (e) => reject(new Error(e.message || "The worker fired error."));
        worker.onmessage = (e) => resolve(e.data);
        worker.postMessage({ type: "start", wasmUrl: chrome.runtime.getURL("/idemix/weft-idemix.wasm"), wasmExecUrl: chrome.runtime.getURL("/idemix/wasm_exec.js") });
      });
      worker.terminate();
      return { worker: new URL(url).origin, page: location.origin, reply };
    });
    expect(out.worker).toBe(out.page);
    expect(out.reply).toMatchObject({ type: "started" });
  });

  test("checks weft_castBallot's params before any window opens", async ({ wallet }) => {
    const dapp = await wallet.dapp();
    let opened = false;
    wallet.context.on("page", (p) => p.url().includes("approve.html") && (opened = true));
    const params = { channel: "privatevote-budget-2027", chaincode: "private-ballot", electionId: "budget-2027" };
    expect(await dapp.request("weft_castBallot", { ...params, electionId: "budget 2027" })).toMatchObject({ code: -32602 });
    expect(await dapp.request("weft_castBallot", { ...params, choice: 1 })).toMatchObject({ code: -32602, message: expect.stringContaining('not "choice"') });
    expect(opened).toBe(false);
  });

  test("opens the window first, unlocks there, and waits for Try again when the network doesn't answer", async ({ wallet }) => {
    test.skip(stack().mode !== "ca", "Needs the relay without peers (the default stack).");
    await wallet.enroll("alice", stack().users.alice!, { channels: ["mychannel", "privatevote-budget-2027"] });
    await wallet.lock();
    const dapp = await wallet.dapp();
    const params = { channel: "privatevote-budget-2027", chaincode: "private-ballot", electionId: "budget-2027" };
    const result = await wallet.approve(
      () => dapp.request("weft_castBallot", params),
      async (win) => {
        await expect(win).toHaveTitle("Weft Experimental · Approve request");
        // Reading the election is signed, so a locked Weft asks for the password first.
        await expect(win.getByRole("heading", { name: "Weft Experimental is locked" })).toBeVisible();
        await win.locator("input[type=password]").fill(PASSWORD);
        await win.getByRole("button", { name: "Unlock" }).click();
        await expect(win.getByRole("button", { name: "Try again" })).toBeVisible({ timeout: 40_000 });
        await expect(win.getByText(/couldn't read budget-2027 from the ledger/)).toBeVisible();
        // A second request from the site waits for this one.
        expect(await dapp.request("weft_castBallot", params)).toMatchObject({ code: -32002 });
        await clickToClose(win, win.getByRole("button", { name: "Reject" }));
      },
    );
    expect(result).toMatchObject({ code: 5002 });
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
