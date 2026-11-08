#!/usr/bin/env node
/**
 * The Weft playground stack: a local Fabric network you can point Weft at.
 *
 *   pnpm playground:up      start everything (first run downloads Fabric, 5 to 10 min)
 *   pnpm playground:up --https
 *                           the same, but the CA proxy serves HTTPS with a mkcert
 *                           certificate, so the CA URL looks like production's
 *   pnpm playground:up --experimental
 *                           also sets up Weft Experimental's channels (docs/adr/0009,
 *                           experimental.mjs); needs Go. Combines with --https
 *   pnpm playground:explorer
 *                           start (or restart) only the explorer, on a running stack
 *   pnpm playground:count <election> [--channel <channel>] [--accept-extra-credentials]
 *                           with --experimental: closes the election early with both
 *                           trustees, decrypts it and prints the counts. --channel
 *                           counts one that isn't in experimental.mjs's list. For an
 *                           election with voter credentials, it refuses while a voter
 *                           ID holds more than one credential, unless given
 *                           --accept-extra-credentials
 *   pnpm playground:credentials <election>
 *                           with --experimental: the credentials an election's voters'
 *                           CA has issued, per enrolment ID (D14 of the step 5 plan)
 *   pnpm playground:status  what's running
 *   pnpm playground:down    stop everything and remove the network
 *
 * What "up" does:
 *   1. Gets Fabric's samples, binaries and images (pinned versions below), or
 *      uses an existing fabric-samples checkout from WEFT_FABRIC_SAMPLES.
 *   2. Starts test-network with CAs, creates `mychannel`, deploys the
 *      asset-transfer `basic` contract and Weft's ballot contract
 *      (examples/ballot-contract) with its private collection.
 *   3. Creates a second channel, `members`, with the basic contract, which
 *      both explorers publish to signed-in members only.
 *   4. Registers demo users in Org1 with known secrets.
 *   5. Starts a proxy in front of Org1's CA on http://localhost, so the
 *      browser can enrol without trusting the CA's self-signed certificate.
 *      With --https it serves https://localhost:7443 instead, using a
 *      certificate from mkcert, whose root your system already trusts.
 *   6. Starts the Weft relay for Org1, serving the playground invite.
 *   7. Starts an explorer for each organisation, reading as its User1,
 *      publishing what explorer.yaml / explorer-org2.yaml allow, and
 *      cross-checking with the other.
 *   8. Seeds two elections (seed-elections.mjs), one counted and one open,
 *      and the members channel's starting assets (seed-members.mjs).
 *
 * With --experimental, after step 5 (experimental.mjs): a voters' CA for
 * each election with voter credentials, in Docker like test-network's CAs
 * (compose-voters-ca.yaml), with a proxy for the browser in front of it
 * (ca-proxy.mjs --voters-only), a channel for each election,
 * privatevote-<election id>, with the election's idemix organisation if it
 * has one (privatevote-budget-2027 has none; privatevote-chair-2027 has
 * ChairVoters2027MSP), and the private-ballot contract on each channel,
 * deployed with deployCC -ccl go. The relay and the explorers then start
 * with WEFT_EXPERIMENTAL=1, the relay accepting idemix signers from each
 * voter MSP and serving each election's voter invite, and the invite and
 * explorers include every election's channel. After step 8, a trustee
 * identity at each organisation's CA, and budget-2027 and chair-2027
 * created, their key ceremonies run and opened with weft-trustee, and the
 * count of chair-2027's credentials.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { productUrl } from "../packages/brand/products.mjs";
import * as experimentalNetwork from "./experimental.mjs";

const FABRIC_VERSION = "2.5.16";
const CA_VERSION = "1.5.17";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");
const state = join(here, ".state");
const samples = resolve(process.env.WEFT_FABRIC_SAMPLES ?? join(here, ".fabric", "fabric-samples"));
const testNetwork = join(samples, "test-network");
const org1 = join(testNetwork, "organizations", "peerOrganizations", "org1.example.com");

const PORTS = { relay: 8787, caProxy: 7080, caProxyHttps: 7443, explorer: 8790, explorerOrg2: 8791 };
/** The local addresses of Weft's sites, as their dev servers serve them. */
const local = (id, path = "/") => productUrl(id, { dev: true, path });
const CHANNEL = "mychannel";
/** Published to members only, for trying sign-in on the explorers and the network page. */
const MEMBERS_CHANNEL = "members";
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

function stopBackground(name, { quiet = false } = {}) {
  const pid = runningPid(name);
  if (pid) {
    process.kill(pid);
    if (!quiet) console.log(`  stopped ${name} (pid ${pid})`);
  }
  rmSync(pidFile(name), { force: true });
}

/* ------------------------------------------------------------------ */
/* Steps                                                               */
/* ------------------------------------------------------------------ */

function checkPrerequisites({ https, experimental }) {
  step(0, "Checking prerequisites");
  if (!has("docker")) fail("Docker is required.", "Install Docker Desktop or OrbStack, then run this again.");
  if (spawnSync("docker", ["info"], { stdio: "ignore" }).status !== 0) {
    fail("Docker is installed but not running.", "Start Docker Desktop or OrbStack, then run this again.");
  }
  if (!has("git")) fail("git is required to fetch fabric-samples.");
  if (!has("curl")) fail("curl is required to download Fabric.");
  if (https && !has("mkcert")) {
    fail(
      "--https needs mkcert, which isn't installed.",
      "Install it (macOS: brew install mkcert; others: https://github.com/FiloSottile/mkcert), " +
        "or run pnpm playground:up without --https: the CA proxy then serves http://localhost:7080, " +
        "which needs no certificate.",
    );
  }
  note(https ? "docker, git, curl and mkcert found" : "docker, git and curl found");
  if (experimental) {
    note(experimentalNetwork.checkGo({ fail }));
    experimentalNetwork.checkElections({ fail });
  }
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
  step(2, "Test network, channel and the basic contract");
  if (containerRunning("peer0.org1.example.com")) {
    note("test-network is already running; keeping it (run playground:down to reset)");
    return;
  }
  const env = { ...process.env, PATH: `${join(samples, "bin")}:${process.env.PATH}` };
  // A new network has none of the old one's contracts or channels.
  rmSync(join(state, "ballot-deployed"), { force: true });
  rmSync(join(state, "members-channel"), { force: true });
  // The trustee identities belong to the old network's CAs, and their state to its elections.
  const x = experimentalNetwork.paths(state);
  for (const path of [x.channels, x.trustees, ...x.legacy]) rmSync(path, { recursive: true, force: true });
  run("./network.sh", ["down"], { cwd: testNetwork, env });
  run("./network.sh", ["up", "createChannel", "-c", CHANNEL, "-ca"], { cwd: testNetwork, env });
  run(
    "./network.sh",
    ["deployCC", "-c", CHANNEL, "-ccn", "basic", "-ccp", "../asset-transfer-basic/chaincode-typescript", "-ccl", "typescript"],
    { cwd: testNetwork, env },
  );
}

/** The ballot contract, deployed once per network. A marker in .state records it. */
function deployBallot() {
  step(3, "Ballot contract");
  const marker = join(state, "ballot-deployed");
  if (existsSync(marker)) {
    note("already deployed on this network");
    return;
  }
  const env = { ...process.env, PATH: `${join(samples, "bin")}:${process.env.PATH}` };
  const source = join(repo, "examples", "ballot-contract");
  run(
    "./network.sh",
    [
      "deployCC", "-c", CHANNEL, "-ccn", "ballot", "-ccp", source, "-ccl", "typescript",
      // Either organisation's peer can endorse a ballot; the private collection
      // is shared by both, so either can count.
      "-ccep", "OR('Org1MSP.peer','Org2MSP.peer')",
      "-cccg", join(source, "collections_config.json"),
    ],
    { cwd: testNetwork, env },
  );
  writeFileSync(marker, new Date().toISOString());
}

/** The members-only channel, created once per network. A marker in .state records it. */
function createMembersChannel() {
  step(4, "Members-only channel");
  const marker = join(state, "members-channel");
  if (existsSync(marker)) {
    note(`${MEMBERS_CHANNEL} already exists on this network`);
    return;
  }
  const env = { ...process.env, PATH: `${join(samples, "bin")}:${process.env.PATH}` };
  run("./network.sh", ["createChannel", "-c", MEMBERS_CHANNEL], { cwd: testNetwork, env });
  run(
    "./network.sh",
    ["deployCC", "-c", MEMBERS_CHANNEL, "-ccn", "basic", "-ccp", "../asset-transfer-basic/chaincode-typescript", "-ccl", "typescript"],
    { cwd: testNetwork, env },
  );
  writeFileSync(marker, new Date().toISOString());
}

function seedElections() {
  step(9, "Elections and the members-only channel's assets");
  const organizations = join(testNetwork, "organizations", "peerOrganizations");
  const result = spawnSync(process.execPath, [join(here, "seed-elections.mjs"), organizations, join(state, "receipts.json")], {
    stdio: "inherit",
  });
  // The playground works without them, so a failure here isn't fatal.
  if (result.status !== 0) note("couldn't seed the elections; see the output above. Everything else is running.");
  const members = spawnSync(process.execPath, [join(here, "seed-members.mjs"), organizations], { stdio: "inherit" });
  if (members.status !== 0) note(`couldn't seed ${MEMBERS_CHANNEL}; see the output above. Everything else is running.`);
}

function registerUsers() {
  step(5, "Demo users");
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

let mkcertMade = null;
/**
 * A localhost certificate signed by mkcert's root, which `mkcert -install`
 * adds to the system's trust store. Made once per run, for Org1's CA proxy
 * and the voters' CA proxies.
 */
function mkcertCertificate() {
  if (mkcertMade) return mkcertMade;
  const cert = join(state, "ca-proxy.pem");
  const key = join(state, "ca-proxy-key.pem");
  note("making sure mkcert's root is trusted (may ask for your password the first time)");
  run("mkcert", ["-install"]);
  if (!existsSync(cert) || !existsSync(key)) {
    run("mkcert", ["-cert-file", cert, "-key-file", key, "localhost", "127.0.0.1", "::1"]);
  }
  mkcertMade = { cert, key };
  return mkcertMade;
}

function startCaProxy({ https }) {
  step(6, "Proxy for Org1's CA");
  const upstream = [
    "--target", "https://localhost:7054",
    "--upstream-ca", join(testNetwork, "organizations", "fabric-ca", "org1", "ca-cert.pem"),
  ];
  if (https) {
    const { cert, key } = mkcertCertificate();
    startBackground("ca-proxy", join(here, "ca-proxy.mjs"), [
      "--listen", String(PORTS.caProxyHttps), ...upstream, "--cert", cert, "--key", key,
    ]);
    return { port: PORTS.caProxyHttps, url: `https://localhost:${PORTS.caProxyHttps}` };
  }
  // The test network's CA serves HTTPS with a certificate browsers don't trust,
  // and the extension can't be told to trust it. The proxy talks HTTPS to the
  // CA (verifying it against the CA root) and serves plain HTTP on localhost,
  // which browsers allow without any certificate.
  startBackground("ca-proxy", join(here, "ca-proxy.mjs"), ["--listen", String(PORTS.caProxy), ...upstream]);
  return { port: PORTS.caProxy, url: `http://localhost:${PORTS.caProxy}` };
}

async function startRelay(caUrl, { experimental, https, restartReason }) {
  step(7, "Weft relay for Org1");
  // Built every time, with the packages it uses: the stack runs the built
  // code, as production does, and an old build would hide your changes.
  note("building the relay");
  run("pnpm", ["--filter", "@weftwallet/relay...", "build"], { cwd: repo });
  const invite = {
    weft: 1,
    network: "Weft playground",
    organization: "Org1",
    mspId: "Org1MSP",
    caUrl,
    caName: "ca-org1",
    relayUrl: `http://localhost:${PORTS.relay}`,
    explorerUrl: `http://localhost:${PORTS.explorer}`,
    channels: [CHANNEL, MEMBERS_CHANNEL, ...(experimental ? experimentalNetwork.privateChannels() : [])],
  };
  writeFileSync(join(state, "invite.json"), `${JSON.stringify(invite, null, 2)}\n`);
  // Experimental: each election's voter invite, served by this relay (docs/adr/0008).
  const relayUrl = `http://localhost:${PORTS.relay}`;
  const voterInvites = experimental
    ? experimentalNetwork.writeVoterInvites(testNetworkLayout(), state, { relayUrl, explorerUrl: `http://localhost:${PORTS.explorer}`, https })
    : [];
  if (restartReason) note(restartReason);
  else if (voterInvites.length && runningPid("relay")) {
    note(`the voter invite${voterInvites.length === 1 ? "" : "s"} for ${voterInvites.join(", ")} changed, so the relay restarts to serve ${voterInvites.length === 1 ? "it" : "them"}`);
    stopBackground("relay");
    await new Promise((r) => setTimeout(r, 500));
  }
  startBackground("relay", join(repo, "apps", "relay", "dist", "main.js"), [], {
    PORT: String(PORTS.relay),
    WEFT_PEER_ENDPOINT: "localhost:7051",
    WEFT_PEER_HOST_ALIAS: "peer0.org1.example.com",
    WEFT_PEER_TLS_CA_CERT: join(org1, "peers", "peer0.org1.example.com", "tls", "ca.crt"),
    WEFT_INVITE_FILE: join(state, "invite.json"),
    WEFT_PUBLIC_URL: `http://localhost:${PORTS.relay}`,
    WEFT_JOIN_PAGE: local("site", "/join/"),
    // Experimental: only the relay of the experimental stack accepts idemix
    // signers, from each election's voter MSP, and keeps no request logs for
    // them (docs/adr/0008).
    ...(experimental
      ? {
          WEFT_EXPERIMENTAL: "1",
          WEFT_IDEMIX_MSP_IDS: experimentalNetwork.voterMspIds(),
          ...(experimentalNetwork.voterElections().length ? { WEFT_VOTER_INVITES: experimentalNetwork.paths(state).voterInvites } : {}),
        }
      : {}),
  });
  await waitFor(`http://localhost:${PORTS.relay}/v1/health`, "The relay");
  ensureStillRunning("relay");
  if (experimental) {
    for (const e of experimentalNetwork.voterElections()) note(`voter invite for ${e.id}: ${voterInviteUrl(e)}`);
  }
}

/** Where the relay serves an election's voter invite. */
const voterInviteUrl = (e) => `http://localhost:${PORTS.relay}/.well-known/weft-voter-invite/${e.id}.json`;

/**
 * An explorer's policy file. For the experimental stack, a copy in .state
 * that also publishes every election's channel, with its private elections.
 */
function explorerPolicy(o, experimental) {
  const policy = join(here, o.policy);
  if (!experimental) return policy;
  const copy = join(state, `${o.name}-experimental.yaml`);
  const text = readFileSync(policy, "utf8").trimEnd();
  writeFileSync(copy, `${text}\n  # Experimental (docs/adr/0009), added by pnpm playground:up --experimental.\n${experimentalNetwork.privatePolicy(o.name)}`);
  return copy;
}

/** Fabric's test-network as experimental.mjs needs it: the same paths and ports network.sh uses. */
function testNetworkLayout() {
  const organizations = join(testNetwork, "organizations");
  const ordererOrg = join(organizations, "ordererOrganizations", "example.com");
  const orderer = join(ordererOrg, "orderers", "orderer.example.com", "tls");
  const peerOrg = (n, port, caPort) => {
    const dir = join(organizations, "peerOrganizations", `org${n}.example.com`);
    return {
      msp: `Org${n}MSP`,
      mspDir: join(dir, "msp"),
      adminMsp: join(dir, "users", `Admin@org${n}.example.com`, "msp"),
      peers: [
        {
          address: `localhost:${port}`,
          hostAlias: `peer0.org${n}.example.com`,
          tlsCa: join(dir, "tlsca", `tlsca.org${n}.example.com-cert.pem`),
          anchor: { host: `peer0.org${n}.example.com`, port },
        },
      ],
      // test-network's CA for the organisation, and the home where registerEnroll.sh enrolled its registrar.
      ca: { url: `https://localhost:${caPort}`, name: `ca-org${n}`, tlsCa: join(organizations, "fabric-ca", `org${n}`, "ca-cert.pem"), registrar: dir },
    };
  };
  return {
    bin: join(samples, "bin"),
    peerConfig: join(samples, "config"),
    orderer: {
      msp: "OrdererMSP",
      mspDir: join(ordererOrg, "msp"),
      endpoints: ["orderer.example.com:7050"],
      consenters: [{ host: "orderer.example.com", port: 7050, cert: join(orderer, "server.crt") }],
      tlsCa: join(ordererOrg, "tlsca", "tlsca.example.com-cert.pem"),
      admins: [{ address: "localhost:7053", tls: { cert: join(orderer, "server.crt"), key: join(orderer, "server.key") } }],
    },
    orgs: [peerOrg(1, 7051, 7054), peerOrg(2, 9051, 8054)],
  };
}

/* ------------------------------------------------------------------ */
/* Experimental: the voters' CAs, in Docker                            */
/* ------------------------------------------------------------------ */

/**
 * One voters' CA per election with voter credentials (experimental.mjs, ELECTIONS), each run
 * from compose-voters-ca.yaml as its own Compose project, with the same image
 * as test-network's CAs. The variables fill in the election's names and ports.
 */
const VOTERS_CA_COMPOSE = join(here, "compose-voters-ca.yaml");
/** Set on every voters' CA container in compose-voters-ca.yaml. */
const VOTERS_CA_LABEL = "service=weft-voters-ca";
const votersCaContainer = (election) => `ca_voters_${election.id.replace(/-/g, "_")}`;

function votersCaCompose(election, home = experimentalNetwork.paths(state).election(election).home) {
  return {
    args: ["compose", "-f", VOTERS_CA_COMPOSE, "-p", `weft-voters-${election.id}`],
    env: {
      ...process.env,
      VOTERS_CA_CONTAINER: votersCaContainer(election),
      VOTERS_CA_NAME: election.voterOrg.ca.name,
      VOTERS_CA_PORT: String(election.voterOrg.ca.port),
      VOTERS_CA_OPERATIONS_PORT: String(election.voterOrg.ca.operations),
      VOTERS_CA_HOME: home,
    },
  };
}

/** Starts an election's voters' CA, with its home mounted from .state, unless it's already running. */
function startVotersCaContainer(election, home) {
  const container = votersCaContainer(election);
  if (containerRunning(container)) note(`${container} already running`);
  else {
    const compose = votersCaCompose(election, home);
    run("docker", [...compose.args, "up", "-d"], { env: compose.env });
    note(`${container} started, with its home in .state/voters-ca/${election.id}/server`);
  }
  return { logs: `docker logs ${container}` };
}

/** Stops and removes every voters' CA container, including those of elections no longer listed. */
function stopVotersCaContainers() {
  if (!has("docker")) return;
  const containers = () => spawnSync("docker", ["ps", "-aq", "--filter", `label=${VOTERS_CA_LABEL}`], { encoding: "utf8" }).stdout?.trim() ?? "";
  if (!containers()) return;
  for (const election of experimentalNetwork.voterElections()) {
    const compose = votersCaCompose(election);
    spawnSync("docker", [...compose.args, "down", "--volumes", "--remove-orphans"], { env: compose.env, stdio: "ignore" });
  }
  const left = containers();
  if (left) spawnSync("docker", ["rm", "-f", ...left.split("\n")], { stdio: "ignore" });
  console.log("  stopped the voters' CAs");
}

/**
 * Removes the experimental files in .state. On Linux the voters' CA
 * containers write their homes as root, so if removing them fails, they're
 * removed from inside a container, as network.sh removes test-network's CA files.
 */
function cleanExperimental() {
  try {
    experimentalNetwork.clean(state);
  } catch {
    const dir = experimentalNetwork.paths(state).votersCa;
    spawnSync("docker", ["run", "--rm", "-v", `${dir}:/data`, "hyperledger/fabric-ca:latest", "sh", "-c", "rm -rf /data/*"], { stdio: "ignore" });
    try {
      experimentalNetwork.clean(state);
    } catch (error) {
      note(`couldn't remove ${dir} (${error.code ?? error.message}); delete it by hand`);
    }
  }
}

/**
 * A contract on one of the experimental channels, with test-network's
 * deployCC. For Go, deployCC runs go mod vendor in the contract's folder and
 * the peer builds it in Docker with fabric-ccenv.
 */
function deployContract({ channel, name, path, language, version, sequence, policy }) {
  const env = { ...process.env, PATH: `${join(samples, "bin")}:${process.env.PATH}` };
  run(
    "./network.sh",
    ["deployCC", "-c", channel, "-ccn", name, "-ccp", path, "-ccl", language, "-ccv", version, "-ccs", String(sequence), "-ccep", policy],
    { cwd: testNetwork, env },
  );
}

/** Whether something other than the named background process answers on a local port. */
async function portTaken(port) {
  return new Promise((done) => {
    const socket = connect(port, "localhost")
      .once("connect", () => (socket.end(), done(true)))
      .once("error", () => done(false));
  });
}

/** The mkcert certificate the CA proxies serve with --https, set by up. */
let proxyTls = null;

/**
 * An election's voters' CA proxy (ca-proxy.mjs --voters-only), as a
 * background process like Org1's CA proxy, on the port in its ELECTIONS
 * entry. Returns whether it started now, and its URL.
 */
async function startVotersCaProxy(election) {
  const name = experimentalNetwork.caProxyName(election);
  const url = experimentalNetwork.caProxyUrl(election, { https: Boolean(proxyTls) });
  if (runningPid(name)) return { started: false, url };
  const { port } = { port: election.voterOrg.ca.proxy };
  if (await portTaken(port)) {
    fail(
      `The proxy for ${election.voterOrg.ca.name} couldn't listen on ${port}: the port is in use.`,
      `Stop what uses it, or give ${election.id} another ca.proxy port in ELECTIONS in playground/experimental.mjs.`,
    );
  }
  const log = openSync(join(state, `${name}.log`), "a");
  const child = spawn(process.execPath, [join(here, "ca-proxy.mjs"), ...experimentalNetwork.caProxyArgs(state, election, proxyTls)], {
    detached: true,
    stdio: ["ignore", log, log],
  });
  child.unref();
  writeFileSync(pidFile(name), String(child.pid));
  await waitForPort(port, `The proxy for ${election.voterOrg.ca.name}`);
  ensureStillRunning(name);
  return { started: true, url };
}

/** Stops every voters' CA proxy, including those of elections no longer listed. */
function stopVotersCaProxies() {
  if (!existsSync(state)) return;
  for (const file of readdirSync(state).filter((f) => /^ca-proxy-.+\.pid$/.test(f))) stopBackground(file.replace(/\.pid$/, ""));
}

/** What experimental.mjs uses from this file. */
const tools = { step, note, fail, startCaServer: startVotersCaContainer, startCaProxy: startVotersCaProxy, deployContract };

/**
 * Two explorers, one per organisation, each reading from its own peer and
 * comparing signed checkpoints with the other (docs/adr/0004, phase 3).
 */
async function startExplorer(stepNumber = 8, { experimental = false } = {}) {
  step(stepNumber, "Explorers for Org1 and Org2");
  // Built every time, with the packages it uses: the stack runs the built
  // code, as production does, and an old build would hide your changes.
  note("building the explorer");
  run("pnpm", ["--filter", "@weftwallet/explorer...", "build"], { cwd: repo });
  const orgs = [
    { name: "explorer", org: "org1", msp: "Org1MSP", peer: 7051, port: PORTS.explorer, other: PORTS.explorerOrg2, policy: "explorer.yaml" },
    { name: "explorer-org2", org: "org2", msp: "Org2MSP", peer: 9051, port: PORTS.explorerOrg2, other: PORTS.explorer, policy: "explorer-org2.yaml" },
  ];
  for (const o of orgs) {
    const orgDir = join(testNetwork, "organizations", "peerOrganizations", `${o.org}.example.com`);
    const user = join(orgDir, "users", `User1@${o.org}.example.com`, "msp");
    startBackground(o.name, join(repo, "apps", "explorer", "dist", "main.js"), [], {
      PORT: String(o.port),
      WEFT_PEER_ENDPOINT: `localhost:${o.peer}`,
      WEFT_PEER_HOST_ALIAS: `peer0.${o.org}.example.com`,
      WEFT_PEER_TLS_CA_CERT: join(orgDir, "peers", `peer0.${o.org}.example.com`, "tls", "ca.crt"),
      WEFT_EXPLORER_MSP_ID: o.msp,
      WEFT_EXPLORER_CERT: join(user, "signcerts"),
      WEFT_EXPLORER_KEY: join(user, "keystore"),
      WEFT_EXPLORER_POLICY: explorerPolicy(o, experimental),
      WEFT_EXPLORER_DB: join(state, `${o.name}.db`),
      WEFT_EXPLORER_PEERS: `http://localhost:${o.other}`,
      // Block pages link to the network page; the local one can reach local explorers.
      WEFT_EXPLORER_NETWORK_PAGE: local("network"),
      // The switcher, the footer and "Get Weft" link to the local sites too.
      WEFT_EXPLORER_PRODUCTS_DOMAIN: "dev",
      NODE_OPTIONS: "--disable-warning=ExperimentalWarning",
      ...(experimental ? { WEFT_EXPERIMENTAL: "1" } : {}),
    });
  }
  for (const o of orgs) {
    await waitFor(`http://localhost:${o.port}/api/v1/status`, `The ${o.msp} explorer`);
    ensureStillRunning(o.name);
  }
}

function summary(caUrl, { experimental, states, https }) {
  const inviteUrl = `http://localhost:${PORTS.relay}/.well-known/weft-invite.json`;
  const playground = local("playground", `/?invite=${encodeURIComponent(inviteUrl)}`);
  console.log(`
${bold("Weft playground is running.")}

  Invite      ${inviteUrl}
  Relay       http://localhost:${PORTS.relay}
  Explorers   http://localhost:${PORTS.explorer} (Org1), http://localhost:${PORTS.explorerOrg2} (Org2)
  Org1 CA     ${caUrl}
  Channels    ${CHANNEL} (public), contracts ${bold("basic")} and ${bold("ballot")}
              ${MEMBERS_CHANNEL} (members only), contract ${bold("basic")}
  Elections   team-lunch (counted), board-2026 (open)
${experimental ? experimentalSummary(states, { https }) : ""}
  Demo users (Org1):
${DEMO_USERS.map((u) => `    ${u.id.padEnd(8)} secret ${u.secret.padEnd(10)} ${dim(u.attrs.replace(":ecert", ""))}`).join("\n")}

Next:
  1. ${bold("pnpm dev:playground")} in another terminal, and ${bold("pnpm dev:network")} for Weft Network
  2. Open ${teal(playground)}
  3. Join with Weft as one of the demo users, then run InitLedger
  4. Vote in board-2026 from the same page, and check your receipt in the explorer
  5. Compare the two explorers: Org2 publishes less, and both agree on every block
  6. Sign in on Weft Network, ${teal(local("network"))}, to see ${MEMBERS_CHANNEL}, the members-only channel

Stop with ${bold("pnpm playground:down")}.
`);
}

function experimentalSummary(states = new Map(), { https = false } = {}) {
  const x = experimentalNetwork;
  const voterElections = x.voterElections();
  const label = (e) => {
    const st = states.get(e.id);
    return `${e.id} (${st ?? "not seeded"}${e.voterOrg && st ? ", anonymous voters" : ""})`;
  };
  // The election to suggest counting: an open one, with voter credentials if there is one.
  const open = x.ELECTIONS.filter((e) => states.get(e.id) === "open");
  const toCount = open.find((e) => e.voterOrg) ?? open[0] ?? x.ELECTIONS[0];
  const lines = [
    "",
    `  ${bold("Experimental")} (Weft Experimental only, not part of Weft)`,
    ...x.ELECTIONS.map((e) => `  Channel     ${x.electionChannel(e)}: Org1MSP and Org2MSP endorse, ${e.voterOrg ? `with ${e.voterOrg.mspId}, for ${e.id} with voter credentials` : `for ${e.id} with X.509 voters`}`),
    ...voterElections.flatMap((e) => [
      `  Voters' CA  ${e.id}: https://localhost:${e.voterOrg.ca.port}, CA ${e.voterOrg.ca.name}, MSP ${e.voterOrg.mspId}`,
      `              for the browser: ${x.caProxyUrl(e, { https })}`,
    ]),
    ...voterElections.map((e) => `  Invite      ${e.id}: ${voterInviteUrl(e)}`),
    ...(voterElections.length ? [`  Voters      ${x.DEMO_VOTERS[0].id} to ${x.DEMO_VOTERS.at(-1).id} (secret <id>pw), affiliation ${x.VOTER_AFFILIATION}, one enrolment each`] : []),
    `  Contract    ${x.PRIVATE_CONTRACT} on every election's channel, endorsed by ${bold("Org1 and Org2")}`,
    "  Trustees    trustee1 (Org1MSP) and trustee2 (Org2MSP), weft.trustee=true, 2 of 2;",
    "              weft-trustee connection files in .state/trustees/<org>/<channel>.yaml",
    `  Elections   ${x.ELECTIONS.map(label).join(", ")}`,
    `  Count       ${bold(`pnpm playground:count ${toCount.id}`)} closes it early and prints the counts`,
    ...voterElections.map((e) => `  Credentials ${bold(`pnpm playground:credentials ${e.id}`)} counts what ${e.voterOrg.ca.name} has issued`),
    `  Wallet      ${bold("pnpm --filter @weftwallet/extension build:experimental")}, then load`,
    "              apps/extension/.output-experimental/chrome-mv3 in a browser profile without Weft",
    "",
  ];
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* Commands                                                            */
/* ------------------------------------------------------------------ */

async function up(flags) {
  const https = flags.includes("--https");
  const experimental = flags.includes("--experimental");
  mkdirSync(state, { recursive: true });
  checkPrerequisites({ https, experimental });
  ensureFabric();
  startNetwork();
  deployBallot();
  createMembersChannel();
  registerUsers();
  const restartReason = setExperimental(experimental);
  const net = testNetworkLayout();
  if (experimental) {
    // The voters' CA proxies serve HTTPS with the same certificate as Org1's.
    if (https) proxyTls = mkcertCertificate();
    await experimentalNetwork.startVotersCas(net, state, tools);
    await experimentalNetwork.createElectionChannels(net, state, tools);
    experimentalNetwork.deployPrivateBallot(net, state, tools);
  }
  const proxy = startCaProxy({ https });
  await waitForPort(proxy.port, "The CA proxy");
  ensureStillRunning("ca-proxy");
  await startRelay(proxy.url, { experimental, https, restartReason });
  await startExplorer(8, { experimental });
  seedElections();
  const states = experimental ? experimentalNetwork.seedElections(net, state, tools) : new Map();
  summary(proxy.url, { experimental, states, https });
}

/**
 * Records whether the stack runs the experimental setup. When that changes
 * on a running stack, the relay and the explorers restart with the new settings.
 */
function setExperimental(experimental) {
  const marker = experimentalNetwork.paths(state).marker;
  // The marker holds the voter MSP IDs and the channels the relay and the
  // explorers were started with, so a new election in ELECTIONS restarts
  // them too, with WEFT_IDEMIX_MSP_IDS, the invite and the policies updated.
  const before = existsSync(marker) ? readFileSync(marker, "utf8") : null;
  const after = experimental ? `${experimentalNetwork.voterMspIds()}\n${experimentalNetwork.privateChannels().join(",")}\n` : null;
  let reason = null;
  if (before !== after) {
    if (experimental && before !== null && runningPid("relay")) {
      reason = `the elections changed, so the relay restarts with WEFT_IDEMIX_MSP_IDS=${experimentalNetwork.voterMspIds()}`;
    }
    for (const name of ["relay", "explorer", "explorer-org2"]) stopBackground(name, { quiet: true });
    if (!experimental) {
      stopVotersCaProxies();
      stopVotersCaContainers();
    }
  }
  if (experimental) writeFileSync(marker, after);
  else rmSync(marker, { force: true });
  return reason;
}

/** The explorer alone, for a stack started before it existed or after a rebuild. */
async function explorer() {
  mkdirSync(state, { recursive: true });
  if (!existsSync(org1)) fail("The playground network isn't set up.", "Run pnpm playground:up first.");
  stopBackground("explorer");
  stopBackground("explorer-org2");
  await new Promise((r) => setTimeout(r, 500)); // let the old process free the port
  await startExplorer(1, { experimental: existsSync(experimentalNetwork.paths(state).marker) });
  console.log(`\n${bold("Explorers")} ${teal(`http://localhost:${PORTS.explorer}`)} (Org1), ${teal(`http://localhost:${PORTS.explorerOrg2}`)} (Org2)\n`);
}

function down() {
  console.log(bold("Stopping the Weft playground"));
  stopBackground("explorer");
  stopBackground("explorer-org2");
  stopBackground("relay");
  stopBackground("ca-proxy");
  stopVotersCaProxies();
  stopVotersCaContainers();
  if (existsSync(testNetwork)) {
    const env = { ...process.env, PATH: `${join(samples, "bin")}:${process.env.PATH}` };
    run("./network.sh", ["down"], { cwd: testNetwork, env });
  }
  rmSync(join(state, "invite.json"), { force: true });
  rmSync(join(state, "ballot-deployed"), { force: true });
  rmSync(join(state, "members-channel"), { force: true });
  rmSync(join(state, "receipts.json"), { force: true });
  cleanExperimental();
  // The next network starts from block 0, so the old index would be wrong.
  for (const name of ["explorer", "explorer-org2"]) {
    for (const suffix of ["", "-wal", "-shm"]) rmSync(join(state, `${name}.db${suffix}`), { force: true });
  }
  console.log("Done. Downloads in playground/.fabric are kept; delete that folder to remove them.");
}

async function status() {
  const line = (label, good, detail) => console.log(`${good ? "✓" : "✗"} ${label.padEnd(10)} ${detail}`);
  line("Network", containerRunning("peer0.org1.example.com"), "peer0.org1.example.com container");
  const proxy = runningPid("ca-proxy");
  let caUrl = `http://localhost:${PORTS.caProxy}`;
  try {
    caUrl = JSON.parse(readFileSync(join(state, "invite.json"), "utf8")).caUrl;
  } catch {}
  line("CA proxy", Boolean(proxy), proxy ? `pid ${proxy}, ${caUrl}` : "not running");
  const relayUp = await ok(`http://localhost:${PORTS.relay}/v1/health`);
  line("Relay", relayUp, `http://localhost:${PORTS.relay}`);
  line("Invite", await ok(`http://localhost:${PORTS.relay}/.well-known/weft-invite.json`), "served by the relay");
  line("Explorer", await ok(`http://localhost:${PORTS.explorer}/api/v1/status`), `http://localhost:${PORTS.explorer} (Org1)`);
  line("Explorer", await ok(`http://localhost:${PORTS.explorerOrg2}/api/v1/status`), `http://localhost:${PORTS.explorerOrg2} (Org2)`);
  if (existsSync(experimentalNetwork.paths(state).marker)) {
    for (const election of experimentalNetwork.voterElections()) {
      const container = votersCaContainer(election);
      line("Voters CA", containerRunning(container), `${container} container, https://localhost:${election.voterOrg.ca.port} (experimental, ${election.id})`);
      const proxyPid = runningPid(experimentalNetwork.caProxyName(election));
      line("CA proxy", Boolean(proxyPid), proxyPid ? `pid ${proxyPid}, port ${election.voterOrg.ca.proxy}, voters only (experimental, ${election.id})` : `not running (experimental, ${election.id})`);
      line("Invite", await ok(voterInviteUrl(election)), `voter invite for ${election.id}, served by the relay`);
    }
  }
}

/**
 * Experimental: closes an election early with both trustees, decrypts it and
 * prints the counts (experimental.mjs, countElection), so a tester sees a
 * count without waiting for its planned closing time.
 */
async function count([id, ...rest]) {
  if (!existsSync(experimentalNetwork.paths(state).marker)) {
    fail("The playground isn't running its experimental channels.", "Run pnpm playground:up --experimental first.");
  }
  if (!id || id.startsWith("--")) fail("Say which election to count.", `For example: pnpm playground:count ${experimentalNetwork.ELECTIONS[0].id}`);
  const at = rest.indexOf("--channel");
  const channel = at >= 0 ? rest[at + 1] : undefined;
  if (at >= 0 && (!channel || channel.startsWith("--"))) fail("Say which channel the election is on.", `For example: pnpm playground:count ${id} --channel privatevote-budget-2027`);
  const acceptExtraCredentials = rest.includes("--accept-extra-credentials");
  experimentalNetwork.countElection(testNetworkLayout(), state, id, tools, { channel, acceptExtraCredentials });
}

/**
 * Experimental: the credentials an election's voters' CA has issued, per
 * enrolment ID (experimental.mjs, printCredentials). Exits with status 1 when
 * a voter ID holds more than one.
 */
async function credentials([id]) {
  if (!existsSync(experimentalNetwork.paths(state).marker)) {
    fail("The playground isn't running its experimental channels.", "Run pnpm playground:up --experimental first.");
  }
  const first = experimentalNetwork.voterElections()[0];
  if (!id || id.startsWith("--")) fail("Say which election's credentials to count.", `For example: pnpm playground:credentials ${first?.id ?? "<election>"}`);
  experimentalNetwork.printCredentials(state, id, { fail });
}

const [command, ...flags] = process.argv.slice(2).filter((a) => a !== "--");
const commands = { up, down, status, explorer, count, credentials };
const unknown =
  command === "count"
    ? flags.slice(1).filter((f, i, all) => !(f === "--channel" || all[i - 1] === "--channel" || f === "--accept-extra-credentials"))
    : command === "credentials"
      ? flags.slice(1)
      : flags.filter((f) => !(command === "up" && (f === "--https" || f === "--experimental")));
if (!commands[command] || unknown.length) {
  console.log(
    "Usage: node playground/cli.mjs <up [--https] [--experimental]|count <election> [--channel <channel>] [--accept-extra-credentials]|credentials <election>|explorer|down|status>",
  );
  if (unknown.length) console.log(`Unknown option: ${unknown.join(" ")}`);
  process.exit(command ? 1 : 0);
}
await commands[command](flags);
