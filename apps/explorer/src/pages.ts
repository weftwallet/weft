/**
 * Server-rendered pages. They work without JavaScript; a few lines of script
 * add relative times and a notice when new blocks arrive.
 */

import { explainStatus } from "@weftwallet/core";
import type { BlockRow, ChannelSummary, TransactionRow } from "./db.ts";
import { html, raw, type Html } from "./html.ts";
import type { ChannelStatus } from "./indexer.ts";
import type { Viewer } from "./auth.ts";
import { agreementFor, type PeerStatus } from "./checkpoints.ts";
import { splitKey, type ElectionView, type ReceiptCheck } from "./elections.ts";
import type { PublishedParty, ShownValue } from "./policy.ts";

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
}

const MARK = raw(`<svg width="24" height="24" viewBox="0 0 16 16" shape-rendering="crispEdges" aria-hidden="true">
  <rect width="16" height="16" rx="4" fill="#3FC1B0"/>
  <rect x="4" y="2" width="2" height="12" fill="#0B1218"/><rect x="10" y="2" width="2" height="12" fill="#0B1218"/>
  <rect x="2" y="4" width="12" height="2" fill="#0B1218"/><rect x="2" y="10" width="12" height="2" fill="#0B1218"/>
  <rect x="9" y="3" width="4" height="4" fill="#3FC1B0"/><rect x="10" y="3" width="2" height="4" fill="#0B1218"/>
  <rect x="3" y="9" width="4" height="4" fill="#3FC1B0"/><rect x="4" y="9" width="2" height="4" fill="#0B1218"/>
  <rect x="3" y="3" width="4" height="4" fill="#3FC1B0"/><rect x="3" y="4" width="4" height="2" fill="#0B1218"/>
  <rect x="9" y="9" width="4" height="4" fill="#3FC1B0"/><rect x="9" y="10" width="4" height="2" fill="#0B1218"/>
</svg>`);

const enc = encodeURIComponent;
const blockUrl = (channel: string, n: number) => `/channels/${enc(channel)}/blocks/${n}`;
const txUrl = (channel: string, id: string) => `/channels/${enc(channel)}/transactions/${enc(id)}`;
const contractUrl = (channel: string, name: string) => `/channels/${enc(channel)}/contracts/${enc(name)}`;

function short(value: string, head = 10, tail = 6): string {
  return value.length <= head + tail + 1 ? value : `${value.slice(0, head)}…${value.slice(-tail)}`;
}

function time(at: number | null): Html {
  if (at === null) return html`<span class="subtle">unknown</span>`;
  const iso = new Date(at).toISOString();
  return html`<time datetime="${iso}" title="${iso.replace("T", " ").replace(/\.\d+Z$/, " UTC")}">${iso.slice(0, 16).replace("T", " ")}</time>`;
}

function party(p: PublishedParty | null): Html {
  if (!p) return html`<span class="subtle">not published</span>`;
  return html`<span>${p.name ?? "unnamed"}</span> <span class="mono subtle">${p.mspId}</span>`;
}

function status(validation: string, redacted = false): Html {
  const ok = validation === "VALID";
  return html`<span class="pill ${ok ? "pill--ok" : "pill--bad"}" title="${redacted ? "" : explainStatus(validation).title}">${ok ? "valid" : validation.toLowerCase().replace(/_/g, " ")}</span>`;
}

/** Composite keys (\0type\0a\0b\0) read as type / a / b. */
function readableKey(key: string): Html {
  const parts = splitKey(key);
  if (!parts) return html`${key}`;
  return html`<span class="subtle">${parts.type}</span>${parts.attrs.map((a) => html`<span class="subtle"> / </span>${a}`)}`;
}

function value(v: ShownValue | null): Html {
  if (!v) return html`<span class="subtle">deleted</span>`;
  if (v.sha256 !== undefined) return html`<span class="mono subtle" title="Published as a hash only">sha256 ${short(v.sha256, 16, 8)}</span>`;
  if (v.hex !== undefined) return html`<span class="mono value">0x${v.hex}</span>`;
  const text = v.text ?? "";
  if (text === "") return html`<span class="subtle">empty</span>`;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null) return html`<pre class="value">${JSON.stringify(parsed, null, 2)}</pre>`;
  } catch {
    /* plain text */
  }
  return html`<span class="mono value">${text}</span>`;
}

function call(tx: TransactionRow): Html {
  if (tx.membersOnly) return html`<span class="subtle">members only</span>`;
  if (tx.redacted) return html`<span class="subtle">unpublished contract</span>`;
  if (tx.type === "config") return html`<span>Channel configuration</span>`;
  if (!tx.chaincode) return html`<span class="subtle">${tx.typeName.toLowerCase()}</span>`;
  return html`<a class="mono" href="${contractUrl(tx.channel, tx.chaincode)}">${tx.chaincode}</a><span class="mono subtle">.</span><span class="mono">${tx.fn ?? ""}</span>`;
}

export function layout(site: Site, title: string, body: Html, options: { query?: string; live?: boolean } = {}): string {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · ${site.name} explorer</title>
<link rel="stylesheet" href="/assets/explorer.css">
<link rel="icon" href="/assets/mark.svg">
</head>
<body>
<header class="top">
  <div class="wrap top__inner">
    <a class="brand" href="/">${MARK}<span class="brand__name">weft</span><span class="brand__sub">explorer</span></a>
    <span class="org" title="Run by ${site.name}">${site.name}</span>
    <form class="search" action="/search" role="search">
      <input name="q" type="search" value="${options.query ?? ""}" placeholder="Transaction ID, block number or contract" aria-label="Search" spellcheck="false" autocomplete="off">
    </form>
    ${account(site)}
  </div>
</header>
<p class="signin-note" id="signin-note" role="alert" hidden></p>
<main class="wrap">${body}</main>
<footer class="wrap foot">
  <span>Run by ${site.name}, from its own peers. It shows only what ${site.name} chose to publish.</span>
  <a href="/api/v1/status">API</a>
</footer>
<script>
document.querySelectorAll("time[datetime]").forEach(function (el) {
  var s = Math.round((Date.now() - new Date(el.getAttribute("datetime")).getTime()) / 1000);
  var t = s < 45 ? "just now" : s < 3600 ? Math.round(s / 60) + " min ago" : s < 86400 ? Math.round(s / 3600) + " h ago" : null;
  if (t) el.textContent = t;
});
${options.live ? raw(LIVE) : ""}
${site.signIn && !site.viewer ? raw(signInScript(site.name)) : ""}
</script>
</body>
</html>`.value;
}

function account(site: Site): Html {
  if (site.viewer) {
    return html`<div class="account">
      <a href="/me" title="Your transactions">${site.viewer.name ?? "Signed in"} <span class="mono subtle">${site.viewer.mspId}</span></a>
      <form method="post" action="/auth/sign-out"><button type="submit" class="link-button">Sign out</button></form>
    </div>`;
  }
  if (!site.signIn) return html``;
  return html`<button type="button" class="signin" id="signin">${MARK_SMALL}<span>Sign in with Weft</span></button>`;
}

const MARK_SMALL = raw(MARK.value.replace('width="24" height="24"', 'width="16" height="16"'));

/**
 * Sign-in: connect, get a nonce, ask Weft to sign in, send the result back.
 * The server checks the signature and that the certificate belongs to a
 * member organisation, then sets a session cookie.
 */
function signInScript(name: string): string {
  const statement = JSON.stringify(`Sign in to ${name}'s explorer`).replace(/</g, "\\u003c");
  return `
(function () {
  var button = document.getElementById("signin");
  var note = document.getElementById("signin-note");
  if (!button) return;
  var label = button.querySelector("span");
  function say(text) { note.textContent = text; note.hidden = false; }
  button.addEventListener("click", async function () {
    note.hidden = true;
    var weft = window.weft;
    if (!weft) { say("Install Weft to sign in. This explorer checks your organisation's identity, which Weft holds."); return; }
    button.disabled = true;
    label.textContent = "Waiting for Weft…";
    try {
      await weft.request({ method: "weft_connect" });
      var nonce = (await (await fetch("/auth/nonce")).json()).nonce;
      var signed = await weft.request({ method: "weft_signIn", params: { nonce: nonce, statement: ${statement} } });
      var res = await fetch("/auth/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(signed) });
      if (!res.ok) throw new Error((await res.json()).error);
      location.reload();
    } catch (error) {
      say(error && error.code === 4001 ? "Sign-in cancelled." : (error && error.message) || "Sign-in didn't work. Try again.");
      button.disabled = false;
      label.textContent = "Sign in with Weft";
    }
  });
})();`;
}

/**
 * Keeps the page current: polls the status API and, when the index grows,
 * fetches this page again and swaps in the new content. Rows that weren't
 * there before are marked briefly. Pages of older blocks don't update.
 */
const LIVE = `
(function () {
  if (/[?&]before=/.test(location.search)) return;
  var seen = null;
  function relative() {
    document.querySelectorAll("time[datetime]").forEach(function (el) {
      var s = Math.round((Date.now() - new Date(el.getAttribute("datetime")).getTime()) / 1000);
      // Future times (an election's closing time) keep their date, except when close.
      var t = s < -86400 ? null : s < -3600 ? "in " + Math.round(-s / 3600) + " h" : s < -45 ? "in " + Math.round(-s / 60) + " min" : s < 0 ? "in a moment" :
        s < 45 ? "just now" : s < 3600 ? Math.round(s / 60) + " min ago" : s < 86400 ? Math.round(s / 3600) + " h ago" : null;
      if (t) el.textContent = t;
    });
  }
  function links(root) {
    var out = {};
    root.querySelectorAll("tbody tr a[href]").forEach(function (a) { out[a.getAttribute("href")] = true; });
    return out;
  }
  function refresh() {
    fetch(location.href, { headers: { accept: "text/html" } }).then(function (r) { return r.text(); }).then(function (text) {
      var next = new DOMParser().parseFromString(text, "text/html").querySelector("main");
      var main = document.querySelector("main");
      if (!next || !main) return;
      var before = links(main);
      main.innerHTML = next.innerHTML;
      main.querySelectorAll("tbody tr").forEach(function (row) {
        var a = row.querySelector("a[href]");
        if (a && !before[a.getAttribute("href")]) row.classList.add("is-new");
      });
      relative();
    }).catch(function () {});
  }
  function check() {
    fetch("/api/v1/status").then(function (r) { return r.json(); }).then(function (s) {
      var total = s.channels.reduce(function (n, c) { return n + c.height; }, 0);
      if (seen !== null && total > seen) refresh();
      seen = total;
    }).catch(function () {});
  }
  check();
  setInterval(check, 4000);
  setInterval(relative, 30000);
})();`;

function channelCard(site: Site, c: ChannelSummary, s: ChannelStatus | undefined): Html {
  const behind = s?.peerHeight != null ? s.peerHeight - c.height : 0;
  const problems = c.brokenLinks + c.badDataHashes;
  return html`<section class="card channel">
  <div class="channel__head">
    <a class="channel__name mono" href="/channels/${enc(c.channel)}">${c.channel}</a>
    ${s?.state === "stopped" ? html`<span class="pill pill--bad" title="${s.lastError ?? ""}">stopped</span>` : s?.state === "retrying" ? html`<span class="pill pill--warn" title="${s.lastError ?? ""}">reconnecting</span>` : behind > 0 ? html`<span class="pill pill--warn">catching up, ${behind} behind</span>` : html`<span class="pill pill--ok">live</span>`}
  </div>
  <dl class="stats">
    <div><dt>Blocks</dt><dd class="mono">${c.height.toLocaleString("en")}</dd></div>
    <div><dt>Transactions</dt><dd class="mono">${c.transactions.toLocaleString("en")}</dd></div>
    <div><dt>Last block</dt><dd>${time(c.lastBlockAt)}</dd></div>
  </dl>
  <p class="check ${problems ? "check--bad" : ""}">
    ${problems
      ? `${problems} ${problems === 1 ? "block doesn't" : "blocks don't"} match the hashes around ${problems === 1 ? "it" : "them"}. See the blocks list.`
      : c.height > 0
        ? `Each of the ${c.height.toLocaleString("en")} blocks carries the hash of the one before, and every one checks out.`
        : "No blocks indexed yet."}
  </p>
  ${crossCheckSummary(site.peers(c.channel), c.height)}
</section>`;
}

const ORG_STATE: Record<PeerStatus["state"], string> = {
  agree: "agrees",
  pending: "waiting for a checkpoint",
  mismatch: "disagrees",
  invalid: "sent a checkpoint that failed the checks",
  unreachable: "couldn't be reached",
};

/** One line per organisation the explorer compares with, and how far they agree. */
function crossCheckSummary(peers: PeerStatus[], height: number): Html {
  if (peers.length === 0) return html``;
  const latest = height - 1;
  const agreeing = peers.filter((p) => p.state === "agree" && p.agreedUpTo !== null).length;
  return html`<div class="orgs">
    <div class="orgs__head"><span>Compared with other organisations</span><span class="mono subtle">${agreeing + 1} of ${peers.length + 1} agree</span></div>
    <ul>${peers.map(
      (p) => html`<li class="peer peer--${p.state}" title="${p.detail ?? ""}">
        <span class="peer__dot"></span>
        <span class="mono">${p.mspId ?? new URL(p.url).host}</span>
        <span class="subtle">${
          p.state === "agree" && p.agreedUpTo !== null
            ? p.agreedUpTo >= latest
              ? "agrees on every block"
              : `agrees up to #${p.agreedUpTo}`
            : p.state === "mismatch" && p.mismatchAt !== null
              ? `disagrees at #${p.mismatchAt}`
              : ORG_STATE[p.state]
        }</span>
      </li>`,
    )}</ul>
  </div>`;
}

function agreementCell(site: Site, b: BlockRow): Html {
  const peers = site.peers(b.channel);
  if (peers.length === 0) return html``;
  const a = agreementFor(b.number, peers);
  const cls = a.mismatched.length ? "pill--bad" : a.agree === a.total ? "pill--ok" : "pill--quiet";
  return html`<td><span class="pill ${cls}" title="${a.mismatched.length ? `Disagree: ${a.mismatched.join(", ")}` : `${a.agree} of ${a.total} organisations report this block`}">${a.agree}/${a.total}</span></td>`;
}

function blockRows(site: Site, blocks: BlockRow[]): Html {
  const compared = blocks.some((b) => site.peers(b.channel).length > 0);
  return html`<table class="table">
  <thead><tr><th>Block</th><th>Time</th><th class="num">Transactions</th><th>Hash</th>${compared ? html`<th>Agree</th>` : ""}</tr></thead>
  <tbody>${blocks.map(
    (b) => html`<tr>
    <td><a class="mono" href="${blockUrl(b.channel, b.number)}">#${b.number}</a>${b.linked === false || !b.dataHashValid ? html` <span class="pill pill--bad">mismatch</span>` : ""}</td>
    <td>${time(b.timestamp)}</td>
    <td class="num mono">${b.txCount}${b.validCount < b.txCount ? html` <span class="subtle">(${b.txCount - b.validCount} invalid)</span>` : ""}</td>
    <td class="mono subtle">${short(b.hash)}</td>
    ${agreementCell(site, b)}
  </tr>`,
  )}</tbody>
</table>`;
}

function txRows(txs: TransactionRow[], options: { showBlock?: boolean } = {}): Html {
  if (txs.length === 0) return html`<p class="empty">No transactions yet.</p>`;
  return html`<table class="table">
  <thead><tr><th>Transaction</th><th>Call</th><th>Submitted by</th>${options.showBlock !== false ? html`<th>Block</th>` : ""}<th>Status</th></tr></thead>
  <tbody>${txs.map(
    (t) => html`<tr>
    <td>${t.txId ? html`<a class="mono" href="${txUrl(t.channel, t.txId)}">${short(t.txId, 8, 4)}</a>` : html`<span class="subtle">unreadable entry</span>`}<div class="subtle small">${time(t.timestamp)}</div></td>
    <td>${call(t)}</td>
    <td>${t.redacted ? html`<span class="subtle">not published</span>` : party(t.creator)}</td>
    ${options.showBlock !== false ? html`<td><a class="mono" href="${blockUrl(t.channel, t.blockNumber)}">#${t.blockNumber}</a></td>` : ""}
    <td>${status(t.validation, t.redacted)}</td>
  </tr>`,
  )}</tbody>
</table>`;
}

export function homePage(site: Site, channels: ChannelSummary[], statuses: ChannelStatus[], latest: BlockRow[], txs: TransactionRow[]): string {
  if (site.channels.length === 0) {
    const lead = site.signIn && !site.viewer
      ? html`${site.name} publishes its channels to members only. Sign in with Weft, with an identity from a member organisation, to see them.`
      : site.viewer
        ? html`None of the channels ${site.name} publishes lists ${site.viewer.mspId} as a member.`
        : html`${site.name} hasn't published any channel. Operators: set <code>level: public</code> or <code>level: members</code> for a channel in the explorer's policy file and restart it.`;
    return layout(site, "Nothing to show", html`<section class="hero"><h1>Nothing to show yet</h1><p class="lead">${lead}</p></section>`);
  }
  return layout(
    site,
    "Overview",
    html`<section class="hero">
  <h1>${site.name}'s view of the ledger</h1>
  <p class="lead">Blocks and transactions as ${site.name}'s peers recorded them, checked block by block here.</p>
</section>
<div class="grid">${channels.map((c) => channelCard(site, c, statuses.find((s) => s.channel === c.channel)))}</div>
<div class="split">
  <section><h2>Latest blocks</h2>${blockRows(site, latest)}</section>
  <section><h2>Latest transactions</h2>${txRows(txs, { showBlock: false })}</section>
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
): string {
  const oldest = blocks.at(-1)?.number;
  return layout(
    site,
    channel.channel,
    html`<nav class="crumbs"><a href="/">Overview</a></nav>
<h1 class="mono">${channel.channel}</h1>
<div class="grid">${channelCard(site, channel, s)}
  <section class="card">
    <h2 class="card__title">Contracts</h2>
    ${contracts.length === 0
      ? html`<p class="empty">No published contract calls yet.</p>`
      : html`<ul class="contracts">${contracts.map(
          (c) => html`<li><a class="mono" href="${contractUrl(channel.channel, c.chaincode)}">${c.chaincode}</a><span class="subtle">${c.transactions} ${c.transactions === 1 ? "transaction" : "transactions"}</span></li>`,
        )}</ul>`}
  </section>
</div>
${site.elections(channel.channel) ? html`<p class="elections-link"><a href="/channels/${enc(channel.channel)}/elections">Elections on ${channel.channel}</a> <span class="subtle">ballots, results and receipt checks</span></p>` : ""}
<section><h2>Blocks</h2>${blockRows(site, blocks)}
${oldest !== undefined && oldest > 0 ? html`<a class="more" href="/channels/${enc(channel.channel)}?before=${oldest}">Older blocks</a>` : ""}
</section>`,
    { live: true },
  );
}

function hashLine(label: string, value: string, check: boolean | null, okText: string, badText: string): Html {
  return html`<dt>${label}</dt><dd><span class="mono hash">${value}</span>${
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
  <strong>${a.agree} of ${a.total} organisations report this block</strong>
  <span>${verdict}</span>
  <span class="small">Each organisation's explorer signs the latest block it has. Because every block carries the hash of the one before, one matching signature covers every block up to it.</span>
</section>`;
}

export function blockPage(site: Site, block: BlockRow, txs: TransactionRow[], hasNext: boolean): string {
  return layout(
    site,
    `Block ${block.number}`,
    html`<nav class="crumbs"><a href="/">Overview</a><a class="mono" href="/channels/${enc(block.channel)}">${block.channel}</a></nav>
<div class="title-row">
  <h1>Block <span class="mono">#${block.number}</span></h1>
  <span class="pager">
    ${block.number > 0 ? html`<a href="${blockUrl(block.channel, block.number - 1)}">Previous</a>` : ""}
    ${hasNext ? html`<a href="${blockUrl(block.channel, block.number + 1)}">Next</a>` : ""}
  </span>
</div>
<section class="card">
  <dl class="details">
    <dt>Time</dt><dd>${time(block.timestamp)}</dd>
    <dt>Transactions</dt><dd>${block.txCount} (${block.validCount} valid)</dd>
    ${hashLine("Hash", block.hash, null, "", "")}
    ${hashLine(
      "Previous hash",
      block.previousHash,
      block.linked,
      `Matches block #${block.number - 1}.`,
      `Doesn't match the hash of block #${block.number - 1}. This block or the one before it isn't what the peer originally recorded.`,
    )}
    ${hashLine("Data hash", block.dataHash, block.dataHashValid, "Matches this block's transactions.", "Doesn't match this block's transactions.")}
  </dl>
  <p class="subtle small">The hash is computed here from the block header. Every block stores the hash of the one before it, so changing an old block breaks every link after it.</p>
</section>
${blockAgreement(site, block)}
<section><h2>Transactions</h2>${txRows(txs, { showBlock: false })}</section>`,
  );
}

export function transactionPage(site: Site, tx: TransactionRow): string {
  const explanation = explainStatus(tx.validation);
  const ok = tx.validation === "VALID";
  const body = html`<nav class="crumbs"><a href="/">Overview</a><a class="mono" href="/channels/${enc(tx.channel)}">${tx.channel}</a><a class="mono" href="${blockUrl(tx.channel, tx.blockNumber)}">#${tx.blockNumber}</a></nav>
<h1>Transaction</h1>
<p class="mono hash">${tx.txId}</p>
<section class="banner ${ok ? "banner--ok" : "banner--bad"}">
  <strong>${ok ? "Valid. Its changes are in the ledger." : `Invalid: ${explanation.title}.`}</strong>
  ${ok ? "" : html`<span>It's recorded in the block, but none of its changes were applied. <span class="mono">${tx.validation}</span></span>`}
</section>
${tx.redacted
  ? html`<section class="card"><p>${
      tx.membersOnly
        ? site.viewer
          ? `Only members of ${tx.channel} can see this transaction's details, and ${site.viewer.mspId} isn't one.`
          : `Only members of ${tx.channel} can see this transaction's details. Sign in with Weft if your organisation is one.`
        : `This transaction called a contract ${site.name} doesn't publish. Only its ID, block, time and status are shown.`
    }</p>
<dl class="details"><dt>Block</dt><dd><a class="mono" href="${blockUrl(tx.channel, tx.blockNumber)}">#${tx.blockNumber}</a></dd><dt>Time</dt><dd>${time(tx.timestamp)}</dd></dl></section>`
  : html`<section class="card">
  <dl class="details">
    <dt>Block</dt><dd><a class="mono" href="${blockUrl(tx.channel, tx.blockNumber)}">#${tx.blockNumber}</a>, position ${tx.index}</dd>
    <dt>Time</dt><dd>${time(tx.timestamp)}</dd>
    <dt>Type</dt><dd>${tx.type === "endorser" ? "Contract call" : tx.type === "config" ? "Channel configuration" : tx.typeName}</dd>
    ${tx.chaincode ? html`<dt>Contract</dt><dd><a class="mono" href="${contractUrl(tx.channel, tx.chaincode)}">${tx.chaincode}</a></dd><dt>Function</dt><dd class="mono fn">${tx.fn ?? ""}</dd>` : ""}
    <dt>Submitted by</dt><dd>${party(tx.creator)}</dd>
    ${tx.type === "endorser" ? html`<dt>Approved by</dt><dd>${tx.endorsers.length === 0 ? html`<span class="subtle">none</span>` : tx.endorsers.map((e) => html`<div>${party(e)}</div>`)}</dd>` : ""}
  </dl>
</section>
${tx.type === "endorser"
  ? html`<section><h2>Arguments</h2>${tx.args.length === 0
      ? html`<p class="empty">None.</p>`
      : html`<ol class="args">${tx.args.map((a) => html`<li>${value(a)}</li>`)}</ol>`}</section>
<section><h2>Changes</h2>${tx.writes.length === 0
      ? html`<p class="empty">${tx.reads > 0 ? `Read ${tx.reads} ${tx.reads === 1 ? "key" : "keys"}, wrote nothing.` : "No reads or writes published."}</p>`
      : html`<table class="table"><thead><tr><th>Key</th><th>New value</th></tr></thead><tbody>${tx.writes.map(
          (w) => html`<tr><td class="mono">${w.namespace !== tx.chaincode ? html`<span class="subtle">${w.namespace}/</span>` : ""}${readableKey(w.key)}</td><td>${value(w.value)}</td></tr>`,
        )}</tbody></table>${!ok ? html`<p class="subtle small">Shown as proposed. The transaction was invalid, so none of these were applied.</p>` : ""}`}</section>
${tx.response && tx.response.payload.text !== "" ? html`<section><h2>Returned</h2><div class="card">${value(tx.response.payload)}</div></section>` : ""}
${tx.event ? html`<section><h2>Event</h2><div class="card"><div class="mono fn">${tx.event.name}</div>${value(tx.event.payload)}</div></section>` : ""}`
  : ""}`}`;
  return layout(site, `Transaction ${short(tx.txId, 8, 4)}`, body);
}

export function contractPage(site: Site, channel: string, chaincode: string, txs: TransactionRow[], before: number | undefined): string {
  const oldest = txs.at(-1)?.blockNumber;
  return layout(
    site,
    chaincode,
    html`<nav class="crumbs"><a href="/">Overview</a><a class="mono" href="/channels/${enc(channel)}">${channel}</a></nav>
<h1>Contract <span class="mono">${chaincode}</span></h1>
<section><h2>${before === undefined ? "Recent transactions" : `Transactions before block #${before}`}</h2>${txRows(txs)}
${txs.length === 50 && oldest !== undefined ? html`<a class="more" href="${contractUrl(channel, chaincode)}?before=${oldest}">Older</a>` : ""}
</section>`,
  );
}

export function searchPage(site: Site, query: string, results: { blocks: BlockRow[]; txs: TransactionRow[]; contracts: { channel: string; chaincode: string }[] }): string {
  const none = results.blocks.length + results.txs.length + results.contracts.length === 0;
  return layout(
    site,
    "Search",
    html`<h1>Search</h1>
${query === ""
  ? html`<p class="empty">Search by transaction ID (or its start), block number, or contract name.</p>`
  : none
    ? html`<p class="empty">Nothing published matches <span class="mono">${query}</span>.</p>`
    : html`${results.blocks.length ? html`<section><h2>Blocks</h2>${blockRows(site, results.blocks)}</section>` : ""}
${results.contracts.length ? html`<section><h2>Contracts</h2><ul class="contracts">${results.contracts.map((c) => html`<li><a class="mono" href="${contractUrl(c.channel, c.chaincode)}">${c.chaincode}</a><span class="subtle mono">${c.channel}</span></li>`)}</ul></section>` : ""}
${results.txs.length ? html`<section><h2>Transactions</h2>${txRows(results.txs)}</section>` : ""}`}`,
    { query },
  );
}

export function notFoundPage(site: Site, what: string): string {
  return layout(site, "Not found", html`<h1>Not found</h1><p class="empty">${what}</p><p><a href="/">Back to the overview</a></p>`);
}

export function mePage(site: Site, viewer: Viewer, txs: TransactionRow[]): string {
  return layout(
    site,
    "Your transactions",
    html`<nav class="crumbs"><a href="/">Overview</a></nav>
<h1>${viewer.name ?? "Your identity"}</h1>
<p class="lead">Signed in with Weft as <span class="mono">${viewer.mspId}</span>. You see what ${site.name} publishes to the members of ${
      site.channels.length === 1 ? site.channels[0] : "your channels"
    }.</p>
<section><h2>Transactions you submitted</h2>${txRows(txs)}</section>`,
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
    "Elections",
    html`<nav class="crumbs"><a href="/">Overview</a><a class="mono" href="/channels/${enc(channel)}">${channel}</a></nav>
<h1>Elections</h1>
<p class="lead">Ballots are kept private. The ledger holds a commitment for each one and, once voting closes, the count. Anyone can count the commitments here, and any voter can check their own.</p>
${list.length === 0
  ? html`<p class="empty">No elections on ${channel} yet.</p>`
  : html`<table class="table"><thead><tr><th>Election</th><th>Closes</th><th class="num">Ballots</th><th>State</th></tr></thead><tbody>${[...list].reverse().map(
      (e) => html`<tr><td><a href="${electionUrl(channel, e.id)}">${e.title}</a><div class="mono subtle small">${e.id}</div></td><td>${time(Date.parse(e.closesAt))}</td><td class="num mono">${e.commitments}</td><td>${electionState(e)}</td></tr>`,
    )}</tbody></table>`}`,
    { live: true },
  );
}

export function electionPage(
  site: Site,
  channel: string,
  e: ElectionView,
  receipt: { txId: string; commitment: string; result: ReceiptCheck } | null,
): string {
  const max = Math.max(1, ...Object.values(e.tally?.counts ?? {}));
  return layout(
    site,
    e.title,
    html`<nav class="crumbs"><a href="/">Overview</a><a class="mono" href="/channels/${enc(channel)}">${channel}</a><a href="/channels/${enc(channel)}/elections">Elections</a></nav>
<div class="title-row"><h1>${e.title}</h1>${electionState(e)}</div>
<section class="card">
  <dl class="details">
    <dt>Election</dt><dd class="mono">${e.id}</dd>
    <dt>Options</dt><dd>${e.options.join(", ")}</dd>
    <dt>Voting closes</dt><dd>${time(Date.parse(e.closesAt))}</dd>
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
    ${e.closedIn ? html`<p class="subtle small">Published in <a class="mono" href="/channels/${enc(channel)}/transactions/${enc(e.closedIn.txId)}">${short(e.closedIn.txId, 8, 4)}</a>, block #${e.closedIn.blockNumber}.</p>` : ""}</div></section>`
  : html`<section><h2>Result</h2><p class="empty">${Date.parse(e.closesAt) > Date.now() ? "Voting is open. The count is published when it closes." : `Voting has closed. ${e.creatorMsp} publishes the count.`}</p></section>`}
<section id="receipt">
  <h2>Check your receipt</h2>
  <form class="card receipt" method="get" action="#receipt">
    <label><span>Transaction ID</span><input name="tx" value="${receipt?.txId ?? ""}" class="mono" required spellcheck="false" autocomplete="off"></label>
    <label><span>Commitment</span><input name="commitment" value="${receipt?.commitment ?? ""}" class="mono" spellcheck="false" autocomplete="off" placeholder="optional"></label>
    <button type="submit" class="signin">Check</button>
  </form>
  ${receipt ? receiptResult(receipt) : ""}
  <div class="card receipt receipt--local" id="local" ${receipt?.result.commitment ? "" : "hidden"}>
    <p class="small">To confirm the commitment is your vote, enter the choice and the salt from your receipt. They stay in this browser.</p>
    <label><span>Your choice</span><select id="local-option">${e.options.map((o) => html`<option>${o}</option>`)}</select></label>
    <label><span>Salt</span><input id="local-salt" class="mono" spellcheck="false" autocomplete="off"></label>
    <button type="button" class="signin" id="local-check">Check here</button>
    <p id="local-result" class="small" aria-live="polite"></p>
  </div>
</section>
<script>
(function () {
  var button = document.getElementById("local-check");
  if (!button) return;
  var expected = ${raw(JSON.stringify(receipt?.result.commitment ?? null))};
  var electionId = ${raw(JSON.stringify(e.id).replace(/</g, "\\u003c"))};
  button.addEventListener("click", async function () {
    var option = document.getElementById("local-option").value, salt = document.getElementById("local-salt").value.trim();
    var bytes = new TextEncoder().encode(electionId + "\\n" + option + "\\n" + salt);
    var hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))).map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
    var out = document.getElementById("local-result");
    out.textContent = hash === expected ? "It matches: this commitment is a vote for " + option + "." : "It doesn't match. Check the choice and the salt.";
    out.className = "small " + (hash === expected ? "ok" : "bad");
  });
  // A voting app can link here with the choice and salt in the fragment,
  // which browsers never send to the server. Check them, then drop them from
  // the address bar.
  var given = new URLSearchParams(location.hash.slice(1));
  if (given.get("salt") && expected) {
    document.getElementById("local-option").value = given.get("option") || "";
    document.getElementById("local-salt").value = given.get("salt");
    history.replaceState(null, "", location.pathname + location.search + "#receipt");
    document.getElementById("receipt").scrollIntoView();
    button.click();
  }
})();
</script>`,
  );
}

function receiptResult(r: { txId: string; commitment: string; result: ReceiptCheck }): Html {
  const res = r.result;
  if (!res.found) return html`<div class="banner banner--bad"><strong>No published transaction has that ID.</strong><span>Check the ID on your receipt. It may also be in a block this explorer hasn't indexed yet.</span></div>`;
  if (!res.commitment) return html`<div class="banner banner--bad"><strong>That transaction isn't a ballot in this election.</strong></div>`;
  if (!res.valid) return html`<div class="banner banner--bad"><strong>The network didn't accept that ballot.</strong><span>It's in block #${res.blockNumber}, marked ${res.validation}, so it wasn't counted. Vote again if voting is still open.</span></div>`;
  const given = r.commitment.trim().toLowerCase();
  if (given && given !== res.commitment) return html`<div class="banner banner--bad"><strong>The commitment doesn't match.</strong><span>The ledger has <span class="mono">${short(res.commitment, 12, 8)}</span> for this transaction.</span></div>`;
  return html`<div class="banner banner--ok"><strong>Your ballot is in block #${res.blockNumber} and was accepted.</strong><span>Commitment <span class="mono">${short(res.commitment, 12, 8)}</span>${given ? ", as on your receipt" : ""}. It's one of the commitments counted above.</span></div>`;
}
