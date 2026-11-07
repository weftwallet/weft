/**
 * The experimental part of the playground stack (docs/adr/0009), for
 * `pnpm playground:up --experimental`. Experimental: no one outside the
 * project has reviewed what it sets up, and it isn't part of the main product.
 *
 * On top of everything `playground:up` runs, it adds, for each election in
 * ELECTIONS:
 *   1. For an election with voter credentials, a voters' Fabric CA with its
 *      own idemix issuer key (docs/adr/0008), and demo voters voter1 to voter5
 *      (affiliation `voters`, one enrolment each): for chair-2027, the CA
 *      ca-chair-2027, whose key backs ChairVoters2027MSP.
 *   2. A channel, privatevote-<election id>, created from its own genesis
 *      block: Org1MSP and Org2MSP as endorsers, and the election's idemix
 *      organisation if it has one. privatevote-budget-2027 has none, and
 *      privatevote-chair-2027 has ChairVoters2027MSP.
 *   3. The private-ballot contract (examples/private-ballot-contract,
 *      docs/adr/0007) on the channel, endorsed by Org1 and Org2, and a hook
 *      for the key ceremony and the seeded elections, which need the trustee
 *      tool (weft-trustee) and aren't built yet.
 *
 * cli.mjs passes in the network's layout (paths and addresses, for Fabric's
 * test-network), its output helpers, startCaServer, which runs a voters'
 * CA in Docker (compose-voters-ca.yaml), and deployContract, which deploys a
 * contract with test-network's deployCC. This file knows nothing about Docker.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Each election's channel is this, a hyphen and the election's ID. */
export const PRIVATE_CHANNEL_PREFIX = "privatevote";
export const PRIVATE_CONTRACT = "private-ballot";

/**
 * The playground's private elections, one entry each, in one list (D10 of
 * the step 4 plan). Each has its own channel (electionChannel), so one
 * election's voters can't read another's ballots, and closing one changes no
 * other, and each channel gets the private-ballot contract.
 *
 * An election with X.509 voters (the private tally only) has just its ID.
 * An election with voter credentials also has `voterOrg`: its idemix MSP,
 * named after it, and its voters' CA, run in its own container on its own
 * ports with its own issuer key (docs/adr/0008). Fabric recommends one idemix
 * MSP per channel, which the channel per election gives. Ports stay clear of
 * test-network's and the e2e tests'.
 *
 * An election added here gets its channel and the contract, and with
 * voterOrg its CA and MSP folder, on the next `playground:up --experimental`.
 */
export const ELECTIONS = [
  { id: "budget-2027" },
  { id: "chair-2027", voterOrg: { mspId: "ChairVoters2027MSP", ca: { name: "ca-chair-2027", port: 7058, operations: 17058 } } },
];
/** The elections with voter credentials, each with a voters' CA and an idemix organisation. */
export const voterElections = () => ELECTIONS.filter((e) => e.voterOrg);
/** The election's channel, for example privatevote-budget-2027. */
export const electionChannel = (e) => `${PRIVATE_CHANNEL_PREFIX}-${e.id}`;
/** Every election's channel, for the invite and the explorers' policies. */
export const privateChannels = () => ELECTIONS.map(electionChannel);
/** Fabric's rule for channel names. */
const CHANNEL_NAME = /^[a-z][a-z0-9.-]{0,248}$/;

/** Every voter shares one affiliation, since each ballot discloses it (docs/adr/0008). */
export const VOTER_AFFILIATION = "voters";
export const DEMO_VOTERS = [1, 2, 3, 4, 5].map((n) => ({ id: `voter${n}`, secret: `voter${n}pw` }));
/** The CA's bootstrap admin, as test-network's CAs have it. */
const CA_ADMIN = { id: "admin", secret: "adminpw" };

/** What each explorer publishes of every election's channel, added to its policy file. */
const PRIVATE_POLICY_SUBMITTER = { explorer: "show", "explorer-org2": "hide" };
export const explorerNames = Object.keys(PRIVATE_POLICY_SUBMITTER);
export const privatePolicy = (explorer) =>
  privateChannels()
    .map((channel) => `  ${channel}:\n    level: public\n    values: show\n    submitter: ${PRIVATE_POLICY_SUBMITTER[explorer]}\n    privateElections: ${PRIVATE_CONTRACT}\n`)
    .join("");

/** Files in the stack's state folder. */
export function paths(state) {
  const votersCa = join(state, "voters-ca");
  const votersMsp = join(state, "voters-msp");
  const channels = join(state, "private-channels");
  return {
    marker: join(state, "experimental"),
    /** Every election's channel files, removed with a new network. */
    channels,
    /**
     * One election's channel: its configtx.yaml and genesis block, a marker
     * once it exists, and a marker for the contract deployed on it.
     */
    channel: (e) => ({
      dir: join(channels, electionChannel(e)),
      marker: join(channels, electionChannel(e), "created"),
      contract: join(channels, electionChannel(e), `${PRIVATE_CONTRACT}.json`),
    }),
    /** What a playground from before the channel per election wrote, for playground:down. */
    legacy: [join(state, "privatevote"), join(state, "privatevote-channel")],
    votersCa,
    votersMsp,
    /**
     * An election with voter credentials: the CA's home (the container's,
     * mounted), its admin's client home, and its MSP folder.
     */
    election: (e) => ({
      home: join(votersCa, e.id, "server"),
      admin: join(votersCa, e.id, "admin"),
      msp: join(votersMsp, e.voterOrg.mspId),
    }),
  };
}

/** The voter MSP IDs, for the relay's WEFT_IDEMIX_MSP_IDS. */
export const voterMspIds = () => voterElections().map((e) => e.voterOrg.mspId).join(",");

/**
 * The contract is written in Go (docs/adr/0007), and Fabric's deployment
 * vendors its modules with the local Go. Called before anything starts.
 */
export function checkGo({ fail }) {
  const result = spawnSync("go", ["version"], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    fail(
      "--experimental needs Go, which isn't installed or isn't on your PATH.",
      "The private-ballot contract is written in Go. Install it (macOS: brew install go; others: https://go.dev/dl/), " +
        "then run this again, or run pnpm playground:up without --experimental.",
    );
  }
  return result.stdout.trim().replace(/^go version /, "");
}

/**
 * Each election's ID names its channel, so it must make a valid Fabric
 * channel name. Called before anything starts, and again before the channels.
 */
export function checkElections({ fail }) {
  const bad = ELECTIONS.find((e) => !CHANNEL_NAME.test(electionChannel(e)));
  if (bad) {
    fail(
      `The election ID ${bad.id} can't name a channel: ${electionChannel(bad)} isn't a valid Fabric channel name.`,
      "Use lower-case letters, digits, dots and hyphens, starting with a letter, in ELECTIONS in playground/experimental.mjs.",
    );
  }
}

function capture(command, args, env = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", env: { ...process.env, ...env } });
  return { ok: result.status === 0, output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}

const lastLine = (output) => output.split("\n").pop();

/**
 * The voters' CAs, one per election. startCaServer starts each with its home
 * in .state/voters-ca/<election>/server, where `fabric-ca-server` writes the
 * idemix issuer keys (IssuerPublicKey, IssuerRevocationPublicKey) the first
 * time it starts. That home is kept until playground:down, so each election's
 * key stays the one in the channel. The admin and the voters are then set up
 * with fabric-samples' fabric-ca-client, as test-network sets up its users.
 */
export async function startVotersCas(net, state, tools) {
  const { step, note } = tools;
  const elections = voterElections();
  step("E1", `Experimental: the voters' CA${elections.length === 1 ? "" : "s"}, with an idemix issuer key for each election with voter credentials`);
  if (!elections.length) note("no election in ELECTIONS has voter credentials");
  for (const election of elections) await startVotersCa(election, net, state, tools);
}

async function startVotersCa(election, net, state, { note, fail, startCaServer }) {
  const files = paths(state).election(election);
  const { name, port } = election.voterOrg.ca;
  const url = `https://localhost:${port}`;
  const tls = join(files.home, "ca-cert.pem");
  const client = join(net.bin, "fabric-ca-client");
  const caClient = (args) => capture(client, [...args, "--caname", name, "--tls.certfiles", tls], { FABRIC_CA_CLIENT_HOME: files.admin });

  const newKey = !existsSync(join(files.home, "IssuerPublicKey"));
  mkdirSync(files.home, { recursive: true });
  mkdirSync(files.admin, { recursive: true });
  const { logs } = startCaServer(election, files.home);

  // The port can accept connections before the CA is ready (Docker publishes
  // it straight away), so wait until the CA answers, as network.sh does.
  let info = { ok: false, output: "" };
  for (let attempt = 0; attempt < 60 && !info.ok; attempt++) {
    if (existsSync(tls)) info = caClient(["getcainfo", "-u", url]);
    if (!info.ok) await new Promise((r) => setTimeout(r, 500));
  }
  if (!info.ok) fail(`The voters' CA ${name} didn't answer on ${url}.`, `${info.output ? `${lastLine(info.output)}\n  ` : ""}See ${logs}.`);
  for (const key of ["IssuerPublicKey", "IssuerRevocationPublicKey"]) {
    if (!existsSync(join(files.home, key))) fail(`The voters' CA ${name} has no ${key} in ${files.home}.`, `See ${logs}.`);
  }
  note(newKey ? `${name} is up on ${url}, with a new issuer key` : `${name} is up on ${url}`);

  // The election's MSP folder, as Fabric's idemix MSP reads it:
  // msp/IssuerPublicKey and msp/RevocationPublicKey.
  mkdirSync(join(files.msp, "msp"), { recursive: true });
  copyFileSync(join(files.home, "IssuerPublicKey"), join(files.msp, "msp", "IssuerPublicKey"));
  copyFileSync(join(files.home, "IssuerRevocationPublicKey"), join(files.msp, "msp", "RevocationPublicKey"));

  // getcainfo above makes the admin's msp folders, so look for the certificate itself.
  if (!existsSync(join(files.admin, "msp", "signcerts", "cert.pem"))) {
    const enrol = caClient(["enroll", "-u", `https://${CA_ADMIN.id}:${CA_ADMIN.secret}@localhost:${port}`]);
    if (!enrol.ok) fail(`Couldn't enrol the admin of the voters' CA ${name}.`, lastLine(enrol.output));
  }
  const affiliation = caClient(["affiliation", "add", VOTER_AFFILIATION, "-u", url]);
  if (!affiliation.ok && !/already exists/i.test(affiliation.output)) {
    fail(`Couldn't add the ${VOTER_AFFILIATION} affiliation to the voters' CA ${name}.`, lastLine(affiliation.output));
  }
  const registered = [];
  for (const voter of DEMO_VOTERS) {
    const result = caClient([
      "register", "-u", url,
      "--id.name", voter.id, "--id.secret", voter.secret, "--id.type", "client",
      "--id.affiliation", VOTER_AFFILIATION, "--id.maxenrollments", "1",
    ]);
    if (result.ok) registered.push(voter.id);
    else if (!/already registered/i.test(result.output)) fail(`Couldn't register ${voter.id} on the voters' CA ${name}.`, lastLine(result.output));
  }
  const range = `${DEMO_VOTERS[0].id} to ${DEMO_VOTERS.at(-1).id}`;
  note(registered.length ? `registered ${registered.join(", ")} for ${election.id}` : `${range} already registered for ${election.id}`);
}

/**
 * configtx.yaml for an election's channel: the network's organisations, and
 * the election's idemix organisation if it has voter credentials.
 */
function configtx(net, state, election) {
  const o = net.orderer;
  const org = (x) => `  - &${x.msp}
    Name: ${x.msp}
    ID: ${x.msp}
    MSPDir: ${x.mspDir}
    Policies:
      Readers: { Type: Signature, Rule: "OR('${x.msp}.admin', '${x.msp}.peer', '${x.msp}.client')" }
      Writers: { Type: Signature, Rule: "OR('${x.msp}.admin', '${x.msp}.client')" }
      Admins: { Type: Signature, Rule: "OR('${x.msp}.admin')" }
      Endorsement: { Type: Signature, Rule: "OR('${x.msp}.peer')" }
    AnchorPeers:
${x.peers.map((peer) => `      - { Host: ${peer.anchor.host}, Port: ${peer.anchor.port} }`).join("\n")}
`;
  // Voters sign with Idemix. Idemix organisations can't endorse (docs/adr/0008).
  const voters = (e) => {
    const id = e.voterOrg.mspId;
    return `  # The election's idemix organisation, with its own issuer key. One per channel.
  - &${id}
    Name: ${id}
    ID: ${id}
    MSPType: idemix
    MSPDir: ${paths(state).election(e).msp}
    Policies:
      Readers: { Type: Signature, Rule: "OR('${id}.member')" }
      Writers: { Type: Signature, Rule: "OR('${id}.member')" }
      Admins: { Type: Signature, Rule: "OR('${id}.admin')" }
      Endorsement: { Type: Signature, Rule: "OR('${id}.member')" }
`;
  };
  const endorsers = net.orgs.map((x) => `'${x.msp}.peer'`).join(",");
  const admins = net.orgs.map((x) => `'${x.msp}.admin'`).join(",");
  return `# Written by playground/experimental.mjs for the ${electionChannel(election)} channel.
Organizations:
  - &OrdererOrg
    Name: OrdererOrg
    ID: ${o.msp}
    MSPDir: ${o.mspDir}
    Policies:
      Readers: { Type: Signature, Rule: "OR('${o.msp}.member')" }
      Writers: { Type: Signature, Rule: "OR('${o.msp}.member')" }
      Admins: { Type: Signature, Rule: "OR('${o.msp}.admin')" }
    OrdererEndpoints:
${o.endpoints.map((e) => `      - ${e}`).join("\n")}
${net.orgs.map(org).join("")}${election.voterOrg ? voters(election) : ""}
Capabilities:
  Channel: &ChannelCapabilities { V2_0: true }
  Orderer: &OrdererCapabilities { V2_0: true }
  Application: &ApplicationCapabilities { V2_5: true }

Profiles:
  PrivateVote:
    Policies:
      Readers: { Type: ImplicitMeta, Rule: "ANY Readers" }
      Writers: { Type: ImplicitMeta, Rule: "ANY Writers" }
      Admins: { Type: ImplicitMeta, Rule: "MAJORITY Admins" }
    Capabilities: *ChannelCapabilities
    Orderer:
      OrdererType: etcdraft
      BatchTimeout: 2s
      BatchSize: { MaxMessageCount: 10, AbsoluteMaxBytes: 99 MB, PreferredMaxBytes: 512 KB }
      EtcdRaft:
        Consenters:
${o.consenters.map((c) => `          - { Host: ${c.host}, Port: ${c.port}, ClientTLSCert: ${c.cert}, ServerTLSCert: ${c.cert} }`).join("\n")}
      Organizations:
        - *OrdererOrg
      Policies:
        Readers: { Type: ImplicitMeta, Rule: "ANY Readers" }
        Writers: { Type: ImplicitMeta, Rule: "ANY Writers" }
        Admins: { Type: ImplicitMeta, Rule: "MAJORITY Admins" }
        BlockValidation: { Type: ImplicitMeta, Rule: "ANY Writers" }
      Capabilities: *OrdererCapabilities
    Application:
      Organizations:
${[...net.orgs.map((x) => x.msp), ...(election.voterOrg ? [election.voterOrg.mspId] : [])].map((id) => `        - *${id}`).join("\n")}
      # Only the X.509 organisations endorse and administer the channel,
      # contracts and their lifecycle alike, and each needs both. MAJORITY
      # would count an idemix organisation too, so one X.509 organisation
      # and an admin credential from a voters' CA would be enough.
      Policies:
        Readers: { Type: ImplicitMeta, Rule: "ANY Readers" }
        Writers: { Type: ImplicitMeta, Rule: "ANY Writers" }
        Admins: { Type: Signature, Rule: "AND(${admins})" }
        LifecycleEndorsement: { Type: Signature, Rule: "AND(${endorsers})" }
        Endorsement: { Type: Signature, Rule: "AND(${endorsers})" }
      Capabilities: *ApplicationCapabilities
`;
}

/** The peer CLI's settings for an organisation's admin on one of its peers. */
export function peerEnv(net, org, peer) {
  return {
    FABRIC_CFG_PATH: net.peerConfig,
    CORE_PEER_TLS_ENABLED: "true",
    CORE_PEER_LOCALMSPID: org.msp,
    CORE_PEER_TLS_ROOTCERT_FILE: peer.tlsCa,
    CORE_PEER_MSPCONFIGPATH: org.adminMsp,
    CORE_PEER_ADDRESS: peer.address,
  };
}

/**
 * The idemix organisations in a channel's latest configuration, fetched
 * from the first organisation's peer, or null if that fails.
 */
export function channelVoterMsps(net, dir, channel) {
  const org = net.orgs[0];
  const block = join(dir, "config.pb");
  const fetched = capture(join(net.bin, "peer"), ["channel", "fetch", "config", block, "-c", channel], peerEnv(net, org, org.peers[0]));
  if (!fetched.ok) return null;
  const json = join(dir, "config.json");
  if (!capture(join(net.bin, "configtxlator"), ["proto_decode", "--input", block, "--type", "common.Block", "--output", json]).ok) return null;
  try {
    const groups = JSON.parse(readFileSync(json, "utf8")).data.data[0].payload.data.config.channel_group.groups.Application.groups;
    // MSP type 1 is idemix; X.509 is 0.
    return Object.keys(groups).filter((id) => groups[id].values?.MSP?.value?.type === 1);
  } catch {
    return null;
  }
}

/**
 * A channel for each election in ELECTIONS, privatevote-<election id>, each
 * created once per network from its own genesis block, with Org1MSP, Org2MSP
 * and only that election's idemix organisation, if it has one. A marker in
 * .state/private-channels/<channel> records each. A channel that exists is
 * checked for its election's idemix organisation, and for no other.
 */
export async function createElectionChannels(net, state, tools) {
  const { step, note } = tools;
  checkElections(tools);
  step("E2", `Experimental: a channel for each election, ${privateChannels().join(", ")}`);
  if (paths(state).legacy.some((path) => existsSync(path))) {
    note("this network also has privatevote, the single channel of an earlier playground; pnpm playground:down and up again removes it");
  }
  for (const election of ELECTIONS) await createElectionChannel(election, net, state, tools);
}

async function createElectionChannel(election, net, state, { note, fail }) {
  const channel = electionChannel(election);
  const { dir, marker } = paths(state).channel(election);
  const expected = election.voterOrg ? [election.voterOrg.mspId] : [];
  const describe = (ids) => (ids.length ? ids.join(", ") : "no idemix organisation");
  if (existsSync(marker)) {
    const inChannel = channelVoterMsps(net, dir, channel);
    if (!inChannel) note(`${channel} already exists; couldn't read its configuration from ${net.orgs[0].peers[0].address} to check its idemix organisation`);
    else if (inChannel.join(",") === expected.join(",")) note(`${channel} already exists, with ${describe(expected)}`);
    else {
      note(
        `${channel} already exists with ${describe(inChannel)}, not ${describe(expected)}; ` +
          "run pnpm playground:down and up again to recreate it",
      );
    }
    return;
  }
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "configtx.yaml"), configtx(net, state, election));
  const block = join(dir, `${channel}.block`);
  const made = capture(join(net.bin, "configtxgen"), ["-profile", "PrivateVote", "-outputBlock", block, "-channelID", channel], {
    FABRIC_CFG_PATH: dir,
  });
  if (!made.ok) fail(`Couldn't make ${channel}'s genesis block.`, made.output.split("\n").slice(-3).join("\n  "));
  note(`${channel}: genesis block in .state/private-channels/${channel}/${channel}.block, with ${describe(expected)}`);

  for (const admin of net.orderer.admins) {
    const tls = admin.tls ? ["--ca-file", net.orderer.tlsCa, "--client-cert", admin.tls.cert, "--client-key", admin.tls.key] : [];
    const joined = capture(join(net.bin, "osnadmin"), ["channel", "join", "--channelID", channel, "--config-block", block, "-o", admin.address, ...tls]);
    if (!joined.ok && !/already exists/i.test(joined.output)) fail(`The orderer at ${admin.address} couldn't join ${channel}.`, lastLine(joined.output));
  }
  note(`${channel}: orderers joined`);

  for (const org of net.orgs) {
    for (const peer of org.peers) {
      const env = peerEnv(net, org, peer);
      // The orderers elect a leader for the new channel first; until then a peer can't fetch its blocks.
      let joined = { ok: false, output: "" };
      for (let attempt = 0; attempt < 10 && !joined.ok; attempt++) {
        joined = capture(join(net.bin, "peer"), ["channel", "join", "-b", block], env);
        if (/already exists/i.test(joined.output)) joined.ok = true;
        if (!joined.ok) await new Promise((r) => setTimeout(r, 2000));
      }
      if (!joined.ok) fail(`${peer.address} couldn't join ${channel}.`, lastLine(joined.output));
      note(`${channel}: ${org.msp}'s peer at ${peer.address} joined`);
    }
  }
  writeFileSync(marker, new Date().toISOString());
}

/** The contract's source, examples/private-ballot-contract. */
export const contractSource = resolve(dirname(fileURLToPath(import.meta.url)), "..", "examples", "private-ballot-contract");

/**
 * A hash of the files the peer builds the contract from: go.mod, go.sum and
 * every non-test .go file, outside vendor/. A change to any of them deploys
 * the contract again, with the next sequence number.
 */
export function contractHash(dir = contractSource) {
  const files = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = join(d, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "vendor" && !entry.name.startsWith(".")) walk(path);
      } else if (entry.name === "go.mod" || entry.name === "go.sum" || (entry.name.endsWith(".go") && !entry.name.endsWith("_test.go"))) {
        files.push(path);
      }
    }
  };
  walk(dir);
  const hash = createHash("sha256");
  for (const file of files) hash.update(`${relative(dir, file)}\0`).update(readFileSync(file)).update("\0");
  return hash.digest("hex");
}

/** Every X.509 organisation's peer must endorse, as for the channel's Endorsement policy. */
export const endorsementPolicy = (net) => `AND(${net.orgs.map((o) => `'${o.msp}.peer'`).join(",")})`;

/**
 * The private-ballot contract on every election's channel (docs/adr/0007,
 * contract-api.md), from examples/private-ballot-contract, endorsed by Org1
 * and Org2. tools.deployContract builds and deploys it with test-network's
 * deployCC -ccl go, which runs go mod vendor in the contract's folder
 * (vendor/ isn't committed). A marker in .state/private-channels/<channel>
 * records the sequence and the source's hash, so the contract is deployed
 * once per network and again, with the next sequence, when its source changes.
 *
 * Then each organisation's peer answers GetElection for the election, which
 * starts the contract on it: until the elections are seeded, the answer is
 * "There's no election <id>."
 */
export function deployPrivateBallot(net, state, tools) {
  const { step, note, fail, deployContract } = tools;
  step("E3", `Experimental: the ${PRIVATE_CONTRACT} contract on ${privateChannels().join(", ")}`);
  const hash = contractHash();
  const policy = endorsementPolicy(net);
  for (const election of ELECTIONS) {
    const channel = electionChannel(election);
    const { contract } = paths(state).channel(election);
    let deployed = null;
    try {
      deployed = JSON.parse(readFileSync(contract, "utf8"));
    } catch {}
    if (deployed?.hash === hash) note(`${channel}: ${PRIVATE_CONTRACT} already deployed, sequence ${deployed.sequence}`);
    else {
      const sequence = (deployed?.sequence ?? 0) + 1;
      deployContract({ channel, name: PRIVATE_CONTRACT, path: contractSource, language: "go", version: String(sequence), sequence, policy });
      writeFileSync(contract, `${JSON.stringify({ sequence, hash, policy })}\n`);
      note(`${channel}: ${PRIVATE_CONTRACT} deployed, sequence ${sequence}, endorsed by ${policy}`);
    }
    for (const org of net.orgs) {
      const answer = queryElection(net, org, channel, election.id);
      if (!answer.ok) fail(`${PRIVATE_CONTRACT} on ${channel} didn't answer from ${org.msp}'s peer.`, answer.output);
      note(`${channel}: ${org.msp}'s peer answers GetElection: ${answer.output}`);
    }
  }
  seedElections(net, state, tools);
}

/**
 * GetElection for the election from the organisation's first peer, with the
 * peer CLI. ok is true for a record or for the contract's "There's no
 * election" refusal, which shows the contract runs.
 */
export function queryElection(net, org, channel, id) {
  const peer = org.peers[0];
  const result = capture(join(net.bin, "peer"), ["chaincode", "query", "-C", channel, "-n", PRIVATE_CONTRACT, "-c", JSON.stringify({ Args: ["GetElection", id] })], peerEnv(net, org, peer));
  if (result.ok) {
    try {
      return { ok: true, output: `${id} is ${JSON.parse(result.output.split("\n").pop()).state}` };
    } catch {
      return { ok: false, output: lastLine(result.output) };
    }
  }
  const refusal = `There's no election ${id}.`;
  return result.output.includes(refusal) ? { ok: true, output: refusal } : { ok: false, output: lastLine(result.output) };
}

/**
 * Hook, phase c of step 4: the key ceremony with weft-trustee for Org1 and
 * Org2, 2 of 2, with a trustee identity (weft.trustee=true) at each
 * organisation's CA, and the seeded elections. budget-2027 is seeded open
 * for 30 days; chair-2027 gets the contract and isn't seeded until voter
 * credentials are built (docs/adr/0008). The trustee tool doesn't exist yet,
 * so the hook only says so.
 */
export function seedElections(_net, _state, { note }) {
  note(`not seeded yet: the key ceremony needs weft-trustee, so ${ELECTIONS.map((e) => e.id).join(" and ")} ${ELECTIONS.length === 1 ? "has" : "have"} no election record`);
}

/**
 * Everything experimental that the stack writes to .state, for playground:down.
 * Throws if a file can't be removed: on Linux the voters' CA containers write
 * their homes as root, and cli.mjs then removes those with Docker.
 */
export function clean(state) {
  const p = paths(state);
  const policies = explorerNames.map((name) => join(state, `${name}-experimental.yaml`));
  for (const path of [p.marker, p.channels, ...p.legacy, p.votersMsp, ...policies, p.votersCa]) rmSync(path, { recursive: true, force: true });
}
