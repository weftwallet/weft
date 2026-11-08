import { describe, expect, it, vi } from "vitest";
import { ExplorerDb } from "./db.ts";
import { decodeBlock } from "./decode.ts";
import { checkBallots, checkCeremony, checkCount, electionFrom, firstRepeat, type PublishedBallot } from "./full-check.ts";
import { goJsonParse, goString } from "./go-utf8.ts";
import { indexBlock } from "./indexer.ts";
import { parsePolicy, publishedChannels, type Policy } from "./policy.ts";
import { checkedOf, electionPage, electionView, parseStateFilter, publishedBallot, stateOf, type Phase, type PrivateElectionSummary, type PrivateRecord } from "./private-elections.ts";
import { privateElectionsSection } from "./private-pages.ts";
import { readTrackingReceipt } from "./receipt.ts";
import { buildServer } from "./server.ts";
import { chain } from "./test/blocks.ts";
import { key, privateElection, type Fixture, type Options } from "./test/private-ballot.ts";

// Each fixture runs a key ceremony and encrypts its ballots, once.
vi.setConfig({ testTimeout: 60_000 });

const CHANNEL = "privatevote-budget-2027";
/** A page's HTML with the template's escapes read back, so sentences can be matched as written. */
const unescaped = (body: string) => body.replace(/&#(\d+);/g, (_, c: string) => String.fromCharCode(Number(c)));
const policyFor = (submitter: "show" | "hide" = "hide", extra: Record<string, unknown> = {}): Policy =>
  parsePolicy({ channels: { [CHANNEL]: { level: "public", values: "show", submitter, privateElections: "private-ballot", ...extra } } });

async function load(f: Fixture, options: { submitter?: "show" | "hide"; experimental?: boolean } = {}) {
  const policy = policyFor(options.submitter);
  const db = new ExplorerDb(":memory:");
  for (const b of f.blocks) await indexBlock(db, policy, decodeBlock(b), { experimental: options.experimental ?? true });
  const app = buildServer({ name: "Org1", channels: publishedChannels(policy), policy, db, status: () => [], experimental: options.experimental ?? true });
  return { db, policy, app };
}

const fixtures = new Map<string, Promise<Fixture>>();
/** Each fixture once: the ceremony and the ballots take a moment to make. */
const fixture = (name: string, o: Options = {}) => {
  if (!fixtures.has(name)) fixtures.set(name, privateElection(o));
  return fixtures.get(name)!;
};
const counted = () => fixture("counted", { until: "counted", choices: [0, 1, 1, 2, 1, 0, 1] });

describe("decoding bytes the way the Go contract does", () => {
  it("keeps valid UTF-8, and replaces each byte of an invalid sequence with one U+FFFD", async () => {
    expect(goString(Buffer.from("Plan B, ünïcode ✓ 🗳️"))).toBe("Plan B, ünïcode ✓ 🗳️");
    // A truncated three-byte sequence: Go replaces each byte, the WHATWG decoder the whole sequence.
    expect(goString(Uint8Array.of(0xe2, 0x82, 0x41))).toBe("��A");
    expect(Buffer.from(Uint8Array.of(0xe2, 0x82, 0x41)).toString("utf8")).toBe("�A");
    // An overlong encoding, a surrogate, a byte that never starts a sequence and a lone continuation byte.
    expect(goString(Uint8Array.of(0xc0, 0xaf))).toBe("��");
    expect(goString(Uint8Array.of(0xed, 0xa0, 0x80))).toBe("���");
    expect(goString(Uint8Array.of(0x61, 0xf5, 0x62, 0x80))).toBe("a�b�");
    expect(goString(Uint8Array.of(0xf0, 0x9f, 0x97))).toBe("���");
    // U+FFFD written out is valid, and stays.
    expect(goString(Buffer.from("�"))).toBe("�");
  });

  it("reads a lone surrogate escape in JSON as U+FFFD, as encoding/json does", async () => {
    expect(goJsonParse('{"title":"a\\ud800b","\\udc00":1}')).toEqual({ title: "a�b", "�": 1 });
    expect(goJsonParse('{"ok":"\\ud83d\\uddf3"}')).toEqual({ ok: "\u{1F5F3}" });
  });

  it("shows a title with bytes that aren't UTF-8 as the endorsing peers read it", async () => {
    const policy = policyFor();
    const db = new ExplorerDb(":memory:");
    const record = (title: Uint8Array) =>
      Buffer.concat([
        Buffer.from('{"v":1,"id":"odd","title":"Budget '),
        Buffer.from(title),
        Buffer.from('","options":["A","B"],"closesAt":"2027-01-31T17:00:00.000Z","creatorMsp":"Org1MSP","trustees":[{"id":"01","msp":"Org1MSP"},{"id":"02","msp":"Org2MSP"}],"threshold":2,"voters":{"kind":"x509","msps":["Org1MSP"]},"state":"keygen"}'),
      ]);
    const blocks = chain(CHANNEL, [
      { txs: [{ txId: "c0", chaincode: "", args: [], config: true }] },
      { txs: [{ txId: "aa01", chaincode: "private-ballot", args: ["CreateElection", Uint8Array.of(0x7b, 0xe2, 0x82, 0x7d)], writes: [{ key: key("election", "odd"), value: record(Uint8Array.of(0xe2, 0x82, 0x41)) }] }] },
    ]);
    for (const b of blocks) await indexBlock(db, policy, decodeBlock(b), { experimental: true });
    expect(electionView(db, policy, CHANNEL, "odd")!.title).toBe("Budget ��A");
  });
});

describe("the policy for private elections", () => {
  it("refuses privateElections with values: hash on the same channel", async () => {
    expect(() => parsePolicy({ channels: { [CHANNEL]: { level: "public", values: "hash", privateElections: "private-ballot" } } })).toThrow(
      `channels.${CHANNEL} has privateElections and values: hash. Private election pages are made from the contract's arguments and writes, which values: hash publishes as hashes only. Set values: show for ${CHANNEL}, or remove privateElections.`,
    );
    // Another channel may hash its values.
    expect(() => parsePolicy({ channels: { [CHANNEL]: { level: "public", privateElections: "private-ballot" }, other: { level: "public", values: "hash" } } })).not.toThrow();
  });

  it("publishes voter tags with submitter: hide, and the submitter's certificate only with submitter: show", async () => {
    const f = await counted();
    const hidden = await load(f, { submitter: "hide" });
    const shown = await load(f, { submitter: "show" });
    const [h] = hidden.db.privateBallots(CHANNEL, f.id);
    const [s] = shown.db.privateBallots(CHANNEL, f.id);
    expect(h!.voterTag).toBe(f.ballots[0]!.voterTag);
    expect(h!.creator).toBeNull();
    expect(s!.creator).toMatchObject({ mspId: "Org1MSP" });
    const api = (await hidden.app.inject(`/api/v1/channels/${CHANNEL}/private-elections/${f.id}/ballots`)).json();
    expect(api.ballots[0]).toMatchObject({ voterTag: f.ballots[0]!.voterTag, tracking: f.ballots[0]!.tracking, verified: true });
    expect(api.ballots[0]).not.toHaveProperty("creator");
    // The transaction itself still hides who submitted it.
    expect((await hidden.app.inject(`/api/v1/channels/${CHANNEL}/transactions/${f.ballots[0]!.txId}`)).json().creator).toBeNull();
  });

  it("indexes and shows nothing private without WEFT_EXPERIMENTAL=1", async () => {
    const f = await counted();
    const { db, app } = await load(f, { experimental: false });
    expect(db.privateElections(CHANNEL)).toEqual([]);
    expect((await app.inject(`/api/v1/channels/${CHANNEL}/private-elections`)).statusCode).toBe(404);
    expect((await app.inject(`/channels/${CHANNEL}/elections/${f.id}`)).statusCode).toBe(404);
    expect((await app.inject("/assets/full-check.js")).statusCode).toBe(404);
    const page = await app.inject(`/channels/${CHANNEL}`);
    expect(page.headers["content-security-policy"]).not.toContain("worker-src");
    expect(page.body).not.toContain("Elections on");
    expect((await app.inject("/api/v1/status")).json().channels[0].publishes).not.toHaveProperty("privateElections");
  });
});

describe("indexing a private election", () => {
  it("follows it from the key ceremony to the count, and checks every step as it reads it", async () => {
    const f = await counted();
    const { db, policy } = await load(f);
    const v = electionView(db, policy, CHANNEL, f.id)!;
    expect(v).toMatchObject({ state: "counted", phase: "counted", recordBallots: 7, fingerprintMatches: true, ballots: { total: 7, failed: 0 } });
    expect(v.tally).toEqual({ counts: f.counts, total: 7 });
    for (const t of v.trustees) {
      expect([t.round1?.verified, t.round2?.verified, t.confirmation?.verified, t.share?.verified]).toEqual([true, true, true, true]);
      expect(t.closeRequest).not.toBeNull();
    }
    expect(v.opened?.verified).toBe(true);
    expect(v.published?.verified).toBe(true);
    // Closed before closesAt (2027) by the closing transaction's timestamp.
    expect(v.closed).toMatchObject({ early: true, closedBy: ["Org1MSP", "Org2MSP"], verified: true });
    const rows = db.privateBallots(CHANNEL, f.id);
    expect(rows.map((b) => b.tracking)).toEqual(f.ballots.map((b) => b.tracking));
    expect(rows.every((b) => b.verified)).toBe(true);
  });

  it("records a ballot whose proofs fail, with the contract's message", async () => {
    const f = await fixture("tampered", { until: "open", choices: [0, 1, 2, 1], tamper: { ballot: 2, option: 2 } });
    const { db } = await load(f);
    const rows = db.privateBallots(CHANNEL, f.id);
    expect(rows.map((b) => b.verified)).toEqual([true, true, false, true]);
    expect(rows[2]!.error).toBe("Ciphertext 2 is not a 0 or a 1.");
    expect(db.privateBallotCount(CHANNEL, f.id)).toEqual({ total: 4, failed: 1 });
  });

  const phases: [Options["until"], string, string | undefined][] = [
    ["round1", "round1", undefined],
    ["round2", "round2", undefined],
    ["round3", "round3", undefined],
    ["opening", "opening", undefined],
    ["open", "open", undefined],
    ["open", "late", "2025-01-31T17:00:00.000Z"],
    ["closeRequested", "open", undefined],
    ["counting", "counting", undefined],
    ["failed", "failed", undefined],
    ["cancelled", "cancelled", undefined],
  ];
  for (const [until, phase, closesAt] of phases) {
    it(`works out the ${phase} state${until === "closeRequested" ? " with a close requested" : ""}`, async () => {
      const f = await fixture(`${until}-${closesAt}`, { until, ...(closesAt ? { closesAt } : {}), choices: [0, 1, 2] });
      const { db, policy } = await load(f);
      const v = electionView(db, policy, CHANNEL, f.id)!;
      expect(v.phase).toBe(phase);
      if (until === "failed") expect(v.failed).toMatchObject({ reportedBy: "Org2MSP", fromTrustee: "Org1MSP" });
      if (until === "closeRequested") expect(v.trustees.map((t) => !!t.closeRequest)).toEqual([true, false]);
      if (until === "counting") expect(v.trustees.map((t) => !!t.share)).toEqual([true, false]);
    });
  }
});

describe("the full check's code, in Node", () => {
  it("passes a whole election, from published data only", async () => {
    const f = await counted();
    const { db, policy } = await load(f);
    const v = electionView(db, policy, CHANNEL, f.id)!;
    const e = checkedOf(db.privateElection(CHANNEL, f.id)!.record as unknown as PrivateRecord, CHANNEL, "private-ballot");
    expect(checkCeremony(e, v.trustees.map((t) => ({ round1: t.round1?.body, round2: t.round2?.body, confirmation: t.confirmation?.body })))).toBeNull();
    const election = electionFrom(e)!;
    const ballots = db.privateBallots(CHANNEL, f.id).map((b, i) => publishedBallot(b, i) as unknown as PublishedBallot);
    expect(checkBallots(election, ballots)).toEqual({ done: 7, failure: null });
    expect(firstRepeat(ballots)).toBeNull();
    const count = {
      ciphertexts: ballots.map((b) => (b.ballot as { ciphertexts: { a: string; b: string }[] }).ciphertexts),
      recordBallots: v.recordBallots,
      totals: v.totals,
      shares: v.trustees.map((t, index) => ({ index, share: t.share!.body })),
      counts: v.tally!.counts,
    };
    expect(checkCount(election, count)).toEqual({ totals: null, shares: null, tally: null });
    expect(checkCount(election, { ...count, counts: [7, 0, 0] }).tally).toBe("The published counts aren't the ones the decryption shares give.");
    expect(checkCount(election, { ...count, ciphertexts: count.ciphertexts.slice(1) }).totals).toBe("The record says 7 ballots were counted, and 6 are published.");
    const swapped = [count.totals![1]!, count.totals![0]!, count.totals![2]!];
    expect(checkCount(election, { ...count, totals: swapped }).totals).toBe("The totals on the ledger aren't the sum of the 7 ballots.");
  });

  it("stops at the first ballot that fails, and finds repeats across ballots", async () => {
    const f = await fixture("tampered", { until: "open", choices: [0, 1, 2, 1], tamper: { ballot: 2, option: 2 } });
    const { db } = await load(f);
    const e = electionFrom(checkedOf(db.privateElection(CHANNEL, f.id)!.record as unknown as PrivateRecord, CHANNEL, "private-ballot"))!;
    const ballots = db.privateBallots(CHANNEL, f.id).map((b, i) => publishedBallot(b, i) as unknown as PublishedBallot);
    expect(checkBallots(e, ballots).failure).toMatchObject({ index: 2, txId: f.ballots[2]!.txId, message: "Ciphertext 2 is not a 0 or a 1." });
    // Published data changed after the fact: another voter tag, a tracking code, a copied ballot.
    const good = ballots.filter((b) => b.index !== 2);
    expect(checkBallots(e, [{ ...good[0]!, voterTag: good[1]!.voterTag }]).failure?.message).toBe("Ciphertext 0 is not a 0 or a 1.");
    expect(checkBallots(e, [{ ...good[0]!, tracking: good[1]!.tracking }]).failure?.message).toBe("Its tracking code isn't the one the ballot gives.");
    expect(firstRepeat([good[0]!, { ...good[1]!, index: 1, voterTag: good[0]!.voterTag }])).toEqual({ index: 1, message: "This identity has already voted in this election." });
    expect(firstRepeat([good[0]!, { ...good[0]!, index: 1, voterTag: "ff".repeat(32) }])).toEqual({ index: 1, message: "A ciphertext in this ballot is already on the ledger." });
  });

  it("works each voter tag out again from the submitter's certificate, when it is published", async () => {
    const f = await counted();
    const { db } = await load(f, { submitter: "show" });
    const e = electionFrom(checkedOf(db.privateElection(CHANNEL, f.id)!.record as unknown as PrivateRecord, CHANNEL, "private-ballot"))!;
    const [a, b] = db.privateBallots(CHANNEL, f.id).map((r, i) => publishedBallot(r, i) as unknown as PublishedBallot);
    expect(checkBallots(e, [a!, b!]).failure).toBeNull();
    expect(checkBallots(e, [{ ...a!, creator: b!.creator! }]).failure?.message).toBe("Its voter tag isn't the one its submitter's certificate gives.");
  });

  it("names a ceremony post that doesn't verify", async () => {
    const f = await counted();
    const { db, policy } = await load(f);
    const v = electionView(db, policy, CHANNEL, f.id)!;
    const e = checkedOf(db.privateElection(CHANNEL, f.id)!.record as unknown as PrivateRecord, CHANNEL, "private-ballot");
    const posts = v.trustees.map((t) => ({ round1: t.round1?.body, round2: t.round2?.body, confirmation: t.confirmation?.body }));
    const r1 = posts[1]!.round1 as { proof: string };
    const other = (posts[0]!.round1 as { proof: string }).proof;
    // Org2MSP's R with Org1MSP's z.
    const changed = posts.map((p, i) => (i === 1 ? { ...p, round1: { ...r1, proof: r1.proof.slice(0, 64) + other.slice(64) } } : p));
    expect(checkCeremony(e, changed)).toBe("The proof of knowledge from Org2MSP doesn't verify.");
    expect(checkCeremony({ ...e, fingerprint: "00".repeat(10) }, posts)).toBe("The election fingerprint on the ledger isn't the one its record gives.");
    expect(checkCeremony(e, [posts[0]!, { ...posts[1]!, confirmation: null }])).toBe("The confirmation from Org2MSP isn't on the ledger.");
  });
});

describe("the private election pages", () => {
  const page = async (f: Fixture, path = "", submitter: "show" | "hide" = "hide") => {
    const { app } = await load(f, { submitter });
    const res = await app.inject(`/channels/${CHANNEL}/elections/${f.id}${path}`);
    expect(res.statusCode).toBe(200);
    return { headers: res.headers, body: unescaped(res.body) };
  };

  it("shows a counted election: the fingerprint, the ceremony, the totals with each trustee's share, the check and the ballots", async () => {
    const f = await counted();
    const res = await page(f);
    const body = res.body;
    expect(res.headers["content-security-policy"]).toContain("worker-src 'self'");
    expect(body).toContain('<span class="pill pill--ok">counted</span>');
    expect(body).toContain("A private election. Experimental: no one outside the project has reviewed its cryptography.");
    const v = (await (await load(f)).app.inject(`/api/v1/channels/${CHANNEL}/private-elections/${f.id}`)).json();
    const fp = v.fingerprint as string;
    expect(body).toContain(`data-copy="${fp}">${fp.match(/.{4}/g)!.map((g) => `<span>${g}</span>`).join("")}</span>`);
    expect(body).toContain("Worked out here from the election's record. Weft shows the same before each vote.");
    expect(body).toContain("Complete. The key and both verifying shares follow from the round 1 commitments, and every trustee proved it holds its share.");
    expect(body).toContain("The counts add up to the 7 ballots, and both decryption shares verify.");
    expect(body).toContain('<span class="pill pill--ok">3 of 3 verify</span>');
    expect(body).toContain("The tally combines the shares of Org1MSP and Org2MSP.");
    expect(body).toContain('id="xcheck-run">Check every ballot</button>');
    expect(body).toContain("This explorer hides submitters, so its own server checks that each tag belongs to its submitter.");
    expect(body.match(/<span class="pill pill--ok">proofs verify<\/span>/g)).toHaveLength(7);
    expect(body).toContain(f.ballots[0]!.voterTag.slice(0, 8));
    // Voting closed early: the closing block beside the planned closing time.
    expect(body).toMatch(/<dt>Voting closed<\/dt><dd>In block <a class="mono" href="[^"]+">#\d+<\/a>, <time[^>]+>[^<]+<\/time>, by Org1MSP and Org2MSP\.<div class="small warn-text">Before its planned closing time, <time datetime="2027-01-31T17:00:00.000Z"/);
    expect(body).not.toMatch(/[–—]/);
  });

  it("shows the reporter of a failed election, and a cancelled one", async () => {
    const failed = (await page(await fixture("failed-undefined", { until: "failed", choices: [0, 1, 2] }))).body;
    expect(failed).toContain("The key ceremony failed. Org2MSP reported that the share it received from Org1MSP doesn't match Org1MSP's commitments.");
    expect(failed).toContain('<span class="pill pill--bad">reported a bad share</span>');
    expect(failed).toContain("Stopped in round 3. The election can't open.");
    expect(failed).not.toContain("Check every ballot");
    const cancelled = (await page(await fixture("cancelled-undefined", { until: "cancelled", choices: [0, 1, 2] }))).body;
    expect(cancelled).toContain("Org1MSP cancelled this election during the key ceremony.");
    expect(cancelled).toContain("Cancelled by Org1MSP in round 2.");
  });

  it("shows each round of the key ceremony, an open election and one past its planned closing time", async () => {
    expect((await page(await fixture("round1-undefined", { until: "round1", choices: [0, 1, 2] }))).body).toContain("Waiting for Org2MSP to post round 1.");
    expect((await page(await fixture("round2-undefined", { until: "round2", choices: [0, 1, 2] }))).body).toContain("Waiting for Org2MSP to post round 2: an encrypted share for each other trustee.");
    expect((await page(await fixture("round3-undefined", { until: "round3", choices: [0, 1, 2] }))).body).toContain("Waiting for Org2MSP to confirm that it holds its key share.");
    const round1 = (await page(await fixture("round1-undefined", { until: "round1", choices: [0, 1, 2] }))).body;
    expect(round1).toContain("Not made yet. It follows from the trustees' round 1 commitments once all three rounds are done.");
    const open = (await page(await fixture("open-undefined", { until: "open", choices: [0, 1, 2] }))).body;
    expect(open).toContain('<span class="pill pill--quiet">open</span>');
    expect(open).toContain("The ballots are added up when 2 of the trustees close voting, and the trustees then decrypt only the totals.");
    const late = (await page(await fixture("open-2025-01-31T17:00:00.000Z", { until: "open", closesAt: "2025-01-31T17:00:00.000Z", choices: [0, 1, 2] }))).body;
    expect(late).toContain('<span class="pill pill--warn">open, past its planned closing time</span>');
    expect(late).toContain("Past its planned closing time. The trustees haven't closed it, so it still accepts ballots.");
    const asked = (await page(await fixture("closeRequested-undefined", { until: "closeRequested", choices: [0, 1, 2] }))).body;
    expect(asked).toContain("Org1MSP has asked to close voting. It closes when 2 of 2 trustees have asked.");
    const counting = (await page(await fixture("counting-undefined", { until: "counting", choices: [0, 1, 2] }))).body;
    expect(counting).toContain('<span class="pill pill--warn">counting</span>');
    expect(counting).toContain("Waiting for 1 more decryption share. The tally needs 2 of 2.");
  });

  it("has the checks hidden during the key ceremony, so they appear once the election opens without a reload", async () => {
    const round2 = (await page(await fixture("round2-undefined", { until: "round2", choices: [0, 1, 2] }))).body;
    expect(round2).toContain('<section class="section-gap" id="check" data-show="check" hidden>');
    expect(round2).toContain('<section class="section-gap" id="receipt" data-show="receipt" hidden>');
    expect(round2).toContain('data-live="title" data-ballots="0"');
    const open = (await page(await fixture("open-undefined", { until: "open", choices: [0, 1, 2] }))).body;
    expect(open).toContain('<section class="section-gap" id="check" data-show="check">');
    expect(open).toContain('<section class="section-gap" id="receipt" data-show="receipt">');
    expect(open).toContain('data-live="title" data-ballots="3"');
    // A failed election never opens, so it has neither.
    const failed = (await page(await fixture("failed-undefined", { until: "failed", choices: [0, 1, 2] }))).body;
    expect(failed).not.toContain('data-show="check"');
    expect(failed).not.toContain('data-show="receipt"');
  });

  it("shows who submitted each ballot only when the policy shows submitters", async () => {
    const f = await counted();
    const shown = (await page(f, "", "show")).body;
    expect(shown).toContain("<th>Tracking code</th><th>Submitted by</th><th>Voter tag</th>");
    // The common name, which is the enrolment ID the voter tag is made from, and the MSP ID.
    expect(shown.match(/<td data-label="Submitted by"><span>voter\d+<\/span> <span class="mono subtle">Org1MSP<\/span><\/td>/g)?.length).toBeGreaterThan(0);
    expect(shown).toContain("This explorer shows who submitted each ballot, from the certificate that signed it.");
    const hidden = (await page(f)).body;
    expect(hidden).not.toContain("Submitted by");
    expect(hidden).toContain("This explorer doesn't show who submitted each ballot");
  });

  it("checks a tracking code from Weft's link, and lands on that ballot", async () => {
    const f = await counted();
    const b = f.ballots[3]!;
    const found = (await page(f, `?tracking=${b.tracking}`)).body;
    expect(found).toContain(`Your ballot is in block #`);
    expect(found).toContain("and its proofs verify.</p><p>It's one of the 7 ballots in the totals, and in the published count.");
    expect(found).toContain(`<tr class="is-yours"><td><a class="mono row-link" href="/channels/${CHANNEL}/transactions/${b.txId}">`);
    expect(found).toContain(`value="${b.tracking}"`);
    const missing = (await page(f, `?tracking=${"0f".repeat(32)}`)).body;
    expect(missing).toContain("No ballot in this election has that tracking code.");
    expect(missing).not.toContain("is-yours");
    const malformed = (await page(f, "?tracking=f9ffddda4e82")).body;
    expect(malformed).toContain('<p class="field__status field-error" id="tracking-error">A tracking code is 64 characters, 0 to 9 and a to f.</p>');
    expect(malformed).toContain('aria-invalid="true" aria-describedby="tracking-error"');
    // A transaction ID finds the ballot too.
    expect((await page(f, `?tracking=${b.txId}`)).body).toContain('<tr class="is-yours">');
  });

  it("pages the ballots, and opens the page with the voter's ballot on it", async () => {
    const choices = Array.from({ length: 56 }, (_, i) => i % 3);
    const f = await fixture("many", { until: "open", choices, perBlock: 10 });
    const first = (await page(f)).body;
    expect(first.match(/class="mono row-link"/g)).toHaveLength(50);
    const older = /<a href="([^"]+)">Older ballots<\/a>/.exec(first)![1]!.replace(/&#38;/g, "&");
    const second = unescaped((await (await load(f)).app.inject(older)).body);
    expect(second.match(/class="mono row-link"/g)).toHaveLength(6);
    expect(second).toMatch(/<a href="[^"]+#ballots">Newer ballots<\/a>/);
    // The oldest ballot is on the second page: Weft's link opens that page.
    const b = f.ballots[0]!;
    const mine = (await page(f, `?tracking=${b.tracking}`)).body;
    expect(mine).toContain(`<tr class="is-yours"><td><a class="mono row-link" href="/channels/${CHANNEL}/transactions/${b.txId}">`);
    expect(mine).toMatch(/<a href="[^"]+#ballots">Newer ballots<\/a>/);
  });

  it("lists a channel's private elections", async () => {
    const f = await counted();
    const { app } = await load(f);
    const list = unescaped((await app.inject(`/channels/${CHANNEL}/elections`)).body);
    expect(list).toContain("Private elections, on the private-ballot contract.");
    expect(list).toContain(`<a class="row-link" href="/channels/${CHANNEL}/elections/${f.id}">Budget 2027</a>`);
    expect(list).toContain('<span class="pill pill--ok">counted</span>');
    expect(unescaped((await app.inject(`/channels/${CHANNEL}`)).body)).toContain("encrypted ballots, the key ceremony, the count and a check of every proof");
  });
});

describe("the private election API", () => {
  it("serves the election, its ballots a page at a time, tracking codes and the worker", async () => {
    const f = await counted();
    const { app } = await load(f);
    const list = (await app.inject(`/api/v1/channels/${CHANNEL}/private-elections`)).json();
    expect(list).toMatchObject({ total: 1, offset: 0, limit: 20, state: null, counts: { all: 1, counted: 1, open: 0 } });
    expect(list.elections).toEqual([expect.objectContaining({ id: f.id, phase: "counted", ballots: 7 })]);
    // A state filter, in the API and on the page.
    expect((await app.inject(`/api/v1/channels/${CHANNEL}/private-elections?state=open`)).json()).toMatchObject({ total: 0, state: "open", elections: [], counts: { all: 1 } });
    expect((await app.inject(`/api/v1/channels/${CHANNEL}/private-elections?state=counted&limit=500`)).json()).toMatchObject({ total: 1, limit: 100 });
    const bad = await app.inject(`/api/v1/channels/${CHANNEL}/private-elections?state=closed`);
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe("There's no state closed. Give one of ceremony, open, counting, counted and ended, or leave state out for every election.");
    const open = unescaped((await app.inject(`/channels/${CHANNEL}/elections?state=open`)).body);
    expect(open).toContain(`No elections on ${CHANNEL} are open now.`);
    expect(open).toMatch(/<a href="\/channels\/privatevote-budget-2027\/elections\?state=open" aria-current="page">Open <span class="filters__count">0<\/span><\/a>/);
    expect(open).toContain(`<title>Elections on ${CHANNEL}, open`);
    const all = unescaped((await app.inject(`/channels/${CHANNEL}/elections`)).body);
    expect(all).toMatch(/aria-current="page">All <span class="filters__count">1<\/span>/);
    expect(all).toContain(`href="/channels/${CHANNEL}/elections?state=counted">Counted <span class="filters__count">1</span>`);
    // Only the states that have an election are offered, besides All.
    expect(all).not.toContain("?state=ceremony");
    const v = (await app.inject(`/api/v1/channels/${CHANNEL}/private-elections/${f.id}`)).json();
    expect(v).toMatchObject({ id: f.id, contract: "private-ballot", state: "counted", submitters: "hide", tally: { counts: f.counts } });
    expect(v.trustees[0].round1.body.commitments).toHaveLength(2);
    const page = (await app.inject(`/api/v1/channels/${CHANNEL}/private-elections/${f.id}/ballots?offset=5&limit=10`)).json();
    expect(page).toMatchObject({ total: 7, offset: 5 });
    expect(page.ballots.map((b: { index: number }) => b.index)).toEqual([5, 6]);
    expect(page.ballots[0].ballot.ciphertexts).toHaveLength(3);
    const t = (await app.inject(`/api/v1/channels/${CHANNEL}/private-elections/${f.id}/tracking/${f.ballots[1]!.tracking}`)).json();
    expect(t).toMatchObject({ found: true, inTotals: true, counted: true, ballot: { txId: f.ballots[1]!.txId } });
    expect((await app.inject(`/api/v1/channels/${CHANNEL}/private-elections/${f.id}/tracking/${"0f".repeat(32)}`)).json()).toEqual({ found: false });
    expect((await app.inject(`/api/v1/channels/${CHANNEL}/private-elections/nope`)).statusCode).toBe(404);
    expect((await app.inject("/api/v1/status")).json().channels[0].publishes).toMatchObject({ privateElections: true, voterTags: true });
  });
});

describe("the elections list's pages and state filter", () => {
  const summary = (i: number, phase: Phase): PrivateElectionSummary => ({ id: `e${i}`, title: `E ${i}`, closesAt: "2027-01-31T17:00:00.000Z", state: "open", phase, ballots: i, fingerprint: null, anonymous: false });
  const phases: Phase[] = ["round1", "round2", "round3", "opening", "open", "late", "counting", "counted", "failed", "cancelled"];
  const list = Array.from({ length: 45 }, (_, i) => summary(i, phases[i % phases.length]!));

  it("groups each phase in one state", () => {
    expect(phases.map(stateOf)).toEqual(["ceremony", "ceremony", "ceremony", "ceremony", "open", "open", "counting", "counted", "ended", "ended"]);
    expect(parseStateFilter(undefined)).toBeNull();
    expect(parseStateFilter("all")).toBeNull();
    expect(parseStateFilter("open")).toBe("open");
    expect(parseStateFilter("closed")).toBeUndefined();
  });

  it("pages newest first, counts every state, and filters before paging", () => {
    const first = electionPage(list, { limit: 20 });
    expect(first).toMatchObject({ total: 45, offset: 0, limit: 20, state: null, counts: { all: 45, ceremony: 20, open: 9, counting: 4, counted: 4, ended: 8 } });
    expect(first.elections.map((e) => e.id).slice(0, 2)).toEqual(["e0", "e1"]);
    expect(electionPage(list, { offset: 40, limit: 20 }).elections).toHaveLength(5);
    const open = electionPage(list, { state: "open", limit: 4 });
    expect(open.total).toBe(9);
    expect(open.elections.map((e) => e.phase)).toEqual(["open", "late", "open", "late"]);
    expect(electionPage(list, { state: "open", offset: 8, limit: 4 }).elections).toHaveLength(1);
  });

  it("links the pages, keeping the filter, and says when a page or a state is empty", () => {
    const body = (page: ReturnType<typeof electionPage>) => unescaped(String(privateElectionsSection(CHANNEL, page)));
    const middle = body(electionPage(list, { state: "ceremony", offset: 4, limit: 4 }));
    expect(middle).toContain(`href="/channels/${CHANNEL}/elections?state=ceremony">Newer elections</a>`);
    expect(middle).toContain(`href="/channels/${CHANNEL}/elections?state=ceremony&page=3">Older elections</a>`);
    expect(body(electionPage(list, { offset: 0, limit: 20 }))).toContain(`<a class="pager__none" role="link" aria-disabled="true">Newer elections</a>`);
    expect(body(electionPage(list, { offset: 100, limit: 20 }))).toContain("There's no page 6 of these elections.");
    expect(body(electionPage([], {}))).toContain(`No private elections on ${CHANNEL} yet.`);
    expect(body(electionPage([], {}))).not.toContain("filters");
  });
});

describe("reading a version 2 receipt", () => {
  const receipt = { type: "weft-ballot-receipt", version: 2, channel: CHANNEL, electionId: "budget-2027", txId: "ab".repeat(32), blockNumber: 41, tracking: "cd".repeat(32) };
  it("fills the tracking code, and says why it can't", async () => {
    expect(readTrackingReceipt(JSON.stringify(receipt), "budget-2027")).toEqual({ ok: true, tracking: "cd".repeat(32) });
    expect(readTrackingReceipt(JSON.stringify({ ...receipt, version: 1, commitment: "x" }), "budget-2027")).toEqual({
      ok: false,
      message: "That's a version 1 receipt, for an election on the ballot contract. This election's receipts are version 2 and carry a tracking code.",
    });
    expect(readTrackingReceipt(JSON.stringify({ ...receipt, electionId: "budget-2029" }), "budget-2027")).toEqual({ ok: false, message: "That receipt is for budget-2029, not this election. Open budget-2029's page to check it." });
    expect(readTrackingReceipt(JSON.stringify({ ...receipt, tracking: "abc" }), "budget-2027").ok).toBe(false);
    expect(readTrackingReceipt("not json", "budget-2027")).toEqual({ ok: false, message: "Weft Explorer couldn't read that file. Choose the receipt Weft saved, a .json file." });
  });
});
