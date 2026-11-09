#!/usr/bin/env node
/**
 * Checks that nothing in any Weft product scrolls sideways (packages/brand/
 * SYSTEM.md, Overflow): not the page, and not any element inside it. Loads
 * every page of the Weft site, the docs, the playground, Weft Network, the
 * explorer (on its sample server) and the wallet's popup and windows (with
 * the background worker faked), in the states it can reach, at 320, 360 and
 * 1440 wide in light and dark, and fails if any element scrolls
 * horizontally or the page does.
 *
 *   pnpm check:sideways                     everything, from the built products
 *   pnpm check:sideways --only docs,explorer
 *   pnpm check:sideways --widths 320 --themes dark
 *
 * Builds first: `pnpm build` (the sites and the explorer) and
 * `pnpm --filter @weftwallet/extension build`. The sites are served from
 * their dist folders; the explorer runs from source on its sample blocks.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, relative, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { wallet as walletProduct } from "./sideways/wallet.mjs";

const ROOT = resolve(import.meta.dirname, "../..");

const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1]?.split(",") : undefined;
};
const ONLY = option("only");
const WIDTHS = (option("widths") ?? ["320", "360", "1440"]).map(Number);
const THEMES = option("themes") ?? ["light", "dark"];
const HEIGHT = 900;
/** --shots <dir>: a full-page screenshot of every state checked, for looking at. */
const SHOTS = option("shots")?.[0];
/** --pages <a,b>: only the paths that contain one of these. */
const PAGES = option("pages");

/* ------------------------------------------------------------------ */
/* Serving                                                             */
/* ------------------------------------------------------------------ */

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".wasm": "application/wasm",
  ".xml": "application/xml",
  ".txt": "text/plain",
};

/** Serves a built folder as a static host does: /a/ is /a/index.html, a miss is 404.html. */
function serveStatic(dir) {
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const candidates = path.endsWith("/") ? [join(dir, path, "index.html")] : [join(dir, path), join(dir, path, "index.html"), join(dir, `${path}.html`)];
    for (const file of candidates) {
      if (!file.startsWith(dir)) break;
      try {
        const body = await readFile(file);
        res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" }).end(body);
        return;
      } catch {}
    }
    const missing = await readFile(join(dir, "404.html")).catch(() => null);
    res.writeHead(404, { "content-type": "text/html; charset=utf-8" }).end(missing ?? "Not found");
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok({ url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })));
}

/** Every page a built Astro site has, as paths. */
async function pagesOf(dir) {
  const out = [];
  const walk = async (d) => {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) await walk(p);
      // A redirect page (Astro's meta refresh) leaves for another product at once.
      else if (entry.name.endsWith(".html") && !/http-equiv="refresh"/i.test(await readFile(p, "utf8"))) out.push("/" + relative(dir, p).replace(/index\.html$/, "").replace(/\\/g, "/"));
    }
  };
  await walk(dir);
  return out.sort();
}

/** Starts the explorer on its sample blocks and resolves with its address. */
function startExplorer() {
  // Away from the ports the dev servers and the browser tests use (8787 to 8799).
  const port = 18700 + Math.floor(Math.random() * 100);
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "src/test/serve-sample.ts"], {
    cwd: join(ROOT, "apps/explorer"),
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "inherit"],
  });
  return new Promise((ok, fail) => {
    child.on("exit", (code) => fail(new Error(`The explorer's sample server stopped (${code}).`)));
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes(`http://localhost:${port}`)) ok({ url: `http://localhost:${port}`, close: () => child.kill() });
    });
  });
}

/* ------------------------------------------------------------------ */
/* Measuring                                                           */
/* ------------------------------------------------------------------ */

/**
 * Runs in the page. Finds the page scrolling sideways, every element that
 * scrolls sideways inside itself, and every element that reaches past the
 * right edge of the viewport where nothing but the page could clip it (a
 * page with overflow-x hidden would otherwise hide it).
 */
function measure() {
  const name = (el) => {
    let s = el.tagName.toLowerCase();
    if (el.id) s += `#${el.id}`;
    const classes = [...el.classList].filter((c) => !/^astro-|^sl-flex$|^is-new$/.test(c)).slice(0, 3);
    if (classes.length) s += `.${classes.join(".")}`;
    return s;
  };
  const path = (el) => {
    const parts = [];
    for (let e = el; e && e !== document.body && parts.length < 3; e = e.parentElement) parts.unshift(name(e));
    // Which of the page's elements of its kind it is, so two code blocks on one page are two findings.
    const nth = [...document.getElementsByTagName(el.tagName)].indexOf(el) + 1;
    return `${parts.join(" > ")} (${el.tagName.toLowerCase()} ${nth})`;
  };
  const sample = (el) => (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
  const out = [];
  const doc = document.scrollingElement;
  const vw = doc.clientWidth;
  if (doc.scrollWidth > vw + 1) out.push({ kind: "page", el: "page", by: doc.scrollWidth - vw, text: "" });
  const clips = (cs) => cs.overflowX !== "visible";
  for (const el of document.body.querySelectorAll("*")) {
    if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
    const cs = getComputedStyle(el);
    if ((cs.overflowX === "auto" || cs.overflowX === "scroll") && el.scrollWidth > el.clientWidth + 1) {
      out.push({ kind: "scrolls", el: path(el), by: el.scrollWidth - el.clientWidth, text: sample(el) });
      continue;
    }
    const r = el.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1 || r.right <= vw + 1) continue;
    // Fixed to the viewport, it can't make the page scroll; what's inside it is measured on its own.
    if (cs.position === "fixed") continue;
    let clipped = false;
    for (let a = el.parentElement; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
      if (clips(getComputedStyle(a))) {
        clipped = true;
        break;
      }
    }
    if (!clipped) out.push({ kind: "past the edge", el: path(el), by: Math.round(r.right - vw), text: sample(el) });
  }
  // Report the outermost element past the edge, not every child inside it.
  const past = out.filter((f) => f.kind === "past the edge");
  return out.filter((f) => f.kind !== "past the edge" || !past.some((p) => p !== f && f.el.startsWith(p.el.replace(/ \([a-z0-9]+ \d+\)$/, "") + " >")));
}

/* ------------------------------------------------------------------ */
/* Products                                                            */
/* ------------------------------------------------------------------ */

/**
 * A product: where it is served, its pages, and the extra states worth
 * opening on a page (a menu, a filled form). A state is a function of the
 * page that leaves it showing what to measure.
 */
const SITES = [
  { id: "site", dir: "apps/site/dist" },
  { id: "docs", dir: "apps/docs/dist" },
  { id: "playground", dir: "apps/playground/dist" },
  { id: "network", dir: "apps/network/dist" },
];

/** Opens the products grid in the header, on any product. */
const productsMenu = {
  name: "products menu open",
  run: async (page) => {
    const grid = page.locator("[data-products-toggle], .products-toggle, button[aria-controls*='products']").first();
    if (!(await grid.count())) return false;
    await grid.click();
    await page.waitForTimeout(400);
    return true;
  },
};

const LONG_INVITE = "https://relay.northwind-freight-holdings-international.example.com/.well-known/weft-invite.json";

/**
 * Runs in the page before its scripts: a window.weft that answers as Weft
 * does once the person has connected, with long values where a page could
 * overflow (a long MSP ID, attributes, a large read).
 */
function fakeProvider() {
  const identity = {
    id: "alice",
    name: "alice-with-a-long-enrolment-name",
    mspId: "NorthwindFreightHoldingsInternationalMSP",
    role: "client",
    attributes: { "hf.EnrollmentID": "alice-with-a-long-enrolment-name", "hf.Affiliation": "org1.department1.northwind-freight-holdings", "hf.Type": "client" },
    issuer: "CN=ca.org1.example.com",
    notAfter: "2027-06-01T00:00:00.000Z",
    fingerprint: "9F:3A",
    certificate: "",
  };
  const tx = "e41b22d89f3a1c07b25e6d0c4a7f38e19b5c2d74a6e0f18c3b9d5a2e7f04c61d";
  const assets = Array.from({ length: 6 }, (_, i) => ({ ID: `asset${i}`, Color: "blue", Size: 5, Owner: "Northwind Freight Holdings International", AppraisedValue: 300, Note: "a-long-value-with-no-spaces-0123456789abcdef0123456789abcdef0123456789abcdef" }));
  const answers = {
    weft_connect: identity,
    weft_identity: identity,
    weft_networks: [{ id: "net", name: "Northwind Trade Finance Consortium (Production)", mspId: identity.mspId, channels: ["mychannel", "letters-of-credit-and-trade-finance-settlements"], active: true }],
    weft_evaluate: { text: JSON.stringify(assets), status: 200 },
    weft_submit: { transactionId: tx, blockNumber: "1204512", status: "VALID", text: null },
  };
  window.weft = {
    isWeft: true,
    version: "0.1.0",
    features: [],
    on() {},
    removeListener() {},
    request: async ({ method }) => answers[method] ?? null,
  };
}

/**
 * Runs in the page before its scripts: Weft and Weft Experimental, each
 * announcing a provider when asked (docs/adr/0010), so a page offers both.
 */
function twoWallets() {
  const provider = () => Object.freeze({ isWeft: true, version: "0.1.0", features: [], request: async () => null, on() {}, off() {} });
  for (const [name, rdns] of [["Weft", "dev.ifeanyiugwu.weft"], ["Weft Experimental", "dev.ifeanyiugwu.weft.experimental"]]) {
    const detail = Object.freeze({ info: Object.freeze({ uuid: crypto.randomUUID(), name, rdns, icon: "" }), provider: provider() });
    window.addEventListener("weft:requestProvider", () => window.dispatchEvent(new CustomEvent("weft:announceProvider", { detail })));
  }
}

function statesFor(product, path, ctx) {
  const states = [{ name: "as loaded", run: async () => true }];
  if (path === "/" || path === "/index.html") states.push(productsMenu);
  if (product === "docs") {
    states.push({
      name: "page list open",
      run: async (page, width) => {
        if (width >= 800) return false;
        const button = page.locator("starlight-menu-button button").first();
        if (!(await button.isVisible().catch(() => false))) return false;
        await button.click();
        await page.waitForTimeout(400);
        return true;
      },
    });
  }
  if (product === "site" && path === "/join/") {
    states.push({ name: "with an invite", url: `/join/?weft-invite=${encodeURIComponent(LONG_INVITE)}`, run: async (page) => (await page.waitForTimeout(1200), true) });
    states.push({
      name: "with an invite and two wallets",
      url: `/join/?weft-invite=${encodeURIComponent(LONG_INVITE)}`,
      init: twoWallets,
      run: async (page) => {
        await page.getByRole("button", { name: "Add to Weft Experimental" }).waitFor({ timeout: 5000 });
        await page.waitForTimeout(600);
        return true;
      },
    });
  }
  if (product === "network" && path === "/" && ctx.explorer) {
    // Opened on the sample explorer, as a link with ?explorer= opens it.
    states.push({
      name: "with the sample explorer",
      url: `/?explorer=${encodeURIComponent(ctx.explorer)}`,
      run: async (page) => {
        await page.getByText("explorer found", { exact: false }).first().waitFor({ timeout: 15000 });
        await page.waitForTimeout(800);
        return true;
      },
    });
  }
  if (product === "network" && path === "/invite/") {
    states.push({
      name: "filled",
      run: async (page) => {
        await page.locator("#invite-url").fill(LONG_INVITE);
        const fields = page.locator("#invite-form input:not([type=checkbox]):not([type=radio])");
        const n = await fields.count();
        for (let i = 0; i < n; i++) {
          const f = fields.nth(i);
          if (!(await f.isVisible()) || (await f.inputValue())) continue;
          const type = await f.getAttribute("type");
          await f.fill(type === "url" ? "https://ca.org1.northwind-freight-holdings-international.example.com:7054" : "NorthwindFreightHoldingsInternationalMSP");
        }
        await page.waitForTimeout(600);
        return true;
      },
    });
  }
  if (product === "playground" && (path === "/" || path === "/index.html")) {
    states.push({
      name: "connected, after a read and a write",
      init: fakeProvider,
      run: async (page) => {
        await page.locator("#pg-conn[data-state=ok]").waitFor({ timeout: 5000 });
        await page.locator("#pg-evaluate").click();
        await page.locator("#pg-result-wrap:not([hidden])").waitFor({ timeout: 5000 });
        await page.locator("#pg-submit").click();
        await page.waitForTimeout(800);
        return true;
      },
    });
  }
  return states;
}

/** The explorer's pages: crawled from its front page, one of each kind of address, plus the ones no link reaches. */
async function explorerPages(browser, base) {
  const page = await browser.newPage();
  const shape = (p) => p.replace(/[0-9a-f]{8,}/gi, "{hex}").replace(/\/\d+(?=\/|$|\?)/g, "/{n}").replace(/=([^&]*)/g, "=…");
  const seen = new Map();
  const queue = ["/"];
  while (queue.length && seen.size < 40) {
    const path = queue.shift();
    if ([...seen.keys()].includes(shape(path))) continue;
    seen.set(shape(path), path);
    await page.goto(base + path).catch(() => {});
    const links = await page.$$eval("a[href]", (as) => as.map((a) => a.href)).catch(() => []);
    for (const href of links) {
      const u = new URL(href);
      if (u.origin !== base || u.pathname.startsWith("/api/") || u.pathname.startsWith("/assets/") || u.pathname.startsWith("/auth/")) continue;
      const p = u.pathname + u.search;
      if (!seen.has(shape(p))) queue.push(p);
    }
  }
  await page.close();
  const pages = new Set(seen.values());
  // The sample's config block, a transaction the peers marked invalid, a hidden contract, and the pages no link reaches.
  for (const extra of [
    "/channels/mychannel/blocks/0",
    "/channels/mychannel/transactions/00066464ffeeddccbbaa99887766554433221100ffeeddccbbaa9988776655443322",
    "/channels/mychannel/contracts/ballot",
    "/channels/mychannel/elections",
    "/me",
    "/search?q=asset7",
    "/search?q=nothing-matches-this",
    "/no-such-page",
    "/channels/mychannel/blocks/999999",
    "/channels/nochannel",
  ]) pages.add(extra);
  return [...pages];
}

/* ------------------------------------------------------------------ */
/* Running                                                             */
/* ------------------------------------------------------------------ */

const findings = [];
let checked = 0;

async function check(browser, product, base, path, states, init) {
  if (PAGES && !PAGES.some((p) => path.includes(p))) return;
  for (const theme of THEMES) {
    for (const width of WIDTHS) {
      for (const state of states) {
        if (state.minWidth && width < state.minWidth) continue;
        const context = await browser.newContext({ viewport: { width, height: HEIGHT }, colorScheme: theme, reducedMotion: "reduce" });
        if (init) await context.addInitScript(init.script, init.arg);
        if (state.init) await context.addInitScript(state.init);
        const page = await context.newPage();
        try {
          await page.goto(base + (state.url ?? path), { waitUntil: "load" });
          await page.waitForTimeout(250);
          if (!(await state.run(page, width))) continue;
          checked++;
          if (SHOTS) {
            const file = `${product}${(state.url ?? path).replace(/[^a-z0-9]+/gi, "-")}${state.name === "as loaded" ? "" : `-${state.name.replace(/\W+/g, "-")}`}-${width}-${theme}.png`;
            await page.screenshot({ path: join(SHOTS, file), fullPage: true });
          }
          for (const f of await page.evaluate(measure)) findings.push({ product, path: state.url ?? path, state: state.name, width, theme, ...f });
        } catch (error) {
          findings.push({ product, path, state: state.name, width, theme, kind: "error", el: String(error).split("\n")[0], by: 0, text: "" });
        } finally {
          await context.close();
        }
      }
    }
  }
}

const browser = await chromium.launch();
const ctx = {};
const closers = [];
try {
  const want = (id) => !ONLY || ONLY.includes(id);
  if (want("explorer") || want("network")) {
    const explorer = await startExplorer();
    closers.push(explorer.close);
    ctx.explorer = explorer.url;
  }
  for (const site of SITES) {
    if (!want(site.id)) continue;
    const dir = join(ROOT, site.dir);
    if (!existsSync(dir)) throw new Error(`${site.dir} is missing. Run pnpm build first.`);
    const server = await serveStatic(dir);
    closers.push(server.close);
    const pages = await pagesOf(dir);
    process.stdout.write(`${site.id}: ${pages.length} pages\n`);
    for (const path of pages) await check(browser, site.id, server.url, path, statesFor(site.id, path, ctx));
  }
  if (want("explorer")) {
    const pages = await explorerPages(browser, ctx.explorer);
    process.stdout.write(`explorer: ${pages.length} pages (${pages.join(", ")})\n`);
    for (const path of pages) await check(browser, "explorer", ctx.explorer, path, statesFor("explorer", path, ctx));
  }
  if (want("wallet")) {
    const dir = join(ROOT, "apps/extension/.output/chrome-mv3");
    if (!existsSync(dir)) throw new Error("apps/extension/.output/chrome-mv3 is missing. Run pnpm --filter @weftwallet/extension build first.");
    const server = await serveStatic(dir);
    closers.push(server.close);
    const screens = walletProduct.screens;
    process.stdout.write(`wallet: ${screens.length} screens (the popup sets its own width, 360px, so it isn't opened narrower)\n`);
    for (const screen of screens) {
      await check(browser, "wallet", server.url, screen.path, [{ name: screen.name, run: screen.run, minWidth: screen.minWidth }], { script: walletProduct.fakeWorker, arg: screen.worker ?? {} });
    }
  }
} finally {
  await browser.close();
  for (const close of closers) close();
}

/* ------------------------------------------------------------------ */
/* Report                                                              */
/* ------------------------------------------------------------------ */

// One line per element, page and state, with the widths and themes it failed at.
const groups = new Map();
for (const f of findings) {
  const key = [f.product, f.path, f.state, f.kind, f.el].join(" | ");
  const g = groups.get(key) ?? { ...f, at: new Set(), max: 0 };
  g.at.add(`${f.width}${f.theme === "dark" ? "d" : "l"}`);
  g.max = Math.max(g.max, f.by);
  groups.set(key, g);
}
for (const g of groups.values()) {
  const widths = [...new Set([...g.at].map((a) => a.slice(0, -1)))].join(", ");
  const themes = [...new Set([...g.at].map((a) => (a.endsWith("d") ? "dark" : "light")))].join(" and ");
  process.stdout.write(`FAIL ${g.product} ${g.path} (${g.state}) ${g.kind}: ${g.el}, by ${g.max}px at ${widths} in ${themes}${g.text ? ` [${g.text}]` : ""}\n`);
}
process.stdout.write(`\nChecked ${checked} page states (${WIDTHS.join(", ")} wide, ${THEMES.join(" and ")}). ${groups.size ? `${groups.size} elements scroll sideways.` : "Nothing scrolls sideways."}\n`);
process.exitCode = groups.size ? 1 : 0;
