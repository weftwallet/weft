/**
 * The private election pages (docs/adr/0007), shown only when the explorer
 * runs with WEFT_EXPERIMENTAL=1 and a channel's policy names
 * privateElections. They follow the step 4 model's explorer frames: the
 * elections list, each election's state from its key ceremony to its count
 * or failure, the ceremony table, the result with each trustee's decryption
 * share, the full check in the browser's workers, the tracking code check
 * that Weft links to (?tracking=…#receipt) and the ballots with their proof
 * status. Server-rendered, like every explorer page; the check and the
 * receipt file are the only parts that need script.
 */

import { X509Certificate } from "node:crypto";
import { html, raw, type Html } from "./html.ts";
import type { PrivateBallotRow } from "./db.ts";
import { blockUrl, channelUrl, crumbs, cut, enc, fieldError, invalid, layout, pager, short, time, txUrl, type Site } from "./pages.ts";
import type { Phase, PrivateElectionSummary, PrivateElectionView, StepView } from "./private-elections.ts";
import { readTrackingReceipt } from "./receipt.ts";

export const privateElectionUrl = (channel: string, id: string) => `/channels/${enc(channel)}/elections/${enc(id)}`;
const apiUrl = (channel: string, id: string) => `/api/v1/channels/${enc(channel)}/private-elections/${enc(id)}`;

const pill = (kind: "ok" | "warn" | "bad" | "quiet", text: string, title?: string) =>
  html`<span class="pill pill--${kind}"${title ? html` title="${title}"` : ""}>${text}</span>`;

const PHASES: Record<Phase, ["ok" | "warn" | "bad" | "quiet", string]> = {
  round1: ["quiet", "key ceremony"],
  round2: ["quiet", "key ceremony"],
  round3: ["quiet", "key ceremony"],
  opening: ["quiet", "key ceremony"],
  open: ["quiet", "open"],
  late: ["warn", "open, past its planned closing time"],
  counting: ["warn", "counting"],
  counted: ["ok", "counted"],
  failed: ["bad", "failed"],
  cancelled: ["quiet", "cancelled"],
};
export const phasePill = (phase: Phase) => pill(...PHASES[phase]);

const KEYGEN: Phase[] = ["round1", "round2", "round3", "opening"];
/** Whether the election has a key, so its ballots, its check and its tracking codes can be shown. */
const hasKey = (v: PrivateElectionView) => !KEYGEN.includes(v.phase) && v.phase !== "failed" && v.phase !== "cancelled";
/**
 * The full check and the tracking code check during the key ceremony: on the
 * page but hidden, with their scripts, so they appear without a reload when
 * the election opens while the page is open (data-show, in pages.ts LIVE).
 * A failed or cancelled election never opens, so it has neither.
 */
const shownOnceOpen = (v: PrivateElectionView, name: string): Html | null =>
  hasKey(v) ? html` data-show="${name}"` : KEYGEN.includes(v.phase) ? html` data-show="${name}" hidden` : null;

/** "Org1MSP", "Org1MSP and Org2MSP", "A, B and C". */
export function list(items: readonly string[]): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}
const n = (x: number) => x.toLocaleString("en-GB");
const plural = (x: number, one: string, many = `${one}s`) => `${n(x)} ${x === 1 ? one : many}`;
const block = (channel: string, s: { block: number }) => html`<a class="mono" href="${blockUrl(channel, s.block)}">#${s.block}</a>`;

/** The fingerprint in five groups of four, in Mono, copied as the plain 20 characters. */
function fingerprint(value: string): Html {
  return html`<span class="mono fp grouped" data-copy="${value}">${(value.match(/.{1,4}/g) ?? [value]).map((g) => html`<span>${g}</span>`)}</span>`;
}

/* The elections list ------------------------------------------------------ */

export function privateElectionsSection(channel: string, list: PrivateElectionSummary[]): Html {
  return html`<p class="lead">Private elections, on the private-ballot contract. Each ballot is encrypted under a key that the election's trustees share, and anyone can check the proofs and the count here. Experimental: no one outside the project has reviewed this cryptography.</p>
<div data-live="private-elections">${list.length === 0
    ? html`<p class="empty">No private elections on ${channel} yet. An election appears here once a trustee creates one with the channel's private-ballot contract.</p>`
    : html`<table class="table"><thead><tr><th>Election</th><th>Planned closing time</th><th class="num">Ballots</th><th>State</th></tr></thead><tbody>${list.map(
        (e) =>
          html`<tr><td><a class="row-link" href="${privateElectionUrl(channel, e.id)}">${e.title}</a><div class="mono subtle small">${e.id}</div></td><td data-label="Closes">${time(Date.parse(e.closesAt))}</td><td class="num mono" data-label="Ballots">${n(e.ballots)}</td><td>${phasePill(e.phase)}</td></tr>`,
      )}</tbody></table>`}</div>`;
}

/** The channel's elections page, with its private elections and, when the policy also names a ballot contract, those too. */
export function privateElectionsPage(site: Site, channel: string, list: PrivateElectionSummary[], ballotContract?: Html): string {
  return layout(
    site,
    `Elections on ${channel}`,
    html`${crumbs(["Overview", "/"], [channel, channelUrl(channel), true], "Elections")}
<h1>Elections</h1>
${privateElectionsSection(channel, list)}
${ballotContract ? html`<section class="section-gap"><h2>On the ballot contract</h2>${ballotContract}</section>` : ""}`,
    { live: true },
  );
}

/* One election ------------------------------------------------------------- */

export interface BallotsPage {
  rows: PrivateBallotRow[];
  newer: string | null;
  older: string | null;
}

export interface TrackingLookup {
  /** What the person entered, as typed. */
  code: string;
  /** The field's error, when the code isn't well formed. */
  error: string;
  /** The ballot, when the code is well formed and one has it. */
  ballot: PrivateBallotRow | null;
}

function banner(v: PrivateElectionView): Html {
  if (v.failed) {
    const from = v.failed.fromTrustee;
    return html`<div class="banner banner--bad private-banner" data-live="banner"><p class="banner__title">The key ceremony failed. ${v.failed.reportedBy} reported that the share it received${from ? ` from ${from} doesn't match ${from}'s` : " doesn't match its sender's"} commitments.</p><p>The election can't open, and no ballot was cast. Version 1 can't show which of the two is at fault. The trustees can create a new election under a new ID.</p></div>`;
  }
  if (v.cancelled) {
    return html`<div class="banner banner--quiet private-banner" data-live="banner"><p class="banner__title">${v.creatorMsp} cancelled this election during the key ceremony.</p><p>No key was made and no ballot was cast.</p></div>`;
  }
  const msps = v.trustees.map((t) => t.msp);
  return html`<div class="banner banner--quiet private-banner" data-live="banner"><p class="banner__title">A private election. Experimental: no one outside the project has reviewed its cryptography.</p><p>Each ballot is encrypted under a key that ${list(msps)} share. This explorer checks the proofs on the ledger, and can't read any ballot.</p></div>`;
}

function closing(v: PrivateElectionView): Html {
  const k = v.threshold;
  if (v.closed) {
    return html`<dt>Voting closed</dt><dd>In block ${block(v.channel, v.closed)}, ${time(v.closed.timestamp)}, by ${list(v.closed.closedBy)}.<div class="small ${v.closed.early ? "warn-text" : "subtle"}">${
      v.closed.early
        ? html`Before its planned closing time, ${time(Date.parse(v.closesAt))}. Any ${k} trustees can close voting early, and the block shows when they did.`
        : html`Its planned closing time was ${time(Date.parse(v.closesAt))}.`
    }</div></dd>`;
  }
  const asked = v.trustees.filter((t) => t.closeRequest).map((t) => t.msp);
  return html`<dt>Planned closing time</dt><dd>${time(Date.parse(v.closesAt))}${
    v.phase === "late" ? html`<div class="small warn-text">Past its planned closing time. The trustees haven't closed it, so it still accepts ballots.</div>` : ""
  }${
    asked.length && (v.phase === "open" || v.phase === "late")
      ? html`<div class="small subtle">${list(asked)} ${asked.length === 1 ? "has" : "have"} asked to close voting. It closes when ${k} of ${v.trustees.length} trustees have asked.</div>`
      : ""
  }</dd>`;
}

function summary(v: PrivateElectionView): Html {
  const msps = v.trustees.map((t) => t.msp);
  const voters = v.voters.kind === "x509" ? html`X.509 identities of ${list(v.voters.msps ?? [])}.` : html`Voter credentials from <span class="mono">${v.voters.msp ?? ""}</span>.`;
  const key = KEYGEN.includes(v.phase)
    ? html`<span class="subtle">Not made yet. It follows from the trustees' round 1 commitments once all three rounds are done.</span>`
    : !v.fingerprint
      ? html`<span class="subtle">None. The key ceremony didn't finish.</span>`
      : html`${fingerprint(v.fingerprint)}<div class="small ${v.fingerprintMatches === false ? "bad" : "subtle"}">${
          v.fingerprintMatches === false
            ? "It isn't the one the election's record gives. Don't vote in this election until its trustees have explained why."
            : "Worked out here from the election's record. Weft shows the same before each vote."
        }</div>`;
  const ballots = !hasKey(v)
    ? html`<span class="subtle">${v.phase === "failed" || v.phase === "cancelled" ? "None. No ballot was cast." : "None. Voting opens after the key ceremony."}</span>`
    : html`<span class="mono">${n(v.ballots.total)}</span> <span class="subtle small">accepted${v.phase === "open" || v.phase === "late" ? " so far" : ""}, counted from the ledger here</span>${
        v.ballots.failed ? html`<div class="small bad">${plural(v.ballots.failed, "ballot doesn't", "ballots don't")} pass this explorer's check. See the ballots below.</div>` : ""
      }`;
  return html`<section class="card" data-live="summary"><dl class="details">
<dt>Election</dt><dd class="mono">${v.id}</dd>
<dt>Options</dt><dd>${v.options.join(", ")}</dd>
${closing(v)}
<dt>Run by</dt><dd class="mono">${v.creatorMsp}</dd>
<dt>Voters</dt><dd>${voters}<div class="subtle small">Who voted is visible to every member. Each ballot shows a voter tag, which names no one.</div></dd>
<dt>Trustees</dt><dd>${v.trustees.map((t, i) => html`${i ? (i === v.trustees.length - 1 ? " and " : ", ") : ""}<span class="mono">${t.msp}</span> (${i + 1})`)}. Any ${v.threshold} of ${msps.length} can decrypt.</dd>
<dt>Election fingerprint</dt><dd>${key}</dd>
<dt>Encrypted ballots</dt><dd>${ballots}</dd>
</dl></section>`;
}

/** A ceremony cell: posted in a block, with this explorer's check; waiting; or not started. */
function stepCell(channel: string, s: StepView | null, waiting: boolean, notPosted = "not started"): Html {
  if (s) {
    const bad = s.verified === false;
    return html`${pill(bad ? "bad" : "ok", bad ? "doesn't verify" : "posted", bad ? s.error ?? undefined : undefined)}<span class="small subtle step-block">block ${block(channel, s)}</span>`;
  }
  return waiting ? pill("quiet", "waiting") : html`<span class="subtle small">${notPosted}</span>`;
}

function ceremonySection(v: PrivateElectionView): Html {
  const t = v.trustees;
  const all = (k: "round1" | "round2" | "confirmation") => t.every((x) => x[k]);
  const missing = (k: "round1" | "round2" | "confirmation") => t.filter((x) => !x[k]).map((x) => x.msp);
  const live = v.phase === "round1" || v.phase === "round2" || v.phase === "round3" || v.phase === "opening";
  const after = v.cancelled ? "not posted" : v.failed ? "stopped" : "not started";
  const rows = t.map((x) => {
    let r3 = stepCell(v.channel, x.confirmation, live && all("round2"), after);
    if (v.failed && v.failed.reportedBy === x.msp) r3 = html`${pill("bad", "reported a bad share")}${v.failed.txId ? html`<span class="small subtle step-block">block ${block(v.channel, v.failed)}</span>` : ""}`;
    return html`<tr><td><span class="mono">${x.msp}</span><div class="small subtle">trustee ${t.indexOf(x) + 1}</div></td><td data-label="Round 1">${stepCell(v.channel, x.round1, live, after)}</td><td data-label="Round 2">${stepCell(v.channel, x.round2, live && all("round1"), after)}</td><td data-label="Round 3">${r3}</td></tr>`;
  });
  const bad = t.flatMap((x) => [x.round1, x.round2, x.confirmation]).find((s) => s?.verified === false);
  const they = (msps: string[]) => (msps.length === 1 ? `${msps[0]} to confirm that it holds its key share` : `${list(msps)} to confirm that they hold their key shares`);
  const cancelledIn = !all("round1") ? 1 : !all("round2") ? 2 : 3;
  const line = bad
    ? html`<p class="check check--bad">A post doesn't pass this explorer's check: ${bad.error ?? ""}</p>`
    : v.phase === "round1"
      ? html`<p class="check check--quiet">Waiting for ${list(missing("round1"))} to post round 1. The contract checks each trustee's proof of knowledge as it is posted.</p>`
      : v.phase === "round2"
        ? html`<p class="check check--quiet">Waiting for ${list(missing("round2"))} to post round 2: an encrypted share for each other trustee. The contract checks only that each is there, since it can't read them.</p>`
        : v.phase === "round3"
          ? html`<p class="check check--quiet">Waiting for ${they(missing("confirmation"))}.</p>`
          : v.phase === "opening"
            ? html`<p class="check check--quiet">Every trustee has confirmed. The election opens when anyone in the channel calls <span class="mono">OpenElection</span>.</p>`
            : v.failed
              ? html`<p class="check check--bad">Stopped in round 3. The election can't open.</p>`
              : v.cancelled
                ? html`<p class="check check--quiet">Cancelled by ${v.creatorMsp} in round ${cancelledIn}.</p>`
                : v.opened?.verified === false
                  ? html`<p class="check check--bad">This explorer's check of the key failed: ${v.opened.error ?? ""}</p>`
                  : html`<p class="check">Complete. The key and ${t.length === 2 ? "both" : `all ${t.length}`} verifying shares follow from the round 1 commitments, and every trustee proved it holds its share.${v.opened ? html` Opened in block ${block(v.channel, v.opened)}.` : ""}</p>`;
  const hex = (h: unknown) => html`<div class="mono small hexline">${String(h ?? "")}</div>`;
  const posted = t.flatMap((x) => {
    const r1 = x.round1?.body as { commitments?: string[]; proof?: string; ceremonyKey?: string } | null | undefined;
    const r2 = x.round2?.body as { shares?: { to: string; nonce: string; box: string }[] } | null | undefined;
    const c = x.confirmation?.body as { c?: string; z?: string } | null | undefined;
    const idOf = (scalar: string) => {
      const i = t.findIndex((y) => y.id === scalar);
      return i < 0 ? scalar : `trustee ${i + 1}, ${t[i]!.msp}`;
    };
    return [
      r1 ? html`<dt>${x.msp}, round 1</dt><dd><div class="small subtle">Commitments</div>${(r1.commitments ?? []).map(hex)}<div class="small subtle">Proof of knowledge</div>${hex(r1.proof)}<div class="small subtle">One-time ceremony key</div>${hex(r1.ceremonyKey)}</dd>` : "",
      r2 ? html`<dt>${x.msp}, round 2</dt><dd>${(r2.shares ?? []).map((s) => html`<div class="small subtle">To ${idOf(s.to)}</div><div class="mono small hexline">nonce ${s.nonce}</div><div class="mono small hexline">box ${s.box}</div>`)}</dd>` : "",
      c ? html`<dt>${x.msp}, round 3</dt><dd><div class="small subtle">Proof that it holds its key share</div><div class="mono small hexline">c ${c.c ?? ""}</div><div class="mono small hexline">z ${c.z ?? ""}</div></dd>` : "",
    ];
  });
  return html`<section class="section-gap" id="ceremony" data-live="ceremony"><h2>Key ceremony</h2><p class="lead">A Pedersen key generation over the ledger, in three rounds. No key share reaches the ledger in a form anyone else can read.</p>
<table class="table ceremony"><thead><tr><th>Trustee</th><th>Round 1, commitments</th><th>Round 2, encrypted shares</th><th>Round 3, confirmation</th></tr></thead><tbody>${rows}</tbody></table>
${line}
${posted.some((p) => p !== "") ? html`<details class="config-more disclosure"><summary>Show what each trustee posted</summary><dl class="details">${posted}</dl></details>` : ""}</section>`;
}

/** Each trustee's decryption share: the block it is in and this explorer's check of its proofs. */
function sharesTable(v: PrivateElectionView): Html {
  const L = v.options.length;
  const rows = v.trustees.map(
    (x) =>
      html`<tr><td><span class="mono">${x.msp}</span></td><td data-label="Posted">${x.share ? html`block ${block(v.channel, x.share)}` : html`<span class="subtle">not yet</span>`}</td><td data-label="Proofs">${
        x.share ? (x.share.verified === false ? pill("bad", "don't verify", x.share.error ?? undefined) : pill("ok", `${L} of ${L} verify`)) : pill("quiet", "waiting")
      }</td></tr>`,
  );
  const values = v.trustees.flatMap((x) => {
    const s = x.share?.body as { shares?: { d: string; c: string; z: string }[] } | null | undefined;
    return s ? [html`<dt>${x.msp}</dt><dd>${(s.shares ?? []).map((e, j) => html`<div class="small subtle">${v.options[j] ?? `Option ${j}`}</div><div class="mono small hexline">d ${e.d}</div><div class="mono small hexline">c ${e.c}</div><div class="mono small hexline">z ${e.z}</div>`)}</dd>`] : [];
  });
  return html`<table class="table"><thead><tr><th>Trustee</th><th>Posted</th><th>Proofs</th></tr></thead><tbody>${rows}</tbody></table>
<details class="config-more disclosure share-values"><summary>Show the encrypted totals and the shares</summary><dl class="details"><dt>Encrypted totals</dt><dd>${(v.totals ?? []).map(
    (t, j) => html`<div class="small subtle">${v.options[j] ?? `Option ${j}`}</div><div class="mono small hexline">a ${t.a}</div><div class="mono small hexline">b ${t.b}</div>`,
  )}</dd>${values}</dl></details>`;
}

function resultSection(v: PrivateElectionView): Html {
  const k = v.threshold;
  let body: Html;
  if (v.phase === "failed" || v.phase === "cancelled") body = html`<p class="empty">No ballots were cast.</p>`;
  else if (KEYGEN.includes(v.phase)) body = html`<p class="empty">Voting opens once the key ceremony is complete.</p>`;
  else if (v.phase === "open" || v.phase === "late") {
    body = html`<p class="empty">The ballots are added up when ${k} of the trustees close voting, and the trustees then decrypt only the totals.</p>`;
  } else if (v.phase === "counting") {
    const posted = v.trustees.filter((x) => x.share).length;
    const ballots = v.recordBallots ?? 0;
    body = html`<div class="card tally"><p>Voting closed in block ${v.closed ? block(v.channel, v.closed) : "?"} with ${plural(ballots, "ballot")}, and the contract added them up per option there. The totals are still encrypted.</p>${
      v.closed?.verified === false
        ? html`<p class="check check--bad">This explorer's check of the totals failed: ${v.closed.error ?? ""}</p>`
        : posted < k
          ? html`<p class="check check--quiet">Waiting for ${plural(k - posted, "more decryption share")}. The tally needs ${k} of ${v.trustees.length}.</p>`
          : html`<p class="check check--quiet">Every share the tally needs is in. The tally is published when anyone in the channel calls <span class="mono">PublishTally</span>.</p>`
    }${sharesTable(v)}</div>`;
  } else {
    const counts = v.tally?.counts ?? [];
    const max = Math.max(1, ...counts);
    const quorum = v.trustees
      .filter((x) => x.share)
      .slice(0, k)
      .map((x) => x.msp);
    const sharesOk = v.trustees.filter((x) => x.share).every((x) => x.share!.verified !== false);
    body = html`<div class="card tally">${v.options.map(
      (o, i) =>
        html`<div class="tally__row"><span>${o}</span><svg class="tally__bar" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true"><rect width="100" height="10" class="tally__track"/><rect width="${Math.max(0.0001, ((counts[i] ?? 0) / max) * 100)}" height="10" class="tally__fill"/></svg><span class="mono">${n(counts[i] ?? 0)}</span></div>`,
    )}
<p class="check${v.published?.verified === false || !sharesOk ? " check--bad" : ""}">${
      v.published?.verified === false
        ? `This explorer's check of the tally failed: ${v.published.error ?? ""}`
        : !sharesOk
          ? "A decryption share doesn't pass this explorer's check. See the shares below."
          : `The counts add up to the ${plural(v.tally?.total ?? 0, "ballot")}, and ${quorum.length === 2 ? "both" : `all ${quorum.length}`} decryption shares verify.`
    }</p>
${v.published ? html`<p class="subtle small">Published in <a class="mono" href="${txUrl(v.channel, v.published.txId)}">${short(v.published.txId)}</a>, block #${v.published.block}. The tally combines the shares of ${list(quorum)}.</p>` : ""}
${sharesTable(v)}</div>`;
  }
  return html`<section class="section-gap" id="result" data-live="result"><h2>Result</h2>${body}</section>`;
}

/* The full check, in the browser's workers -------------------------------- */

/** About how long one worker takes per three-option ballot in Chromium, for the estimate under the button (prototype-results.md). */
export const MS_PER_BALLOT = 27;

function fullCheckSection(v: PrivateElectionView): Html {
  const shown = shownOnceOpen(v, "check");
  if (!shown) return html``;
  const L = v.options.length;
  const detail =
    v.submitters === "show"
      ? `${L} bit proofs, a sum proof and the tracking code of each, with each voter tag worked out again from its submitter's certificate`
      : `${L} bit proofs, a sum proof and the tracking code of each, against its published voter tag. This explorer hides submitters, so its own server checks that each tag belongs to its submitter`;
  const step = (key: string, label: string, text: string, bar = false) =>
    html`<li class="xcheck__step" data-step="${key}"><span>${label}</span><span class="small subtle xcheck__word" data-word>waiting</span><span class="small subtle xcheck__detail">${text}</span>${
      bar ? html`<div class="xcheck__bar" aria-hidden="true"><span></span></div>` : ""
    }</li>`;
  return html`<section class="section-gap" id="check"${shown}><h2>Check the whole election</h2><p class="lead">This browser reads the key ceremony, every ballot, the totals and the decryption shares from this explorer and checks each proof again, so you don't have to rely on this explorer's own check. Nothing is sent anywhere.</p>
<div class="card xcheck" id="xcheck">
<ol class="xcheck__steps">
${step("ceremony", "Key ceremony", `${v.trustees.length} proofs of knowledge and ${v.trustees.length} confirmations, with the key, the context and the fingerprint worked out again from the commitments.`)}
${step("ballots", "Ballot proofs", `${detail}.`, true)}
${step("totals", "Totals", "Every ballot added up again, against the totals written when voting closed.")}
${step("shares", "Decryption shares", `${L} proofs from each trustee that posted a share.`)}
${step("tally", "Tally", "The shares combined, and each count found again.")}
</ol>
<div class="xcheck__actions"><button type="button" class="button" id="xcheck-run">Check every ballot</button><span class="subtle small" id="xcheck-hint"></span><button type="button" class="link-button xcheck__stop" id="xcheck-stop" aria-hidden="true" tabindex="-1">Stop checking</button></div>
<div id="xcheck-result" aria-live="polite"></div>
</div></section>
<script>${raw(fullCheckScript(v))}</script>`;
}

const json = (x: unknown) => JSON.stringify(x).replace(/</g, "\\u003c");

/**
 * The full check's script. It reads the election and its ballots from this
 * explorer's API, starts up to four workers (/assets/full-check.js, which
 * the content security policy's worker-src allows), and checks the key
 * ceremony, then the ballots in batches of 50 in ledger order, then the
 * totals, the decryption shares and the tally. It reports the first failure
 * by ballot and transaction, or that everything checks out, and how long
 * it took. Stop checking ends the workers.
 */
function fullCheckScript(v: PrivateElectionView): string {
  return `
(function () {
  var API = ${json(apiUrl(v.channel, v.id))};
  var CHANNEL = ${json(v.channel)};
  var MS = ${MS_PER_BALLOT};
  var PAGE = 1000, BATCH = 50;
  var WORKERS = Math.max(1, Math.min(4, navigator.hardwareConcurrency || 2));
  var card = document.getElementById("xcheck"), run = document.getElementById("xcheck-run"), stop = document.getElementById("xcheck-stop");
  var hint = document.getElementById("xcheck-hint"), out = document.getElementById("xcheck-result");
  var current = null;
  function fmt(x) { return x.toLocaleString("en-GB"); }
  function plural(x, one, many) { return fmt(x) + " " + (x === 1 ? one : many || one + "s"); }
  function list(xs) { return xs.length <= 1 ? xs.join("") : xs.slice(0, -1).join(", ") + " and " + xs[xs.length - 1]; }
  function cut(s) { return s.length <= 17 ? s : s.slice(0, 8) + "\\u2026" + s.slice(-8); }
  function seconds(ms) { return ms < 10000 ? (ms / 1000).toFixed(1) + " s" : ms < 120000 ? Math.round(ms / 1000) + " s" : (ms / 60000).toFixed(1) + " minutes"; }
  function estimate(total) {
    var ms = total * MS / WORKERS;
    return "About " + (ms < 60000 ? Math.max(1, Math.round(ms / 1000)) + (ms < 1500 ? " second" : " seconds") : Math.round(ms / 60000) + (ms < 90000 ? " minute" : " minutes")) + " for " + plural(total, "ballot") + " in " + plural(WORKERS, "worker") + ".";
  }
  hint.textContent = estimate(${v.ballots.total});
  // As ballots arrive (pages.ts LIVE), the estimate follows the count, unless a check is running.
  document.addEventListener("weft:live", function () {
    var title = document.querySelector('[data-live="title"]');
    if (!current && title) hint.textContent = estimate(Number(title.getAttribute("data-ballots")) || 0);
  });
  function step(key) { return card.querySelector('[data-step="' + key + '"]'); }
  function word(key, kind, text) {
    var w = step(key).querySelector("[data-word]");
    w.textContent = text;
    w.className = "small xcheck__word" + (kind === "ok" ? " ok" : kind === "bad" ? " bad" : kind === "busy" ? "" : " subtle");
  }
  function bar(frac, bad) {
    var b = step("ballots").querySelector(".xcheck__bar");
    b.classList.toggle("xcheck__bar--bad", !!bad);
    b.firstChild.style.transform = "scaleX(" + Math.max(0, Math.min(1, frac)) + ")";
  }
  function reset() {
    ["ceremony", "ballots", "totals", "shares", "tally"].forEach(function (k) { word(k, "", "waiting"); });
    bar(0);
    out.innerHTML = "";
  }
  function show(kind, title, body) {
    out.innerHTML = "";
    var d = document.createElement("div");
    d.className = "banner banner--" + kind;
    if (kind === "bad") d.setAttribute("role", "alert");
    var t = document.createElement("p");
    t.className = "banner__title";
    t.textContent = title;
    d.append(t);
    if (body) { var p = document.createElement("p"); body.forEach(function (part) { p.append(part); }); d.append(p); }
    out.append(d);
    weftSay(d.textContent);
  }
  function link(href, text) { var a = document.createElement("a"); a.className = "mono"; a.href = href; a.textContent = text; return a; }
  function busy(on) {
    weftBusy(run, on);
    stop.setAttribute("aria-hidden", on ? "false" : "true");
    stop.tabIndex = on ? 0 : -1;
  }
  function finish(c) {
    c.workers.forEach(function (w) { w.terminate(); });
    if (current === c) current = null;
    busy(false);
    run.textContent = "Check again";
  }
  stop.addEventListener("click", function () {
    var c = current;
    if (!c) return;
    c.stopped = true;
    finish(c);
    reset();
    show("quiet", "Check stopped after " + fmt(c.done) + " of " + plural(c.total, "ballot") + ".", ["Nothing was checked to the end. Check every ballot starts again from the key ceremony."]);
    run.focus();
  });
  function ask(c, w, message) {
    return new Promise(function (resolve, reject) {
      var id = ++c.seq;
      c.waiting[id] = { resolve: resolve, reject: reject, progress: message.onProgress };
      delete message.onProgress;
      message.id = id;
      w.postMessage(message);
    });
  }
  function worker(c) {
    var w = new Worker("/assets/full-check.js");
    w.onmessage = function (e) {
      var m = e.data, wait = c.waiting[m.id];
      if (!wait) return;
      if (m.type === "progress") { if (wait.progress) wait.progress(m.done); return; }
      delete c.waiting[m.id];
      if (m.type === "error") wait.reject(new Error(m.message)); else wait.resolve(m);
    };
    w.onerror = function (e) {
      e.preventDefault();
      Object.keys(c.waiting).forEach(function (id) { c.waiting[id].reject({ worker: e.message || "the worker didn't start" }); delete c.waiting[id]; });
    };
    c.workers.push(w);
    return w;
  }
  async function getJson(url) {
    var r = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw { http: r.status };
    return r.json();
  }
  run.addEventListener("click", function () {
    if (run.getAttribute("aria-disabled") === "true") return;
    start();
  });
  async function start() {
    var c = { workers: [], waiting: {}, seq: 0, stopped: false, settled: false, done: 0, total: ${v.ballots.total} };
    current = c;
    reset();
    busy(true);
    var t0 = performance.now();
    try {
      var v = await getJson(API);
      if (c.stopped) return;
      var e = { channel: v.channel, chaincode: v.contract, electionId: v.id, options: v.options, threshold: v.threshold, trustees: v.trustees.map(function (t) { return t.msp; }), publicKey: v.publicKey, verifyingShares: v.verifyingShares, context: v.context, fingerprint: v.fingerprint };
      c.total = v.ballots.total;
      word("ballots", "busy", "reading 0 of " + fmt(c.total));
      var ballots = [];
      for (var offset = 0; offset < c.total; offset += PAGE) {
        var page = await getJson(API + "/ballots?offset=" + offset + "&limit=" + PAGE);
        if (c.stopped) return;
        ballots = ballots.concat(page.ballots);
        word("ballots", "busy", "reading " + fmt(ballots.length) + " of " + fmt(c.total));
        if (page.ballots.length < PAGE) break;
      }
      c.total = ballots.length;
      for (var i = 0; i < WORKERS; i++) worker(c);

      word("ceremony", "busy", "checking");
      var posts = v.trustees.map(function (t) { return { round1: t.round1 && t.round1.body, round2: t.round2 && t.round2.body, confirmation: t.confirmation && t.confirmation.body }; });
      var cer = await ask(c, c.workers[0], { type: "ceremony", election: e, posts: posts });
      if (c.stopped) return;
      if (cer.failure) {
        word("ceremony", "bad", "failed");
        ["ballots", "totals", "shares", "tally"].forEach(function (k) { word(k, "", "not checked"); });
        finish(c);
        show("bad", "The key ceremony doesn't check out.", [cer.failure + " The check stopped there, before the ballots."]);
        return;
      }
      word("ceremony", "ok", "checks out");

      // The checks across ballots, in ledger order: a repeated voter tag or ciphertext.
      var tags = {}, as = {}, repeat = null;
      for (var j = 0; j < ballots.length && !repeat; j++) {
        var b = ballots[j], cts = (b.ballot && b.ballot.ciphertexts) || [];
        for (var x = 0; x < cts.length; x++) if (as[cts[x].a]) { repeat = { index: j, message: "A ciphertext in this ballot is already on the ledger." }; break; }
        if (!repeat && tags[b.voterTag]) repeat = { index: j, message: "This identity has already voted in this election." };
        cts.forEach(function (ct) { as[ct.a] = true; });
        tags[b.voterTag] = true;
      }
      var limit = repeat ? repeat.index + 1 : ballots.length;
      var batches = [];
      for (var s = 0; s < limit; s += BATCH) batches.push({ start: s, items: ballots.slice(s, Math.min(limit, s + BATCH)).map(function (b, k) { return { index: s + k, txId: b.txId, block: b.block, tracking: b.tracking, voterTag: b.voterTag, ballot: b.ballot, creator: b.creator || null }; }), done: 0 });
      var failures = [], next = 0, frame = 0;
      function paint() {
        frame = 0;
        c.done = batches.reduce(function (a, bt) { return a + bt.done; }, 0);
        if (!c.stopped && !c.settled) { word("ballots", "busy", fmt(c.done) + " of " + fmt(ballots.length)); bar(ballots.length ? c.done / ballots.length : 1); }
      }
      function tick() { if (!frame) frame = requestAnimationFrame(paint); }
      word("ballots", "busy", "0 of " + fmt(ballots.length));
      await Promise.all(c.workers.map(async function (w) {
        while (!c.stopped && next < batches.length) {
          var bt = batches[next++];
          // Past the first failure found so far, nothing can be the first.
          if (failures.length && bt.start > Math.min.apply(null, failures.map(function (f) { return f.index; }))) continue;
          var res = await ask(c, w, { type: "ballots", election: e, ballots: bt.items, onProgress: function (d) { bt.done = d; tick(); } });
          bt.done = res.done;
          tick();
          if (res.failure) failures.push(res.failure);
        }
      }));
      if (c.stopped) return;
      paint();
      // Progress that arrives after this point is stale.
      c.settled = true;
      if (frame) cancelAnimationFrame(frame);
      if (repeat && !failures.some(function (f) { return f.index <= repeat.index; })) {
        var rb = ballots[repeat.index];
        failures.push({ index: repeat.index, txId: rb.txId, block: rb.block, tracking: rb.tracking, message: repeat.message });
      }
      if (failures.length) {
        var f = failures.sort(function (a, b) { return a.index - b.index; })[0];
        word("ballots", "bad", "failed at " + fmt(f.index + 1) + " of " + fmt(ballots.length));
        bar((f.index + 1) / Math.max(1, ballots.length), true);
        ["totals", "shares", "tally"].forEach(function (k) { word(k, "", "not checked"); });
        finish(c);
        show("bad", "Ballot " + fmt(f.index + 1) + " of " + fmt(ballots.length) + " doesn't check out.", [
          f.message + " It is in transaction ", link("/channels/" + encodeURIComponent(CHANNEL) + "/transactions/" + encodeURIComponent(f.txId), cut(f.txId)),
          ", block #" + f.block + ", with tracking code " + cut(f.tracking) + ". The check stopped at this first failure. The contract should have refused this ballot, so tell the network's operators.",
        ]);
        out.firstChild.dataset.ms = String(Math.round(performance.now() - t0));
        return;
      }
      word("ballots", "ok", plural(ballots.length, "ballot") + " check out");
      bar(1);

      var closed = !!v.totals;
      var shares = v.trustees.map(function (t, i) { return t.share ? { index: i, share: t.share.body } : null; }).filter(Boolean);
      var counts = v.tally ? v.tally.counts : null;
      var said = [];
      if (closed) {
        ["totals", "shares", "tally"].forEach(function (k) { word(k, "busy", "checking"); });
        var cnt = await ask(c, c.workers[0], { type: "count", election: e, count: { ciphertexts: ballots.map(function (b) { return b.ballot.ciphertexts; }), recordBallots: v.recordBallots, totals: v.totals, shares: shares, counts: counts } });
        if (c.stopped) return;
        var r = cnt.result;
        var steps = [["totals", "The totals don't check out.", r.totals], ["shares", "A decryption share doesn't check out.", r.shares], ["tally", "The tally doesn't check out.", r.tally]];
        for (var q = 0; q < steps.length; q++) {
          var st = steps[q];
          if (st[2]) {
            word(st[0], "bad", "failed");
            for (var z = q + 1; z < steps.length; z++) word(steps[z][0], "", "not checked");
            finish(c);
            show("bad", st[1], [st[2] + " The check stopped at this first failure."]);
            return;
          }
          if (st[0] === "shares" && !shares.length) word("shares", "", "none posted yet");
          else if (st[0] === "tally" && !counts) word("tally", "", "not published yet");
          else word(st[0], "ok", "checks out");
        }
      } else {
        word("totals", "", "not yet");
        word("shares", "", "not yet");
        word("tally", "", "not yet");
      }
      var took = performance.now() - t0;
      finish(c);
      var body;
      if (counts) body = "The key ceremony, the " + plural(ballots.length, "ballot") + ", the totals and " + (shares.length === 2 ? "both decryption shares" : plural(shares.length, "decryption share")) + " give " + list(v.options.map(function (o, i) { return o + " " + fmt(counts[i]); })) + ". ";
      else if (closed) body = "The key ceremony, the " + plural(ballots.length, "ballot") + ", the totals and the " + plural(shares.length, "decryption share") + " posted so far. The tally is checked once it is published. ";
      else body = "The key ceremony and the " + plural(ballots.length, "ballot") + " so far. The totals, the decryption shares and the tally are checked once they are on the ledger. ";
      show("ok", "Everything checks out.", [body + "Took " + seconds(took) + " in " + plural(WORKERS, "worker") + "."]);
      out.firstChild.dataset.ms = String(Math.round(took));
    } catch (error) {
      if (c.stopped) return;
      finish(c);
      error = error || {};
      if (error.worker) show("bad", "This browser couldn't run the check's workers.", ["Reload the page and try again. " + error.worker]);
      else if (error.http || error instanceof TypeError || (error.name === "TimeoutError")) show("bad", "This explorer didn't answer, so the check didn't finish.", ["Check your connection and try again."]);
      else show("bad", "The check couldn't finish.", [String(error.message || error)]);
    }
  }
})();`;
}

/* The tracking code check ---------------------------------------------- */

function trackingResult(v: PrivateElectionView, t: TrackingLookup): Html {
  if (t.error || !t.code) return html``;
  const b = t.ballot;
  if (!b) {
    return html`<div class="banner banner--bad" id="tracking-result"><p class="banner__title">No ballot in this election has that tracking code.</p><p>Check the code on your receipt. Its ballot may also be in a block this explorer hasn't indexed yet.</p></div>`;
  }
  const where =
    v.phase === "counted"
      ? `It's one of the ${plural(v.recordBallots ?? 0, "ballot")} in the totals, and in the published count.`
      : v.phase === "counting"
        ? `It's one of the ${plural(v.recordBallots ?? 0, "ballot")} in the totals, which the trustees are decrypting.`
        : "It will be in the totals when the trustees close voting.";
  if (!b.verified) {
    return html`<div class="banner banner--bad" id="tracking-result"><p class="banner__title">Your ballot is in block #${b.block}, and its proofs don't pass this explorer's check.</p><p>${b.error ?? ""} Transaction <a class="mono" href="${txUrl(v.channel, b.txId)}">${short(b.txId)}</a>. Tell the network's operators.</p></div>`;
  }
  return html`<div class="banner banner--ok" id="tracking-result"><p class="banner__title">Your ballot is in block #${b.block} and its proofs verify.</p><p>${where} Transaction <a class="mono" href="${txUrl(v.channel, b.txId)}">${short(b.txId)}</a>, committed ${time(b.timestamp)}. The tracking code shows nothing about your choice.</p></div>`;
}

function trackingSection(v: PrivateElectionView, t: TrackingLookup | null): Html {
  const shown = shownOnceOpen(v, "receipt");
  if (!shown) return html``;
  return html`<section class="section-gap" id="receipt"${shown}><h2>Check your tracking code</h2>
<form class="card receipt receipt--single" method="get" action="#receipt" id="tracking-form" novalidate>
  <div class="xr-file" id="tracking-file-row" hidden>
    <input type="file" accept=".json,application/json" id="tracking-file" tabindex="-1" aria-hidden="true">
    <button type="button" class="btn btn--small" id="tracking-choose">Choose receipt file</button>
    <p id="tracking-file-hint">or drop it on this form, or paste the copied receipt. It fills the field below.</p>
    <p class="field__status" id="tracking-file-status" role="status"></p>
  </div>
  <div class="field"><label for="tracking">Tracking code</label><input id="tracking" name="tracking" value="${t?.code ?? ""}" class="mono" spellcheck="false" autocomplete="off"${invalid(t?.error ? "tracking-error" : null)}>${fieldError("tracking-error", t?.error ?? "")}</div>
  <button type="submit" class="button">Check</button>
</form>
${t ? trackingResult(v, t) : ""}
</section>
<script>
(function () {
  var input = document.getElementById("tracking");
  var field = weftField(input, function (v) {
    v = v.trim();
    return v === "" ? "Enter the tracking code from your receipt." : /^[0-9a-f]{64}$/i.test(v) ? "" : "A tracking code is 64 characters, 0 to 9 and a to f.";
  });
  var form = document.getElementById("tracking-form");
  weftForm(form, [field]);
  var result = document.getElementById("tracking-result");
  if (result) weftSay(Array.from(result.querySelectorAll(":scope > p")).map(function (p) { return p.textContent.trim(); }).join(" "));
  var readTrackingReceipt = ${raw(readTrackingReceipt.toString())};
  var electionId = ${raw(json(v.id))};
  var fileInput = document.getElementById("tracking-file"), status = document.getElementById("tracking-file-status");
  document.getElementById("tracking-file-row").hidden = false;
  function says(kind, message) {
    status.textContent = message || "";
    status.classList.toggle("field-ok", kind === "ok" && !!message);
    status.classList.toggle("field-error", kind === "error" && !!message);
  }
  function fill(text, name) {
    var r = readTrackingReceipt(text, electionId);
    if (!r.ok) { says("error", r.message); return; }
    input.value = r.tracking;
    input.classList.add("is-filled");
    field.run();
    says("ok", "Filled from " + (name || "the pasted receipt") + ".");
  }
  function readFile(file) {
    if (file.size > 64 * 1024) { says("error", "That file is too large to be a receipt. A receipt is under 1 KB."); return; }
    file.text().then(function (text) { fill(text, file.name); }, function () { says("error", "Weft Explorer couldn't read that file. Choose the receipt Weft saved, a .json file."); });
  }
  document.getElementById("tracking-choose").addEventListener("click", function () { fileInput.click(); });
  fileInput.addEventListener("change", function () { if (fileInput.files && fileInput.files[0]) readFile(fileInput.files[0]); fileInput.value = ""; });
  input.addEventListener("input", function () { input.classList.remove("is-filled"); });
  form.addEventListener("dragover", function (e) {
    var types = Array.from(e.dataTransfer ? e.dataTransfer.types : []);
    if (types.indexOf("Files") < 0 && types.indexOf("text/plain") < 0) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    form.classList.add("is-dragging");
  });
  form.addEventListener("dragleave", function (e) { if (!form.contains(e.relatedTarget)) form.classList.remove("is-dragging"); });
  form.addEventListener("drop", function (e) {
    e.preventDefault();
    form.classList.remove("is-dragging");
    var files = e.dataTransfer.files;
    if (files && files.length > 1) { says("error", "Drop one receipt at a time."); return; }
    if (files && files.length === 1) { readFile(files[0]); return; }
    var text = e.dataTransfer.getData("text/plain");
    if (text) fill(text, null);
  });
  form.addEventListener("paste", function (e) {
    var text = e.clipboardData ? e.clipboardData.getData("text/plain") : "";
    if (!text || !/^\\s*\\{/.test(text)) return;
    e.preventDefault();
    fill(text, null);
  });
})();
</script>`;
}

/* The ballots ------------------------------------------------------------ */

/** Who submitted a ballot, from its creator's certificate: the common name and the MSP ID, as the transaction pages show a submitter. */
function submitter(b: PrivateBallotRow): Html {
  if (!b.creator) return html`<span class="subtle">not published</span>`;
  let name: string | null = null;
  try {
    name = /(?:^|\n)CN=([^\n]+)/.exec(new X509Certificate(Buffer.from(b.creator.idBytes, "base64")).subject)?.[1] ?? null;
  } catch {
    /* not a certificate: the MSP ID alone */
  }
  return name ? html`<span>${name}</span> <span class="mono subtle">${b.creator.mspId}</span>` : html`<span class="mono">${b.creator.mspId}</span>`;
}

function ballotsSection(v: PrivateElectionView, page: BallotsPage, yours: string | null): Html {
  if (!hasKey(v)) return html``;
  const L = v.options.length;
  const showSubmitter = v.submitters === "show";
  const rows = page.rows.map((b) => {
    const mine = b.txId === yours;
    return html`<tr${mine ? raw(' class="is-yours"') : ""}><td><a class="mono row-link" href="${txUrl(v.channel, b.txId)}"><span data-copy="${b.tracking}" title="${b.tracking}">${cut(b.tracking)}</span></a>${mine ? html` <span class="small ok">yours</span>` : ""}</td>${
      showSubmitter ? html`<td data-label="Submitted by">${submitter(b)}</td>` : ""
    }<td class="mono subtle" data-label="Voter tag">${short(b.voterTag)}</td><td data-label="Block"><a class="mono" href="${blockUrl(v.channel, b.block)}">#${b.block}</a></td><td data-label="Committed">${time(b.timestamp)}</td><td>${
      b.verified ? pill("ok", "proofs verify") : pill("bad", "proofs fail", b.error ?? undefined)
    }</td></tr>`;
  });
  return html`<section class="section-gap" id="ballots" data-live="ballots"><h2>Ballots</h2><p class="lead">Each ballot is ${L} ciphertexts with proofs that it chooses exactly one option. This explorer checked every proof as it read the block. A tracking code is a hash of the ballot and shows nothing about the choice. A voter tag names no one, and anyone with the voter's certificate can work it out for this election.${
    v.submitters === "hide"
      ? " This explorer doesn't show who submitted each ballot, and shows its voter tag, which every proof is bound to."
      : " This explorer shows who submitted each ballot, from the certificate that signed it."
  }</p>
${page.rows.length === 0
  ? html`<p class="empty">No ballots yet. Each ballot appears here once its block is indexed.</p>`
  : html`<table class="table ballots"><thead><tr><th>Tracking code</th>${showSubmitter ? html`<th>Submitted by</th>` : ""}<th>Voter tag</th><th>Block</th><th>Committed</th><th>Proofs</th></tr></thead><tbody>${rows}</tbody></table>`}
${page.newer || page.older ? pager("Pages of ballots", ["Newer ballots", page.newer], ["Older ballots", page.older]) : ""}
</section>`;
}

export function privateElectionPage(site: Site, v: PrivateElectionView, page: BallotsPage, tracking: TrackingLookup | null): string {
  const yours = tracking?.ballot?.txId ?? null;
  return layout(
    site,
    `${v.title}, a private election on ${v.channel}`,
    html`${crumbs(["Overview", "/"], [v.channel, channelUrl(v.channel), true], ["Elections", `${channelUrl(v.channel)}/elections`], v.title)}
<div class="title-row" data-live="title" data-ballots="${v.ballots.total}"><h1>${v.title}</h1>${phasePill(v.phase)}</div>
${banner(v)}
${summary(v)}
${ceremonySection(v)}
${resultSection(v)}
${fullCheckSection(v)}
${trackingSection(v, tracking)}
${ballotsSection(v, page, yours)}`,
    { live: true },
  );
}
