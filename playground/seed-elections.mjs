#!/usr/bin/env node
/**
 * Seeds the playground's ballot contract with two elections, so the
 * explorers have something to show and the docs playground has something to
 * vote in:
 *
 *   team-lunch   closed, with a published tally (four ballots)
 *   board-2026   open for 30 days, with two ballots from Org2
 *
 * Org1's User1 and Admin vote in team-lunch only, so Org1's demo users (alice,
 * bob) can still vote in board-2026 from Weft. Safe to run again: elections
 * and ballots that already exist are kept.
 *
 *   node playground/seed-elections.mjs <peerOrganizations folder> [receipts.json]
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createPrivateKey, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The explorer already depends on the Fabric Gateway client.
const require = createRequire(join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "apps/explorer/package.json"));
const grpc = require("@grpc/grpc-js");
const { connect, signers } = require("@hyperledger/fabric-gateway");

const [organizations, receiptsFile] = process.argv.slice(2);
if (!organizations) {
  console.error("Usage: node playground/seed-elections.mjs <peerOrganizations folder> [receipts.json]");
  process.exit(1);
}
const CHANNEL = "mychannel";
const PEERS = { org1: { msp: "Org1MSP", port: 7051 }, org2: { msp: "Org2MSP", port: 9051 } };
const decode = (bytes) => new TextDecoder().decode(bytes);
const only = (dir) => join(dir, readdirSync(dir).filter((f) => !f.startsWith("."))[0]);

function gateway(org, user) {
  const base = join(organizations, `${org}.example.com`);
  const { msp, port } = PEERS[org];
  const client = new grpc.Client(
    `localhost:${port}`,
    grpc.credentials.createSsl(readFileSync(join(base, "peers", `peer0.${org}.example.com`, "tls", "ca.crt"))),
    { "grpc.ssl_target_name_override": `peer0.${org}.example.com` },
  );
  const userMsp = join(base, "users", `${user}@${org}.example.com`, "msp");
  const gw = connect({
    client,
    identity: { mspId: msp, credentials: readFileSync(only(join(userMsp, "signcerts"))) },
    signer: signers.newPrivateKeySigner(createPrivateKey(readFileSync(only(join(userMsp, "keystore"))))),
  });
  return { msp, contract: gw.getNetwork(CHANNEL).getContract("ballot"), close: () => (gw.close(), client.close()) };
}

/** The contract's own message, from wherever the Gateway put it. */
const reason = (error) => [error?.message, ...(error?.details ?? []).map((d) => d.message)].filter(Boolean).join(" ");

async function create(id, title, options, closesAt) {
  const admin = gateway("org1", "Admin");
  try {
    await admin.contract.submit("CreateElection", { arguments: [id, title, JSON.stringify(options), closesAt.toISOString()] });
    console.log(`    created ${id}`);
    return true;
  } catch (error) {
    if (!/already exists/.test(reason(error))) throw error;
    console.log(`    ${id} already exists`);
    return false;
  } finally {
    admin.close();
  }
}

async function vote(id, org, user, option) {
  const voter = gateway(org, user);
  const salt = randomBytes(16).toString("hex");
  try {
    const result = await voter.contract.submitAsync("CastVote", {
      arguments: [id],
      transientData: { ballot: JSON.stringify({ option, salt }) },
      endorsingOrganizations: [voter.msp],
    });
    const status = await result.getStatus();
    if (!status.successful) throw new Error(`CastVote for ${id} wasn't committed (code ${status.code}).`);
    console.log(`    ${user}@${org} voted in ${id}`);
    return { ...JSON.parse(decode(result.getResult())), option, salt, voter: `${user}@${org}` };
  } catch (error) {
    if (!/already voted|has closed/.test(reason(error))) throw error;
    return null;
  } finally {
    voter.close();
  }
}

async function close(id) {
  const admin = gateway("org1", "Admin");
  try {
    const election = JSON.parse(decode(await admin.contract.evaluate("GetElection", { arguments: [id] })));
    if (election.state === "closed") return;
    const wait = Date.parse(election.closesAt) - Date.now() + 2000;
    if (wait > 0) {
      console.log(`    counting ${id} when voting closes, in ${Math.ceil(wait / 1000)} s`);
      await new Promise((r) => setTimeout(r, wait));
    }
    const closed = JSON.parse(decode(await admin.contract.submit("CloseElection", { arguments: [id] })));
    console.log(`    ${id} closed: ${Object.entries(closed.tally.counts).map(([o, n]) => `${o} ${n}`).join(", ")}`);
  } finally {
    admin.close();
  }
}

const receipts = [];
const keep = (r) => r && receipts.push(r);

await create("team-lunch", "Where should the team have lunch?", ["Noodles", "Tacos", "Salad"], new Date(Date.now() + 20_000));
keep(await vote("team-lunch", "org1", "User1", "Noodles"));
keep(await vote("team-lunch", "org2", "User1", "Tacos"));
keep(await vote("team-lunch", "org2", "Admin", "Noodles"));
keep(await vote("team-lunch", "org1", "Admin", "Salad"));

await create("board-2026", "Board chair, 2026", ["Ada", "Grace", "Linus"], new Date(Date.now() + 30 * 24 * 3600_000));
keep(await vote("board-2026", "org2", "User1", "Grace"));
keep(await vote("board-2026", "org2", "Admin", "Ada"));

await close("team-lunch");

if (receiptsFile && receipts.length) {
  let previous = [];
  try {
    previous = JSON.parse(readFileSync(receiptsFile, "utf8"));
  } catch {}
  writeFileSync(receiptsFile, `${JSON.stringify([...previous, ...receipts], null, 2)}\n`);
}
