#!/usr/bin/env node
/**
 * The Weft playground stack: a local Fabric network you can point Weft at.
 *
 *   pnpm playground:up      start everything (first run downloads Fabric, ~5–10 min)
 *   pnpm playground:status  what's running
 *   pnpm playground:down    stop everything and remove the network
 *
 * What "up" does:
 *   1. Gets Fabric's samples, binaries and images (pinned versions below), or
 *      uses an existing fabric-samples checkout from WEFT_FABRIC_SAMPLES.
 *   2. Starts test-network with CAs, creates `mychannel`, deploys the
 *      asset-transfer `basic` contract.
 *   3. Registers demo users in Org1 with known secrets.
 *   4. Starts a proxy in front of Org1's CA on http://localhost, so the
 *      browser can enrol without trusting the CA's self-signed certificate.
 *   5. Starts the Weft relay for Org1, serving the playground invite.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FABRIC_VERSION = "2.5.16";
const CA_VERSION = "1.5.17";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");
const state = join(here, ".state");
const samples = resolve(process.env.WEFT_FABRIC_SAMPLES ?? join(here, ".fabric", "fabric-samples"));
const testNetwork = join(samples, "test-network");
const org1 = join(testNetwork, "organizations", "peerOrganizations", "org1.example.com");

const PORTS = { relay: 8787, caProxy: 7080, docs: 4321 };
const CHANNEL = "mychannel";
const DEMO_USERS = [
  { id: "alice", secret: "alicepw", attrs: "role=auditor:ecert" },
  { id: "bob", secret: "bobpw", attrs: "role=trader:ecert" },
];

/* ------------------------------------------------------------------ */
/* Output                                                              */
/* ------------------------------------------------------------------ */

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const teal = (s) => `\x1b[36m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const step = (n, text) => console.log(`\n${teal(`[${n}]`)} ${bold(text)}`);
const note = (text) => console.log(`    ${dim(text)}`);

function fail(message, hint) {
  console.error(`\n\x1b[31m✗ ${message}\x1b[0m`);
  if (hint) console.error(`  ${hint}`);
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function has(command) {
  return spawnSync(process.platform === "win32" ? "where" : "which", [command], { stdio: "ignore" }).status === 0;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.status !== 0) fail(`${command} ${args.join(" ")} failed (exit ${result.status ?? "signal"})`);
}

function containerRunning(name) {
  try {
    return execFileSync("docker", ["ps", "--format", "{{.Names}}"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split("\n")
      .includes(name);
  } catch {
    return false;
  }
}

async function ok(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitFor(url, label, seconds = 30) {
  for (let i = 0; i < seconds * 2; i++) {
    if (await ok(url)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  fail(`${label} didn't come up at ${url}`, `See ${join(state, "*.log")}`);
}

/** Waits until something accepts connections on a local port. */
async function waitForPort(port, label, seconds = 15) {
  for (let i = 0; i < seconds * 4; i++) {
    const open = await new Promise((done) => {
      const socket = connect(port, "localhost")
        .once("connect", () => (socket.end(), done(true)))
        .once("error", () => done(false));
    });
    if (open) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  fail(`${label} didn't start on port ${port}`, `See ${join(state, "*.log")}`);
}

function pidFile(name) {
  return join(state, `${name}.pid`);
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function runningPid(name) {
  if (!existsSync(pidFile(name))) return null;
  const pid = Number(readFileSync(pidFile(name), "utf8"));
  return alive(pid) ? pid : null;
}

/** Starts a long-running Node process in the background, logging to .state/<name>.log. */
function startBackground(name, script, args, env = {}) {
  const existing = runningPid(name);
  if (existing) {
    note(`${name} already running (pid ${existing})`);
    return;
  }
  const log = openSync(join(state, `${name}.log`), "a");
  const child = spawn(process.execPath, [script, ...args], {
    detached: true,
    stdio: ["ignore", log, log],
    env: { ...process.env, ...env },
  });
  child.unref();
  writeFileSync(pidFile(name), String(child.pid));
  note(`${name} started (pid ${child.pid}), log: .state/${name}.log`);
}

/**
 * A process can exit straight away (most often because its port is taken)
 * while something else answers on that port. Catch that instead of reporting success.
 */
function ensureStillRunning(name) {
  if (runningPid(name)) return;
  const log = join(state, `${name}.log`);
  const tail = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").slice(-3).join("\n  ") : "";
  fail(`${name} exited right after starting.`, `${tail}\n  Is something else already using its port?`);
}

function stopBackground(name) {
  const pid = runningPid(name);
  if (pid) {
    process.kill(pid);
    console.log(`  stopped ${name} (pid ${pid})`);
  }
  rmSync(pidFile(name), { force: true });
}

/* ------------------------------------------------------------------ */
/* Steps                                                               */
/* ------------------------------------------------------------------ */

function checkPrerequisites() {
  step(0, "Checking prerequisites");
  if (!has("docker")) fail("Docker is required.", "Install Docker Desktop or OrbStack, then run this again.");
  if (spawnSync("docker", ["info"], { stdio: "ignore" }).status !== 0) {
    fail("Docker is installed but not running.", "Start Docker Desktop or OrbStack, then run this again.");
  }
  if (!has("git")) fail("git is required to fetch fabric-samples.");
  if (!has("curl")) fail("curl is required to download Fabric.");
  note("docker, git and curl found");
}

function ensureFabric() {
  step(1, "Fabric samples, binaries and images");
  if (existsSync(join(samples, "bin", "peer")) && existsSync(testNetwork)) {
    note(`using ${samples}`);
    return;
  }
  if (process.env.WEFT_FABRIC_SAMPLES) {
    fail(`WEFT_FABRIC_SAMPLES=${samples} has no bin/peer or test-network.`, "Point it at a complete fabric-samples checkout.");
  }
  const dir = dirname(samples);
  mkdirSync(dir, { recursive: true });
  note(`downloading Fabric ${FABRIC_VERSION} and Fabric CA ${CA_VERSION} into playground/.fabric (one-time)`);
  run("curl", ["-sSLO", "https://raw.githubusercontent.com/hyperledger/fabric/main/scripts/install-fabric.sh"], { cwd: dir });
  run("bash", ["install-fabric.sh", "--fabric-version", FABRIC_VERSION, "--ca-version", CA_VERSION, "docker", "samples", "binary"], {
    cwd: dir,
  });
}

function startNetwork() {
  step(2, "Test network, channel and contract");
  if (containerRunning("peer0.org1.example.com")) {
    note("test-network is already running; keeping it (run playground:down to reset)");
    return;
  }
  const env = { ...process.env, PATH: `${join(samples, "bin")}:${process.env.PATH}` };
  run("./network.sh", ["down"], { cwd: testNetwork, env });
  run("./network.sh", ["up", "createChannel", "-c", CHANNEL, "-ca"], { cwd: testNetwork, env });
  run(
    "./network.sh",
    ["deployCC", "-c", CHANNEL, "-ccn", "basic", "-ccp", "../asset-transfer-basic/chaincode-typescript", "-ccl", "typescript"],
    { cwd: testNetwork, env },
  );
}

function registerUsers() {
  step(3, "Demo users");
  const caClient = join(samples, "bin", "fabric-ca-client");
  const tlsRoot = join(testNetwork, "organizations", "fabric-ca", "org1", "ca-cert.pem");
  for (const user of DEMO_USERS) {
    const result = spawnSync(
      caClient,
      [
        "register",
        "--caname", "ca-org1",
        "--id.name", user.id,
        "--id.secret", user.secret,
        "--id.type", "client",
        "--id.attrs", user.attrs,
        "--tls.certfiles", tlsRoot,
      ],
      { encoding: "utf8", env: { ...process.env, FABRIC_CA_CLIENT_HOME: org1 } },
    );
    const output = `${result.stdout}${result.stderr}`;
    if (result.status === 0) note(`registered ${user.id}`);
    else if (/already registered/i.test(output)) note(`${user.id} already registered`);
    else fail(`Couldn't register ${user.id}`, output.trim().split("\n").pop());
  }
}

function startCaProxy() {
  step(4, "Proxy for Org1's CA");
  // The test network's CA serves HTTPS with a certificate browsers don't trust,
  // and the extension can't be told to trust it. The proxy talks HTTPS to the
  // CA (verifying it against the CA root) and serves plain HTTP on localhost,
  // which browsers allow without any certificate.
  startBackground("ca-proxy", join(here, "ca-proxy.mjs"), [
    "--listen", String(PORTS.caProxy),
    "--target", "https://localhost:7054",
    "--upstream-ca", join(testNetwork, "organizations", "fabric-ca", "org1", "ca-cert.pem"),
  ]);
  return `http://localhost:${PORTS.caProxy}`;
}

async function startRelay(caUrl) {
  step(5, "Weft relay for Org1");
  if (!existsSync(join(repo, "apps", "relay", "dist", "main.js"))) {
    note("building the relay");
    run("pnpm", ["--filter", "@weftwallet/relay...", "build"], { cwd: repo });
  }
  const invite = {
    weft: 1,
    network: "Weft playground",
    organization: "Org1",
    mspId: "Org1MSP",
    caUrl,
    caName: "ca-org1",
    relayUrl: `http://localhost:${PORTS.relay}`,
    channels: [CHANNEL],
  };
  writeFileSync(join(state, "invite.json"), `${JSON.stringify(invite, null, 2)}\n`);
  startBackground("relay", join(repo, "apps", "relay", "dist", "main.js"), [], {
    PORT: String(PORTS.relay),
    WEFT_PEER_ENDPOINT: "localhost:7051",
    WEFT_PEER_HOST_ALIAS: "peer0.org1.example.com",
    WEFT_PEER_TLS_CA_CERT: join(org1, "peers", "peer0.org1.example.com", "tls", "ca.crt"),
    WEFT_INVITE_FILE: join(state, "invite.json"),
    WEFT_PUBLIC_URL: `http://localhost:${PORTS.relay}`,
    WEFT_JOIN_PAGE: `http://localhost:${PORTS.docs}/join/`,
  });
  await waitFor(`http://localhost:${PORTS.relay}/v1/health`, "The relay");
  ensureStillRunning("relay");
}

function summary(caUrl) {
  const inviteUrl = `http://localhost:${PORTS.relay}/.well-known/weft-invite.json`;
  const playground = `http://localhost:${PORTS.docs}/playground/?invite=${encodeURIComponent(inviteUrl)}`;
  console.log(`
${bold("Weft playground is running.")}

  Invite      ${inviteUrl}
  Relay       http://localhost:${PORTS.relay}
  Org1 CA     ${caUrl}
  Channel     ${CHANNEL}, contract ${bold("basic")}

  Demo users (Org1):
${DEMO_USERS.map((u) => `    ${u.id.padEnd(8)} secret ${u.secret.padEnd(10)} ${dim(u.attrs.replace(":ecert", ""))}`).join("\n")}

Next:
  1. ${bold("pnpm dev:docs")} in another terminal
  2. Open ${teal(playground)}
  3. Join with Weft as one of the demo users, then run InitLedger

Stop with ${bold("pnpm playground:down")}.
`);
}

/* ------------------------------------------------------------------ */
/* Commands                                                            */
/* ------------------------------------------------------------------ */

async function up() {
  mkdirSync(state, { recursive: true });
  checkPrerequisites();
  ensureFabric();
  startNetwork();
  registerUsers();
  const caUrl = startCaProxy();
  await waitForPort(PORTS.caProxy, "The CA proxy");
  ensureStillRunning("ca-proxy");
  await startRelay(caUrl);
  summary(caUrl);
}

function down() {
  console.log(bold("Stopping the Weft playground"));
  stopBackground("relay");
  stopBackground("ca-proxy");
  if (existsSync(testNetwork)) {
    const env = { ...process.env, PATH: `${join(samples, "bin")}:${process.env.PATH}` };
    run("./network.sh", ["down"], { cwd: testNetwork, env });
  }
  rmSync(join(state, "invite.json"), { force: true });
  console.log("Done. Downloads in playground/.fabric are kept; delete that folder to remove them.");
}

async function status() {
  const line = (label, good, detail) => console.log(`${good ? "✓" : "✗"} ${label.padEnd(10)} ${detail}`);
  line("Network", containerRunning("peer0.org1.example.com"), "peer0.org1.example.com container");
  const proxy = runningPid("ca-proxy");
  line("CA proxy", Boolean(proxy), proxy ? `pid ${proxy}, http://localhost:${PORTS.caProxy}` : "not running");
  const relayUp = await ok(`http://localhost:${PORTS.relay}/v1/health`);
  line("Relay", relayUp, `http://localhost:${PORTS.relay}`);
  line("Invite", await ok(`http://localhost:${PORTS.relay}/.well-known/weft-invite.json`), "served by the relay");
}

const command = process.argv[2];
const commands = { up, down, status };
if (!commands[command]) {
  console.log("Usage: node playground/cli.mjs <up|down|status>");
  process.exit(command ? 1 : 0);
}
await commands[command]();
