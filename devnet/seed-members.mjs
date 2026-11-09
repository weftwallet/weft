#!/usr/bin/env node
/**
 * Puts the asset-transfer sample's starting assets on the playground's
 * members-only channel, so its explorers have transactions to show members.
 * Safe to run again: it does nothing when assets are already there.
 *
 *   node devnet/seed-members.mjs <peerOrganizations folder>
 */
import { readdirSync, readFileSync } from "node:fs";
import { createPrivateKey } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The explorer already depends on the Fabric Gateway client.
const require = createRequire(join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "apps/explorer/package.json"));
const grpc = require("@grpc/grpc-js");
const { connect, signers } = require("@hyperledger/fabric-gateway");

const [organizations] = process.argv.slice(2);
if (!organizations) {
  console.error("Usage: node devnet/seed-members.mjs <peerOrganizations folder>");
  process.exit(1);
}
const only = (dir) => join(dir, readdirSync(dir).filter((f) => !f.startsWith("."))[0]);
const base = join(organizations, "org1.example.com");
const userMsp = join(base, "users", "User1@org1.example.com", "msp");
const client = new grpc.Client(
  "localhost:7051",
  grpc.credentials.createSsl(readFileSync(join(base, "peers", "peer0.org1.example.com", "tls", "ca.crt"))),
  { "grpc.ssl_target_name_override": "peer0.org1.example.com" },
);
const gateway = connect({
  client,
  identity: { mspId: "Org1MSP", credentials: readFileSync(only(join(userMsp, "signcerts"))) },
  signer: signers.newPrivateKeySigner(createPrivateKey(readFileSync(only(join(userMsp, "keystore"))))),
});
try {
  const basic = gateway.getNetwork("members").getContract("basic");
  const assets = JSON.parse(new TextDecoder().decode(await basic.evaluateTransaction("GetAllAssets")) || "[]");
  if (assets.length) {
    console.log("    members already has assets");
  } else {
    await basic.submitTransaction("InitLedger");
    console.log("    InitLedger on members");
  }
} finally {
  gateway.close();
  client.close();
}
