/**
 * How long indexing private elections holds the explorer's main thread,
 * with ballots checked in the main thread and in the check threads
 * (check-pool.ts). It indexes a made-up election of X.509 ballots and the
 * recorded election with voter credentials (test/fixtures), each a few
 * times into a fresh index, and prints the time it took and the longest the
 * main thread couldn't answer anything (the event loop's delay), as a request
 * arriving during indexing would wait.
 *
 *   pnpm --filter @weftwallet/explorer bench:index [ballots] [threads]
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { gunzipSync } from "node:zlib";
import { common } from "@hyperledger/fabric-protos";
import { DIST_WASM, startIdemixNode } from "@weftwallet/idemix/node";
import { CheckPool, inlineChecker, type BallotChecker } from "../check-pool.ts";
import { defaultThreads } from "../config.ts";
import { ExplorerDb } from "../db.ts";
import { decodeBlock, type DecodedBlock } from "../decode.ts";
import { indexBlock } from "../indexer.ts";
import { parsePolicy } from "../policy.ts";
import { privateElection } from "./private-ballot.ts";

const ballots = Number(process.argv[2] ?? 120);
const threads = Number(process.argv[3] ?? defaultThreads());

async function measure(name: string, blocks: () => DecodedBlock[], channel: string, checker: BallotChecker, runs: number) {
  const policy = parsePolicy({ channels: { [channel]: { level: "public", values: "show", submitter: "show", privateElections: "private-ballot" } } });
  // One run first, so each thread has made the election's key table, as a running explorer has.
  await index(blocks(), policy, checker);
  const h = monitorEventLoopDelay({ resolution: 1 });
  let worst = 0;
  let last = performance.now();
  const probe = setInterval(() => {
    const now = performance.now();
    worst = Math.max(worst, now - last - 2);
    last = now;
  }, 2);
  h.enable();
  const t = performance.now();
  for (let i = 0; i < runs; i++) await index(blocks(), policy, checker);
  const took = performance.now() - t;
  h.disable();
  clearInterval(probe);
  const ms = (n: number) => `${n.toFixed(0)} ms`;
  console.log(`${name.padEnd(44)} ${ms(took / runs).padStart(8)} a run   main thread held up to ${ms(Math.max(worst, h.max / 1e6)).padStart(7)}, p99 ${ms(h.percentile(99) / 1e6)}`);
}

async function index(blocks: DecodedBlock[], policy: ReturnType<typeof parsePolicy>, checker: BallotChecker) {
  const db = new ExplorerDb(":memory:");
  for (const b of blocks) {
    await indexBlock(db, policy, b, { experimental: true, checker });
    // A block stream hands the indexer one block at a time.
    await new Promise((r) => setImmediate(r));
  }
  db.close();
}

const f = await privateElection({ until: "open", choices: Array.from({ length: ballots }, (_, i) => i % 3), perBlock: 10 });
const x509 = () => f.blocks.map((b) => decodeBlock(b));
console.log(`X.509 ballots: ${ballots}, in blocks of 10. Check threads: ${threads}.`);
await measure("in the main thread", x509, f.channel, inlineChecker(null), 3);
const pool = await CheckPool.start({ size: threads });
await measure(`in ${threads} check threads`, x509, f.channel, pool, 3);
await pool.close();

if (existsSync(join(DIST_WASM, "weft-idemix.wasm"))) {
  const raw = gunzipSync(readFileSync(new URL("./fixtures/privatevote-chair-2029.blocks.gz", import.meta.url)));
  const anonymous = () => {
    const out: DecodedBlock[] = [];
    for (let o = 0; o < raw.length; ) {
      const n = raw.readUInt32BE(o);
      out.push(decodeBlock(common.Block.deserializeBinary(raw.subarray(o + 4, o + 4 + n))));
      o += 4 + n;
    }
    return out;
  };
  console.log("Anonymous ballots: chair-2029's 5, one a block.");
  await measure("in the main thread, with the idemix module", anonymous, "privatevote-chair-2029", inlineChecker((await startIdemixNode()).sync), 5);
  const idemixPool = await CheckPool.start({ size: threads, idemixDir: DIST_WASM });
  await measure(`in ${threads} check threads, each with the module`, anonymous, "privatevote-chair-2029", idemixPool, 5);
  await idemixPool.close();
} else {
  console.log("The idemix module isn't built, so the anonymous ballots weren't measured.");
}
