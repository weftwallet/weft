import { describe, expect, it } from "vitest";
import { ExplorerDb } from "./db.ts";
import { decodeBlock } from "./decode.ts";
import { commitmentFor, elections, splitKey } from "./elections.ts";
import { parsePolicy, publishBlock, publishedChannels } from "./policy.ts";
import { buildServer } from "./server.ts";
import { chain } from "./test/blocks.ts";

const k = (...parts: string[]) => `\u0000${parts.join("\u0000")}\u0000`;
const E = "board-2026";
const election = (state: "open" | "closed", tally?: unknown) =>
  JSON.stringify({ id: E, title: "Board of directors", options: ["Ada", "Grace"], closesAt: "2026-10-20T09:00:00.000Z", creatorMsp: "Org1MSP", state, ...(tally ? { tally } : {}) });
const salts = ["a".repeat(32), "b".repeat(32), "c".repeat(32)];
const votes: [string, string, string][] = [
  ["aa0001", "Ada", salts[0]!],
  ["aa0002", "Grace", salts[1]!],
  ["aa0003", "Ada", salts[2]!],
];

function setup(policySource: Record<string, unknown> = { level: "public", submitter: "hide", elections: "ballot" }) {
  const policy = parsePolicy({ channels: { votes: policySource } });
  const db = new ExplorerDb(":memory:");
  const blocks = chain("votes", [
    { txs: [{ txId: "ee0000", chaincode: "ballot", args: ["CreateElection", E], writes: [{ key: k("election", E), value: election("open") }] }] },
    {
      txs: votes.map(([txId, option, salt]) => ({
        txId,
        chaincode: "ballot",
        args: ["CastVote", E],
        writes: [{ key: k("commitment", E, txId), value: JSON.stringify({ commitment: commitmentFor(E, option, salt) }) }],
      })),
      codes: [0, 0, 11], // the third ballot lost an MVCC race and wasn't counted
    },
    { txs: [{ txId: "ff0000", chaincode: "ballot", args: ["CloseElection", E], writes: [{ key: k("election", E), value: election("closed", { counts: { Ada: 1, Grace: 1 }, total: 2 }) }] }] },
  ]);
  for (const b of blocks) db.addBlock(publishBlock(policy, decodeBlock(b)));
  const app = buildServer({ name: "Org1", channels: publishedChannels(policy), policy, db, status: () => [] });
  return { db, app };
}

describe("elections", () => {
  it("reads composite keys", () => {
    expect(splitKey(k("commitment", E, "tx1"))).toEqual({ type: "commitment", attrs: [E, "tx1"] });
    expect(splitKey("plain")).toBeNull();
  });

  it("counts commitments in valid transactions and checks the published total", () => {
    const { db } = setup();
    const [e] = elections(db.contractRows("votes", "ballot"));
    expect(e).toMatchObject({ id: E, state: "closed", commitments: 2, tallyMatches: true, tally: { total: 2 } });
    expect(e!.closedIn).toMatchObject({ txId: "ff0000", blockNumber: 2 });
  });

  it("shows the result and checks receipts", async () => {
    const { app } = setup();
    const page = await app.inject(`/channels/votes/elections/${E}`);
    expect(page.body).toContain("The published total, 2, matches the 2 commitments on the ledger.");

    const ok = (await app.inject(`/api/v1/channels/votes/elections/${E}/receipts/aa0001`)).json();
    expect(ok).toMatchObject({ found: true, valid: true, blockNumber: 1, commitment: commitmentFor(E, "Ada", salts[0]!) });

    const lost = (await app.inject(`/api/v1/channels/votes/elections/${E}/receipts/aa0003`)).json();
    expect(lost).toMatchObject({ found: true, valid: false, validation: "MVCC_READ_CONFLICT" });

    const good = await app.inject(`/channels/votes/elections/${E}?tx=aa0001&commitment=${commitmentFor(E, "Ada", salts[0]!)}`);
    expect(good.body).toContain("Your ballot is in block #1 and was accepted.");
    const wrong = await app.inject(`/channels/votes/elections/${E}?tx=aa0001&commitment=${"0".repeat(64)}`);
    expect(wrong.body).toContain("The commitment doesn't match.");
    expect((await app.inject(`/channels/votes/elections/${E}?tx=aa0003`)).body).toContain("The network didn't accept that ballot.");
    expect((await app.inject(`/channels/votes/elections/${E}?tx=nope00`)).body).toContain("No published transaction has that ID.");
  });

  it("never needs the voter's choice: no option appears on the ledger", () => {
    const { db } = setup();
    const text = JSON.stringify(db.contractRows("votes", "ballot").map((r) => r.writes));
    expect(text).not.toMatch(/"option"/);
  });

  it("are hidden with their contract", async () => {
    const { app } = setup({ level: "public", elections: "ballot", contracts: { ballot: "members" } });
    expect((await app.inject("/channels/votes/elections")).statusCode).toBe(404);
    expect((await app.inject(`/api/v1/channels/votes/elections/${E}/receipts/aa0001`)).statusCode).toBe(404);
  });
});
