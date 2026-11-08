import { Auth } from "./auth.ts";
import { CheckpointSigner, CrossCheck } from "./checkpoints.ts";
import { loadConfig } from "./config.ts";
import { ExplorerDb } from "./db.ts";
import { Indexer } from "./indexer.ts";
import { policyFingerprint, publishedChannels } from "./policy.ts";
import { existsSync } from "node:fs";
import { FULL_CHECK_WORKER, buildServer } from "./server.ts";
import { CheckPool, inlineChecker, type BallotChecker } from "./check-pool.ts";

const config = loadConfig();
const privateElections = config.experimental && Object.values(config.policy.channels).some((c) => c.privateElections);
if (privateElections && !existsSync(FULL_CHECK_WORKER)) {
  throw new Error(
    `The policy names privateElections, and the full check's worker, ${FULL_CHECK_WORKER}, isn't built. Run pnpm --filter @weftwallet/explorer build, then start the explorer again.`,
  );
}
// Ballots on private elections are checked as the indexer reads each block,
// in a pool of worker threads (check-pool.ts) so the checks don't hold up
// requests, or with WEFT_EXPLORER_CHECK_THREADS=0 in this thread. Anonymous
// ballots (docs/adr/0008) are checked with the idemix module, which each
// thread starts, and in the browser's full check, which this explorer serves
// the module to. Both refuse a module whose SHA-256 isn't the pinned one.
let idemixDir: string | null = null;
let checker: BallotChecker = inlineChecker(null);
if (privateElections) {
  const { DIST_WASM, startIdemixNode } = await import("@weftwallet/idemix/node");
  idemixDir = DIST_WASM;
  try {
    checker = config.checkThreads === 0 ? inlineChecker((await startIdemixNode()).sync) : await CheckPool.start({ size: config.checkThreads, idemixDir });
  } catch (error) {
    throw new Error(
      `The policy names privateElections, and the idemix module in ${DIST_WASM} didn't start: ${error instanceof Error ? error.message : String(error)} Run pnpm --filter @weftwallet/idemix build:wasm, which needs Go, then start the explorer again.`,
    );
  }
}
const db = new ExplorerDb(config.databasePath);
const rebuilt = db.usePolicy(policyFingerprint(config.policy));
const channels = publishedChannels(config.policy);
const signer = new CheckpointSigner(config);
// Every published channel is compared. Requests are signed, so other
// organisations' explorers share members-only channels with this one too.
const crossCheck = new CrossCheck(db, channels, config.peers, undefined, signer);
const app = buildServer({
  name: config.name,
  mspId: config.mspId,
  ...(config.networkPage ? { networkPage: config.networkPage } : {}),
  products: config.products,
  receiptOrigins: config.receiptOrigins,
  experimental: config.experimental,
  ...(idemixDir ? { idemixDir } : {}),
  channels,
  policy: config.policy,
  db,
  status: () => indexer.statuses(),
  auth: new Auth(config.sessionSecret),
  signer,
  crossCheck,
  ...(config.publicUrl ? { publicUrl: config.publicUrl } : {}),
  logger: true,
});
const indexer = new Indexer(config, config.policy, db, { info: (m) => app.log.info(m), warn: (m) => app.log.warn(m) }, checker);

const shutdown = async () => {
  indexer.stop();
  crossCheck.stop();
  await checker.close();
  await app.close();
  db.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ port: config.port, host: config.host });
if (channels.length === 0) {
  app.log.warn("The policy publishes no channels, so there's nothing to index. Set level: public for a channel.");
} else {
  app.log.info(`Publishing ${channels.join(", ")} as ${config.name}, read with ${config.mspId}`);
}
if (config.experimental) {
  // docs/adr/0009: private election pages, for channels whose policy names privateElections.
  const named = channels.filter((c) => config.policy.channels[c]?.privateElections);
  app.log.warn(
    `Started with WEFT_EXPERIMENTAL=1, for Weft Experimental. ${named.length ? `Private election pages are on for ${named.join(", ")}, with each ballot's voter tag published.` : "No channel names privateElections, so no private election pages are shown."} Their cryptography hasn't been reviewed outside the project.`,
  );
}
if (checker instanceof CheckPool) app.log.info(`Checking private election ballots in ${checker.size} ${checker.size === 1 ? "thread" : "threads"}`);
if (rebuilt) app.log.info("The policy changed since the last run, so the index is being rebuilt from block 0.");
indexer.start();
crossCheck.start();
if (config.peers.length) app.log.info(`Cross-checking with ${config.peers.join(", ")}`);
