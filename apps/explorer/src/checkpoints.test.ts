import "reflect-metadata";
import { exportPkcs8 } from "./test/keys.ts";
import { describe, expect, it } from "vitest";
import { CheckpointSigner, CrossCheck, agreementFor, comparePeer, parseCheckpointMessage } from "./checkpoints.ts";
import { ExplorerDb } from "./db.ts";
import { decodeBlock } from "./decode.ts";
import { parsePolicy, publishBlock, publishedChannels } from "./policy.ts";
import { buildServer } from "./server.ts";
import { chain } from "./test/blocks.ts";
import { ca, user } from "./test/certs.ts";

const policy = parsePolicy({ organisation: "Org", channels: { mychannel: { level: "public" }, quiet: { level: "members" } } });

async function network() {
  const org1 = await ca("ca.org1");
  const org2 = await ca("ca.org2");
  const org3 = await ca("ca.org3");
  const members = [
    { mspId: "Org1MSP", rootCerts: [org1.pem] },
    { mspId: "Org2MSP", rootCerts: [org2.pem] },
    { mspId: "Org3MSP", rootCerts: [org3.pem] },
  ];
  const specs = (tamper: boolean) => [
    { txs: [{ txId: "cfg000", chaincode: "", args: [], config: true, members }] },
    { txs: [{ txId: "aa1111", chaincode: "basic", args: ["Create", tamper ? "forged" : "a1"] }] },
    { txs: [{ txId: "bb2222", chaincode: "basic", args: ["Create", "a2"] }] },
  ];
  /** One organisation's explorer, with its own copy of the ledger. */
  async function explorer(
    mspId: string,
    issuer: Awaited<ReturnType<typeof ca>>,
    options: { tamper?: boolean; upTo?: number; policy?: ReturnType<typeof parsePolicy> } = {},
  ) {
    const p = options.policy ?? policy;
    const db = new ExplorerDb(":memory:");
    for (const b of chain("mychannel", specs(!!options.tamper)).slice(0, (options.upTo ?? 2) + 1)) {
      const decoded = decodeBlock(b);
      const config = decoded.transactions.find((t) => t.members);
      if (config?.members) db.setMembers("mychannel", config.members);
      db.addBlock(publishBlock(p, decoded));
    }
    const identity = await user(issuer, `explorer.${mspId}`);
    const signer = new CheckpointSigner({ mspId, certificate: identity.pem, privateKey: await exportPkcs8(identity.keys.privateKey) });
    return { db, signer, app: buildServer({ name: mspId, channels: publishedChannels(p), policy: p, db, status: () => [], signer }) };
  }
  return { org1, org2, org3, explorer };
}

const checkpointOf = async (e: { app: ReturnType<typeof buildServer> }) => (await e.app.inject("/api/v1/channels/mychannel/checkpoint")).json();

describe("checkpoints", () => {
  it("are signed, canonical, and only for public channels", async () => {
    const { explorer, org1 } = await network();
    const one = await explorer("Org1MSP", org1);
    const cp = await checkpointOf(one);
    expect(cp).toMatchObject({ channel: "mychannel", mspId: "Org1MSP", number: 2 });
    expect(parseCheckpointMessage(cp.message)).toMatchObject({ number: 2, hash: cp.hash });
    expect(cp.hash).toBe(one.db.blockHash("mychannel", 2));
    expect((await one.app.inject("/api/v1/channels/quiet/checkpoint")).statusCode).toBe(404);
    expect(() => parseCheckpointMessage(cp.message.replace("number: 2", "number: 02"))).toThrow();
  });

  it("agree when the ledgers match, and say where they don't", async () => {
    const { explorer, org1, org2, org3 } = await network();
    const one = await explorer("Org1MSP", org1);
    const two = await explorer("Org2MSP", org2);
    const three = await explorer("Org3MSP", org3, { tamper: true });

    const agree = comparePeer(one.db, "mychannel", "https://org2", await checkpointOf(two), undefined);
    expect(agree).toMatchObject({ state: "agree", mspId: "Org2MSP", agreedUpTo: 2 });

    const differ = comparePeer(one.db, "mychannel", "https://org3", await checkpointOf(three), undefined);
    expect(differ).toMatchObject({ state: "mismatch", mspId: "Org3MSP", mismatchAt: 2 });

    expect(agreementFor(2, [agree, differ])).toEqual({ agree: 2, total: 3, mismatched: ["Org3MSP"] });
  });

  it("refuses checkpoints signed by someone outside the channel or tampered with", async () => {
    const { explorer, org1, org2 } = await network();
    const one = await explorer("Org1MSP", org1);
    const two = await explorer("Org2MSP", org2);
    const cp = await checkpointOf(two);

    const claimed = { ...cp, message: cp.message.replace("Org2MSP", "Org1MSP") };
    expect(comparePeer(one.db, "mychannel", "u", claimed, undefined)).toMatchObject({ state: "invalid", detail: /signature/ });

    const outsider = await ca("ca.elsewhere");
    const mallory = await explorer("Org2MSP", outsider);
    expect(comparePeer(one.db, "mychannel", "u", await checkpointOf(mallory), undefined)).toMatchObject({
      state: "invalid",
      detail: /wasn't issued by Org2MSP's CA/,
    });
    expect(comparePeer(one.db, "other", "u", cp, undefined)).toMatchObject({ state: "invalid", detail: /not other/ });
  });

  it("keeps earlier agreement while the other organisation is ahead", async () => {
    const { explorer, org1, org2 } = await network();
    const behind = await explorer("Org1MSP", org1, { upTo: 1 });
    const ahead = await explorer("Org2MSP", org2);
    const first = comparePeer(behind.db, "mychannel", "u", await checkpointOf(ahead), undefined);
    expect(first).toMatchObject({ state: "pending", theirHeight: 2, agreedUpTo: null });
    const later = comparePeer(behind.db, "mychannel", "u", await checkpointOf(ahead), { ...first, state: "agree", agreedUpTo: 1 });
    expect(later).toMatchObject({ state: "agree", agreedUpTo: 1 });
  });

  it("finds the first block that differs", async () => {
    const { explorer, org1, org3 } = await network();
    const one = await explorer("Org1MSP", org1);
    const three = await explorer("Org3MSP", org3, { tamper: true });
    const cross = new CrossCheck(one.db, ["mychannel"], ["https://org3.example"], async (url) =>
      url.endsWith("/checkpoint") ? checkpointOf(three) : (await three.app.inject(new URL(url).pathname)).json(),
    );
    const [status] = await (async () => (await cross.checkAll(), cross.peersFor("mychannel")))();
    expect(status).toMatchObject({ state: "mismatch", mismatchAt: 1 });
    expect(status!.detail).toBe("From block #1, Org3MSP's ledger has different blocks.");
  });

  it("polls peers and shows the result on pages", async () => {
    const { explorer, org1, org2 } = await network();
    const one = await explorer("Org1MSP", org1);
    const two = await explorer("Org2MSP", org2);
    const cross = new CrossCheck(one.db, ["mychannel"], ["https://org2.example", "https://down.example"], async (url) => {
      if (url.startsWith("https://down.example")) throw new Error("connect ECONNREFUSED");
      return checkpointOf(two);
    });
    await cross.checkAll();
    expect(cross.peersFor("mychannel").map((p) => p.state)).toEqual(["agree", "unreachable"]);
    // Saved, so a restart starts from what it knew.
    expect(new CrossCheck(one.db, ["mychannel"], ["https://org2.example"]).peersFor("mychannel")[0]!.state).toBe("agree");

    const app = buildServer({ name: "Org1", channels: ["mychannel", "quiet"], policy, db: one.db, status: () => [], crossCheck: cross });
    const block = await app.inject("/channels/mychannel/blocks/2");
    expect(block.body).toContain("2 of 3 organisations report this block");
    const home = await app.inject("/channels/mychannel");
    expect(home.body).toContain("Org2MSP");
    expect(home.body).toContain("couldn&#39;t be reached");
  });
});

describe("checked without trusting the explorer", () => {
  it("serves headers that link and a checkpoint its organisation's CA vouches for", async () => {
    const { blockHeaderHash, checkHeaders, verifyCheckpoint } = await import("@weftwallet/core/chain");
    const { explorer, org2 } = await network();
    const two = await explorer("Org2MSP", org2);
    const headers = (await two.app.inject("/api/v1/channels/mychannel/headers?from=0&to=2")).json();
    expect(headers).toHaveLength(3);
    expect(await checkHeaders(headers)).toEqual({ ok: true, from: 0, to: 2 });
    // The same hash the server computed, recomputed with WebCrypto.
    expect(await blockHeaderHash(2, headers[2].previousHash, headers[2].dataHash)).toBe(two.db.blockHash("mychannel", 2));

    const forged = headers.map((h: { number: number }) => (h.number === 1 ? { ...h, dataHash: "00".repeat(32) } : h));
    expect(await checkHeaders(forged)).toMatchObject({ ok: false, at: 1 });

    const members = (await two.app.inject("/api/v1/channels/mychannel/members")).json();
    expect(members.map((m: { mspId: string }) => m.mspId)).toEqual(["Org1MSP", "Org2MSP", "Org3MSP"]);
    const cp = await checkpointOf(two);
    expect(await verifyCheckpoint(cp, members)).toMatchObject({ ok: true, checkpoint: { mspId: "Org2MSP", number: 2, hash: headers[2].hash } });

    // Signed by Org2's explorer, but claiming to be Org1's.
    const claimed = { ...cp, message: cp.message.replace("Org2MSP", "Org1MSP") };
    expect(await verifyCheckpoint(claimed, members)).toMatchObject({ ok: false, reason: /signature/ });
    // A configuration without Org2.
    expect(await verifyCheckpoint(cp, members.filter((m: { mspId: string }) => m.mspId !== "Org2MSP"))).toMatchObject({ ok: false, reason: /isn't a member/ });
    // A CA that didn't issue the certificate.
    const wrongCa = members.map((m: { mspId: string; rootCerts: string[] }) => (m.mspId === "Org2MSP" ? { ...m, rootCerts: members[0].rootCerts } : m));
    expect(await verifyCheckpoint(cp, wrongCa)).toMatchObject({ ok: false, reason: /wasn't issued/ });
  });
});

describe("members-only channels", () => {
  it("are compared between member organisations' explorers, which sign their requests", async () => {
    const members = parsePolicy({ channels: { mychannel: { level: "members" } } });
    const { explorer, org1, org2 } = await network();
    const one = await explorer("Org1MSP", org1, { policy: members });
    const two = await explorer("Org2MSP", org2, { policy: members });
    const path = "/api/v1/channels/mychannel/checkpoint";

    expect((await two.app.inject(path)).statusCode).toBe(404);
    const signed = one.signer.requestHeaders(path);
    expect((await two.app.inject({ url: path, headers: signed })).json()).toMatchObject({ mspId: "Org2MSP", number: 2 });

    // Signed for one path, not another; recent; by a member's CA.
    expect((await two.app.inject({ url: "/api/v1/channels/mychannel/blocks/1", headers: signed })).statusCode).toBe(404);
    const old = one.signer.requestHeaders(path, new Date(Date.now() - 10 * 60_000));
    expect((await two.app.inject({ url: path, headers: old })).statusCode).toBe(404);
    const outsider = await explorer("Org2MSP", await ca("ca.elsewhere"), { policy: members });
    expect((await two.app.inject({ url: path, headers: outsider.signer.requestHeaders(path) })).statusCode).toBe(404);
    const forged = { ...signed, "x-weft-request": Buffer.from(Buffer.from(signed["x-weft-request"]!, "base64").toString().replace("Org1MSP", "Org2MSP")).toString("base64") };
    expect((await two.app.inject({ url: path, headers: forged })).statusCode).toBe(404);

    // End to end: Org1's explorer polls Org2's and they agree.
    const cross = new CrossCheck(
      one.db,
      ["mychannel"],
      ["https://org2.example"],
      async (url, headers) => {
        const response = await two.app.inject({ url: new URL(url).pathname, headers: headers ?? {} });
        if (response.statusCode !== 200) throw new Error(`HTTP ${response.statusCode}`);
        return response.json();
      },
      one.signer,
    );
    await cross.checkAll();
    expect(cross.peersFor("mychannel")[0]).toMatchObject({ state: "agree", mspId: "Org2MSP", agreedUpTo: 2 });
  });
});

