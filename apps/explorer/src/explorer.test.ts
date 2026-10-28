import { describe, expect, it } from "vitest";
import { ExplorerDb } from "./db.ts";
import { decodeBlock } from "./decode.ts";
import { parsePolicy, publishBlock, publishedChannels } from "./policy.ts";
import { buildServer } from "./server.ts";
import { chain, sha256 } from "./test/blocks.ts";

const blocks = () =>
  chain("mychannel", [
    { txs: [{ txId: "c0", chaincode: "", args: [], config: true }] },
    {
      txs: [
        { txId: "aa1100", chaincode: "basic", args: ["CreateAsset", "asset1", "blue"], writes: [{ key: "asset1", value: '{"color":"blue"}' }], event: "Created" },
        { txId: "bb2200", chaincode: "basic", args: ["TransferAsset", "asset1", "Bob"], writes: [{ key: "asset1", value: "x" }] },
      ],
      codes: [0, 11], // VALID, MVCC_READ_CONFLICT
    },
    {
      txs: [
        { txId: "cc3300", chaincode: "ballot", args: ["Vote", "secret"], writes: [{ key: "v1", value: "secret" }], creator: "Org2MSP" },
        { txId: "dd44", chaincode: "basic", args: ["DeleteAsset", "asset1"], writes: [{ key: "asset1" }, { key: "tally", value: "1", ns: "ballot" }] },
      ],
    },
  ]);

const policy = parsePolicy({
  organisation: "Org1",
  channels: {
    mychannel: { level: "public", contracts: { ballot: "hidden" } },
    other: { level: "hidden" },
  },
});

describe("decoding", () => {
  it("reads calls, writes, events and validation codes", () => {
    const [, b1] = blocks().map(decodeBlock);
    expect(b1!.channel).toBe("mychannel");
    expect(b1!.dataHashValid).toBe(true);
    const [create, transfer] = b1!.transactions;
    expect(create).toMatchObject({ txId: "aa1100", type: "endorser", chaincode: "basic", fn: "CreateAsset", validation: "VALID", reads: 1 });
    expect(create!.args.map((a) => Buffer.from(a).toString())).toEqual(["asset1", "blue"]);
    expect(create!.writes[0]).toMatchObject({ namespace: "basic", key: "asset1", isDelete: false });
    expect(create!.event?.name).toBe("Created");
    expect(create!.creator?.mspId).toBe("Org1MSP");
    expect(create!.endorsers.map((e) => e.mspId)).toEqual(["Org1MSP"]);
    expect(transfer!.validation).toBe("MVCC_READ_CONFLICT");
  });

  it("recomputes header hashes so each block links to the one before", () => {
    const decoded = blocks().map(decodeBlock);
    for (let i = 1; i < decoded.length; i++) expect(decoded[i]!.previousHash).toBe(decoded[i - 1]!.hash);
  });

  it("notices a block whose data was changed", () => {
    const block = blocks()[1]!;
    const data = block.getData()!.getDataList_asU8();
    block.getData()!.setDataList([data[1]!, data[0]!]);
    expect(decodeBlock(block).dataHashValid).toBe(false);
  });

  it("lists a transaction it can't read rather than failing the block", () => {
    const block = blocks()[1]!;
    const data = block.getData()!.getDataList_asU8();
    block.getData()!.setDataList([Uint8Array.from([0xff, 0xff, 0xff]), data[1]!]);
    const decoded = decodeBlock(block);
    expect(decoded.transactions[0]).toMatchObject({ type: "other", typeName: "UNREADABLE", txId: "" });
    expect(decoded.transactions[1]!.txId).toBe("bb2200");
  });
});

describe("policy", () => {
  it("starts hidden and publishes only public channels for now", () => {
    expect(parsePolicy({ channels: { a: {} } }).channels.a!.level).toBe("hidden");
    expect(publishedChannels(policy)).toEqual(["mychannel"]);
    expect(publishedChannels(parsePolicy({ channels: { a: { level: "members" }, b: { level: "hidden" } } }))).toEqual(["a"]);
    expect(() => parsePolicy({ channels: { a: { level: "open" } } })).toThrow(/public, members, hidden/);
  });

  it("redacts hidden contracts and their writes", () => {
    const published = blocks().map((b) => publishBlock(policy, decodeBlock(b)));
    const [vote, del] = published[2]!.transactions;
    expect(vote).toMatchObject({ txId: "cc3300", redacted: true, chaincode: null, fn: null, args: [], writes: [], creator: null });
    // A public contract's call keeps its own writes but not the hidden contract's.
    expect(del!.writes).toEqual([{ namespace: "basic", key: "asset1", isDelete: true, value: null, level: "public" }]);
  });

  it("can publish values as hashes and hide submitters", () => {
    const hashed = parsePolicy({ channels: { mychannel: { level: "public", values: "hash", submitter: "hide" } } });
    const tx = publishBlock(hashed, decodeBlock(blocks()[1]!)).transactions[0]!;
    expect(tx.args[0]).toEqual({ sha256: sha256("asset1") });
    expect(tx.writes[0]!.value).toEqual({ sha256: sha256('{"color":"blue"}') });
    expect(tx.creator).toBeNull();
    expect(tx.endorsers).toEqual([{ mspId: "Org1MSP", name: null }]);
  });
});

describe("server", () => {
  const setup = () => {
    const db = new ExplorerDb(":memory:");
    for (const b of blocks()) db.addBlock(publishBlock(policy, decodeBlock(b)));
    const app = buildServer({ name: "Org1", channels: publishedChannels(policy), policy, db, status: () => [] });
    return { db, app };
  };

  it("indexes blocks with link checks", () => {
    const { db } = setup();
    expect(db.nextBlock("mychannel")).toBe(3);
    expect(db.channels(["mychannel"])[0]).toMatchObject({ height: 3, transactions: 5, brokenLinks: 0, badDataHashes: 0 });
    expect(db.block("mychannel", 2)!.block.linked).toBe(true);
    expect(db.contracts("mychannel").map((c) => c.chaincode)).toEqual(["basic"]);
  });

  it("serves pages and the API for published channels only", async () => {
    const { app } = setup();
    const home = await app.inject("/");
    expect(home.statusCode).toBe(200);
    expect(home.body).toContain("Org1's view of the ledger");

    const tx = await app.inject("/channels/mychannel/transactions/aa1100");
    expect(tx.body).toContain("CreateAsset");
    expect(tx.body).toContain("Valid. Its changes are in the ledger.");
    const conflict = await app.inject("/channels/mychannel/transactions/bb2200");
    expect(conflict.body).toContain("Someone else changed the same data first");

    const hidden = await app.inject("/channels/mychannel/transactions/cc3300");
    expect(hidden.body).toContain("doesn&#39;t publish");
    expect(hidden.body).not.toContain("secret");

    expect((await app.inject("/channels/other")).statusCode).toBe(404);
    expect((await app.inject("/api/v1/channels/other/blocks")).statusCode).toBe(404);

    const api = await app.inject("/api/v1/channels/mychannel/blocks/1");
    expect(api.headers["access-control-allow-origin"]).toBe("*");
    expect(api.json().transactions.map((t: { txId: string }) => t.txId)).toEqual(["aa1100", "bb2200"]);
  });

  it("says what it publishes, without naming hidden contracts", async () => {
    const { app } = setup();
    const [channel] = (await app.inject("/api/v1/status")).json().channels;
    expect(channel).toMatchObject({ channel: "mychannel", level: "public", publishes: { values: "show", submitter: "show", membersOnly: [], elections: false } });
    expect(JSON.stringify(channel)).not.toContain("ballot");
  });

  it("finds transactions by ID prefix, blocks by number and contracts by name", async () => {
    const { app } = setup();
    expect((await app.inject("/search?q=2")).headers.location).toBe("/channels/mychannel/blocks/2");
    expect((await app.inject("/search?q=aa1100")).headers.location).toBe("/channels/mychannel/transactions/aa1100");
    const byName = await app.inject("/search?q=bas");
    expect(byName.body).toContain("/channels/mychannel/contracts/basic");
    // Hidden contracts don't turn up.
    expect((await app.inject("/search?q=ballot")).body).toContain("Nothing published matches");
  });

  it("escapes what it shows", async () => {
    const db = new ExplorerDb(":memory:");
    const evil = chain("mychannel", [{ txs: [{ txId: "ee55", chaincode: "basic", args: ["<script>alert(1)</script>"] }] }]);
    db.addBlock(publishBlock(policy, decodeBlock(evil[0]!)));
    const app = buildServer({ name: "Org1", channels: ["mychannel"], policy, db, status: () => [] });
    const page = await app.inject("/channels/mychannel/transactions/ee55");
    expect(page.body).not.toContain("<script>alert(1)");
    expect(page.body).toContain("&#60;script&#62;");
  });
});

describe("policy changes", () => {
  it("clears the index when what's published changes", async () => {
    const { policyFingerprint } = await import("./policy.ts");
    const db = new ExplorerDb(":memory:");
    expect(db.usePolicy(policyFingerprint(policy))).toBe(false);
    for (const b of blocks()) db.addBlock(publishBlock(policy, decodeBlock(b)));
    expect(db.usePolicy(policyFingerprint(policy))).toBe(false);
    expect(db.nextBlock("mychannel")).toBe(3);

    const stricter = parsePolicy({ channels: { mychannel: { level: "public", values: "hash" } } });
    expect(db.usePolicy(policyFingerprint(stricter))).toBe(true);
    expect(db.nextBlock("mychannel")).toBe(0);
  });
});
