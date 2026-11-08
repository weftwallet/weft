/**
 * Anonymous ballots (docs/adr/0008), from real blocks: chair-2029 on
 * privatevote-chair-2029, recorded from a local Fabric 2.5 network with the
 * private-ballot contract, where voter credentials of ChairVoters2029MSP
 * cast 5 ballots through Weft Experimental's signer and the trustees
 * counted them (test/fixtures/privatevote-chair-2029.blocks.gz, blocks 0 to
 * 21). The forged ballots are those blocks changed here; the repeated
 * pseudonym is a second ballot that the idemix module made for a
 * credential that voted in block 12 (test/fixtures/chair-2029-second-ballot.json).
 *
 * The idemix module checks each ballot's creator and pseudonym proof, as
 * the indexer does in Node and the browser's full check does in a worker.
 * Without the module built (it needs Go), these tests skip and say why.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { common } from "@hyperledger/fabric-protos";
import { PINNED, type IdemixSync } from "@weftwallet/idemix";
import { DIST_WASM, startIdemixNode } from "@weftwallet/idemix/node";
import { beforeAll, describe, expect, it } from "vitest";
import { ExplorerDb } from "./db.ts";
import { decodeBlock, idemixCreator, type DecodedBlock, type DecodedTransaction } from "./decode.ts";
import { checkBallots, checkPseudonyms, electionFrom, firstRepeat, type PublishedBallot } from "./full-check.ts";
import { goString } from "./go-utf8.ts";
import { indexBlock } from "./indexer.ts";
import { parsePolicy, publishedChannels, type Policy } from "./policy.ts";
import { checkedOf, electionView, indexStats, resetIndexStats, type PrivateRecord } from "./private-elections.ts";
import { buildServer } from "./server.ts";

const CHANNEL = "privatevote-chair-2029";
const ID = "chair-2029";
const VOTERS = "ChairVoters2029MSP";
const fixtures = new URL("./test/fixtures/", import.meta.url);

const built = existsSync(join(DIST_WASM, "weft-idemix.wasm"));
const skip = built ? false : "The idemix module isn't built (pnpm --filter @weftwallet/idemix build:wasm, which needs Go).";

/** The recorded blocks, decoded afresh for each test so one can change them. */
function blocks(): DecodedBlock[] {
  const raw = gunzipSync(readFileSync(new URL("privatevote-chair-2029.blocks.gz", fixtures)));
  const out: DecodedBlock[] = [];
  for (let o = 0; o < raw.length; ) {
    const n = raw.readUInt32BE(o);
    out.push(decodeBlock(common.Block.deserializeBinary(raw.subarray(o + 4, o + 4 + n))));
    o += 4 + n;
  }
  return out;
}

const unescaped = (body: string) => body.replace(/&#(\d+);/g, (_, c: string) => String.fromCharCode(Number(c)));
const policyFor = (submitter: "show" | "hide"): Policy =>
  parsePolicy({ channels: { [CHANNEL]: { level: "public", values: "show", submitter, privateElections: "private-ballot" } } });

function load(list: DecodedBlock[], idemix: IdemixSync | null, submitter: "show" | "hide" = "show") {
  const policy = policyFor(submitter);
  const db = new ExplorerDb(":memory:");
  for (const b of list) indexBlock(db, policy, b, { experimental: true, idemix });
  const app = buildServer({ name: "Org1", channels: publishedChannels(policy), policy, db, status: () => [], experimental: true, idemixDir: DIST_WASM });
  return { db, policy, app };
}

/** A ballot transaction's pseudonymJson, changed by `change`, in its argument and in the ballot the contract stored. */
function changeProof(tx: DecodedTransaction, change: (p: Record<string, string>) => void): void {
  const p = JSON.parse(goString(tx.args[2]!)) as Record<string, string>;
  change(p);
  tx.args[2] = Buffer.from(JSON.stringify(p));
  const w = tx.writes.find((x) => x.key.startsWith("\u0000ballot\u0000"))!;
  const stored = JSON.parse(goString(w.value)) as { pseudonym: Record<string, string> };
  stored.pseudonym = p;
  w.value = Buffer.from(JSON.stringify(stored));
}

describe.skipIf(skip)("anonymous ballots from real blocks", () => {
  let idemix: IdemixSync;
  beforeAll(async () => {
    idemix = (await startIdemixNode()).sync;
  });

  it("indexes each anonymous ballot with its pseudonym as the voter tag, and checks its creator and pseudonym proof", () => {
    resetIndexStats();
    const { db, policy } = load(blocks(), idemix);
    const v = electionView(db, policy, CHANNEL, ID)!;
    expect(v.phase).toBe("counted");
    expect(v.ballots).toEqual({ total: 5, failed: 0 });
    expect(v.anonymous).toMatchObject({ msp: VOTERS, affiliation: "voters", role: "member", hashMatchesKey: true });
    expect(v.anonymous!.channelKeyHash).toBe(v.anonymous!.issuerKeyHash);
    expect(v.tally!.total).toBe(5);
    expect(v.published?.verified).toBe(true);
    const ballots = db.privateBallots(CHANNEL, ID);
    for (const b of ballots) {
      expect(b.error).toBeNull();
      expect(b.creator).toBeNull();
      expect(b.anonymous!.creator).toMatchObject({ mspId: VOTERS, ou: "voters", role: "member" });
      expect(b.anonymous!.pseudonym.pseudonym).toMatch(/^[0-9a-f]{128}$/);
    }
    // Five credentials, five pseudonyms, and five one-off Nyms.
    expect(new Set(ballots.map((b) => b.voterTag)).size).toBe(5);
    expect(new Set(ballots.map((b) => b.anonymous!.creator.nym)).size).toBe(5);
    const s = indexStats();
    expect(s.anonymous).toBe(5);
    console.log(`Index time per anonymous ballot: ${(s.ms / s.ballots).toFixed(0)} ms in all, ${(s.anonymousMs / s.anonymous).toFixed(0)} ms of it the creator and the pseudonym proof.`);
  });

  it("refuses a forged pseudonym proof, another ballot's creator, and a changed creator proof", () => {
    const cases: [string, (list: DecodedBlock[]) => void, string][] = [
      [
        "a changed sr",
        (list) => changeProof(list[13]!.transactions[0]!, (p) => (p.sr = JSON.parse(goString(list[14]!.transactions[0]!.args[2]!)).sr)),
        "The pseudonym proof is not valid.",
      ],
      [
        "another ballot's one-off identity",
        (list) => (list[13]!.transactions[0]!.creator = list[14]!.transactions[0]!.creator),
        "The pseudonym proof is not valid.",
      ],
      [
        "a changed identity proof",
        (list) => {
          const c = list[13]!.transactions[0]!.creator!;
          const bytes = Uint8Array.from(c.idBytes);
          bytes[Math.floor(bytes.length / 2)]! ^= 1;
          c.idBytes = bytes;
        },
        "The one-off identity's proof isn't valid for the election's issuer key.",
      ],
    ];
    for (const [name, change, message] of cases) {
      const list = blocks();
      change(list);
      const { db } = load(list, idemix);
      const bad = db.privateBallots(CHANNEL, ID).find((b) => b.block === 13)!;
      expect(bad.verified, name).toBe(false);
      expect(bad.error, name).toBe(message);
      expect(db.privateBallots(CHANNEL, ID).filter((b) => !b.verified)).toHaveLength(1);
    }
  });

  it("flags a second ballot from one credential with the credential's message", () => {
    const second = JSON.parse(readFileSync(new URL("chair-2029-second-ballot.json", fixtures), "utf8")) as {
      txId: string;
      creator: { mspId: string; idBytes: string };
      voterTag: string;
      tracking: string;
      ballotJson: string;
      pseudonymJson: string;
    };
    const list = blocks();
    // The second ballot in a block of its own, as the 6th ballot, before voting closes.
    const template = list[16]!;
    const tx = structuredClone(template.transactions[0]!);
    const key = (...parts: string[]) => `\u0000${parts.join("\u0000")}\u0000`;
    const ballot = JSON.parse(second.ballotJson) as { ciphertexts: { a: string }[] };
    tx.txId = second.txId;
    tx.args = [Buffer.from(ID), Buffer.from(second.ballotJson), Buffer.from(second.pseudonymJson)];
    const bytes = Buffer.from(second.creator.idBytes, "base64");
    // The creator as decode.ts reads it from id_bytes.
    tx.creator = { ...tx.creator!, idBytes: bytes, idemix: idemixCreator(bytes)! };
    tx.writes = [
      { namespace: "private-ballot", key: key("ballot", ID, second.txId), isDelete: false, value: Buffer.from(JSON.stringify({ tracking: second.tracking, ballot: { v: "1", ...ballot }, pseudonym: JSON.parse(second.pseudonymJson) })) },
      ...ballot.ciphertexts.map((c) => ({ namespace: "private-ballot", key: key("ciphertext", ID, c.a), isDelete: false, value: Buffer.from(second.txId) })),
      { namespace: "private-ballot", key: key("voted", ID, second.voterTag), isDelete: false, value: Buffer.from(second.txId) },
    ];
    const extra: DecodedBlock = { ...template, number: 17, transactions: [tx] };
    const { db } = load([...list.slice(0, 17), extra], idemix);
    const rows = db.privateBallots(CHANNEL, ID);
    expect(rows).toHaveLength(6);
    const repeat = rows.find((b) => b.txId === second.txId)!;
    expect(repeat.voterTag).toBe(rows[0]!.voterTag);
    expect(repeat.verified).toBe(false);
    expect(repeat.error).toBe("This credential has already voted in this election.");
    expect(firstRepeat(rows.map((b, i) => ({ ...b, index: i, ballot: { ciphertexts: [] } })), "idemix")).toEqual({ index: 5, message: "This credential has already voted in this election." });
  });

  it("records each anonymous ballot as unchecked, and says why, without the module", () => {
    const { db } = load(blocks(), null);
    const rows = db.privateBallots(CHANNEL, ID);
    expect(rows).toHaveLength(5);
    for (const b of rows) expect(b.error).toBe("This explorer couldn't start the idemix module, so it can't check this ballot's creator or pseudonym.");
  });

  it("runs the browser's full check of anonymous ballots in Node: ballot proofs from each pseudonym, then each identity and pseudonym proof", async () => {
    const { db, policy, app } = load(blocks(), idemix, "hide");
    const row = db.privateElection(CHANNEL, ID)!;
    const checked = checkedOf(row.record as unknown as PrivateRecord, CHANNEL, "private-ballot");
    const e = electionFrom(checked)!;
    const api = (await app.inject(`/api/v1/channels/${CHANNEL}/private-elections/${ID}/ballots`)).json() as { ballots: PublishedBallot[] };
    expect(api.ballots).toHaveLength(5);
    // D12: published where submitters are hidden, and naming no one.
    for (const b of api.ballots) {
      expect(b.creator).toBeUndefined();
      expect(b.anonymousCreator).toMatchObject({ mspId: VOTERS, ou: "voters", role: "member" });
      expect(b.pseudonym?.pseudonym).toMatch(/^[0-9a-f]{128}$/);
    }
    expect(JSON.stringify(api)).not.toMatch(/voter[1-5]/);
    expect(checkBallots(e, api.ballots, undefined, checked.anonymous!)).toEqual({ done: 5, failure: null });
    const t = performance.now();
    expect(checkPseudonyms(idemix, checked, checked.anonymous!, api.ballots)).toEqual({ done: 5, failure: null });
    console.log(`The full check's pseudonym step in Node: ${((performance.now() - t) / 5).toFixed(0)} ms per ballot.`);
    // A pseudonym proof from another ballot, and a tag that isn't its pseudonym's.
    const swapped = api.ballots.map((b, i) => (i === 2 ? { ...b, pseudonym: api.ballots[3]!.pseudonym } : b));
    expect(checkPseudonyms(idemix, checked, checked.anonymous!, swapped).failure).toMatchObject({ index: 2, message: "The pseudonym proof is not valid." });
    expect(checkBallots(e, swapped, undefined, checked.anonymous!).failure).toMatchObject({ index: 2, message: "Its voter tag isn't the one its pseudonym gives." });
    const otherAffiliation = { ...checked.anonymous!, affiliation: "officers" };
    expect(checkPseudonyms(idemix, checked, otherAffiliation, api.ballots).failure?.message).toBe("This credential can't vote in this election: its affiliation isn't officers.");
  });

  it("shows the election with anonymous voters, the pinned issuer key and the Pseudonym column", async () => {
    for (const submitter of ["show", "hide"] as const) {
      const { app } = load(blocks(), idemix, submitter);
      const page = unescaped((await app.inject(`/channels/${CHANNEL}/elections/${ID}`)).body);
      expect(page).toContain("A private election with anonymous voters.");
      expect(page).toContain(`signed by an anonymous member of ${VOTERS}`);
      expect(page).toContain(`Voter credentials from <span class="mono">${VOTERS}</span>.`);
      expect(page).toContain(`It matches ${VOTERS}'s key in the channel's configuration.`);
      expect(page).toContain("<th>Pseudonym</th>");
      expect(page).not.toContain("<th>Voter tag</th>");
      expect(page).toContain("Pseudonym proofs");
      expect(page).not.toContain("Who voted is visible to every member.");
      expect(page.includes('<span class="anon">Anonymous member</span>')).toBe(submitter === "show");
      expect(page).not.toMatch(/voter[1-5]\b/);
      const list = unescaped((await app.inject(`/channels/${CHANNEL}/elections`)).body);
      expect(list).toContain(`${ID} · anonymous voters`);
    }
    const { app } = load(blocks(), idemix, "hide");
    const tx = blocks()[12]!.transactions[0]!;
    const txPage = unescaped((await app.inject(`/channels/${CHANNEL}/transactions/${tx.txId}`)).body);
    expect(txPage).toContain(`Anonymous member of the voter organisation <span class="mono">${VOTERS}</span>`);
    expect(txPage).toContain("used for this transaction only");
    const channel = unescaped((await app.inject(`/channels/${CHANNEL}`)).body);
    expect(channel).toContain("<h2>Members</h2>");
    expect(channel).toContain("Members are anonymous. They can't endorse. Fabric can't revoke their credentials.");
    expect(channel).toMatch(/<td data-label="Kind">Idemix<\/td>/);
  });

  it("shows the key mismatch banner when the pinned issuer key isn't the channel's", async () => {
    const { db, app } = load(blocks(), idemix);
    const summary = db.configSummary(CHANNEL)!;
    db.setConfigSummary(CHANNEL, { ...summary, organisations: summary.organisations.map((o) => (o.mspId === VOTERS ? { ...o, issuerKeyHash: "ab".repeat(32) } : o)) });
    const page = unescaped((await app.inject(`/channels/${CHANNEL}/elections/${ID}`)).body);
    expect(page).toContain(`This election's issuer key isn't ${VOTERS}'s key in the channel's configuration.`);
    expect(page).toContain("so no ballot can be cast until they agree");
    expect(page).toContain(`It isn't ${VOTERS}'s key in the channel's configuration, <span class="mono" title="${"ab".repeat(32)}">abababab…abababab</span>.`);
  });

  it("serves the pinned module to the browser's full check, gzipped, under a policy that lets it compile", async () => {
    const { app } = load(blocks().slice(0, 1), idemix);
    const wasm = await app.inject({ url: "/assets/idemix/weft-idemix.wasm", headers: { "accept-encoding": "gzip" } });
    expect(wasm.statusCode).toBe(200);
    expect(wasm.headers["content-type"]).toBe("application/wasm");
    expect(wasm.headers["content-encoding"]).toBe("gzip");
    expect(gunzipSync(wasm.rawPayload).length).toBe(PINNED.wasmBytes);
    expect((await app.inject("/assets/idemix/wasm_exec.js")).statusCode).toBe(200);
    expect((await app.inject("/assets/full-check.js")).headers["content-security-policy"]).toContain("'wasm-unsafe-eval'");
    expect((await app.inject(`/channels/${CHANNEL}`)).headers["content-security-policy"]).toContain("script-src 'unsafe-inline' 'wasm-unsafe-eval';");
  });
});
