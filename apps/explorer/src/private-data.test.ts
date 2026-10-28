import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ExplorerDb } from "./db.ts";
import { decodeBlock } from "./decode.ts";
import { parsePolicy, publishBlock, publishedChannels, viewTransaction } from "./policy.ts";
import { buildServer } from "./server.ts";
import { chain } from "./test/blocks.ts";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const blocks = () =>
  chain("deals", [
    { txs: [{ txId: "cfg000", chaincode: "", args: [], config: true }] },
    {
      txs: [
        {
          txId: "pd0001",
          chaincode: "deals",
          args: ["Agree", "deal1"],
          writes: [{ key: "deal1", value: "agreed" }],
          privateWrites: [
            { collection: "prices", key: "deal1", value: '{"price":1200}' },
            { collection: "prices", key: "old", value: undefined },
          ],
        },
      ],
    },
  ]);

function explorer(privateData?: "names" | "hashes", level: "public" | "members" = "public") {
  const policy = parsePolicy({ channels: { deals: { level: "public", contracts: { deals: level }, ...(privateData ? { privateData } : {}) } } });
  const db = new ExplorerDb(":memory:");
  for (const b of blocks()) db.addBlock(publishBlock(policy, decodeBlock(b)));
  return { db, app: buildServer({ name: "Org1", channels: publishedChannels(policy), policy, db, status: () => [] }) };
}

describe("private data", () => {
  it("is decoded as the hashes the ledger holds", () => {
    const tx = decodeBlock(blocks()[1]!).transactions[0]!;
    expect(tx.privateData).toEqual([
      {
        namespace: "deals",
        collection: "prices",
        reads: 0,
        writes: [
          { keyHash: sha("deal1"), valueHash: sha('{"price":1200}'), isDelete: false },
          { keyHash: sha("old"), valueHash: null, isDelete: true },
        ],
      },
    ]);
  });

  it("is published by collection and count unless the policy publishes hashes", async () => {
    const names = explorer();
    const tx = (await names.app.inject("/api/v1/channels/deals/transactions/pd0001")).json();
    expect(tx.privateData).toEqual([{ namespace: "deals", collection: "prices", reads: 0, writes: 1, deletes: 1, level: "public" }]);
    const page = (await names.app.inject("/channels/deals/transactions/pd0001")).body;
    expect(page).toContain("Private data");
    expect(page).toContain("wrote 1 key, deleted 1 key");
    expect(page).not.toContain(sha('{"price":1200}'));

    const hashes = explorer("hashes");
    const withHashes = (await hashes.app.inject("/api/v1/channels/deals/transactions/pd0001")).json();
    expect(withHashes.privateData[0].hashes[0]).toEqual({ keyHash: sha("deal1"), valueHash: sha('{"price":1200}'), isDelete: false });
    const hashPage = (await hashes.app.inject("/channels/deals/transactions/pd0001")).body;
    expect(hashPage).toContain(sha('{"price":1200}'));
    expect(hashPage).toContain("If you hold one of these values");
  });

  it("follows the contract's level", async () => {
    const members = explorer("hashes", "members");
    const row = members.db.transaction("deals", "pd0001")!;
    expect(viewTransaction(row, false).privateData).toEqual([]);
    expect(viewTransaction(row, true).privateData).toHaveLength(1);
    const hidden = explorer("hashes", "hidden" as "members");
    expect((await hidden.app.inject("/api/v1/channels/deals/transactions/pd0001")).json().privateData).toEqual([]);
  });

  it("must be names or hashes", () => {
    expect(() => parsePolicy({ channels: { deals: { level: "public", privateData: "values" } } })).toThrow(/names or hashes/);
  });
});
