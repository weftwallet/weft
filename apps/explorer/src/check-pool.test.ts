/**
 * The indexer's check threads (check-pool.ts): a block's ballots checked in
 * worker threads give the same index as checked in the main thread, for
 * X.509 ballots and for anonymous ballots with the idemix module, and a
 * forged ballot is refused with the same message.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { common } from "@hyperledger/fabric-protos";
import { DIST_WASM, startIdemixNode } from "@weftwallet/idemix/node";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CheckPool, inlineChecker, type BallotChecker } from "./check-pool.ts";
import { ExplorerDb } from "./db.ts";
import { decodeBlock, type DecodedBlock } from "./decode.ts";
import { goString } from "./go-utf8.ts";
import { indexBlock } from "./indexer.ts";
import { parsePolicy, type Policy } from "./policy.ts";
import { privateElection } from "./test/private-ballot.ts";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const built = existsSync(join(DIST_WASM, "weft-idemix.wasm"));

const policyFor = (channel: string): Policy => parsePolicy({ channels: { [channel]: { level: "public", values: "show", submitter: "show", privateElections: "private-ballot" } } });

async function index(blocks: DecodedBlock[], channel: string, checker: BallotChecker) {
  const db = new ExplorerDb(":memory:");
  const policy = policyFor(channel);
  for (const b of blocks) await indexBlock(db, policy, b, { experimental: true, checker });
  return db;
}

/** What the index holds for an election's ballots, in ledger order. */
const rows = (db: ExplorerDb, channel: string, id: string) =>
  db.privateBallots(channel, id).map((b) => ({ txId: b.txId, voterTag: b.voterTag, tracking: b.tracking, verified: b.verified, error: b.error }));

describe("ballots checked in worker threads", () => {
  let pool: CheckPool;
  beforeAll(async () => {
    pool = await CheckPool.start({ size: 2 });
  });
  afterAll(async () => {
    await pool?.close();
  });

  it("index as in the main thread, a block of ballots at a time", async () => {
    const f = await privateElection({ until: "counted", choices: [0, 1, 1, 2, 1, 0, 1, 2], perBlock: 4, tamper: { ballot: 5, option: 1 } });
    const blocks = f.blocks.map((b) => decodeBlock(b));
    const inline = await index(blocks, f.channel, inlineChecker(null));
    const threads = await index(f.blocks.map((b) => decodeBlock(b)), f.channel, pool);
    expect(rows(threads, f.channel, f.id)).toEqual(rows(inline, f.channel, f.id));
    const failed = rows(threads, f.channel, f.id).filter((b) => !b.verified);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.error).toBe(rows(inline, f.channel, f.id).find((b) => !b.verified)!.error);
    expect(pool.size).toBe(2);
  });

  it("refuse a check once closed", async () => {
    const closed = await CheckPool.start({ size: 1 });
    await closed.close();
    const f = await privateElection({ until: "open", choices: [0] });
    const db = await index(f.blocks.map((b) => decodeBlock(b)), f.channel, closed);
    expect(rows(db, f.channel, f.id)[0]!.error).toBe("This explorer couldn't check this ballot: The check threads have stopped.");
  });
});

describe.skipIf(!built)("anonymous ballots checked in worker threads", () => {
  const CHANNEL = "privatevote-chair-2029";
  const blocks = () => {
    const raw = gunzipSync(readFileSync(new URL("./test/fixtures/privatevote-chair-2029.blocks.gz", import.meta.url)));
    const out: DecodedBlock[] = [];
    for (let o = 0; o < raw.length; ) {
      const n = raw.readUInt32BE(o);
      out.push(decodeBlock(common.Block.deserializeBinary(raw.subarray(o + 4, o + 4 + n))));
      o += 4 + n;
    }
    return out;
  };
  let pool: CheckPool;
  beforeAll(async () => {
    pool = await CheckPool.start({ size: 2, idemixDir: DIST_WASM });
  });
  afterAll(async () => {
    await pool?.close();
  });

  it("check each creator and pseudonym proof with each thread's own idemix module", async () => {
    const inline = await index(blocks(), CHANNEL, inlineChecker((await startIdemixNode()).sync));
    const threads = await index(blocks(), CHANNEL, pool);
    expect(rows(threads, CHANNEL, "chair-2029")).toEqual(rows(inline, CHANNEL, "chair-2029"));
    expect(rows(threads, CHANNEL, "chair-2029").every((b) => b.verified)).toBe(true);
  });

  it("refuse a forged pseudonym proof with the message the main thread gives", async () => {
    const forged = blocks();
    const tx = forged[13]!.transactions[0]!;
    const p = JSON.parse(goString(tx.args[2]!)) as Record<string, string>;
    p.sr = (JSON.parse(goString(forged[14]!.transactions[0]!.args[2]!)) as Record<string, string>).sr!;
    tx.args[2] = Buffer.from(JSON.stringify(p));
    const threads = await index(forged, CHANNEL, pool);
    expect(rows(threads, CHANNEL, "chair-2029").find((b) => b.txId === tx.txId)?.error).toBe("The pseudonym proof is not valid.");
  });

  it("refuse to start when the module isn't there", async () => {
    await expect(CheckPool.start({ size: 1, idemixDir: "/nonexistent/" })).rejects.toThrow(/ENOENT|no such file/);
  });
});
