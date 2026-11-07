import { inviteLinks } from "@weftwallet/core";
import { loadConfig } from "./config.ts";
import { GatewayPool } from "./gateways.ts";
import { buildServer } from "./server.ts";

const config = loadConfig();
const pool = new GatewayPool(config);
const app = buildServer(config, pool);

const shutdown = async () => {
  await app.close();
  pool.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ port: config.port, host: config.host });
app.log.info(`Weft relay forwarding to ${config.peerEndpoint}`);
if (config.experimental) {
  // docs/adr/0009: the switch is parsed, and nothing experimental is served yet.
  const voters = config.idemixMspIds.length ? config.idemixMspIds.join(", ") : "none";
  app.log.warn(`Started with WEFT_EXPERIMENTAL=1, for Weft Experimental. Voter MSPs for idemix signers: ${voters}. This relay accepts no idemix signers yet.`);
}
if (config.invite && config.publicUrl) {
  const links = inviteLinks(`${config.publicUrl}/.well-known/weft-invite.json`, config.joinPage);
  app.log.info(`Invite for ${config.invite.mspId}: ${links.join}`);
} else if (config.invite) {
  app.log.info("Serving an invite at /.well-known/weft-invite.json (set WEFT_PUBLIC_URL to print share links)");
}
