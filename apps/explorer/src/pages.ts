/**
 * Server-rendered pages. They work without JavaScript; a few lines of script
 * add relative times, keep live pages current and run the checks that stay
 * in the browser.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { products } from "@weftwallet/brand/products";
import { explainStatus } from "@weftwallet/core";
import type { BlockRow, ChannelSummary, TransactionRow } from "./db.ts";
import { html, raw, type Html } from "./html.ts";
import type { ChannelStatus } from "./indexer.ts";
import type { Viewer } from "./auth.ts";
import { agreementFor, type PeerStatus } from "./checkpoints.ts";
import { splitKey, type ElectionView, type ReceiptCheck } from "./elections.ts";
import type { PublishedParty, ShownValue } from "./policy.ts";
import { productAddress, type ProductAddresses } from "./config.ts";
import { acceptHandoff, readReceipt } from "./receipt.ts";

export interface Site {
  name: string;
  /** Channels this viewer can see. */
  channels: string[];
  viewer: Viewer | null;
  /** Whether anything is published to members, so signing in is worth offering. */
  signIn: boolean;
  /** The other organisations' explorers' reports for a channel. Empty when none are configured. */
  peers: (channel: string) => PeerStatus[];
  /** Whether the channel has elections this viewer can see. */
  elections: (channel: string) => boolean;
  /** Whether the channel's elections include private ones (docs/adr/0007), shown only with WEFT_EXPERIMENTAL=1. */
  privateElections?: (channel: string) => boolean;
  /** The network page, which checks this explorer against the others from outside it. */
  networkPage?: string;
  /** Where the other Weft products are (WEFT_EXPLORER_PRODUCTS_DOMAIN). */
  products: ProductAddresses;
  /** Who may hand an election page a receipt's choice and salt (receipt.ts, acceptHandoff). */
  receiptOrigins: string[];
}

const require = createRequire(import.meta.url);
/** A brand SVG, made decorative: the text beside it names it. */
const markSvg = (file: string, size: number) =>
  raw(
    readFileSync(require.resolve(`@weftwallet/brand/${file}`), "utf8")
      .replace(/<!--[\s\S]*?-->\s*/g, "")
      .replace(/\s+role="img"\s+aria-label="[^"]*"/, ' aria-hidden="true" focusable="false"')
      .replace(/width="\d+" height="\d+"/, `width="${size}" height="${size}"`),
  );

/** Weft Explorer's mark: the finished cloth, on ink in the loom's frame. */
const MARK = markSvg(products.explorer.markSmall, 28);
/** The same mark at 24px and 16px, for its own entry in the products menu and the footer. */
const EXPLORER_MARKS = { mark: markSvg(products.explorer.markSmall, 24), small: markSvg(products.explorer.markSmall, 16) };
/** The full drawing at 48px, for the system pages: a 404, an error, nothing to show. */
const SYSTEM_MARK = markSvg(products.explorer.mark, 48);

/**
 * The other Weft products, as the sites' switcher lists them, at the
 * addresses this explorer was started with (WEFT_EXPLORER_PRODUCTS_DOMAIN).
 */
const SITE_IDS = ["site", "docs", "playground", "network"] as const;
const SITE_MARKS = Object.fromEntries(SITE_IDS.map((id) => [id, { mark: markSvg(products[id].markSmall, 24), small: markSvg(products[id].markSmall, 16) }]));
const sites = (where: ProductAddresses) =>
  SITE_IDS.map((id) => ({ ...products[id], ...SITE_MARKS[id]!, href: productAddress(id, where)! }));

/**
 * The repository, from the explorer's package.json (it ships in the image),
 * as a web address: "git+https://github.com/o/r.git", "github:o/r" and "o/r"
 * all give https://github.com/o/r. Null when there is none.
 */
export function repositoryUrl(pkg: { repository?: string | { url?: string } }): string | null {
  const given = (typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url)?.trim();
  if (!given) return null;
  const short = /^(?:github:)?([\w.-]+\/[\w.-]+)$/.exec(given);
  const url = short ? `https://github.com/${short[1]}` : given.replace(/^git\+/, "").replace(/^git:\/\//, "https://");
  try {
    const parsed = new URL(url.replace(/\.git$/, ""));
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString().replace(/\/$/, "") : null;
  } catch {
    return null;
  }
}
const REPOSITORY = repositoryUrl(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")));

/**
 * The scripts every Weft page shares, inlined from @weftwallet/ui so there is
 * one copy: early.js (the stored theme before the first paint, the page
 * transition's direction), theme-control.js, product-switcher.js and
 * header.js (the header's controls and layout, inlined right after the
 * header so they are in place before the first paint; header.css documents
 * their markup).
 */
const shared = (file: string) => readFileSync(require.resolve(`@weftwallet/ui/${file}`), "utf8");
const EARLY_SHARED = shared("early.js");
const HEADER_SCRIPTS = shared("theme-control.js") + "\n" + shared("product-switcher.js") + "\n" + shared("header.js");
/** The system page's address and Go back (system-page.js), inlined after the page's .sys section. */
const SYSTEM_PAGE_SCRIPT = shared("system-page.js");

/** The page ground in each theme, for the browser's own chrome (theme-color). */
const TOKENS = readFileSync(require.resolve("@weftwallet/brand/tokens.css"), "utf8");
const BG = {
  dark: /--weft-bg:\s*(#[0-9a-fA-F]{6})/.exec(TOKENS)?.[1] ?? "#0B1218",
  light: /\[data-theme="light"\]\s*\{[^}]*?--weft-bg:\s*(#[0-9a-fA-F]{6})/.exec(TOKENS)?.[1] ?? "#F5F3EE",
};

export const enc = encodeURIComponent;
export const channelUrl = (channel: string) => `/channels/${enc(channel)}`;
export const blockUrl = (channel: string, n: number) => `/channels/${enc(channel)}/blocks/${n}`;
export const txUrl = (channel: string, id: string) => `/channels/${enc(channel)}/transactions/${enc(id)}`;
const contractUrl = (channel: string, name: string) => `/channels/${enc(channel)}/contracts/${enc(name)}`;

/** An identifier cut in the middle, keeping 8 characters at each end, because people check the ends. */
export function cut(value: string): string {
  return value.length <= 17 ? value : `${value.slice(0, 8)}…${value.slice(-8)}`;
}

/** A shortened identifier. Copying it copies the whole value. */
export function short(value: string): Html {
  if (value.length <= 17) return html`${value}`;
  return html`<span data-copy="${value}" title="${value}">${cut(value)}</span>`;
}

/**
 * An identifier in full, in groups of four so two can be compared block by
 * block. The gaps are margins, not spaces, so copying gives the plain value.
 */
export function grouped(value: string, attrs: Html | string = ""): Html {
  const groups = value.match(/.{1,4}/g) ?? [value];
  return html`<span class="mono hash grouped" data-copy="${value}"${attrs}>${groups.map((g, i) => html`${i ? raw("<wbr>") : ""}<span>${g}</span>`)}</span>`;
}

export function time(at: number | null): Html {
  if (at === null) return html`<span class="subtle">unknown</span>`;
  const iso = new Date(at).toISOString();
  return html`<time datetime="${iso}" title="${iso.replace("T", " ").replace(/\.\d+Z$/, " UTC")}">${iso.slice(0, 16).replace("T", " ")} UTC</time>`;
}

function party(p: PublishedParty | null): Html {
  if (!p) return html`<span class="subtle">not published</span>`;
  return p.name ? html`<span>${p.name}</span> <span class="mono subtle">${p.mspId}</span>` : html`<span class="mono">${p.mspId}</span>`;
}

/** Validation codes, named in a word or two for a table. The full reason and the code are in the title. */
const STATUS_NAMES: Record<string, string> = {
  MVCC_READ_CONFLICT: "conflict",
  PHANTOM_READ_CONFLICT: "conflict",
  ENDORSEMENT_POLICY_FAILURE: "not endorsed",
  DUPLICATE_TXID: "duplicate",
  BAD_CREATOR_SIGNATURE: "signature refused",
  BAD_PROPOSAL_TXID: "malformed",
  EXPIRED_CHAINCODE: "contract changed",
  CHAINCODE_VERSION_CONFLICT: "contract changed",
  INVALID_ENDORSER_TRANSACTION: "endorsements differ",
  ILLEGAL_WRITESET: "write refused",
  INVALID_WRITESET: "write refused",
};

function status(validation: string, redacted = false): Html {
  if (validation === "VALID") return html`<span class="pill pill--ok">valid</span>`;
  const why = explainStatus(validation);
  return html`<span class="pill pill--bad"${redacted ? "" : html` title="${why.title} (${validation})"`}>${STATUS_NAMES[validation] ?? "invalid"}</span>`;
}

/** Technical detail behind "Details": a code, a raw message. */
export function errorDetails(detail: string | null | undefined): Html {
  if (!detail) return html``;
  return html`<details class="error-details"><summary>Details</summary><p>${detail}</p></details>`;
}

/** Composite keys (\0type\0a\0b\0) read as type / a / b. */
function readableKey(key: string): Html {
  const parts = splitKey(key);
  if (!parts) return html`${key}`;
  return html`<span class="subtle">${parts.type}</span>${parts.attrs.map((a) => html`<span class="subtle"> / </span>${a}`)}`;
}

/** A JSON value up to this long, with nothing nested in it, stays on one line. */
export const ONE_LINE_JSON = 48;
/** A pretty-printed value longer than this many lines is cut there, with Show all. */
export const VALUE_LINES = 24;

/**
 * How a JSON value is shown: on one line when it is short and flat
 * ({"n":0}), pretty-printed when it is long or nested. Exported for the tests.
 */
export function jsonText(parsed: object): { text: string; oneLine: boolean } {
  const compact = JSON.stringify(parsed);
  const nested = Object.values(parsed).some((v) => typeof v === "object" && v !== null);
  if (!nested && compact.length <= ONE_LINE_JSON) return { text: compact, oneLine: true };
  return { text: JSON.stringify(parsed, null, 2), oneLine: false };
}

let valueIds = 0;

function value(v: ShownValue | null): Html {
  if (!v) return html`<span class="subtle">deleted</span>`;
  if (v.sha256 !== undefined) return html`<span class="mono subtle" title="Published as a hash only">sha256 ${short(v.sha256)}</span>`;
  if (v.hex !== undefined) return html`<span class="mono value">0x${v.hex}</span>`;
  const text = v.text ?? "";
  if (text === "") return html`<span class="subtle">empty</span>`;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null) {
      const shown = jsonText(parsed);
      if (shown.oneLine) return html`<span class="mono value">${shown.text}</span>`;
      const lines = shown.text.split("\n").length;
      if (lines <= VALUE_LINES) return html`<pre class="value">${shown.text}</pre>`;
      // Cut at VALUE_LINES, with a control to show the rest and to cut it
      // again (VALUE_SCRIPT, explorer.css .value-cap).
      const id = `value-${++valueIds}`;
      return html`<div class="value-cap"><pre class="value" id="${id}" data-lines="${lines}">${shown.text}</pre><button type="button" class="link-button value-cap__toggle" aria-expanded="false" aria-controls="${id}">Show all</button></div>`;
    }
  } catch {
    /* plain text */
  }
  return html`<span class="mono value">${text}</span>`;
}

/**
 * Show all and Show less for long values. The value's height moves between
 * its cut and its whole as a transition, so a second press turns it back
 * from wherever it is (SYSTEM.md, Motion: reversible things).
 */
const VALUE_SCRIPT = `
(function () {
  var still = matchMedia("(prefers-reduced-motion: reduce)");
  document.querySelectorAll(".value-cap__toggle").forEach(function (button) {
    var pre = document.getElementById(button.getAttribute("aria-controls"));
    function settled() {
      if (button.getAttribute("aria-expanded") === "true") pre.style.maxHeight = "none";
      // Cut again: the control stays in view, where the value now ends.
      else if (button.getBoundingClientRect().top < 0) button.scrollIntoView({ block: "nearest" });
    }
    button.addEventListener("click", function () {
      var open = button.getAttribute("aria-expanded") !== "true";
      // From the height it has now, so a second press turns it back from there.
      pre.style.maxHeight = pre.getBoundingClientRect().height + "px";
      pre.offsetHeight;
      button.setAttribute("aria-expanded", String(open));
      button.textContent = open ? "Show less" : "Show all";
      pre.classList.toggle("is-open", open);
      pre.style.maxHeight = open ? pre.scrollHeight + (pre.offsetHeight - pre.clientHeight) + "px" : "";
      if (still.matches) settled();
    });
    pre.addEventListener("transitionend", function (e) { if (e.propertyName === "max-height") settled(); });
  });
})();`;

function call(tx: TransactionRow): Html {
  if (tx.membersOnly) return html`<span class="subtle">members only</span>`;
  if (tx.redacted) return html`<span class="subtle">unpublished contract</span>`;
  if (tx.type === "config") {
    const first = tx.config?.changes[0];
    const more = (tx.config?.changes.length ?? 0) - 1;
    return html`<span>Channel configuration</span>${first ? html`<div class="small subtle">${more > 0 ? `${first.replace(/\.$/, "")}, and ${more} more.` : first}</div>` : ""}`;
  }
  if (!tx.chaincode) return html`<span class="subtle">${tx.typeName.toLowerCase()}</span>`;
  return html`<a class="mono" href="${contractUrl(tx.channel, tx.chaincode)}">${tx.chaincode}</a><span class="mono subtle">.</span><span class="mono">${tx.fn ?? ""}</span>`;
}

/** Icons on the 16px grid, one 1.5px stroke with round ends, as the header draws them. */
const ICONS = {
  grid: raw(`<svg class="weft-switcher__grid" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" focusable="false"><rect x="2" y="2" width="5" height="5" rx="1.25"></rect><rect x="9" y="2" width="5" height="5" rx="1.25"></rect><rect x="2" y="9" width="5" height="5" rx="1.25"></rect><rect x="9" y="9" width="5" height="5" rx="1.25"></rect></svg>`),
  check: raw(`<svg class="weft-switcher__check" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3.5 8.5l3 3 6-7"></path></svg>`),
  search: raw(`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="7" cy="7" r="4.75"></circle><path d="M10.5 10.5L14 14"></path></svg>`),
  searchField: raw(`<svg class="shell-search__icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="7" cy="7" r="4.75"></circle><path d="M10.5 10.5L14 14"></path></svg>`),
  shut: raw(`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M4 4l8 8M12 4l-8 8"></path></svg>`),
  close: raw(`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>`),
  chevron: raw(`<svg class="account-menu__chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M4 6l4 4 4-4"></path></svg>`),
};

/** The theme toggle, as every Weft site renders it (header.css has the markup). */
function themeControl(): Html {
  return html`<button type="button" class="weft-theme shell-tool" aria-pressed="false" aria-label="Dark theme" aria-describedby="weft-theme-desc" data-weft-theme="weft-theme">
      <svg class="weft-theme__icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><mask id="weft-theme-mask"><rect x="-4" y="-4" width="24" height="24" fill="#fff"></rect><circle class="weft-theme__cut" cx="12.5" cy="3.5" r="4.6" fill="#000"></circle></mask><circle class="weft-theme__core" cx="8" cy="8" r="6" fill="currentColor" mask="url(#weft-theme-mask)"></circle><g class="weft-theme__rays" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3.05 3.05l1.06 1.06M11.89 11.89l1.06 1.06M3.05 12.95l1.06-1.06M11.89 4.11l1.06-1.06"></path></g></svg>
      <span class="weft-theme__desc" id="weft-theme-desc">Following your device</span>
    </button>`;
}

/**
 * The products grid, as every Weft site renders it, with Weft Explorer last,
 * marked as current and run by this organisation (on a phone the
 * organisation's chip leaves the bar for the row under it; this entry still
 * names it). The menu is a .reversible (motion.css).
 */
function productSwitcher(site: Site): Html {
  return html`<div class="weft-switcher" data-weft-switcher>
      <button type="button" class="weft-switcher__button" aria-expanded="false" aria-controls="weft-products" aria-label="Weft products" title="Weft products">${ICONS.grid}</button>
      <ul class="weft-switcher__menu reversible reversible--down" id="weft-products">
        ${sites(site.products).map((p) => html`<li><a href="${p.href}">${p.mark}<span class="weft-switcher__text"><span class="weft-switcher__name">${p.name}</span><span class="weft-switcher__summary">${p.summary}</span></span></a></li>`)}
        <li><a href="/" aria-current="page">${EXPLORER_MARKS.mark}<span class="weft-switcher__text"><span class="weft-switcher__name">${products.explorer.name}</span><span class="weft-switcher__summary">${products.explorer.summary}</span><span class="weft-switcher__here">Run by ${site.name}</span></span>${ICONS.check}</a></li>
      </ul>
    </div>`;
}

/** Search: the field in the bar, and on a phone a 36px button that opens the same field across it (header.css). */
function search(query: string): Html {
  const field = html`<form class="shell-search" action="/search" role="search">
      ${ICONS.searchField}
      <input class="shell-search__input" name="q" type="search" value="${query}" placeholder="Search the ledger" aria-label="Search by transaction ID, block number or contract" title="Transaction ID, block number or contract" spellcheck="false" autocomplete="off">
    </form>`;
  return html`${field}
    <button type="button" class="shell-tool shell-search-open" aria-expanded="false" aria-controls="search-pop" aria-label="Search" title="Search" data-shell-search-open>${ICONS.search}</button>
    <div class="shell-search-pop reversible reversible--down" id="search-pop">${field}<button type="button" class="shell-tool" aria-label="Close search" title="Close search" data-shell-search-close>${ICONS.shut}</button></div>`;
}

/**
 * A field's reserved error line (SYSTEM.md, Errors): always present, 20px
 * tall, so nothing below the field moves when a message fades into it.
 */
export function fieldError(id: string, message = ""): Html {
  return html`<p class="field__status${message ? " field-error" : ""}" id="${id}">${message}</p>`;
}

/** A field's attributes when the server already found it wrong. */
export function invalid(errorId: string | null): Html {
  return errorId ? html` aria-invalid="true" aria-describedby="${errorId}"` : html``;
}

/**
 * In the head, before the first paint: the shared early script (the chosen
 * theme, so it never flashes the other one, and the direction of a page
 * change), the browser's own chrome colour, and the helpers the pages' own
 * scripts use for announcing, busy controls and checking fields.
 */
const EARLY = `
${EARLY_SHARED}
(function () {
  var root = document.documentElement;
  var bg = ${JSON.stringify(BG)};
  // The browser's own chrome follows the page's theme.
  function themeColour() {
    var t = root.dataset.theme;
    document.querySelectorAll('meta[name="theme-color"]').forEach(function (m) {
      m.content = t ? bg[t] : m.media.indexOf("light") >= 0 ? bg.light : bg.dark;
    });
  }
  themeColour();
  new MutationObserver(themeColour).observe(root, { attributes: true, attributeFilter: ["data-theme"] });
  // The page's one live region, written only when something changes for the person.
  window.weftSay = function (text) {
    var region = document.getElementById("live");
    if (!region) return;
    region.textContent = "";
    setTimeout(function () { region.textContent = text; }, 60);
  };
  // A busy control (SYSTEM.md, Loading): aria-disabled at once, the loader
  // only after wait-before-loader, and gone at once when the work ends.
  var loaderTimers = new WeakMap();
  window.weftBusy = function (button, busy) {
    var pending = loaderTimers.get(button);
    if (pending) { clearTimeout(pending); loaderTimers.delete(button); }
    if (busy) {
      button.setAttribute("aria-disabled", "true");
      var wait = parseFloat(getComputedStyle(root).getPropertyValue("--weft-wait-before-loader")) || 300;
      loaderTimers.set(button, setTimeout(function () {
        loaderTimers.delete(button);
        if (button.getAttribute("aria-disabled") === "true") button.classList.add("is-working");
      }, wait));
    } else {
      button.removeAttribute("aria-disabled");
      button.classList.remove("is-working");
    }
  };
  // A field checked when it loses focus, then on every change while its error
  // shows. The message goes into the field's reserved line (p.field__status).
  window.weftField = function (input, check) {
    var error = document.getElementById(input.id + "-error");
    var showing = input.getAttribute("aria-invalid") === "true";
    function describe(on) {
      var ids = (input.getAttribute("aria-describedby") || "").split(" ").filter(function (id) { return id && id !== error.id; });
      if (on) ids.push(error.id);
      if (ids.length) input.setAttribute("aria-describedby", ids.join(" ")); else input.removeAttribute("aria-describedby");
    }
    function run() {
      var message = check(input.value);
      showing = !!message;
      error.textContent = message || "";
      error.classList.toggle("field-error", !!message);
      if (message) input.setAttribute("aria-invalid", "true"); else input.removeAttribute("aria-invalid");
      describe(!!message);
      return !message;
    }
    input.addEventListener("blur", function () { if (input.value !== "" || showing) run(); });
    input.addEventListener("input", function () { if (showing) run(); });
    return { input: input, run: run };
  };
  // On submit: check every field and move focus to the first one that's wrong.
  window.weftForm = function (form, fields, done) {
    form.addEventListener("submit", function (e) {
      var first = null;
      fields.forEach(function (f) { if (!f.run() && !first) first = f.input; });
      if (first) { e.preventDefault(); first.focus(); return; }
      if (done) { e.preventDefault(); done(); }
    });
  };
})();`;

/** Relative times, kept current on every page. Times more than a day away keep their date. */
const RELATIVE = `
window.weftRelative = function (root) {
  (root || document).querySelectorAll("time[datetime]").forEach(function (el) {
    if (!el.dataset.text) el.dataset.text = el.textContent;
    var s = Math.round((Date.now() - Date.parse(el.getAttribute("datetime"))) / 1000);
    var t = s < -86400 ? null : s < -3600 ? "in " + Math.round(-s / 3600) + " h" : s < -45 ? "in " + Math.round(-s / 60) + " min" : s < 0 ? "in a moment" :
      s < 45 ? "just now" : s < 3600 ? Math.round(s / 60) + " min ago" : s < 86400 ? Math.round(s / 3600) + " h ago" : null;
    var text = t || el.dataset.text;
    if (el.textContent !== text) el.textContent = text;
  });
};
weftRelative();
setInterval(weftRelative, 30000);
// A shortened or grouped identifier copies as its whole value, without spaces.
document.addEventListener("copy", function (e) {
  var selection = getSelection();
  if (!selection || selection.isCollapsed || !e.clipboardData) return;
  var node = selection.getRangeAt(0).commonAncestorContainer;
  var el = (node.nodeType === 1 ? node : node.parentElement).closest("[data-copy]");
  if (!el) return;
  e.clipboardData.setData("text/plain", el.getAttribute("data-copy"));
  e.preventDefault();
});`;

/**
 * The header's controls are the shared scripts, inlined after the header
 * (HEADER_SCRIPTS); what is left here is the disclosure that closes the way
 * it opened (motion.css details.disclosure: the content leaves before the
 * native element shuts).
 */
const CHROME = `
(function () {
  var still = matchMedia("(prefers-reduced-motion: reduce)");
  function close(details, done) {
    if (!details.open || details.classList.contains("is-closing")) return;
    var content = Array.prototype.find.call(details.children, function (c) { return c.tagName !== "SUMMARY"; });
    if (!content || still.matches || getComputedStyle(content).animationName === "none") { details.open = false; if (done) done(); return; }
    details.classList.add("is-closing");
    var timer = setTimeout(end, 300);
    function end() {
      clearTimeout(timer);
      content.removeEventListener("animationend", end);
      details.classList.remove("is-closing");
      details.open = false;
      if (done) done();
    }
    content.addEventListener("animationend", end);
  }
  document.querySelectorAll("details.disclosure").forEach(function (details) {
    details.querySelector("summary").addEventListener("click", function (e) {
      if (details.open) { e.preventDefault(); close(details); }
    });
  });
})();`;

/**
 * The sign-in button, and the note its errors appear in, named by the
 * button's data-signin. In the header and the page the note comes right
 * after the button; in the row under the header on a phone it goes after
 * the row's line (header.css .shell-row), so the line can be clipped as the
 * row leaves while the note stays, and the row stays while it shows
 * (data-row-keep).
 */
function signInButton(where: "header" | "row" | "page"): Html {
  return html`${signInOnly(where)}${signInNote(where)}`;
}
function signInOnly(where: "header" | "row" | "page"): Html {
  return html`<button type="button" class="signin"${where === "header" ? raw(' id="signin"') : ""} data-signin="signin-note-${where}">${WALLET_MARK}<span>Sign in with Weft</span></button>`;
}
function signInNote(where: "header" | "row" | "page"): Html {
  return html`<div class="signin-note${where === "page" ? " signin-note--inline" : ""}" id="signin-note-${where}" role="alert"${where === "row" ? raw(" data-row-keep") : ""} hidden>
  <div class="signin-note__body"><p class="signin-note__text"></p><details class="error-details" hidden><summary>Details</summary><p></p></details></div>
  <button type="button" class="signin-note__close" aria-label="Close">${ICONS.close}</button>
</div>`;
}

export function layout(site: Site, title: string, body: Html, options: { query?: string; live?: boolean; current?: "me" } = {}): string {
  const signIn = site.signIn && !site.viewer;
  return html`<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="${BG.dark}" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="${BG.light}" media="(prefers-color-scheme: light)">
<title>${title} | ${site.name}'s explorer</title>
<script>${raw(EARLY)}</script>
<link rel="expect" href="#foot" blocking="render">
<link rel="preload" href="/assets/fonts/sans-400.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/assets/fonts/sans-600.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/assets/fonts/mono-500.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/assets/tokens.css">
<link rel="stylesheet" href="/assets/motion.css">
<link rel="stylesheet" href="/assets/select.css">
<link rel="stylesheet" href="/assets/header.css">
<link rel="stylesheet" href="/assets/explorer.css">
<link rel="icon" type="image/svg+xml" href="/assets/mark.svg">
</head>
<body>
<a class="skip" href="#main">Skip to the content</a>
<p class="sr" id="live" role="status"></p>
<header class="shell-head">
  <div class="shell-bar">
    ${productSwitcher(site)}
    <a class="shell-lockup" href="/" aria-label="Weft Explorer, home">${MARK}<span class="shell-word">weft<span class="shell-word__product"> explorer</span></span></a>
    <span class="org" title="Run by ${site.name}">${site.name}</span>
    ${search(options.query ?? "")}
    ${account(site, options.current === "me")}
    ${themeControl()}
  </div>
  ${orgRow(site, options.current === "me")}
</header>
<script>${raw(HEADER_SCRIPTS)}</script>
<main class="wrap" id="main">${options.live ? LIVE_NOTE : ""}${body}</main>
<footer class="foot" id="foot">
  <div class="wrap foot__inner">
    <p class="foot__run">Run by ${site.name}, from its own peers. It shows only what ${site.name} chose to publish. <a href="/api/v1/status">Read this data as JSON</a></p>
    <div class="foot__row">
      <ul class="foot__products">
        ${sites(site.products).map((p) => html`<li><a href="${p.href}">${p.small}${p.name}</a></li>`)}
        <li><a href="/" aria-current="page">${EXPLORER_MARKS.small}${products.explorer.name}</a></li>
      </ul>
      <p>Weft is open source under the Apache 2.0 licence.${REPOSITORY ? html` <a href="${REPOSITORY}">Source on GitHub</a>.` : ""}</p>
    </div>
  </div>
</footer>
<script>
${raw(RELATIVE)}
${raw(CHROME)}
${options.live ? raw(LIVE) : ""}
${signIn ? raw(signInScript(site.name, productAddress("site", site.products)!)) : ""}
</script>
</body>
</html>`.value;
}

/**
 * The account in the bar, from 720px: the person's name, which opens their
 * transactions, and Sign out. A long name ends in an ellipsis; its title has
 * the whole name.
 */
function account(site: Site, current: boolean): Html {
  if (site.viewer) {
    const name = site.viewer.name ?? "Signed in";
    return html`<div class="account">
      <a href="/me" title="${name}, ${site.viewer.mspId}. Your transactions"${current ? raw(' aria-current="page"') : ""}>${name} <span class="mono subtle">${site.viewer.mspId}</span></a>
      <form method="post" action="/auth/sign-out"><button type="submit" class="link-button">Sign out</button></form>
    </div>`;
  }
  if (!site.signIn) return html``;
  return signInButton("header");
}

/**
 * Under 720px the organisation and the account leave the bar for a 40px row
 * under it, in the header (header.css .shell-row: it leaves as the page
 * scrolls down and comes back as it scrolls up). On the left, who runs this
 * explorer; on the right, "Sign in with Weft", or the person's name as a
 * button that opens a menu like the products grid's (product-switcher.js,
 * [data-weft-menu]) with their transactions and Sign out.
 */
function orgRow(site: Site, current: boolean): Html {
  const viewer = site.viewer;
  const name = viewer ? viewer.name ?? "Signed in" : "";
  const end = viewer
    ? html`<button type="button" class="account-menu__button" aria-expanded="false" aria-controls="account-menu" title="${name}, ${viewer.mspId}" data-weft-menu-button><span class="account-menu__name">${name}</span>${ICONS.chevron}</button>`
    : site.signIn
      ? signInOnly("row")
      : html``;
  const after = viewer
    ? html`<div class="account-menu reversible reversible--down" id="account-menu">
      <p class="account-menu__who">Signed in with Weft as <span class="account-menu__person">${name}</span> <span class="account-menu__msp">${viewer.mspId}</span></p>
      <ul>
        <li><a class="account-menu__item" href="/me"${current ? raw(' aria-current="page"') : ""}>Your transactions</a></li>
        <li><form method="post" action="/auth/sign-out"><button type="submit" class="account-menu__item">Sign out</button></form></li>
      </ul>
    </div>`
    : site.signIn
      ? signInNote("row")
      : html``;
  return html`<div class="shell-row org-row"${viewer ? raw(" data-weft-menu") : ""}>
    <div class="shell-row__line org-row__line">
      <p class="org-row__org" title="Run by ${site.name}">Run by <span>${site.name}</span></p>
      ${end}
    </div>
    ${after}
  </div>`;
}

/** The wallet's mark, on "Sign in with Weft": it's Weft that signs, not the explorer. */
const WALLET_MARK = markSvg(products.wallet.markSmall, 16);

/**
 * Sign-in: connect, get a nonce, ask Weft to sign in, send the result back.
 * The server checks the signature and that the certificate belongs to a
 * member organisation, then sets a session cookie. While it works the button
 * keeps its label and focus, shows Weft's loader after the wait and ignores presses.
 */
function signInScript(name: string, getWeft: string): string {
  const statement = JSON.stringify(`Sign in to ${name}'s explorer`).replace(/</g, "\\u003c");
  return `
(function () {
  var getWeft = ${JSON.stringify(getWeft)};
  // Every request that may never answer has a time limit.
  function within(ms, promise, who) {
    return Promise.race([promise, new Promise(function (_, reject) { setTimeout(function () { reject({ timeout: who }); }, ms); })]);
  }
  function hide(note, now) {
    if (note.hidden) return;
    var still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (now || still) { note.hidden = true; note.classList.remove("is-leaving"); return; }
    note.classList.add("is-leaving");
    note.addEventListener("animationend", function end() { note.removeEventListener("animationend", end); note.hidden = true; note.classList.remove("is-leaving"); });
  }
  function show(note, kind, text, detail, link) {
    var p = note.querySelector(".signin-note__text");
    p.textContent = text;
    if (link) { var a = document.createElement("a"); a.href = getWeft; a.textContent = "Get Weft"; p.append(" ", a); }
    var details = note.querySelector(".error-details");
    details.hidden = !detail;
    details.open = false;
    details.querySelector("p").textContent = detail || "";
    note.className = "signin-note" + (note.classList.contains("signin-note--inline") ? " signin-note--inline" : "") + (kind === "error" ? " signin-note--error" : "");
    note.hidden = false;
  }
  document.querySelectorAll("[data-signin]").forEach(function (button) {
    var note = document.getElementById(button.getAttribute("data-signin"));
    note.querySelector(".signin-note__close").addEventListener("click", function () { hide(note); button.focus(); });
    note.addEventListener("keydown", function (e) { if (e.key === "Escape") { hide(note); button.focus(); } });
    button.addEventListener("click", async function () {
      if (button.getAttribute("aria-disabled") === "true") return;
      hide(note, true);
      var weft = window.weft;
      if (!weft) { show(note, "info", "Install Weft to sign in. This explorer checks your organisation's identity, which Weft holds.", null, true); return; }
      weftBusy(button, true);
      weftSay("Waiting for Weft to sign you in.");
      try {
        await within(120000, weft.request({ method: "weft_connect" }), "weft");
        var nonce = (await (await within(15000, fetch("/auth/nonce"), "explorer")).json()).nonce;
        var signed = await within(120000, weft.request({ method: "weft_signIn", params: { nonce: nonce, statement: ${statement} } }), "weft");
        var res = await within(15000, fetch("/auth/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(signed) }), "explorer");
        if (!res.ok) { var body = await res.json().catch(function () { return {}; }); throw { refused: body.error || "This explorer couldn't check that sign-in. Try again.", detail: body.error ? body.detail : "HTTP " + res.status }; }
        location.reload();
        return;
      } catch (error) {
        error = error || {};
        if (error.code === 4001) show(note, "info", "Sign-in cancelled.");
        else if (error.timeout === "weft") show(note, "error", "Weft didn't answer. Open Weft, check it's unlocked, and try again.");
        else if (error.timeout === "explorer") show(note, "error", "This explorer didn't answer. Check your connection and try again.");
        else if (error.refused) show(note, "error", error.refused, error.detail);
        else if (error instanceof TypeError) show(note, "error", "This explorer didn't answer. Check your connection and try again.", error.message);
        else show(note, "error", "Weft couldn't sign you in. Try again.", [error.code, error.message].filter(Boolean).join(": "));
      }
      weftBusy(button, false);
    });
  });
})();`;
}

/**
 * Keeps a page current. It polls the status API and, when a channel changes,
 * fetches the page again and updates the parts marked data-live in place:
 * rows are added, changed or dropped one by one, so focus, scroll position
 * and anything typed survive. Rows that weren't there before come in as a
 * pick, and the page's live region says what arrived. Pages of older blocks
 * don't update.
 */
/**
 * What a live page shows after three failed checks: when it stopped, how
 * often it checks, and Check now, which checks at once. The LIVE script
 * writes the times. A reversible (motion.css), so it leaves the way it came.
 */
const LIVE_NOTE = html`<div class="live-note reversible reversible--down" id="live-note" hidden><p id="live-note-text">This page has stopped updating. It checks again every 4 seconds.</p><button type="button" class="btn btn--small" id="live-check">Check now</button></div>`;

export const LIVE = `
(function () {
  if (/[?&]before=/.test(location.search)) return;
  var seen = null, failures = 0, stoppedAt = null, resumed = false, every = 4000;
  var note = document.getElementById("live-note"), noteText = document.getElementById("live-note-text"), checkNow = document.getElementById("live-check");
  var clock = function () { return new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }); };
  var checksAgain = "It checks again every " + every / 1000 + " seconds.";
  var rowKey = function (row) { var a = row.querySelector("a[href]"); return a ? a.getAttribute("href") : null; };
  // Replace one element, keeping focus on the same link or field inside it.
  function swap(old, fresh) {
    var active = document.activeElement, find = null;
    if (active && active !== document.body && old.contains(active)) {
      find = active.id ? "#" + CSS.escape(active.id) : active.getAttribute("href") ? '[href="' + CSS.escape(active.getAttribute("href")) + '"]' : null;
    }
    old.replaceWith(fresh);
    var again = find && (fresh.matches(find) ? fresh : fresh.querySelector(find));
    if (again) again.focus({ preventScroll: true });
  }
  function rows(body, next, added) {
    var byKey = {};
    Array.from(body.rows).forEach(function (r) { var k = rowKey(r); if (k) byKey[k] = r; });
    var wanted = Array.from(next.rows);
    wanted.forEach(function (fresh, i) {
      var k = rowKey(fresh), row = k && byKey[k];
      if (row) {
        Array.from(fresh.cells).forEach(function (cell, j) {
          var old = row.cells[j];
          if (old && old.innerHTML !== cell.innerHTML) swap(old, document.importNode(cell, true));
        });
      } else {
        row = document.importNode(fresh, true);
        row.classList.add("is-new");
        added.push(row);
      }
      if (body.rows[i] !== row) body.insertBefore(row, body.rows[i] || null);
    });
    // Rows that fell off the end go; focus moves to the row that took their place.
    while (body.rows.length > wanted.length) {
      var last = body.rows[body.rows.length - 1];
      var hadFocus = last.contains(document.activeElement);
      last.remove();
      if (hadFocus) { var link = body.rows.length ? body.rows[body.rows.length - 1].querySelector("a[href]") : null; if (link) link.focus({ preventScroll: true }); }
    }
  }
  function update(next) {
    weftRelative(next);
    // What the person is reading stays where it is when rows arrive above it.
    var top = document.querySelector(".shell-head"), edge = top && getComputedStyle(top).position === "sticky" ? top.getBoundingClientRect().bottom : 0;
    var anchor = Array.from(document.querySelectorAll("main h1, main h2, main .card, main tbody tr")).find(function (el) { return el.getBoundingClientRect().bottom > edge; });
    var before = anchor ? anchor.getBoundingClientRect().top : 0;
    var added = [];
    document.querySelectorAll("main [data-live]").forEach(function (part) {
      var fresh = next.querySelector('[data-live="' + part.dataset.live + '"]');
      if (!fresh) return;
      var body = part.querySelector("tbody"), nextBody = fresh.querySelector("tbody");
      var head = part.querySelector("thead"), nextHead = fresh.querySelector("thead");
      if (body && nextBody && head && nextHead && head.innerHTML === nextHead.innerHTML) {
        rows(body, nextBody, added);
        // Whatever sits beside the table (the pager) is checked on its own.
        Array.from(fresh.children).forEach(function (child, i) {
          var old = part.children[i];
          if (old && !old.contains(body) && old.outerHTML !== child.outerHTML) swap(old, document.importNode(child, true));
        });
      } else if (part.innerHTML !== fresh.innerHTML) {
        swap(part, document.importNode(fresh, true));
      }
    });
    if (anchor && anchor.isConnected && scrollY > 0) {
      var moved = anchor.getBoundingClientRect().top - before;
      // The page moved itself, so the header's row (header.js) takes it as no scroll.
      if (moved) { scrollBy(0, moved); if (window.weftHeaderSkipScroll) weftHeaderSkipScroll(); }
    }
    // A part shown only in some states (the private election's checks, once it opens) follows the page.
    document.querySelectorAll("main [data-show]").forEach(function (part) {
      var fresh = next.querySelector('[data-show="' + part.dataset.show + '"]');
      if (fresh && part.hidden !== fresh.hidden) part.hidden = fresh.hidden;
    });
    weftRelative();
    announce(added);
    document.dispatchEvent(new Event("weft:live"));
  }
  function announce(added) {
    var again = resumed;
    resumed = false;
    var blocks = [], txs = 0, elections = 0, seenHref = {};
    added.forEach(function (row) {
      var href = rowKey(row);
      if (seenHref[href]) return;
      seenHref[href] = true;
      var block = /\\/blocks\\/(\\d+)$/.exec(href);
      if (block) blocks.push(Number(block[1]));
      else if (/\\/transactions\\//.test(href)) txs++;
      else if (/\\/elections\\//.test(href)) elections++;
    });
    var said = [];
    if (blocks.length === 1) said.push("Block #" + blocks[0] + " arrived.");
    else if (blocks.length > 1) said.push(blocks.length + " new blocks arrived, up to #" + Math.max.apply(null, blocks) + ".");
    if (txs) said.push(txs === 1 ? "1 new transaction." : txs + " new transactions.");
    if (elections) said.push(elections === 1 ? "1 new election." : elections + " new elections.");
    if (again) said.unshift("This page is updating again.");
    if (said.length) weftSay(said.join(" "));
  }
  function failed() {
    failures++;
    if (failures === 1) stoppedAt = clock();
    if (failures === 3 && note) {
      noteText.textContent = "This page stopped updating at " + stoppedAt + ". " + checksAgain;
      note.hidden = false;
      note.classList.add("is-open");
      weftSay("This page has stopped updating. " + checksAgain);
    }
  }
  // The note leaves, and the page fetches itself again to catch up on what it missed.
  function recovered() {
    if (note && !note.hidden) {
      var hadFocus = note.contains(document.activeElement);
      note.classList.remove("is-open");
      note.hidden = true;
      // Focus moves to what takes the note's place: the page's heading.
      var h1 = hadFocus && document.querySelector("main h1");
      if (h1) { if (!h1.hasAttribute("tabindex")) h1.setAttribute("tabindex", "-1"); h1.focus({ preventScroll: true }); }
    }
    resumed = true;
    refresh();
  }
  function refresh() {
    fetch(location.href, { headers: { accept: "text/html" }, signal: AbortSignal.timeout(15000) })
      .then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.text(); })
      .then(function (text) { update(new DOMParser().parseFromString(text, "text/html")); })
      .catch(function () {
        if (resumed) { resumed = false; weftSay("This page is updating again."); }
        failed();
      });
  }
  function check(done) {
    if (document.hidden && !done) return;
    fetch("/api/v1/status", { signal: AbortSignal.timeout(10000) })
      .then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
      .then(function (s) {
        var wasDown = failures >= 3;
        failures = 0;
        var now = s.channels.map(function (c) { return [c.channel, c.height, c.state, c.peerHeight].join(":"); }).join(" ");
        if (wasDown) recovered();
        else if (seen !== null && now !== seen) refresh();
        seen = now;
        if (done) done(true);
      })
      .catch(function () {
        failed();
        if (done) done(false);
      });
  }
  // Check now: busy while it tries (the loader only after wait-before-loader).
  // When the explorer still doesn't answer, the note stays and says so.
  if (checkNow) checkNow.addEventListener("click", function () {
    if (checkNow.getAttribute("aria-disabled") === "true") return;
    weftBusy(checkNow, true);
    check(function (ok) {
      weftBusy(checkNow, false);
      if (ok) return;
      var text = "This page stopped updating at " + stoppedAt + ". Checked again at " + clock() + " and the explorer didn't answer. " + checksAgain;
      noteText.textContent = text;
      weftSay(text);
    });
  });
  check();
  setInterval(check, every);
  document.addEventListener("visibilitychange", function () { if (!document.hidden) check(); });
})();`;

const ORG_STATE: Record<PeerStatus["state"], string> = {
  agree: "agrees",
  pending: "waiting for a checkpoint",
  mismatch: "disagrees",
  invalid: "sent a checkpoint that failed the checks",
  unreachable: "couldn't be reached",
};

/** The indexer's state, in a pill and, when it isn't reading, a sentence on what that means. */
function indexerState(site: Site, c: ChannelSummary, s: ChannelStatus | undefined): { pill: Html; note: Html } {
  const behind = s?.peerHeight != null ? s.peerHeight - c.height : 0;
  if (s?.state === "stopped") {
    return {
      pill: html`<span class="pill pill--bad">stopped</span>`,
      note: html`<div class="state state--bad"><p>This explorer stopped reading ${c.channel} from ${site.name}'s peer. Its operator needs to fix the cause and restart it.</p>${errorDetails(s.lastError)}</div>`,
    };
  }
  if (s?.state === "retrying") {
    return {
      pill: html`<span class="pill pill--warn">reconnecting</span>`,
      note: html`<div class="state state--warn"><p>Reconnecting to ${site.name}'s peer. ${c.height > 0 ? `Blocks up to #${c.height - 1} are shown.` : "No blocks are shown yet."}</p>${errorDetails(s.lastError)}</div>`,
    };
  }
  if (s?.state === "starting") return { pill: html`<span class="pill pill--quiet">starting</span>`, note: html`` };
  if (behind > 0) return { pill: html`<span class="pill pill--warn">${behind} ${behind === 1 ? "block" : "blocks"} behind</span>`, note: html`` };
  return { pill: LIVE_CHIP, note: html`` };
}

/** "live", with a steady accent dot: this page updates as blocks arrive. */
const LIVE_CHIP = html`<span class="pill pill--live"><span class="pill__dot" aria-hidden="true"></span>live</span>`;

/** Whether the indexer is reading a channel and has caught up with its peer. */
function isLive(c: ChannelSummary, s: ChannelStatus | undefined): boolean {
  const behind = s?.peerHeight != null ? s.peerHeight - c.height : 0;
  return !!s && s.state !== "stopped" && s.state !== "retrying" && s.state !== "starting" && behind <= 0;
}

/**
 * One channel: a card among others, or, as the home's only channel, a row
 * that uses the width (`row`). On the home the "live" state is said once,
 * beside the heading, so a live row carries no chip of its own.
 */
function channelCard(site: Site, c: ChannelSummary, s: ChannelStatus | undefined, options: { onChannelPage?: boolean; row?: boolean; quietLive?: boolean } = {}): Html {
  const problems = c.brokenLinks + c.badDataHashes;
  const state = indexerState(site, c, s);
  const pill = options.quietLive && isLive(c, s) ? html`` : state.pill;
  return html`<section class="card channel${options.row ? " channel--row" : ""}" data-live="channel-${c.channel}">
  <div class="channel__head">
    ${options.onChannelPage ? html`<h2 class="card__title">Ledger</h2>` : html`<a class="channel__name mono" href="${channelUrl(c.channel)}">${c.channel}</a>`}
    ${pill}
  </div>
  <dl class="stats">
    <div><dt>Blocks</dt><dd class="mono">${c.height.toLocaleString("en")}</dd></div>
    <div><dt>Transactions</dt><dd class="mono">${c.transactions.toLocaleString("en")}</dd></div>
    <div><dt>Last block</dt><dd>${time(c.lastBlockAt)}</dd></div>
  </dl>
  ${state.note}
  ${c.height === 0 && s?.state === "stopped" ? "" : html`<p class="check ${problems ? "check--bad" : c.height > 0 ? "" : "check--quiet"}">
    ${problems
      ? `${problems} ${problems === 1 ? "block doesn't" : "blocks don't"} match the hashes around ${problems === 1 ? "it" : "them"}. See the blocks list.`
      : c.height > 0
        ? `Each of the ${c.height.toLocaleString("en")} blocks carries the hash of the one before, and every hash matches.`
        : `No blocks indexed yet. They appear here as this explorer reads them from ${site.name}'s peer.`}
  </p>`}
  ${crossCheckSummary(site.peers(c.channel), c.height)}
</section>`;
}

/** One line per organisation the explorer compares with, and how far they agree. */
function crossCheckSummary(peers: PeerStatus[], height: number): Html {
  if (peers.length === 0) return html``;
  const latest = height - 1;
  const agreeing = peers.filter((p) => p.state === "agree" && p.agreedUpTo !== null).length;
  return html`<div class="orgs">
    <div class="orgs__head"><span>Compared with other organisations</span><span class="mono subtle">${agreeing + 1} of ${peers.length + 1} agree</span></div>
    <ul>${peers.map(
      (p) => html`<li class="peer peer--${p.state}">
        <div class="peer__row">
          <span class="peer__dot"></span>
          <span class="peer__text"><span class="mono">${p.mspId ?? new URL(p.url).host}</span> <span class="subtle">${
            p.state === "agree" && p.agreedUpTo !== null
              ? p.agreedUpTo >= latest
                ? "agrees on every block"
                : `agrees up to #${p.agreedUpTo}`
              : p.state === "mismatch" && p.mismatchAt !== null
                ? `disagrees at #${p.mismatchAt}`
                : ORG_STATE[p.state]
          }</span></span>
        </div>
        ${p.state === "agree" || p.state === "pending" ? "" : errorDetails(p.detail)}
      </li>`,
    )}</ul>
  </div>`;
}

/** A block's Agree cell. Empty, but present, when its channel isn't compared and others in the table are. */
function agreementCell(site: Site, b: BlockRow): Html {
  const peers = site.peers(b.channel);
  if (peers.length === 0) return html`<td class="agree-none"></td>`;
  const a = agreementFor(b.number, peers);
  const cls = a.mismatched.length ? "pill--bad" : a.agree === a.total ? "pill--ok" : "pill--quiet";
  return html`<td data-label="Agree"><span class="pill ${cls}" title="${a.mismatched.length ? `Disagree: ${a.mismatched.join(", ")}` : `${a.agree} of ${a.total} organisations report this block`}">${a.agree}/${a.total}</span></td>`;
}

/**
 * The channel a row belongs to, in tables that mix channels: a column of its
 * own on search's full-width tables, or a line under the row's first words
 * in the overview's two tables side by side.
 */
type ChannelShown = "column" | "line" | undefined;
const channelCell = (channel: string) => html`<td class="channel-cell" data-label="Channel"><a class="mono" href="${channelUrl(channel)}">${channel}</a></td>`;
const channelLine = (channel: string) => html`<div class="channel-line small"><a class="mono" href="${channelUrl(channel)}">${channel}</a></div>`;

/**
 * A table of blocks. `hash: false` leaves the hash out, for the overview's
 * two tables side by side; the block's page has it in full, with its check.
 */
function blockRows(site: Site, blocks: BlockRow[], empty: Html | string, options: { channel?: ChannelShown; hash?: boolean } = {}): Html {
  if (blocks.length === 0) return html`<p class="empty">${empty}</p>`;
  const compared = blocks.some((b) => site.peers(b.channel).length > 0);
  const hash = options.hash !== false;
  return html`<table class="table">
  <thead><tr><th>Block</th>${options.channel === "column" ? html`<th>Channel</th>` : ""}<th>Time</th><th class="num">Transactions</th>${hash ? html`<th>Hash</th>` : ""}${compared ? html`<th>Agree</th>` : ""}</tr></thead>
  <tbody>${blocks.map(
    (b) => html`<tr>
    <td><a class="mono row-link" href="${blockUrl(b.channel, b.number)}">#${b.number}</a>${b.linked === false || !b.dataHashValid ? html` <span class="pill pill--bad">mismatch</span>` : ""}${options.channel === "line" ? channelLine(b.channel) : ""}</td>
    ${options.channel === "column" ? channelCell(b.channel) : ""}
    <td>${time(b.timestamp)}</td>
    <td class="num mono" data-label="Transactions">${b.txCount}${b.validCount < b.txCount ? html` <span class="subtle tx-invalid">(${b.txCount - b.validCount} invalid)</span>` : ""}</td>
    ${hash ? html`<td class="mono subtle" data-label="Hash">${short(b.hash)}</td>` : ""}
    ${compared ? agreementCell(site, b) : ""}
  </tr>`,
  )}</tbody>
</table>`;
}

function txRows(txs: TransactionRow[], options: { showBlock?: boolean; empty?: string; channel?: ChannelShown } = {}): Html {
  if (txs.length === 0) return html`<p class="empty">${options.empty ?? "No transactions yet."}</p>`;
  return html`<table class="table">
  <thead><tr><th>Transaction</th>${options.channel === "column" ? html`<th>Channel</th>` : ""}<th>Call</th><th>Submitted by</th>${options.showBlock !== false ? html`<th>Block</th>` : ""}<th>Status</th></tr></thead>
  <tbody>${txs.map(
    (t) => html`<tr>
    <td>${
      t.txId
        ? html`<a class="mono row-link" href="${txUrl(t.channel, t.txId)}">${short(t.txId)}</a>`
        : t.type === "config"
          ? // Configuration updates often have no transaction ID; their block shows them.
            html`<a class="row-link" href="${blockUrl(t.channel, t.blockNumber)}">configuration</a>`
          : html`<span class="subtle">unreadable entry</span>`
    }<div class="subtle small">${time(t.timestamp)}</div></td>
    ${options.channel === "column" ? channelCell(t.channel) : ""}
    <td class="call">${call(t)}${options.channel === "line" ? channelLine(t.channel) : ""}</td>
    <td data-label="By">${t.redacted ? html`<span class="subtle">not published</span>` : party(t.creator)}</td>
    ${options.showBlock !== false ? html`<td data-label="Block"><a class="mono" href="${blockUrl(t.channel, t.blockNumber)}">#${t.blockNumber}</a></td>` : ""}
    <td>${status(t.validation, t.redacted)}</td>
  </tr>`,
  )}</tbody>
</table>`;
}

/** Breadcrumbs, ending with the page itself. */
export function crumbs(...links: ([string, string, boolean?] | string)[]): Html {
  return html`<nav class="crumbs" aria-label="Breadcrumb"><ol>${links.map((l) =>
    typeof l === "string"
      ? html`<li><span aria-current="page">${l}</span></li>`
      : html`<li><a${l[2] ? raw(' class="mono"') : ""} href="${l[1]}">${l[0]}</a></li>`,
  )}</ol></nav>`;
}

/**
 * A pair of links between pages: newer first, then older. One with nowhere
 * to go stays in its place, disabled, so the other doesn't move.
 */
export function pager(label: string, newer: [string, string | null], older: [string, string | null], rel = false): Html {
  const link = ([text, href]: [string, string | null], relation: string) =>
    href ? html`<a href="${href}"${rel ? raw(` rel="${relation}"`) : ""}>${text}</a>` : html`<a class="pager__none" role="link" aria-disabled="true">${text}</a>`;
  return html`<nav class="pager" aria-label="${label}">${link(newer, "next")}${link(older, "prev")}</nav>`;
}

export function homePage(site: Site, channels: ChannelSummary[], statuses: ChannelStatus[], latest: BlockRow[], txs: TransactionRow[]): string {
  if (site.channels.length === 0) {
    // Not an error, so no code and no Details: what would be here, and how
    // to get it here (SYSTEM.md, Errors).
    const howTo = `${productAddress("docs", site.products, "/operators/explorer/")}`;
    const parts: SystemPageParts =
      site.signIn && !site.viewer
        ? {
            heading: "Nothing to show yet",
            lead: [html`${site.name} publishes its channels to members only. Sign in with Weft, with an identity from a member organisation, to see them.`],
            actions: [signInOnly("page"), sysLink("How explorers publish channels", howTo, "text")],
            after: signInNote("page"),
          }
        : site.viewer
          ? {
              heading: "Nothing to show yet",
              lead: [
                html`None of the channels ${site.name} publishes lists ${site.viewer.mspId} as a member. Ask ${site.name}'s operator to add ${site.viewer.mspId} to a channel, or sign in with an identity from another organisation.`,
              ],
              actions: [
                html`<form method="post" action="/auth/sign-out"><button type="submit" class="btn">Sign out</button></form>`,
                sysLink("How explorers publish channels", howTo, "text"),
              ],
            }
          : {
              heading: "Nothing to show yet",
              lead: [html`${site.name} hasn't published any channel.`],
              sub: html`If you run this explorer, set <code>level: public</code> or <code>level: members</code> for a channel in its policy file, then restart it.`,
              actions: [sysLink("Read how to publish a channel", howTo)],
            };
    return layout(site, "Nothing to show", systemPage(parts));
  }
  const one = channels.length === 1;
  const allLive = channels.length > 0 && channels.every((c) => isLive(c, statuses.find((s) => s.channel === c.channel)));
  return layout(
    site,
    "Overview",
    html`<section class="hero">
  <div class="title-row title-row--chip"><h1>${site.name}'s view of the ledger</h1>${allLive ? LIVE_CHIP : ""}</div>
  <p class="lead">Blocks and transactions as ${site.name}'s peers recorded them, checked block by block here.</p>
</section>
<div class="grid${one ? " grid--one" : ""}">${channels.map((c) => channelCard(site, c, statuses.find((s) => s.channel === c.channel), { row: one, quietLive: one }))}</div>
<div class="split">
  <section><h2>Latest blocks</h2><div data-live="blocks">${blockRows(site, latest, "No blocks indexed yet.", { channel: one ? undefined : "line", hash: false })}</div></section>
  <section><h2>Latest transactions</h2><div data-live="transactions">${txRows(txs, { showBlock: false, empty: "No published transactions yet.", channel: one ? undefined : "line" })}</div></section>
</div>`,
    { live: true },
  );
}

export function channelPage(
  site: Site,
  channel: ChannelSummary,
  s: ChannelStatus | undefined,
  blocks: BlockRow[],
  contracts: { chaincode: string; transactions: number; lastBlock: number }[],
  page: { before?: number; size: number },
): string {
  const name = channel.channel;
  const newest = blocks[0]?.number;
  const oldest = blocks.at(-1)?.number;
  const range = page.before !== undefined && newest !== undefined ? `Blocks #${oldest} to #${newest}` : null;
  const newerBefore = page.before !== undefined ? page.before + page.size : undefined;
  const newer = page.before === undefined ? null : newerBefore! >= channel.height ? channelUrl(name) : `${channelUrl(name)}?before=${newerBefore}`;
  const older = oldest !== undefined && oldest > 0 ? `${channelUrl(name)}?before=${oldest}` : null;
  const empty =
    page.before !== undefined
      ? html`No blocks before #${page.before}. <a href="${channelUrl(name)}">Latest blocks</a>`
      : s?.state === "stopped"
        ? `No blocks. This explorer stopped reading ${name}, so none will appear until its operator restarts it.`
        : `No blocks indexed yet. They appear here as this explorer reads them from ${site.name}'s peer.`;
  return layout(
    site,
    range ? `${range} on ${name}` : `Channel ${name}`,
    html`${range ? crumbs(["Overview", "/"], [name, channelUrl(name), true], range) : crumbs(["Overview", "/"], name)}
<h1>Channel <span class="mono">${name}</span></h1>
<div class="grid">${channelCard(site, channel, s, { onChannelPage: true })}
  <section class="card" data-live="contracts">
    <h2 class="card__title">Contracts</h2>
    ${contracts.length === 0
      ? html`<p class="empty">No published contract calls yet. Contracts appear here once a published one is called.</p>`
      : html`<ul class="contracts">${contracts.map(
          (c) => html`<li><a class="mono" href="${contractUrl(name, c.chaincode)}">${c.chaincode}</a><span class="subtle">${c.transactions} ${c.transactions === 1 ? "transaction" : "transactions"}</span></li>`,
        )}</ul>`}
  </section>
</div>
${site.elections(name)
  ? html`<p class="elections-link"><a href="${channelUrl(name)}/elections">Elections on ${name}</a> <span class="subtle">${
      site.privateElections?.(name) ? "encrypted ballots, the key ceremony, the count and a check of every proof" : "ballots, results and receipt checks"
    }</span></p>`
  : ""}
<section><h2>${range ?? "Blocks"}</h2><div data-live="blocks">${blockRows(site, blocks, empty)}
${newer || older ? pager("Pages of blocks", ["Newer blocks", newer], ["Older blocks", older]) : ""}</div>
</section>`,
    { live: true },
  );
}

function hashLine(label: string, value: string, check: boolean | null, okText: string, badText: string): Html {
  return html`<dt>${label}</dt><dd>${grouped(value)}${
    check === null ? "" : check ? html`<div class="ok small">${okText}</div>` : html`<div class="bad small">${badText}</div>`
  }</dd>`;
}

/** Which organisations report this block with the same hash. */
function blockAgreement(site: Site, block: BlockRow): Html {
  const peers = site.peers(block.channel);
  if (peers.length === 0) return html``;
  const a = agreementFor(block.number, peers);
  const verdict = a.mismatched.length
    ? `${a.mismatched.join(", ")} ${a.mismatched.length === 1 ? "has" : "have"} a different block here. One of the ledgers isn't what was originally recorded.`
    : a.agree === a.total
      ? `Every organisation compared reports this block with the same hash.`
      : `${a.agree} of ${a.total} organisations report this block with the same hash so far. The others haven't sent a checkpoint that covers it yet.`;
  return html`<section class="banner ${a.mismatched.length ? "banner--bad" : a.agree === a.total ? "banner--ok" : "banner--quiet"}">
  <p class="banner__title">${a.agree} of ${a.total} organisations report this block</p>
  <p>${verdict}</p>
  <p class="small">Each organisation's explorer signs the latest block it has. Because every block carries the hash of the one before, one matching signature covers every block up to it.</p>
</section>`;
}

export function blockPage(site: Site, block: BlockRow, txs: TransactionRow[], hasNext: boolean): string {
  const channel = block.channel;
  return layout(
    site,
    `Block ${block.number} on ${channel}`,
    html`${crumbs(["Overview", "/"], [channel, channelUrl(channel), true], `Block #${block.number}`)}
<div class="title-row">
  <h1>Block <span class="mono">#${block.number}</span></h1>
  ${pager(
    "Blocks",
    ["Newer block", hasNext ? blockUrl(channel, block.number + 1) : null],
    ["Older block", block.number > 0 ? blockUrl(channel, block.number - 1) : null],
    true,
  )}
</div>
<section class="card">
  <dl class="details">
    <dt>Time</dt><dd>${time(block.timestamp)}</dd>
    <dt>Transactions</dt><dd>${block.txCount} (${block.validCount} valid)</dd>
    <dt>Hash</dt><dd>${grouped(block.hash, raw(' id="block-hash"'))}<div class="small subtle hash-check" id="hash-check"></div></dd>
    ${hashLine(
      "Previous hash",
      block.previousHash,
      block.linked,
      `Matches block #${block.number - 1}.`,
      `Doesn't match the hash of block #${block.number - 1}. This block or the one before it isn't what the peer originally recorded.`,
    )}
    ${hashLine("Data hash", block.dataHash, block.dataHashValid, "Matches this block's transactions.", "Doesn't match this block's transactions.")}
  </dl>
  <p class="card__note subtle small">The hash is computed from the block header. Every block stores the hash of the one before it, so changing an old block breaks every link after it.${
    site.networkPage
      ? html` To check this block against every organisation's ledger, without relying on this explorer, use <a id="network-page" href="${site.networkPage}">Weft Network</a>.`
      : ""
  }</p>
</section>
<script>
(async function () {
  // Recompute the hash in this browser from the header shown, as Fabric
  // does: SHA-256 of DER(number, previous hash, data hash).
  var out = document.getElementById("hash-check");
  var link = document.getElementById("network-page");
  if (link) link.href += (link.href.indexOf("?") < 0 ? "?" : "&") + "explorer=" + encodeURIComponent(location.origin);
  if (!out || !window.crypto || !crypto.subtle) return;
  function hex(h) { return (h.match(/../g) || []).map(function (b) { return parseInt(b, 16); }); }
  function len(n) { if (n < 128) return [n]; var b = []; for (; n > 0; n = Math.floor(n / 256)) b.unshift(n & 255); return [128 | b.length].concat(b); }
  function el(tag, c) { return [tag].concat(len(c.length), c); }
  function int(v) { var b = []; var n = BigInt(v); do { b.unshift(Number(n & 255n)); n >>= 8n; } while (n > 0n); if (b[0] & 128) b.unshift(0); return el(2, b); }
  var der = el(48, int(${raw(String(block.number))}).concat(el(4, hex(${raw(JSON.stringify(block.previousHash))})), el(4, hex(${raw(JSON.stringify(block.dataHash))}))));
  var digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(der)));
  var computed = Array.from(digest, function (b) { return b.toString(16).padStart(2, "0"); }).join("");
  var ok = computed === document.getElementById("block-hash").textContent.trim();
  out.textContent = ok ? "Your browser computed the same hash from this header." : "Your browser computed a different hash from this header.";
  out.className = "small hash-check " + (ok ? "ok" : "bad");
  if (!ok) {
    var details = document.createElement("details");
    details.className = "error-details";
    details.innerHTML = "<summary>Details</summary><p></p>";
    details.querySelector("p").textContent = "Computed: " + computed;
    out.after(details);
  }
})();
</script>
${blockAgreement(site, block)}
${txs.map((t) => (t.config ? configSection(t.config) : ""))}
<section><h2>Transactions</h2>${txRows(txs, { showBlock: false, empty: "This block has no transactions." })}</section>`,
  );
}

function membersOnlyNote(site: Site, channel: string): Html {
  if (site.viewer) return html`<p>Only members of ${channel} can see this transaction's details, and ${site.viewer.mspId} isn't one.</p>`;
  return html`<p>Only members of ${channel} can see this transaction's details. Sign in with Weft if your organisation is one.</p>${
    site.signIn ? html`<div class="actions">${signInButton("page")}</div>` : ""
  }`;
}

export function transactionPage(site: Site, tx: TransactionRow): string {
  const explanation = explainStatus(tx.validation);
  const ok = tx.validation === "VALID";
  const body = html`${crumbs(["Overview", "/"], [tx.channel, channelUrl(tx.channel), true], [`Block #${tx.blockNumber}`, blockUrl(tx.channel, tx.blockNumber)], "Transaction")}
<h1>Transaction</h1>
<p class="tx-id">${grouped(tx.txId)}</p>
<section class="banner ${ok ? "banner--ok" : "banner--bad"}">
  <p class="banner__title">${ok ? "Valid. Its changes are in the ledger." : `Invalid. ${explanation.title}.`}</p>
  ${ok ? "" : html`<p>It's recorded in the block, but none of its changes were applied.</p>${errorDetails(tx.validation)}`}
</section>
${tx.redacted
  ? html`<section class="card">${
      tx.membersOnly ? membersOnlyNote(site, tx.channel) : html`<p>${`This transaction called a contract ${site.name} doesn't publish. Only its ID, block, time and status are shown.`}</p>`
    }
<dl class="details card__details"><dt>Block</dt><dd><a class="mono" href="${blockUrl(tx.channel, tx.blockNumber)}">#${tx.blockNumber}</a></dd><dt>Time</dt><dd>${time(tx.timestamp)}</dd></dl></section>`
  : html`<section class="card">
  <dl class="details">
    <dt>Block</dt><dd><a class="mono" href="${blockUrl(tx.channel, tx.blockNumber)}">#${tx.blockNumber}</a>, number ${tx.index + 1} in the block</dd>
    <dt>Time</dt><dd>${time(tx.timestamp)}</dd>
    <dt>Type</dt><dd>${tx.type === "endorser" ? "Contract call" : tx.type === "config" ? "Channel configuration" : tx.typeName}</dd>
    ${tx.chaincode ? html`<dt>Contract</dt><dd><a class="mono" href="${contractUrl(tx.channel, tx.chaincode)}">${tx.chaincode}</a></dd><dt>Function</dt><dd class="mono fn">${tx.fn ?? ""}</dd>` : ""}
    <dt>Submitted by</dt><dd>${party(tx.creator)}</dd>
    ${tx.type === "endorser" ? html`<dt>Endorsed by</dt><dd>${tx.endorsers.length === 0 ? html`<span class="subtle">none</span>` : tx.endorsers.map((e) => html`<div>${party(e)}</div>`)}</dd>` : ""}
  </dl>
</section>
${tx.config ? configSection(tx.config) : ""}
${tx.type === "endorser"
  ? html`<section><h2>Arguments</h2>${tx.args.length === 0
      ? html`<p class="empty">None.</p>`
      : html`<ol class="args" role="list">${tx.args.map((a) => html`<li>${value(a)}</li>`)}</ol>`}</section>
<section><h2>Changes</h2>${tx.writes.length === 0
      ? html`<p class="empty">${tx.reads > 0 ? `Read ${tx.reads} ${tx.reads === 1 ? "key" : "keys"}, wrote nothing.` : "No reads or writes published."}</p>`
      : html`<table class="table table--plain table--changes"><thead><tr><th>Key</th><th>New value</th></tr></thead><tbody>${tx.writes.map(
          (w) => html`<tr><td class="mono key">${w.namespace !== tx.chaincode ? html`<span class="subtle">${w.namespace}/</span>` : ""}${readableKey(w.key)}</td><td data-label="New value">${value(w.value)}</td></tr>`,
        )}</tbody></table>${!ok ? html`<p class="subtle small table__note">Shown as proposed. The transaction was invalid, so none of these were applied.</p>` : ""}`}</section>
${privateDataSection(tx)}
${tx.response && tx.response.payload.text !== "" ? html`<section><h2>Returned</h2><div class="card">${value(tx.response.payload)}</div></section>` : ""}
${tx.event ? html`<section><h2>Event</h2><div class="card"><div class="mono fn">${tx.event.name}</div>${value(tx.event.payload)}</div></section>` : ""}`
  : ""}`}`;
  const capped = body.value.includes("value-cap__toggle") ? html`<script>${raw(VALUE_SCRIPT)}</script>` : "";
  return layout(site, `Transaction ${cut(tx.txId)} on ${tx.channel}`, html`${body}${capped}`);
}

/** A config transaction: what changed, who signed the update, and the configuration it leaves. */
function configSection(config: NonNullable<TransactionRow["config"]>): Html {
  const s = config.summary;
  const cas = (list: { subject: string; fingerprint: string }[]) =>
    list.length ? list.map((c) => html`<div>${c.subject} <span class="mono subtle">${c.fingerprint}</span></div>`) : html`<span class="subtle">none</span>`;
  const names = (list: string[]) => (list.length ? html`<span class="mono">${list.join(", ")}</span>` : html`<span class="subtle">none</span>`);
  return html`<section><h2>${config.first ? "How the channel started" : "What changed"}</h2>${
    config.changes.length
      ? html`<ul class="changes">${config.changes.map((c) => html`<li>${c}</li>`)}</ul>`
      : html`<p class="empty">This explorer can't read what changed.</p>`
  }${
    config.signers.length
      ? html`<p class="small subtle">The update was signed by ${config.signers.map((p, i) => html`${i ? ", " : ""}${p.name ? html`${p.name} <span class="mono">(${p.mspId})</span>` : html`<span class="mono">${p.mspId}</span>`}`)}.</p>`
      : ""
  }</section>
<section><h2>Members after this change</h2>
<table class="table table--plain"><thead><tr><th>Organisation</th><th>Root CAs</th><th>Anchor peers</th></tr></thead><tbody>${s.organisations.map(
    (o) => html`<tr><td class="mono">${o.mspId}</td><td data-label="Root CAs">${cas(o.rootCas)}</td><td data-label="Anchor peers">${names(o.anchorPeers)}</td></tr>`,
  )}</tbody></table></section>
<section><h2>Ordering</h2><div class="card"><dl class="details">
  <dt>Consensus</dt><dd class="mono">${s.consensus ?? html`<span class="subtle">not set</span>`}</dd>
  <dt>Consenters</dt><dd>${names(s.consenters)}</dd>
  <dt>Organisations</dt><dd>${s.ordererOrganisations.length ? s.ordererOrganisations.map((o) => html`<div><span class="mono">${o.mspId}</span>${o.endpoints.length ? html` <span class="subtle mono">${o.endpoints.join(", ")}</span>` : ""}</div>`) : html`<span class="subtle">none</span>`}</dd>
  ${s.batch ? html`<dt>Blocks</dt><dd>Cut every ${s.batch.timeout || "?"}, or at ${s.batch.maxMessages} transactions, whichever comes first</dd>` : ""}
</dl></div></section>
<details class="card config-more disclosure"><summary>Capabilities and policies</summary><dl class="details">
  <dt>Capabilities</dt><dd>${names([...s.capabilities.channel.map((c) => `channel ${c}`), ...s.capabilities.application.map((c) => `application ${c}`), ...s.capabilities.orderer.map((c) => `orderer ${c}`)])}</dd>
  ${Object.entries(s.policies).map(([name, rule]) => html`<dt class="mono">${name}</dt><dd class="mono">${rule}</dd>`)}
</dl></details>`;
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Private data: the collection's members' peers keep the values; the ledger
 * has only their hashes. Shown by name and count, and with the hashes when
 * the policy publishes them, plus a check for anyone holding a value.
 */
function privateDataSection(tx: TransactionRow): Html {
  const sets = tx.privateData ?? [];
  if (sets.length === 0) return html``;
  const hashes = sets.flatMap((p) => p.hashes ?? []);
  return html`<section id="private"><h2>Private data</h2>
<div class="card">
  <p class="small card__intro">The values are kept by the peers of the organisations in each collection. The ledger has only their hashes${hashes.length ? "" : ", which this explorer doesn't publish"}.</p>
  <dl class="details">${sets.map(
    (p) => html`<dt class="mono">${p.namespace !== tx.chaincode ? html`<span class="subtle">${p.namespace}/</span>` : ""}${p.collection}</dt><dd>${
      [p.writes ? `wrote ${count(p.writes, "key")}` : "", p.deletes ? `deleted ${count(p.deletes, "key")}` : "", p.reads ? `read ${count(p.reads, "key")}` : ""]
        .filter(Boolean)
        .join(", ") || "used, with no reads or writes published"
    }</dd>`,
  )}</dl>
</div>
${hashes.length
  ? html`<table class="table table--plain"><thead><tr><th>Key hash</th><th>Value hash</th></tr></thead><tbody>${hashes.map(
      (w) => html`<tr><td>${grouped(w.keyHash)}</td><td data-label="Value hash">${w.valueHash ? grouped(w.valueHash) : html`<span class="subtle">deleted</span>`}</td></tr>`,
    )}</tbody></table>
<form class="card receipt receipt--local receipt--single" id="pd-form" novalidate>
  <p class="small">If you hold one of these values, check it's the one recorded. It stays in this browser.</p>
  <div class="field"><label for="pd-value">Value, exactly as stored</label><input id="pd-value" class="mono" spellcheck="false" autocomplete="off">${fieldError("pd-value-error")}</div>
  <button type="submit" class="button" id="pd-check">Check</button>
  <p id="pd-result" class="small result"></p>
</form>
<script>
(function () {
  var hashes = ${raw(JSON.stringify(hashes.map((w) => w.valueHash).filter(Boolean)))};
  var input = document.getElementById("pd-value"), out = document.getElementById("pd-result");
  var field = weftField(input, function (v) { return v === "" ? "Enter the value to check." : ""; });
  weftForm(document.getElementById("pd-form"), [field], async function () {
    var bytes = new TextEncoder().encode(input.value);
    var hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))).map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
    var found = hashes.indexOf(hash) >= 0;
    out.textContent = found ? "It matches a value this transaction wrote." : "It doesn't match any value this transaction wrote.";
    out.className = "small result is-shown " + (found ? "ok" : "bad");
    weftSay(out.textContent);
  });
})();
</script>`
  : ""}
</section>`;
}

export function contractPage(
  site: Site,
  channel: string,
  chaincode: string,
  txs: TransactionRow[],
  page: { before?: number; newer: string | null; older: string | null },
): string {
  const before = page.before;
  return layout(
    site,
    `Contract ${chaincode} on ${channel}${before === undefined ? "" : `, before block #${before}`}`,
    html`${crumbs(["Overview", "/"], [channel, channelUrl(channel), true], `Contract ${chaincode}`)}
<h1>Contract <span class="mono">${chaincode}</span></h1>
<section><h2>${before === undefined ? "Recent transactions" : `Transactions before block #${before}`}</h2>${txRows(txs, {
      empty: before === undefined ? "No published transactions yet." : `No transactions before block #${before}.`,
    })}
${page.newer || page.older ? pager("Pages of transactions", ["Newer transactions", page.newer], ["Older transactions", page.older]) : ""}
</section>`,
  );
}

export interface SearchResults {
  blocks: BlockRow[];
  txs: TransactionRow[];
  contracts: { channel: string; chaincode: string }[];
  /** Why nothing matched, when the query explains it. */
  hint?: string;
}

export function searchPage(site: Site, query: string, results: SearchResults): string {
  const total = results.blocks.length + results.txs.length + results.contracts.length;
  return layout(
    site,
    query === "" ? "Search" : `Search for ${query}`,
    html`<h1>Search</h1>
${query === ""
  ? html`<p class="empty">Search by transaction ID or its first 6 characters, block number, or contract name. Use the search field at the top of the page.</p>`
  : total === 0
    ? html`<p class="empty">Nothing published matches <span class="mono">${query}</span>.${results.hint ? html` ${results.hint}` : ""}</p>`
    : html`<p class="lead">${count(total, "result")} for <span class="mono">${query}</span>.</p>
${results.blocks.length ? html`<section><h2>Blocks</h2>${blockRows(site, results.blocks, "", { channel: site.channels.length > 1 ? "column" : undefined })}</section>` : ""}
${results.contracts.length ? html`<section><h2>Contracts</h2><ul class="contracts">${results.contracts.map((c) => html`<li><a class="mono" href="${contractUrl(c.channel, c.chaincode)}">${c.chaincode}</a><span class="subtle mono">${c.channel}</span></li>`)}</ul></section>` : ""}
${results.txs.length ? html`<section><h2>Transactions</h2>${txRows(results.txs, { channel: site.channels.length > 1 ? "column" : undefined })}</section>` : ""}`}`,
    { query },
  );
}

/* System pages ----------------------------------------------------------- */

/**
 * A 404, an error or an empty state, in the layout every Weft product uses
 * for them (@weftwallet/ui system-page.css, served as part of explorer.css):
 * the explorer's 48px mark, the code as an eyebrow when there is one, what
 * happened as the heading, one or two sentences, what was asked for, the next
 * steps as buttons, and anything technical behind Details. SystemPage.astro
 * renders the same markup on the sites.
 */
interface SystemPageParts {
  eyebrow?: string;
  heading: string;
  lead: (Html | string)[];
  /** What was asked for: the address, or the transaction ID. */
  asked?: { label: string; value: string };
  /** A note for whoever runs this explorer, after the lead. */
  sub?: Html;
  /** A search field, for an address that matches no page at all. */
  search?: boolean;
  actions: Html[];
  /** Anything that goes after the buttons, such as sign-in's note. */
  after?: Html;
  /** With Try again: what the line under the buttons says when the page still fails. */
  retry?: string;
  details?: string;
}

function systemPage(p: SystemPageParts): Html {
  return html`<section class="sys">
  <div class="sys__mark">${SYSTEM_MARK}</div>
  ${p.eyebrow ? html`<p class="sys__eyebrow">${p.eyebrow}</p>` : ""}
  <h1 tabindex="-1">${p.heading}</h1>
  ${p.lead.map((l) => html`<p class="sys__lead">${l}</p>`)}
  ${p.asked ? html`<p class="sys__addr"><span>${p.asked.label}</span><code data-sys-address>${p.asked.value}</code></p>` : ""}
  ${p.sub ? html`<p class="sys__sub">${p.sub}</p>` : ""}
  ${p.search
    ? html`<form class="sys__search" action="/search" role="search"><label for="sys-q">Search this explorer</label><div><input id="sys-q" name="q" type="search" placeholder="Transaction ID, block number or contract" spellcheck="false" autocomplete="off"><button type="submit" class="btn btn--primary">Search</button></div></form>`
    : ""}
  <div class="sys__actions">${p.actions}</div>
  ${p.after ?? ""}
  ${p.retry ? html`<p class="sys__retry" id="sys-retry" role="status"></p>` : ""}
  ${errorDetails(p.details)}
</section>
<script>${raw(SYSTEM_PAGE_SCRIPT)}</script>
${p.retry ? html`<script>${raw(retryScript(p.retry))}</script>` : ""}`;
}

/** A next step that goes somewhere. */
function sysLink(label: string, href: string, kind?: "primary" | "text"): Html {
  return html`<a class="btn${kind ? ` btn--${kind}` : ""}" href="${href}">${label}</a>`;
}

/** Go back, shown only when the page before was on this explorer (system-page.js). */
const SYS_BACK = html`<button type="button" class="btn btn--text" data-sys-back hidden>Go back</button>`;

/**
 * Try again: fetches the page again in place, so the button keeps focus and
 * shows the explorer's loader after the wait, as any busy control does. When
 * the page answers, it is shown; when it still fails, the line under the
 * buttons says when it last tried and what happened.
 */
function retryScript(still: string): string {
  return `
(function () {
  var button = document.querySelector("[data-sys-retry]"), line = document.getElementById("sys-retry");
  if (!button || !line) return;
  button.addEventListener("click", function () {
    if (button.getAttribute("aria-disabled") === "true") return;
    weftBusy(button, true);
    line.textContent = "";
    fetch(location.href, { headers: { accept: "text/html" }, cache: "no-store", signal: AbortSignal.timeout(15000) })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        location.reload();
      })
      .catch(function () {
        weftBusy(button, false);
        var at = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
        line.textContent = "Tried again at " + at + ". " + ${JSON.stringify(still)};
      });
  });
})();`;
}

const TRY_AGAIN = html`<button type="button" class="btn btn--primary" data-sys-retry>Try again</button>`;

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** 1 November 2026, 14:02:11 UTC */
function utcStamp(at: number): string {
  const d = new Date(at);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())} UTC`;
}

export interface NotFound {
  /** The tab's title: "Page not found", "Transaction not found". */
  title: string;
  /** What wasn't found, as a plain sentence about this request. */
  heading: string;
  lead?: string[];
  /** What was asked for: the address, or the transaction ID. */
  asked: { label: string; value: string };
  /** When what was asked for may be published to members only: the sentence that offers signing in. */
  signIn?: string;
  /** A search field on the page, for an address that matches no page at all. */
  search?: boolean;
}

/** Something that isn't here. */
export function notFoundPage(site: Site, page: NotFound): string {
  const offerSignIn = !!page.signIn && site.signIn && !site.viewer;
  const actions: Html[] = [];
  if (offerSignIn) actions.push(signInOnly("page"));
  actions.push(sysLink("Go to the overview", "/", offerSignIn || page.search ? undefined : "primary"), SYS_BACK);
  return layout(
    site,
    page.title,
    systemPage({
      eyebrow: "Error 404",
      heading: page.heading,
      lead: [...(page.lead ?? []), ...(offerSignIn ? [page.signIn!] : [])],
      asked: page.asked,
      ...(page.search ? { search: true } : {}),
      actions,
      ...(offerSignIn ? { after: signInNote("page") } : {}),
    }),
  );
}

/** Where a failed request came from, for the address line and Details. */
export interface FailedRequest {
  method: string;
  /** The path asked for, with its query. */
  path: string;
  /** The address as the person typed it: host and path. */
  address: string;
  at: number;
}

/**
 * A request that went wrong: an address this explorer can't read (4xx), a
 * peer that didn't answer (503), or a fault in this explorer (5xx).
 */
export function errorPage(site: Site, statusCode: number, detail: string, request?: FailedRequest): string {
  if (statusCode < 500) {
    return layout(
      site,
      "Address not valid",
      systemPage({
        eyebrow: `Error ${statusCode}`,
        heading: "That address isn't valid",
        lead: ["This explorer couldn't read that address. Check it, or start again from the overview."],
        ...(request ? { asked: { label: "Address", value: request.address } } : {}),
        actions: [sysLink("Go to the overview", "/", "primary"), SYS_BACK],
        details: `${statusCode}: ${detail}`,
      }),
    );
  }
  if (statusCode === 503) {
    return layout(
      site,
      "Peer unreachable",
      systemPage({
        eyebrow: "Error 503",
        heading: `This explorer can't reach ${site.name}'s peer`,
        lead: [`This page needs an answer from ${site.name}'s peer, and the peer didn't answer within 10 seconds. The overview still shows the blocks indexed so far.`],
        actions: [TRY_AGAIN, sysLink("Go to the overview", "/")],
        retry: "The peer still didn't answer.",
        details: `503: ${detail}`,
      }),
    );
  }
  return layout(
    site,
    "Something went wrong",
    systemPage({
      eyebrow: `Error ${statusCode}`,
      heading: "This explorer couldn't build this page",
      lead: [`Something went wrong inside ${site.name}'s explorer. Try again in a moment. If it happens again, send the details below to ${site.name}'s operator.`],
      actions: [TRY_AGAIN, sysLink("Go to the overview", "/")],
      retry: "The explorer still couldn't build this page.",
      details: [`${statusCode}: ${detail}`, ...(request ? [`${request.method} ${request.path}`, utcStamp(request.at)] : [])].join("\n"),
    }),
  );
}

export function mePage(site: Site, viewer: Viewer, txs: TransactionRow[]): string {
  return layout(
    site,
    "Your transactions",
    html`${crumbs(["Overview", "/"], "Your transactions")}
<h1>Your transactions</h1>
<p class="lead">Signed in with Weft as ${viewer.name ? html`${viewer.name} (<span class="mono">${viewer.mspId}</span>)` : html`<span class="mono">${viewer.mspId}</span>`}. You see what ${site.name} publishes to the members of ${
      site.channels.length === 1 ? site.channels[0] : "your channels"
    }.</p>
<section><h2>Transactions you submitted</h2>${txRows(txs, {
      empty: viewer.name
        ? "None yet. Transactions you submit on your channels appear here."
        : "Your certificate has no name, so this explorer can't tell which transactions are yours.",
    })}</section>`,
    { current: "me" },
  );
}

/** /me for someone not signed in. */
export function signedOutMePage(site: Site): string {
  return layout(
    site,
    "Your transactions",
    html`${crumbs(["Overview", "/"], "Your transactions")}
<h1>Your transactions</h1>
${site.signIn
  ? html`<p class="lead">Sign in with Weft to see the transactions you submitted.</p><div class="actions">${signInButton("page")}</div>`
  : html`<p class="lead">${site.name} doesn't publish anything to members only, so there's nothing to sign in to here.</p>`}`,
  );
}

/* Elections (docs/adr/0004, phase 4) ------------------------------------ */

const electionUrl = (channel: string, id: string) => `/channels/${enc(channel)}/elections/${enc(id)}`;

function electionState(e: ElectionView): Html {
  return e.state === "closed"
    ? html`<span class="pill pill--ok">counted</span>`
    : Date.parse(e.closesAt) <= Date.now()
      ? html`<span class="pill pill--warn">closed, not yet counted</span>`
      : html`<span class="pill pill--quiet">open</span>`;
}

export function electionsPage(site: Site, channel: string, list: ElectionView[]): string {
  return layout(
    site,
    `Elections on ${channel}`,
    html`${crumbs(["Overview", "/"], [channel, channelUrl(channel), true], "Elections")}
<h1>Elections</h1>
${electionsList(channel, list)}`,
    { live: true },
  );
}

/** The ballot contract's elections: the lead and the table, also shown under a channel's private elections. */
export function electionsList(channel: string, list: ElectionView[]): Html {
  return html`<p class="lead">Ballots are kept private. The ledger holds a commitment for each one and, once voting closes, the count. Anyone can count the commitments here, and any voter can check their own.</p>
<div data-live="elections">${list.length === 0
  ? html`<p class="empty">No elections on ${channel} yet. An election appears here once someone creates one with the channel's ballot contract.</p>`
  : html`<table class="table"><thead><tr><th>Election</th><th>Closes</th><th class="num">Ballots</th><th>State</th></tr></thead><tbody>${[...list].reverse().map(
      (e) => html`<tr><td><a class="row-link" href="${electionUrl(channel, e.id)}">${e.title}</a><div class="mono subtle small">${e.id}</div></td><td data-label="Closes">${time(Date.parse(e.closesAt))}</td><td class="num mono" data-label="Ballots">${e.commitments}</td><td>${electionState(e)}</td></tr>`,
    )}</tbody></table>`}</div>`;
}

export function electionPage(
  site: Site,
  channel: string,
  e: ElectionView,
  receipt: { txId: string; commitment: string; result: ReceiptCheck } | null,
): string {
  const max = Math.max(1, ...Object.values(e.tally?.counts ?? {}));
  const closed = Date.parse(e.closesAt) <= Date.now();
  // A malformed field is a field error; only a well-formed receipt is looked up.
  const commitment = receipt?.commitment.trim() ?? "";
  const commitmentError = commitment && !/^[0-9a-f]{64}$/i.test(commitment) ? "A commitment is 64 characters, 0 to 9 and a to f." : "";
  const lookedUp = receipt && !commitmentError ? receipt : null;
  const txWrong = lookedUp && (!lookedUp.result.found || !lookedUp.result.commitment);
  return layout(
    site,
    `${e.title}, an election on ${channel}`,
    html`${crumbs(["Overview", "/"], [channel, channelUrl(channel), true], ["Elections", `${channelUrl(channel)}/elections`], e.title)}
<div class="title-row"><h1>${e.title}</h1>${electionState(e)}</div>
<section class="card">
  <dl class="details">
    <dt>Election</dt><dd class="mono">${e.id}</dd>
    <dt>Options</dt><dd>${e.options.join(", ")}</dd>
    <dt>${closed ? "Voting closed" : "Voting closes"}</dt><dd>${time(Date.parse(e.closesAt))}</dd>
    <dt>Run by</dt><dd class="mono">${e.creatorMsp}</dd>
    <dt>Ballots committed</dt><dd><span class="mono">${e.commitments}</span> <span class="subtle small">counted from the ledger here</span></dd>
  </dl>
</section>
${e.tally
  ? html`<section><h2>Result</h2><div class="card tally">${e.options.map(
      (o) => html`<div class="tally__row"><span>${o}</span><svg class="tally__bar" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true"><rect width="100" height="10" class="tally__track"/><rect width="${Math.max(0.0001, ((e.tally!.counts[o] ?? 0) / max) * 100)}" height="10" class="tally__fill"/></svg><span class="mono">${e.tally!.counts[o] ?? 0}</span></div>`,
    )}
    <p class="check ${e.tallyMatches ? "" : "check--bad"}">${
      e.tallyMatches
        ? `The published total, ${e.tally.total}, matches the ${e.commitments} commitments on the ledger.`
        : `The published total, ${e.tally.total}, doesn't match the ${e.commitments} commitments on the ledger.`
    }</p>
    ${e.closedIn ? html`<p class="subtle small">Published in <a class="mono" href="/channels/${enc(channel)}/transactions/${enc(e.closedIn.txId)}">${short(e.closedIn.txId)}</a>, block #${e.closedIn.blockNumber}.</p>` : ""}</div></section>`
  : html`<section><h2>Result</h2><p class="empty">${closed ? `Voting has closed. ${e.creatorMsp} publishes the count.` : "Voting is open. The count is published when it closes."}</p></section>`}
<section id="receipt">
  <h2>Check your receipt</h2>
  <form class="card receipt" method="get" action="#receipt" id="receipt-form" novalidate tabindex="-1" aria-describedby="receipt-file-hint">
    <div class="xr-file" id="receipt-file-row" hidden>
      <input type="file" accept=".json,application/json" id="receipt-file" tabindex="-1" aria-hidden="true">
      <button type="button" class="btn btn--small" id="receipt-choose">Choose receipt file</button>
      <p id="receipt-file-hint">or drop it on this form, or paste the copied receipt. It fills the fields below.</p>
      <p class="field__status" id="receipt-file-status" role="status"></p>
    </div>
    <div class="field"><label for="receipt-tx">Transaction ID</label><input id="receipt-tx" name="tx" value="${receipt?.txId ?? ""}" class="mono" spellcheck="false" autocomplete="off"${invalid(txWrong ? "receipt-result" : null)}>${fieldError("receipt-tx-error")}</div>
    <div class="field"><label for="receipt-commitment">Commitment (optional)</label><input id="receipt-commitment" name="commitment" value="${receipt?.commitment ?? ""}" class="mono" spellcheck="false" autocomplete="off"${invalid(commitmentError ? "receipt-commitment-error" : null)}>${fieldError("receipt-commitment-error", commitmentError)}</div>
    <button type="submit" class="button">Check</button>
  </form>
  ${lookedUp ? receiptResult(lookedUp) : ""}
  <form class="card receipt receipt--local" id="local" novalidate ${lookedUp?.result.commitment ? "" : "hidden"}>
    <p class="small">To confirm the commitment is your vote, enter the choice and the salt from your receipt. They stay in this browser.</p>
    <div class="field"><label for="local-option">Your choice</label><span class="select"><select id="local-option"><button><selectedcontent></selectedcontent></button>${e.options.map((o) => html`<option>${o}</option>`)}</select></span></div>
    <div class="field"><label for="local-salt">Salt</label><input id="local-salt" class="mono" spellcheck="false" autocomplete="off">${fieldError("local-salt-error")}</div>
    <button type="submit" class="button" id="local-check">Check here</button>
    <p id="local-result" class="small result"></p>
  </form>
</section>
<script>
(function () {
  var tx = weftField(document.getElementById("receipt-tx"), function (v) {
    return v.trim() === "" ? "Enter the transaction ID from your receipt." : "";
  });
  var commitment = weftField(document.getElementById("receipt-commitment"), function (v) {
    v = v.trim();
    return v === "" || /^[0-9a-f]{64}$/i.test(v) ? "" : "A commitment is 64 characters, 0 to 9 and a to f.";
  });
  weftForm(document.getElementById("receipt-form"), [tx, commitment]);
  var result = document.getElementById("receipt-result");
  if (result) weftSay(Array.from(result.querySelectorAll(":scope > p")).map(function (p) { return p.textContent.trim(); }).join(" "));

  var expected = ${raw(JSON.stringify(lookedUp?.result.commitment ?? null))};
  var electionId = ${raw(JSON.stringify(e.id).replace(/</g, "\\u003c"))};
  var checkedTx = ${raw(JSON.stringify(lookedUp?.txId ?? null).replace(/</g, "\\u003c"))};
  var trusted = ${raw(JSON.stringify(site.receiptOrigins).replace(/</g, "\\u003c"))};

  // A receipt file, chosen, dropped on the form or pasted into it, fills the
  // transaction ID and commitment; it doesn't submit. Its choice and salt
  // wait in this tab's session storage while the form is sent, never in the
  // address, so they reach neither this explorer's server nor the history.
  var STASH = "weft-receipt-check";
  var stash = null;
  var readReceipt = ${raw(readReceipt.toString())};
  var receiptForm = document.getElementById("receipt-form");
  var txInput = document.getElementById("receipt-tx"), cmInput = document.getElementById("receipt-commitment");
  var fileInput = document.getElementById("receipt-file"), fileStatus = document.getElementById("receipt-file-status");
  var unreadable = "Weft Explorer couldn't read that file. Choose the receipt your voting app saved, a .json file.";
  document.getElementById("receipt-file-row").hidden = false;
  function fileSays(kind, message) {
    fileStatus.textContent = message || "";
    fileStatus.classList.toggle("field-ok", kind === "ok" && !!message);
    fileStatus.classList.toggle("field-error", kind === "error" && !!message);
  }
  function fill(text, name) {
    var r = readReceipt(text, electionId);
    if (!r.ok) { fileSays("error", r.message); return; }
    txInput.value = r.txId;
    cmInput.value = r.commitment;
    [txInput, cmInput].forEach(function (input) { input.classList.add("is-filled"); });
    tx.run();
    commitment.run();
    stash = r.option && r.salt ? { txId: r.txId, option: r.option, salt: r.salt } : null;
    var from = name || "the pasted receipt";
    fileSays("ok", "Filled from " + from + ". Your choice and salt stay in this browser.");
  }
  function readFile(file) {
    if (file.size > 64 * 1024) { fileSays("error", "That file is too large to be a receipt. A receipt is under 1 KB."); return; }
    file.text().then(function (text) { fill(text, file.name); }, function () { fileSays("error", unreadable); });
  }
  document.getElementById("receipt-choose").addEventListener("click", function () { fileInput.click(); });
  fileInput.addEventListener("change", function () {
    if (fileInput.files && fileInput.files[0]) readFile(fileInput.files[0]);
    fileInput.value = "";
  });
  // Typing over a filled field makes it the person's own again.
  [txInput, cmInput].forEach(function (input) {
    input.addEventListener("input", function () {
      input.classList.remove("is-filled");
      if (input === txInput) stash = null;
    });
  });
  receiptForm.addEventListener("submit", function (e) {
    if (e.defaultPrevented) return;
    try {
      if (stash && txInput.value.trim() === stash.txId) sessionStorage.setItem(STASH, JSON.stringify(stash));
      else sessionStorage.removeItem(STASH);
    } catch (error) { /* without storage, the choice and salt are entered by hand */ }
  });
  receiptForm.addEventListener("dragover", function (e) {
    var types = Array.from(e.dataTransfer ? e.dataTransfer.types : []);
    if (types.indexOf("Files") < 0 && types.indexOf("text/plain") < 0) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    receiptForm.classList.add("is-dragging");
  });
  receiptForm.addEventListener("dragleave", function (e) {
    if (!receiptForm.contains(e.relatedTarget)) receiptForm.classList.remove("is-dragging");
  });
  receiptForm.addEventListener("drop", function (e) {
    e.preventDefault();
    receiptForm.classList.remove("is-dragging");
    var files = e.dataTransfer.files;
    if (files && files.length > 1) { fileSays("error", "Drop one receipt at a time."); return; }
    if (files && files.length === 1) { readFile(files[0]); return; }
    var text = e.dataTransfer.getData("text/plain");
    if (text) fill(text, null);
  });
  receiptForm.addEventListener("paste", function (e) {
    var text = e.clipboardData ? e.clipboardData.getData("text/plain") : "";
    if (!text) return;
    // A plain value pasted into a field is just that.
    if (e.target.matches("input") && !/^\\s*\\{/.test(text)) return;
    e.preventDefault();
    fill(text, null);
  });
  var form = document.getElementById("local");
  var salt = weftField(document.getElementById("local-salt"), function (v) { return v.trim() === "" ? "Enter the salt from your receipt." : ""; });
  weftForm(form, [salt], async function () {
    var option = document.getElementById("local-option").value, value = document.getElementById("local-salt").value.trim();
    var bytes = new TextEncoder().encode(electionId + "\\n" + option + "\\n" + value);
    var hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))).map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
    var out = document.getElementById("local-result");
    out.textContent = hash === expected ? "It matches: this commitment is a vote for " + option + "." : "It doesn't match. Check the choice and the salt.";
    out.className = "small result is-shown " + (hash === expected ? "ok" : "bad");
    weftSay(out.textContent);
  });
  function checkHere(option, salt) {
    var select = document.getElementById("local-option");
    if (!Array.from(select.options).some(function (o) { return o.value === option; })) return;
    select.value = option;
    document.getElementById("local-salt").value = salt;
    document.getElementById("receipt").scrollIntoView();
    form.requestSubmit(document.getElementById("local-check"));
  }
  // An address from before receipts were handed over by message may still
  // carry a choice and salt in its fragment. They aren't read; they're
  // dropped from the address bar.
  if (/(^#|&)salt=/.test(location.hash)) history.replaceState(null, "", location.pathname + location.search + "#receipt");
  if (expected && checkedTx) {
    // A receipt file chosen before the form was sent.
    var kept = null;
    try {
      kept = JSON.parse(sessionStorage.getItem(STASH) || "null");
      sessionStorage.removeItem(STASH);
    } catch (error) { kept = null; }
    if (kept && kept.txId === checkedTx && typeof kept.option === "string" && typeof kept.salt === "string") checkHere(kept.option, kept.salt);
    // The page that opened this one (a voting app, or Weft) hands over the
    // choice and salt by message once asked (receipt.ts, acceptHandoff). The
    // ask carries nothing, and nothing else is sent back.
    else if (window.opener) {
      var acceptHandoff = ${raw(acceptHandoff.toString())};
      var handedOver = false;
      window.addEventListener("message", function (e) {
        if (handedOver || e.source !== window.opener) return;
        var got = acceptHandoff({ origin: e.origin, data: e.data }, { electionId: electionId, txId: checkedTx, trusted: trusted });
        if (!got) return;
        handedOver = true;
        checkHere(got.option, got.salt);
      });
      try { window.opener.postMessage({ type: "weft-receipt-check:ready", version: 1 }, "*"); } catch (error) { /* the opener has gone */ }
    }
  }
})();
</script>`,
  );
}

function receiptResult(r: { txId: string; commitment: string; result: ReceiptCheck }): Html {
  const res = r.result;
  const banner = (kind: "ok" | "bad", title: string, body: Html | string = "") =>
    // Titles are this file's own sentences, written as they should read.
    html`<div class="banner banner--${kind}" id="receipt-result"><p class="banner__title">${raw(title)}</p>${body}</div>`;
  if (!res.found) return banner("bad", "No published transaction has that ID.", html`<p>Check the ID on your receipt. It may also be in a block this explorer hasn't indexed yet.</p>`);
  if (!res.commitment) return banner("bad", "That transaction isn't a ballot in this election.", html`<p>Check the ID on your receipt, and that it's for this election.</p>`);
  if (!res.valid) {
    const why = explainStatus(res.validation ?? "");
    return banner(
      "bad",
      "The network didn't accept that ballot.",
      html`<p>It's in block #${res.blockNumber}, but it was invalid (${why.title.charAt(0).toLowerCase()}${why.title.slice(1)}), so it wasn't counted. Vote again if voting is still open.</p>${errorDetails(res.validation)}`,
    );
  }
  const given = r.commitment.trim().toLowerCase();
  if (given && given !== res.commitment) return banner("bad", "The commitment doesn't match.", html`<p>The ledger has <span class="mono">${short(res.commitment)}</span> for this transaction.</p>`);
  return banner(
    "ok",
    `Your ballot is in block #${res.blockNumber} and was accepted.`,
    html`<p>Commitment <span class="mono">${short(res.commitment)}</span>${given ? ", as on your receipt" : ""}. It's one of the commitments counted above.</p>`,
  );
}
