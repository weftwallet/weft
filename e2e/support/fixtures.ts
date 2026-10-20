/**
 * Test fixtures: a browser with the test build of Weft loaded, a small web
 * app ("site") to call it from, and helpers for the approval windows.
 */

import { test as base, chromium, expect, type BrowserContext, type Page, type Worker } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { EXTENSION, PORTS, type StackInfo } from "./stack.ts";

export { expect };

/** The wallet password the fixture sets, unless a test opts out with test.use({ walletPassword: null }). */
export const PASSWORD = "e2e wallet password";

export function stack(): StackInfo {
  const raw = process.env.WEFT_E2E_INFO;
  if (!raw) throw new Error("WEFT_E2E_INFO is missing: run the tests through Playwright (global setup starts the stack).");
  return JSON.parse(raw) as StackInfo;
}

/** A blank web app on localhost, plus JSON documents tests can change (e.g. an invite). */
export class Site {
  readonly origin = `http://localhost:${PORTS.site}`;
  private docs = new Map<string, unknown>();
  private server: Server;

  constructor() {
    this.server = createServer((req, res) => {
      const path = new URL(req.url ?? "/", this.origin).pathname;
      res.setHeader("access-control-allow-origin", "*");
      if (this.docs.has(path)) {
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify(this.docs.get(path)));
      }
      res.setHeader("content-type", "text/html");
      res.end("<!doctype html><title>Test app</title>");
    });
  }

  listen(): Promise<void> {
    return new Promise((r) => this.server.listen(PORTS.site, "127.0.0.1", r));
  }

  close(): Promise<void> {
    return new Promise((r) => this.server.close(() => r()));
  }

  /** Serves `body` as JSON at `path`. */
  serve(path: string, body: unknown): string {
    this.docs.set(path, body);
    return `${this.origin}${path}`;
  }
}

/** A tab of the test app, with window.weft. */
export class Dapp {
  constructor(readonly page: Page) {}

  /** Calls window.weft.request; resolves with the result or { code, message } on error. */
  request<T = any>(method: string, params?: unknown): Promise<T> {
    return this.page.evaluate(
      ([m, p]) =>
        (window as any).weft
          .request(p === undefined ? { method: m } : { method: m, params: p })
          .then((r: unknown) => r, (e: any) => ({ code: e.code, message: e.message, data: e.data })),
      [method, params] as const,
    );
  }

  /** Starts recording provider events. */
  async record(): Promise<void> {
    await this.page.evaluate(() => {
      const w = window as any;
      w.__events = [];
      for (const e of ["disconnect", "identityChanged", "networkChanged", "certificateStatus"]) {
        w.weft.on(e, (payload: any) => w.__events.push({ event: e, payload }));
      }
    });
  }

  /** Recorded events since the last call, after a moment for delivery. */
  async events(settleMs = 600): Promise<{ event: string; payload: any }[]> {
    await this.page.waitForTimeout(settleMs);
    return this.page.evaluate(() => (window as any).__events.splice(0));
  }
}

export class Wallet {
  constructor(
    readonly context: BrowserContext,
    readonly id: string,
    readonly worker: Worker,
    readonly site: Site,
  ) {}

  url(path: string): string {
    return `chrome-extension://${this.id}/${path}`;
  }

  /** Opens the test app in a new tab. */
  async dapp(): Promise<Dapp> {
    const page = await this.context.newPage();
    await page.goto(this.site.origin);
    await page.waitForFunction(() => (window as any).weft?.isWeft, null, { timeout: 15_000 });
    return new Dapp(page);
  }

  /** The popup, as a 360×600 tab. */
  async popup(): Promise<Page> {
    const page = await this.context.newPage();
    await page.setViewportSize({ width: 360, height: 600 });
    await page.goto(this.url("popup.html"));
    return page;
  }

  /** Calls the background worker the way the popup does. */
  async ui<T = any>(method: string, payload?: unknown): Promise<T> {
    const page = this.context.pages().find((p) => p.url().startsWith(this.url(""))) ?? (await this.popup());
    const response = await page.evaluate(
      ([m, p]) => (globalThis as any).chrome.runtime.sendMessage({ channel: "weft-ui", method: m, payload: p }),
      [method, payload] as const,
    );
    if (!response?.ok) throw new Error(response?.error ?? "no response");
    return response.value as T;
  }

  /**
   * Runs `request` (which opens an approval window), lets `steps` act in that
   * window, and returns the request's result.
   */
  async approve<T>(request: () => Promise<T>, steps: (win: Page) => Promise<void>): Promise<T> {
    const opened = this.context.waitForEvent("page");
    const result = request();
    const win = await opened;
    await win.waitForLoadState();
    await win.setViewportSize({ width: 380, height: 640 });
    await steps(win);
    return result;
  }

  /** weft_addNetwork, then enrol through the approval window. */
  async join(dapp: Dapp, user: string, secret: string, inviteUrl = stack().inviteUrl) {
    return this.approve(
      () => dapp.request("weft_addNetwork", { url: inviteUrl }),
      async (win) => {
        await win.getByRole("button", { name: "Review invite" }).click();
        await win.getByText("You're joining").waitFor();
        await win.locator("input.mono").fill(user);
        await win.locator("input[type=password]").fill(secret);
        await win.getByRole("button", { name: "Enrol", exact: true }).click();
      },
    );
  }

  /** weft_connect, approved. */
  async connect(dapp: Dapp) {
    return this.approve(
      () => dapp.request("weft_connect"),
      async (win) => win.locator("footer").getByRole("button", { name: "Connect" }).click(),
    );
  }

  /** Unlocks with the test password, through the worker. */
  async unlock() {
    return this.ui("vaultUnlock", { password: PASSWORD });
  }

  async lock() {
    return this.ui("vaultLock");
  }

  /** Enrols through the background directly, for setting up state quickly. */
  async enroll(user: string, secret: string, network: Partial<Record<string, unknown>> = {}) {
    const s = stack();
    return this.ui("enroll", {
      network: {
        name: "Weft e2e", organization: "Org1", mspId: "Org1MSP", channels: ["mychannel"],
        relayUrl: s.relayUrl, caUrl: s.caUrl, caName: "ca-org1", ...network,
      },
      enrollmentId: user,
      secret,
    });
  }
}

type Fixtures = { wallet: Wallet; walletPassword: string | null };
type WorkerFixtures = { site: Site };

export const test = base.extend<Fixtures, WorkerFixtures>({
  site: [
    async ({}, use) => {
      const site = new Site();
      await site.listen();
      await use(site);
      await site.close();
    },
    { scope: "worker" },
  ],

  walletPassword: [PASSWORD, { option: true }],

  wallet: async ({ site, walletPassword }, use, testInfo) => {
    const headed = testInfo.tags.includes("@headed");
    const context = await chromium.launchPersistentContext(testInfo.outputPath("profile"), {
      channel: "chromium",
      headless: !headed,
      args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
    });
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
    const id = new URL(worker.url()).host;
    const wallet = new Wallet(context, id, worker, site);
    if (walletPassword) {
      await wallet.ui("vaultSetup", { password: walletPassword });
      // ui() opened a popup tab to talk to the worker; tests expect a clean slate.
      for (const page of context.pages()) if (page.url().startsWith(wallet.url(""))) await page.close();
    }
    await use(wallet);
    await context.close();
  },
});
