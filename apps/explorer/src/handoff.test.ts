import { describe, expect, it } from "vitest";
import { domain } from "@weftwallet/brand/products";
import { receiptOrigins } from "./config.ts";
import { ExplorerDb } from "./db.ts";
import { decodeBlock } from "./decode.ts";
import { commitmentFor } from "./elections.ts";
import { parsePolicy, publishBlock, publishedChannels } from "./policy.ts";
import { acceptHandoff } from "./receipt.ts";
import { buildServer } from "./server.ts";
import { chain } from "./test/blocks.ts";

const E = "board-2026";
const TX = "9f3a1c07b25e4d18a6c3f09e7b21d45c8e60a93f1b7d2c45e8f06a1b3c9de41b";
const SALT = "6f1c9a42d07e83b5c2a1f4e9d8b03c71";
const PLAYGROUND = `https://play.${domain}`;
const page = { electionId: E, txId: TX, trusted: [PLAYGROUND] };
const answer = { type: "weft-receipt-check:receipt", version: 1, electionId: E, txId: TX, option: "Ada", salt: SALT };

describe("a receipt handed to the election page", () => {
  it("is taken from Weft Playground and from a browser extension's page", () => {
    expect(acceptHandoff({ origin: PLAYGROUND, data: answer }, page)).toEqual({ option: "Ada", salt: SALT });
    for (const origin of ["chrome-extension://abcdefghijklmnopabcdefghijklmnop", "moz-extension://4b1e1c4e-2c8f-4f61-9d0f-2f6a2b7c1d3e"]) {
      expect(acceptHandoff({ origin, data: answer }, page), origin).toEqual({ option: "Ada", salt: SALT });
    }
  });

  it("is ignored from any other web page", () => {
    for (const origin of ["https://evil.example", `http://play.${domain}`, `https://play.${domain}.evil.example`, "null", "chrome-extension://", "file://"]) {
      expect(acceptHandoff({ origin, data: answer }, page), origin).toBeNull();
    }
  });

  it("is used only when shaped as this page's receipt", () => {
    const from = (data: unknown) => acceptHandoff({ origin: PLAYGROUND, data }, page);
    expect(from({ ...answer, txId: TX.toUpperCase() })).toEqual({ option: "Ada", salt: SALT });
    expect(from(null)).toBeNull();
    expect(from("Ada")).toBeNull();
    expect(from([answer])).toBeNull();
    expect(from({ ...answer, type: "weft-receipt-check:ready" })).toBeNull();
    expect(from({ ...answer, version: 2 })).toBeNull();
    expect(from({ ...answer, electionId: "team-lunch" })).toBeNull();
    expect(from({ ...answer, txId: "0".repeat(64) })).toBeNull();
    expect(from({ ...answer, salt: SALT.toUpperCase() })).toBeNull();
    expect(from({ ...answer, salt: "abc" })).toBeNull();
    expect(from({ ...answer, option: "" })).toBeNull();
    expect(from({ ...answer, option: "x".repeat(201) })).toBeNull();
    expect(from({ ...answer, extra: "anything" })).toBeNull();
    const { salt: _s, ...noSalt } = answer;
    expect(from(noSalt)).toBeNull();
  });

  it("works from its own source, as the election page inlines it", () => {
    const inlined = new Function(`return (${acceptHandoff.toString()})`)() as typeof acceptHandoff;
    expect(inlined({ origin: PLAYGROUND, data: answer }, page)).toEqual({ option: "Ada", salt: SALT });
    expect(inlined({ origin: "https://evil.example", data: answer }, page)).toBeNull();
  });
});

describe("who may hand one over", () => {
  it("is Weft Playground where the products are, and the operator's own apps", () => {
    expect(receiptOrigins({ local: false, domain }, undefined)).toEqual([PLAYGROUND]);
    expect(receiptOrigins({ local: true }, "")).toEqual(["http://localhost:4323"]);
    expect(receiptOrigins({ local: false, domain: "weft.example.org" }, " https://vote.example.org/ballot , http://localhost:5173,https://vote.example.org")).toEqual([
      "https://play.weft.example.org",
      "https://vote.example.org",
      "http://localhost:5173",
    ]);
  });

  it("refuses an address that isn't one, or plain http beyond localhost", () => {
    expect(() => receiptOrigins({ local: true }, "vote.example.org")).toThrow("WEFT_EXPLORER_RECEIPT_ORIGINS: vote.example.org isn't an address.");
    expect(() => receiptOrigins({ local: true }, "http://vote.example.org")).toThrow(/must use https:\/\//);
  });
});

describe("the election page", () => {
  const k = (...parts: string[]) => `\u0000${parts.join("\u0000")}\u0000`;
  const election = JSON.stringify({ id: E, title: "Board of directors", options: ["Ada", "Grace"], closesAt: "2099-10-20T09:00:00.000Z", creatorMsp: "Org1MSP", state: "open" });
  function setup(receiptOrigins?: string[]) {
    const policy = parsePolicy({ channels: { votes: { level: "public", submitter: "hide", elections: "ballot" } } });
    const db = new ExplorerDb(":memory:");
    const blocks = chain("votes", [
      { txs: [{ txId: "ee0000", chaincode: "ballot", args: ["CreateElection", E], writes: [{ key: k("election", E), value: election }] }] },
      { txs: [{ txId: TX, chaincode: "ballot", args: ["CastVote", E], writes: [{ key: k("commitment", E, TX), value: JSON.stringify({ commitment: commitmentFor(E, "Ada", SALT) }) }] }] },
    ]);
    for (const b of blocks) db.addBlock(publishBlock(policy, decodeBlock(b)));
    return buildServer({ name: "Org1", channels: publishedChannels(policy), policy, db, status: () => [], ...(receiptOrigins ? { receiptOrigins } : {}) });
  }

  it("asks its opener once it has found the ballot, and trusts only the listed origins", async () => {
    const app = setup(["https://vote.example.org"]);
    const found = (await app.inject(`/channels/votes/elections/${E}?tx=${TX}&commitment=${commitmentFor(E, "Ada", SALT)}`)).body;
    expect(found).toContain("Your ballot is in block #1 and was accepted.");
    expect(found).toContain('window.opener.postMessage({ type: "weft-receipt-check:ready", version: 1 }, "*")');
    expect(found).toContain('var trusted = ["https://vote.example.org"];');
    expect(found).toContain(`var checkedTx = "${TX}";`);
    // Without a ballot to check there is nothing to ask for.
    const none = (await app.inject(`/channels/votes/elections/${E}`)).body;
    expect(none).toContain("var checkedTx = null;");
  });

  it("defaults to Weft Playground where the products are", async () => {
    const body = (await setup().inject(`/channels/votes/elections/${E}?tx=${TX}`)).body;
    expect(body).toContain(`var trusted = ["${PLAYGROUND}"];`);
  });

  it("reads no choice or salt from its address, and drops an old one from it", async () => {
    const body = (await setup().inject(`/channels/votes/elections/${E}?tx=${TX}`)).body;
    expect(body).not.toMatch(/URLSearchParams\(location\.hash/);
    expect(body).not.toMatch(/receiptForm\.action = "#" \+/);
    expect(body).toContain('if (/(^#|&)salt=/.test(location.hash)) history.replaceState(null, "", location.pathname + location.search + "#receipt");');
  });
});
