import { Auth } from "./auth.ts";
import { CheckpointSigner, CrossCheck } from "./checkpoints.ts";
import { loadConfig } from "./config.ts";
import { ExplorerDb } from "./db.ts";
import { Indexer } from "./indexer.ts";
import { policyFingerprint, publishedChannels } from "./policy.ts";
import { existsSync } from "node:fs";
import { FULL_CHECK_WORKER, buildServer } from "./server.ts";

const config = loadConfig();
if (config.experimental && Object.values(config.policy.channels).some((c) => c.privateElections) && !existsSync(FULL_CHECK_WORKER)) {
  throw new Error(
    `The policy names privateElections, and the full check's worker, ${FULL_CHECK_WORKER}, isn't built. Run pnpm --filter @weftwallet/explorer build, then start the explorer again.`,
  );
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
const indexer = new Indexer(config, config.policy, db, { info: (m) => app.log.info(m), warn: (m) => app.log.warn(m) });

const shutdown = async () => {
  indexer.stop();
  crossCheck.stop();
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
if (rebuilt) app.log.info("The policy changed since the last run, so the index is being rebuilt from block 0.");
indexer.start();
crossCheck.start();
if (config.peers.length) app.log.info(`Cross-checking with ${config.peers.join(", ")}`);
