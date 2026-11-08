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
  // docs/adr/0008 and 0009: idemix signers, without request logs, and voter invites.
  app.log.warn(
    config.idemixMspIds.length
      ? `Started with WEFT_EXPERIMENTAL=1, for Weft Experimental. It accepts idemix signers from ${config.idemixMspIds.join(", ")}, and logs a request only once it knows the signer is X.509.`
      : "Started with WEFT_EXPERIMENTAL=1, for Weft Experimental, with no voter MSPs in WEFT_IDEMIX_MSP_IDS, so it accepts no idemix signers.",
  );
  for (const id of config.voterInvites.keys()) {
    const path = `/.well-known/weft-voter-invite/${id}.json`;
    app.log.info(`Voter invite for ${id}: ${config.publicUrl ? `${config.publicUrl}${path}` : path}`);
  }
}
if (config.invite && config.publicUrl) {
  const links = inviteLinks(`${config.publicUrl}/.well-known/weft-invite.json`, config.joinPage);
  app.log.info(`Invite for ${config.invite.mspId}: ${links.join}`);
} else if (config.invite) {
  app.log.info("Serving an invite at /.well-known/weft-invite.json (set WEFT_PUBLIC_URL to print share links)");
}
