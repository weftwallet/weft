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
 *      ca-chair-2027, whose key backs ChairVoters2027MSP. In front of it, a
 *      proxy for the browser (ca-proxy.mjs --voters-only) that passes only
 *      cainfo and idemix enrolment with basic authorisation.
 *   2. A channel, privatevote-<election id>, created from its own genesis
 *      block: Org1MSP and Org2MSP as endorsers, and the election's idemix
 *      organisation if it has one. privatevote-budget-2027 has none, and
 *      privatevote-chair-2027 has ChairVoters2027MSP.
 *   3. The private-ballot contract (contracts/private-ballot,
 *      docs/adr/0007) on the channel, endorsed by Org1 and Org2.
 *   4. A trustee identity for each organisation, trustee1 for Org1 and
 *      trustee2 for Org2, registered at its CA with weft.trustee=true, and a
 *      connection file for weft-trustee (packages/trustee) on each
 *      election's channel, in .state/trustees/<org>.
 *   5. Each election that has a `seed`, created with weft-trustee, with the
 *      key ceremony run for Org1 and Org2, 2 of 2, and opened. budget-2027
 *      and chair-2027 are open for 30 days; chair-2027 pins its CA's issuer
 *      key and the affiliation `voters`. An election that already exists is
 *      left as it is. For each election with voter credentials, the count of
 *      credentials its CA has issued per enrolment ID (credentialCount).
 *
 * writeVoterInvites writes each voter election's invite to
 * .state/voter-invites, which the relay serves (WEFT_VOTER_INVITES).
 * credentialCount, for `pnpm playground:credentials <election>`, `up` and
 * `count`, reads the voters' CA's own database: Fabric CA has no limit on
 * idemix credentials issued through token authorisation, so the count is
 * what finds a voter ID with more than one (D14 of the step 5 plan).
 *
 * countElection, for `pnpm playground:count <election>`, closes an election
 * early with both trustees, posts both decryption shares and publishes the
 * tally, with weft-trustee. With `--channel`, it counts an election that
 * isn't in ELECTIONS, on one of their channels, such as one the e2e tests
 * create with seedElection.
 *
 * cli.mjs passes in the network's layout (paths and addresses, for Fabric's
 * test-network), its output helpers, startCaServer, which runs a voters'
 * CA in Docker (compose-voters-ca.yaml), startCaProxy, which starts a
 * voters' CA proxy as a background process, and deployContract, which
 * deploys a contract with test-network's deployCC. This file knows nothing
 * about Docker.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
 * Each election has its ID, and a `seed` if playground:up should create and
 * open it: its title, options and how many days it stays open. Org1 and
 * Org2 are its trustees, 2 of 2. Without `voterOrg`, their X.509 identities
 * vote (the private tally only). With `voterOrg`, voter credentials vote
 * (docs/adr/0008): its idemix MSP, named after the election, and its voters'
 * CA, run in its own container on its own ports with its own issuer key, with
 * `ca.proxy` the port of the proxy the browser reaches it through. Fabric
 * recommends one idemix MSP per channel, which the channel per election
 * gives. Ports stay clear of test-network's and the e2e tests'.
 *
 * An election added here gets its channel and the contract, with voterOrg
 * its CA, proxy, MSP folder and voter invite, and with seed its creation and
 * key ceremony, on the next `playground:up --experimental`.
 */
export const ELECTIONS = [
  { id: "budget-2027", seed: { title: "Budget 2027", options: ["Plan A", "Plan B", "Plan C"], openForDays: 30 } },
  {
    id: "chair-2027",
    seed: { title: "Chair 2027", options: ["Ada Obi", "Ben Carter", "Chioma Ude"], openForDays: 30 },
    voterOrg: { mspId: "ChairVoters2027MSP", ca: { name: "ca-chair-2027", port: 7058, operations: 17058, proxy: 7081 } },
  },
];
/** The elections with voter credentials, each with a voters' CA and an idemix organisation. */
export const voterElections = () => ELECTIONS.filter((e) => e.voterOrg);
/**
 * The election's channel, for example privatevote-budget-2027. An election
 * that isn't in ELECTIONS, such as one the e2e tests create, names the
 * channel it is on.
 */
export const electionChannel = (e) => e.channel ?? `${PRIVATE_CHANNEL_PREFIX}-${e.id}`;
/** Every election's channel, for the invite and the explorers' policies. */
export const privateChannels = () => ELECTIONS.map(electionChannel);
/** Fabric's rule for channel names. */
const CHANNEL_NAME = /^[a-z][a-z0-9.-]{0,248}$/;

/** Every voter shares one affiliation, since each ballot discloses it (docs/adr/0008). */
export const VOTER_AFFILIATION = "voters";
export const DEMO_VOTERS = [1, 2, 3, 4, 5].map((n) => ({ id: `voter${n}`, secret: `voter${n}pw` }));
/** The CA's bootstrap admin, as test-network's CAs have it. */
const CA_ADMIN = { id: "admin", secret: "adminpw" };
/** Who the voter invites name as the election relay's operator: the playground's relay is Org1's, which a real election rules out. */
export const RELAY_OPERATOR = "Weft Playground";
/** Fabric's idemix curve, the one every voter invite and election names. */
const CURVE = "FP256BN_AMCL";

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
    /** Each organisation's trustee identity, connection files, passphrase and weft-trustee state. */
    trustees: join(state, "trustees"),
    trustee: (org) => {
      const dir = join(state, "trustees", org.msp.replace(/MSP$/, "").toLowerCase());
      return {
        dir,
        msp: join(dir, "msp"),
        passphrase: join(dir, "passphrase"),
        connection: (e) => join(dir, `${electionChannel(e)}.yaml`),
      };
    },
    /**
     * An election with voter credentials: the CA's home (the container's,
     * mounted), its admin's client home, and its MSP folder.
     */
    election: (e) => ({
      home: join(votersCa, e.id, "server"),
      admin: join(votersCa, e.id, "admin"),
      msp: join(votersMsp, e.voterOrg.mspId),
      /** The CA's own database, where it records each credential it issues. */
      db: join(votersCa, e.id, "server", "fabric-ca-server.db"),
    }),
    /** Each election's voter invite, <election>.json, which the relay serves. */
    voterInvites: join(state, "voter-invites"),
  };
}

/** The background process name, and so the log, of an election's voters' CA proxy. */
export const caProxyName = (e) => `ca-proxy-${e.id}`;
/**
 * What is left running of elections no longer in ELECTIONS: the voters' CA
 * proxies, by their background names from the pid files in .state
 * (`pidFiles`), and the voters' CA containers, by name (`containers`, named
 * by `containerOf`). The next `playground:up --experimental` stops both.
 */
export function unlistedVoters({ pidFiles, containers }, containerOf, elections = voterElections()) {
  const proxies = new Set(elections.map(caProxyName));
  const kept = new Set(elections.map(containerOf));
  return {
    proxies: pidFiles
      .filter((f) => /^ca-proxy-.+\.pid$/.test(f))
      .map((f) => f.replace(/\.pid$/, ""))
      .filter((name) => !proxies.has(name)),
    containers: containers.filter((name) => !kept.has(name)),
  };
}
/** Where the browser reaches an election's voters' CA. */
export const caProxyUrl = (e, { https = false } = {}) => `${https ? "https" : "http"}://localhost:${e.voterOrg.ca.proxy}`;
/**
 * The arguments for ca-proxy.mjs in front of an election's voters' CA, in
 * voters-only mode, with a mkcert certificate when `tls` is given.
 */
export const caProxyArgs = (state, e, tls = null) => [
  "--listen", String(e.voterOrg.ca.proxy),
  "--target", `https://localhost:${e.voterOrg.ca.port}`,
  "--upstream-ca", join(paths(state).election(e).home, "ca-cert.pem"),
  "--voters-only",
  ...(tls ? ["--cert", tls.cert, "--key", tls.key] : []),
];

/** "f1642101…b0b87480", as weft-trustee shortens hashes. */
const shortHash = (hex) => `${hex.slice(0, 8)}…${hex.slice(-8)}`;
/** SHA-256 of a file, in lowercase hex. */
const fileHash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** The voter MSP IDs, for the relay's WEFT_IDEMIX_MSP_IDS. */
export const voterMspIds = () => voterElections().map((e) => e.voterOrg.mspId).join(",");

/** The Go versions the contract's go.mod names: its minimum (the go line) and its toolchain line. */
export function contractGo(dir = contractSource) {
  const mod = readFileSync(join(dir, "go.mod"), "utf8");
  return { minimum: mod.match(/^go (\S+)$/m)?.[1] ?? null, toolchain: mod.match(/^toolchain (\S+)$/m)?.[1] ?? null };
}

/** Compares Go versions such as 1.24.7 and 1.26.3, without the "go" prefix. */
function compareGo(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/**
 * The contract is written in Go (docs/adr/0007), and Fabric's deployment
 * vendors its modules with the local Go. Its go.mod needs Go 1.26.3 or later,
 * for IBM idemix (docs/adr/0008), and has no toolchain line, so that
 * fabric-ccenv's Go 1.26.4 builds it without a download. An older local Go,
 * from 1.21, downloads go1.26.3 when it vendors the contract, unless
 * GOTOOLCHAIN stops it. Called before anything starts. Returns the
 * line cli.mjs prints.
 */
export function checkGo({ fail }) {
  // Outside any module, so a go.mod's toolchain line doesn't make this Go switch before it answers.
  const env = (name) => spawnSync("go", ["env", name], { encoding: "utf8", cwd: tmpdir() });
  const found = env("GOVERSION");
  if (found.error || found.status !== 0) {
    fail(
      "--experimental needs Go, which isn't installed or isn't on your PATH.",
      "The private-ballot contract is written in Go. Install it (macOS: brew install go; others: https://go.dev/dl/), " +
        "then run this again, or run pnpm playground:up without --experimental.",
    );
  }
  const version = found.stdout.trim();
  const { minimum, toolchain } = contractGo();
  const plain = version.replace(/^go/, "").replace(/[^0-9.].*$/, "");
  if (!minimum || compareGo(plain, minimum) >= 0) return `Go found (${version}), for --experimental`;
  const wanted = toolchain ?? `go${minimum}`;
  if (compareGo(plain, "1.21") < 0) {
    fail(
      `${version} can't vendor the private-ballot contract: its go.mod needs Go ${minimum} or later, and Go before 1.21 can't download a newer toolchain.`,
      `Install Go ${minimum} or later (https://go.dev/dl/), then run this again.`,
    );
  }
  const mode = env("GOTOOLCHAIN").stdout?.trim() || "auto";
  // auto and <name>+auto download a newer toolchain; a named toolchain new enough is used as it is.
  const named = mode.match(/^go(\d[\d.]*)$/)?.[1];
  const downloads = mode === "auto" || mode.endsWith("+auto") || (named !== undefined && compareGo(named, minimum) >= 0);
  if (!downloads) {
    fail(
      `${version} can't vendor the private-ballot contract: its go.mod needs Go ${minimum} or later, and GOTOOLCHAIN=${mode} stops Go from downloading ${wanted}.`,
      `Unset GOTOOLCHAIN, or set it to auto, so Go downloads ${wanted} when it vendors the contract. Or install Go ${minimum} or later.`,
    );
  }
  return `Go found (${version}), for --experimental. The contract's go.mod names ${named ? `go${named}` : wanted}, which Go downloads when it vendors the contract`;
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
      "Use lower-case letters, digits, dots and hyphens, starting with a letter, in ELECTIONS in devnet/experimental.mjs.",
    );
  }
  const noProxy = voterElections().find((e) => !Number.isInteger(e.voterOrg.ca?.proxy));
  if (noProxy) {
    fail(
      `${noProxy.id} has voter credentials, but its entry in ELECTIONS has no ca.proxy, the port the browser reaches ${noProxy.voterOrg.ca?.name ?? "its voters' CA"} on.`,
      "Give it a free port in ELECTIONS in devnet/experimental.mjs, for example 7081 for chair-2027 and 7181 for chair-2028.",
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

async function startVotersCa(election, net, state, { note, fail, startCaServer, startCaProxy }) {
  const files = paths(state).election(election);
  const { name, port } = election.voterOrg.ca;
  const url = `https://localhost:${port}`;
  const tls = join(files.home, "ca-cert.pem");
  const client = join(net.bin, "fabric-ca-client");
  const caClient = (args) => capture(client, [...args, "--caname", name, "--tls.certfiles", tls], { FABRIC_CA_CLIENT_HOME: files.admin });

  const newKey = !existsSync(join(files.home, "IssuerPublicKey"));
  if (newKey) newIssuerKeys.add(election.id);
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
  const keyHash = shortHash(fileHash(join(files.home, "IssuerPublicKey")));
  note(newKey ? `${name} is up on ${url}, with a new issuer key, SHA-256 ${keyHash}` : `${name} is up on ${url}, issuer key SHA-256 ${keyHash}`);

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

  // The browser's way in: voters reach the CA only through this proxy (D4 of the step 5 plan).
  const proxy = await startCaProxy(election);
  note(
    proxy.started
      ? `proxy for ${name} started on ${proxy.url}, for the browser (log: .state/${caProxyName(election)}.log)`
      : `proxy for ${name} already running on ${proxy.url}`,
  );
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
  return `# Written by devnet/experimental.mjs for the ${electionChannel(election)} channel.
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
  const groups = applicationGroups(net, dir, channel);
  // MSP type 1 is idemix; X.509 is 0.
  return groups ? Object.keys(groups).filter((id) => groups[id].values?.MSP?.value?.type === 1) : null;
}

/** The Application organisations in a channel's latest configuration, decoded, or null. */
function applicationGroups(net, dir, channel) {
  const org = net.orgs[0];
  const block = join(dir, "config.pb");
  const fetched = capture(join(net.bin, "peer"), ["channel", "fetch", "config", block, "-c", channel], peerEnv(net, org, org.peers[0]));
  if (!fetched.ok) return null;
  const json = join(dir, "config.json");
  if (!capture(join(net.bin, "configtxlator"), ["proto_decode", "--input", block, "--type", "common.Block", "--output", json]).ok) return null;
  try {
    return JSON.parse(readFileSync(json, "utf8")).data.data[0].payload.data.config.channel_group.groups.Application.groups;
  } catch {
    return null;
  }
}

/** The issuer public key an idemix organisation has in the configuration that applicationGroups last decoded, or null. */
function channelIssuerKey(dir, mspId) {
  try {
    const groups = JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).data.data[0].payload.data.config.channel_group.groups.Application.groups;
    const ipk = groups[mspId]?.values?.MSP?.value?.config?.ipk;
    return typeof ipk === "string" ? Buffer.from(ipk, "base64") : null;
  } catch {
    return null;
  }
}

/** The voters' CAs that made a new issuer key in this run, for the channel guard. */
const newIssuerKeys = new Set();

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

/**
 * The voters' CA's issuer key must be the one its MSP has in the channel:
 * credentials under any other key are refused by every peer. The two differ
 * when the CA's home in .state was deleted while the network kept the channel.
 */
function checkIssuerKey(election, state, dir, channel, fail) {
  const { mspId, ca } = election.voterOrg;
  const inChannel = channelIssuerKey(dir, mspId);
  const atCa = readFileSync(join(paths(state).election(election).home, "IssuerPublicKey"));
  if (!inChannel || inChannel.equals(atCa)) return;
  fail(
    newIssuerKeys.has(election.id)
      ? `${ca.name} has a new issuer key, but ${channel} already has ${mspId} with another.`
      : `${ca.name}'s issuer key isn't the one ${mspId} has in ${channel}.`,
    "The CA's home was deleted while the channel stayed. Run pnpm playground:down, then pnpm playground:up --experimental.",
  );
}

async function createElectionChannel(election, net, state, { note, fail }) {
  const channel = electionChannel(election);
  const { dir, marker } = paths(state).channel(election);
  const expected = election.voterOrg ? [election.voterOrg.mspId] : [];
  const describe = (ids) => (ids.length ? ids.join(", ") : "no idemix organisation");
  if (existsSync(marker)) {
    const inChannel = channelVoterMsps(net, dir, channel);
    if (!inChannel) note(`${channel} already exists; couldn't read its configuration from ${net.orgs[0].peers[0].address} to check its idemix organisation`);
    else if (inChannel.join(",") === expected.join(",")) {
      if (election.voterOrg) checkIssuerKey(election, state, dir, channel, fail);
      note(`${channel} already exists, with ${describe(expected)}`);
    } else {
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

  let existed = false;
  for (const admin of net.orderer.admins) {
    const tls = admin.tls ? ["--ca-file", net.orderer.tlsCa, "--client-cert", admin.tls.cert, "--client-key", admin.tls.key] : [];
    const joined = capture(join(net.bin, "osnadmin"), ["channel", "join", "--channelID", channel, "--config-block", block, "-o", admin.address, ...tls]);
    if (!joined.ok && !/already exists/i.test(joined.output)) fail(`The orderer at ${admin.address} couldn't join ${channel}.`, lastLine(joined.output));
    // osnadmin exits with 0 when the orderer answers 405 because it already has the channel.
    if (/already exists/i.test(joined.output)) existed = true;
  }
  note(existed ? `${channel}: the orderers already have it, from before .state had a record of it` : `${channel}: orderers joined`);

  for (const org of net.orgs) {
    for (const peer of org.peers) {
      const env = peerEnv(net, org, peer);
      // The orderers elect a leader for the new channel first; until then a peer can't fetch its blocks.
      let joined = { ok: false, output: "" };
      let had = false;
      for (let attempt = 0; attempt < 10 && !joined.ok; attempt++) {
        joined = capture(join(net.bin, "peer"), ["channel", "join", "-b", block], env);
        if (/already exists/i.test(joined.output)) {
          joined.ok = true;
          existed = had = true;
        }
        if (!joined.ok) await new Promise((r) => setTimeout(r, 2000));
      }
      if (!joined.ok) fail(`${peer.address} couldn't join ${channel}.`, lastLine(joined.output));
      note(`${channel}: ${org.msp}'s peer at ${peer.address} ${had ? "already had it" : "joined"}`);
    }
  }
  // A channel the network already had keeps its own configuration, not the
  // genesis block just made, so its voter organisation's key is checked too.
  if (existed && election.voterOrg) {
    applicationGroups(net, dir, channel);
    checkIssuerKey(election, state, dir, channel, fail);
  }
  writeFileSync(marker, new Date().toISOString());
}

/** The contract's source, contracts/private-ballot. */
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const contractSource = join(repoRoot, "contracts", "private-ballot");

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
 * contract-api.md), from contracts/private-ballot, endorsed by Org1
 * and Org2. tools.deployContract builds and deploys it with test-network's
 * deployCC -ccl go, which runs go mod vendor in the contract's folder
 * (vendor/ isn't committed). A marker in .state/private-channels/<channel>
 * records the sequence and the source's hash, so the contract is deployed
 * once per network and again, with the next sequence, when its source changes.
 *
 * Then each organisation's peer answers GetElection for the election, which
 * starts the contract on it: before an election is seeded, the answer is
 * "There's no election <id>." cli.mjs runs seedElections once the relay
 * and the explorers are up.
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

/* ------------------------------------------------------------------ */
/* The trustees, the key ceremony and the seeded elections             */
/* ------------------------------------------------------------------ */

/** weft-trustee, built from packages/trustee. */
export const trusteeTool = () => join(repoRoot, "packages", "trustee", "dist", "cli.js");
/** Each organisation's trustee identity: trustee1 for the first organisation, trustee2 for the second. */
export const trusteeUser = (net, org) => {
  const n = net.orgs.indexOf(org) + 1;
  return { id: `trustee${n}`, secret: `trustee${n}pw` };
};

/**
 * Registers and enrols each organisation's trustee identity at its CA, with
 * weft.trustee=true in the enrolment certificate, as an explorer's identity is
 * set up (key-ceremony.md). The certificate and key go in
 * .state/trustees/<org>/msp, and next to them weft-trustee's connection file
 * for each election's channel, <channel>.yaml, a random passphrase for its
 * state folder (0600), and the state folder itself, state/.
 */
export function setUpTrustees(net, state, { note, fail }) {
  const client = join(net.bin, "fabric-ca-client");
  for (const org of net.orgs) {
    const files = paths(state).trustee(org);
    const user = trusteeUser(net, org);
    const { ca } = org;
    const caClient = (home, args) => capture(client, [...args, "--caname", ca.name, "--tls.certfiles", ca.tlsCa], { FABRIC_CA_CLIENT_HOME: home });
    const registered = caClient(ca.registrar, [
      "register", "-u", ca.url,
      "--id.name", user.id, "--id.secret", user.secret, "--id.type", "client",
      "--id.attrs", "weft.trustee=true:ecert",
    ]);
    if (!registered.ok && !/already registered/i.test(registered.output)) fail(`Couldn't register ${user.id} at ${org.msp}'s CA.`, lastLine(registered.output));
    mkdirSync(files.dir, { recursive: true, mode: 0o700 });
    if (!existsSync(join(files.msp, "signcerts", "cert.pem"))) {
      const host = new URL(ca.url).host;
      const enrolled = caClient(files.dir, ["enroll", "-u", `https://${user.id}:${user.secret}@${host}`, "-M", files.msp]);
      if (!enrolled.ok) fail(`Couldn't enrol ${user.id} at ${org.msp}'s CA.`, lastLine(enrolled.output));
    }
    if (!existsSync(files.passphrase)) writeFileSync(files.passphrase, `${randomBytes(24).toString("hex")}\n`, { mode: 0o600 });
    chmodSync(files.passphrase, 0o600);
    const peer = org.peers[0];
    for (const election of ELECTIONS) {
      writeFileSync(
        files.connection(election),
        `# Written by devnet/experimental.mjs: ${org.msp}'s trustee, ${user.id}, for ${electionChannel(election)}.
# From this folder: WEFT_TRUSTEE_PASSPHRASE=$(cat passphrase) weft-trustee status --election ${election.id} --connection ${electionChannel(election)}.yaml
peer: ${peer.address}
${peer.hostAlias ? `peerHostAlias: ${peer.hostAlias}\n` : ""}tlsCa: ${peer.tlsCa}
msp: ${org.msp}
cert: msp/signcerts
key: msp/keystore
channel: ${electionChannel(election)}
contract: ${PRIVATE_CONTRACT}
home: state
`,
      );
    }
    note(`${user.id} for ${org.msp}, with weft.trustee=true, in .state/trustees/${relative(paths(state).trustees, files.dir)}`);
  }
}

/** Runs weft-trustee as an organisation's trustee, with its passphrase. */
export function runTrustee(net, state, org, election, command, args = []) {
  const files = paths(state).trustee(org);
  const result = spawnSync(process.execPath, [trusteeTool(), command, "--election", election.id, "--connection", files.connection(election), ...args], {
    encoding: "utf8",
    env: { ...process.env, WEFT_TRUSTEE_PASSPHRASE: readFileSync(files.passphrase, "utf8").trim() },
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return { ok: result.status === 0, stdout: result.stdout ?? "", output };
}

/** The election as an organisation's trustee reads it through its own peer, or the failure. */
function trusteeStatus(net, state, org, election) {
  const r = runTrustee(net, state, org, election, "status", ["--json"]);
  if (r.ok) return { report: JSON.parse(r.stdout) };
  if (r.output.includes(`There's no election ${election.id}.`)) return { missing: true };
  return { error: r.output };
}

/** The first ✗ line of weft-trustee's output, and its hint. */
const failedLines = (output) => {
  const lines = output.split("\n");
  const at = lines.findIndex((l) => l.startsWith("✗"));
  return at < 0 ? lastLine(output) : lines.slice(at, at + 2).join("\n  ");
};

const pad2 = (n) => String(n).padStart(2, "0");
/** Now plus some days, on the minute, as the contract writes times. */
export function closingTime(days, now = new Date()) {
  const d = new Date(now.getTime() + days * 86_400_000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}T${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:00.000Z`;
}

/**
 * Builds weft-trustee, sets up the trustees, and creates and opens each
 * election in ELECTIONS that has a seed: CreateElection as Org1's trustee,
 * then commit, share and confirm for Org1 and Org2 in turn, the last confirm
 * opening it. An election with voter credentials pins its CA's issuer key and
 * the affiliation `voters`. An election that already exists, in any state, is
 * left as it is, except one still in its key ceremony, whose remaining rounds
 * are run. For an election with voter credentials, the credential count
 * follows (D14). Then each organisation's trustee reads every election
 * through its own peer's gateway. Returns each election's state, or null.
 */
export function seedElections(net, state, tools) {
  const { step, note } = tools;
  step("E4", "Experimental: trustee identities, the key ceremony and the seeded elections");
  const states = new Map(ELECTIONS.map((e) => [e.id, null]));
  // Built every time, with the packages it uses, as the relay and the explorers are.
  const built = spawnSync("pnpm", ["--filter", "@weftwallet/trustee...", "build"], { cwd: repoRoot, encoding: "utf8" });
  if (built.status !== 0) {
    note(`couldn't build weft-trustee, so nothing is seeded: ${lastLine(`${built.stdout ?? ""}${built.stderr ?? ""}`.trim())}`);
    return states;
  }
  setUpTrustees(net, state, tools);
  const [creator] = net.orgs;
  for (const election of ELECTIONS) {
    if (!election.seed) note(`${election.id}: not seeded, since it has no seed in ELECTIONS`);
    else for (const line of seedElection(net, state, election, creator).split("\n")) note(`${election.id}: ${line}`);
    if (election.voterOrg) note(`${election.id}: ${credentialSummary(credentialCount(state, election), election)}`);
  }
  // The smoke check: every election's channel answers through each organisation's gateway.
  for (const election of ELECTIONS) {
    for (const org of net.orgs) {
      const read = trusteeStatus(net, state, org, election);
      if (read.report) states.set(election.id, read.report.election.state);
      const what = read.report ? `${election.id} is ${read.report.election.state}` : read.missing ? `There's no election ${election.id}.` : null;
      note(what ? `${electionChannel(election)}: ${org.msp}'s gateway answers GetElection as ${trusteeUser(net, org).id}: ${what}` : `${electionChannel(election)}: ${org.msp}'s gateway didn't answer: ${failedLines(read.error)}`);
    }
  }
  return states;
}

/** The block a weft-trustee line names, such as "Opened chair-2027 in block 12.", or null. */
const blockIn = (output, verb, id) => output.match(new RegExp(`${verb} ${id} in block (\\d+)`))?.[1] ?? null;

/**
 * Creates one election with weft-trustee as `creator`'s trustee, runs the key
 * ceremony for every organisation in net.orgs and opens it, or finishes the
 * ceremony of one already created. Says what happened: in one line for an
 * election with X.509 voters, and in a line for each step, joined with
 * newlines, for one with voter credentials. Used for each seeded election,
 * and by the e2e tests for an election of their own on an existing channel
 * ({ id, channel, seed }).
 */
export function seedElection(net, state, election, creator) {
  const first = trusteeStatus(net, state, creator, election);
  if (first.error) return `couldn't read it through ${creator.msp}'s peer, so it isn't seeded: ${failedLines(first.error)}`;
  if (first.report && first.report.election.state !== "keygen") return `already exists, in ${first.report.election.state}; left as it is`;
  const lines = [];
  const vo = election.voterOrg;
  let opened = null;
  if (first.missing) {
    const { title, options, openForDays } = election.seed;
    const created = runTrustee(net, state, creator, election, "create", [
      "--title", title,
      ...options.flatMap((o) => ["--option", o]),
      "--closes-at", closingTime(openForDays),
      ...net.orgs.flatMap((o) => ["--trustee", o.msp]),
      "--threshold", String(net.orgs.length),
      ...(vo
        ? ["--voter-credentials", vo.mspId, "--issuer-key", join(paths(state).election(election).msp, "msp", "IssuerPublicKey"), "--affiliation", VOTER_AFFILIATION]
        : []),
    ]);
    if (!created.ok) return `couldn't create it: ${failedLines(created.output)}`;
    if (vo) lines.push(`created in block ${blockIn(created.output, "Created", election.id) ?? "?"}, with voter credentials from ${vo.mspId} and its issuer key pinned`);
  }
  // The rounds each trustee hasn't posted yet, in order.
  for (const [round, command] of [["round1", "commit"], ["round2", "share"], ["confirmation", "confirm"]]) {
    for (const [i, org] of net.orgs.entries()) {
      const now = trusteeStatus(net, state, org, election);
      if (!now.report) return [...lines, `stopped in the key ceremony: ${failedLines(now.error ?? "")}`].join("\n");
      if (now.report.election.state !== "keygen") break;
      if (now.report.ceremony.trustees[i][round]) continue;
      const r = runTrustee(net, state, org, election, command);
      if (!r.ok) return [...lines, `stopped in the key ceremony, at ${command} for ${org.msp}: ${failedLines(r.output)}. Run pnpm playground:down and up again`].join("\n");
      opened ??= blockIn(r.output, "Opened", election.id);
    }
  }
  const after = trusteeStatus(net, state, creator, election);
  if (!after.report) return [...lines, `couldn't read it after the key ceremony: ${failedLines(after.error ?? "")}`].join("\n");
  const rec = after.report.election;
  if (rec.state === "keygen") {
    const r = runTrustee(net, state, creator, election, "open");
    if (!r.ok) return [...lines, `the key ceremony finished and it didn't open: ${failedLines(r.output)}`].join("\n");
    opened ??= blockIn(r.output, "Opened", election.id);
  }
  const open = trusteeStatus(net, state, creator, election).report?.election;
  if (open?.state !== "open") return [...lines, `the key ceremony finished and it is in ${open?.state ?? "an unknown state"}`].join("\n");
  const fingerprint = open.fingerprint.match(/.{4}/g).join(" ");
  const orgs = list(net.orgs.map((o) => o.msp));
  if (!vo) return `created, key ceremony run for ${orgs}, ${open.threshold} of ${open.trustees.length}, and open until ${when(open.closesAt)}; fingerprint ${fingerprint}`;
  lines.push(`key ceremony run for ${orgs}, ${open.threshold} of ${open.trustees.length}, and opened${opened ? ` in block ${opened}` : ""}`);
  lines.push(`election fingerprint ${fingerprint}`);
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* The credential count (D14 of the step 5 plan)                       */
/* ------------------------------------------------------------------ */

const require = createRequire(import.meta.url);

/**
 * The credentials an election's voters' CA has issued, per enrolment ID,
 * from the CA's own database, read-only: its `credentials` table, one row per
 * idemix credential, and its `users` table for the IDs registered in the
 * voters' affiliation (Fabric CA 1.5.17's schema). Fabric CA counts basic
 * enrolments against maxenrollments, but not credentials issued through
 * token authorisation, so this is what finds a voter ID with more than one.
 *
 * Returns { db, voters: [{ id, credentials }], others, extra, issued } or
 * { error } when the database can't be read.
 */
export function credentialCount(state, election) {
  const { db } = paths(state).election(election);
  if (!existsSync(db)) return { db, error: `${election.voterOrg.ca.name} has no database at ${relative(state, db)} yet` };
  let sqlite;
  try {
    // Lazily, so a stack without voter credentials never loads node:sqlite.
    sqlite = new (require("node:sqlite").DatabaseSync)(db, { readOnly: true });
  } catch (error) {
    return { db, error: `couldn't open ${relative(state, db)}: ${error.message}` };
  }
  try {
    const issued = new Map(sqlite.prepare("SELECT id, COUNT(*) AS n FROM credentials GROUP BY id").all().map((r) => [r.id, Number(r.n)]));
    const registered = sqlite.prepare("SELECT id FROM users WHERE affiliation = ? ORDER BY rowid").all(VOTER_AFFILIATION).map((r) => r.id);
    const voters = registered.map((id) => ({ id, credentials: issued.get(id) ?? 0 }));
    const others = [...issued].filter(([id]) => !registered.includes(id)).map(([id, credentials]) => ({ id, credentials }));
    return {
      db,
      voters,
      others,
      extra: voters.filter((v) => v.credentials > 1),
      issued: voters.reduce((n, v) => n + v.credentials, 0),
    };
  } catch (error) {
    return { db, error: `couldn't read the credentials in ${relative(state, db)}: ${error.message}` };
  } finally {
    sqlite.close();
  }
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** One line for up and count: how many credentials the voters' CA has issued, and whether any ID has more than one. */
export function credentialSummary(count, election = null, { names = true } = {}) {
  const ca = election?.voterOrg.ca.name;
  if (count.error) return `the credentials weren't counted: ${count.error}`;
  const name = ca ?? "the voters' CA";
  if (count.extra.length) {
    return `${name} has issued more than one credential to ${list(count.extra.map((v) => v.id))}, so ${election ? election.id : "the election"} may have more votes than voters`;
  }
  if (count.issued === 0) return `${name} has issued 0 credentials, so no enrolment ID has more than one`;
  const holders = count.voters.filter((v) => v.credentials > 0).map((v) => v.id);
  return `${name} has issued ${plural(count.issued, "credential")}${names ? `, to ${list(holders)},` : ","} and none to the same ID twice`;
}

/**
 * pnpm playground:credentials <election>: the table of credentials per
 * enrolment ID. Exits with status 1 when an ID in the voters' affiliation has
 * more than one, or the database can't be read.
 */
export function printCredentials(state, id, { fail }) {
  const election = ELECTIONS.find((e) => e.id === id);
  if (!election?.voterOrg) {
    const withCredentials = voterElections().map((e) => e.id);
    fail(
      election ? `${id} has X.509 voters, so it has no voters' CA to count.` : `There's no election ${id} in the playground's list.`,
      withCredentials.length ? `The elections with voter credentials are ${list(withCredentials)}.` : "No election in ELECTIONS in devnet/experimental.mjs has voter credentials.",
    );
  }
  const count = credentialCount(state, election);
  const { ca, mspId } = { ca: election.voterOrg.ca.name, mspId: election.voterOrg.mspId };
  if (count.error) fail(`${ca}'s credentials weren't counted: ${count.error}.`, "Run pnpm playground:up --experimental first.");
  console.log(`${ca}, for ${id} (${mspId}), from .state/${relative(state, count.db)}\n`);
  const width = Math.max("Enrolment ID".length, ...count.voters.map((v) => v.id.length)) + 3;
  console.log(`  ${"Enrolment ID".padEnd(width)}Credentials`);
  for (const v of count.voters) console.log(`  ${v.id.padEnd(width)}${v.credentials}`);
  if (count.others.length) {
    console.log(`\n  Outside the ${VOTER_AFFILIATION} affiliation, whose credentials the contract refuses: ${count.others.map((o) => `${o.id} ${o.credentials}`).join(", ")}`);
  }
  if (count.extra.length) {
    const lines = count.extra.map((v) => `${v.id} has ${v.credentials} credentials, so one person can vote ${v.credentials} times in ${id}.`);
    fail(
      lines.join("\n  "),
      "The CA issued them through token authorisation, which maxenrollments doesn't count. Credentials can't be revoked: cancel the election if it is still in keygen, or tell the voters and run a new election under a new issuer key.",
    );
  }
  const holders = count.voters.filter((v) => v.credentials > 0).length;
  console.log(`\n✓ No enrolment ID has more than one credential. ${holders} of ${count.voters.length} voters hold one.`);
  return count;
}

/* ------------------------------------------------------------------ */
/* Voter invites (D8 of the step 5 plan)                               */
/* ------------------------------------------------------------------ */

/** Every PEM certificate in an MSP folder's cacerts and intermediatecerts, as one chain. */
function caChain(mspDir) {
  const pems = [];
  for (const sub of ["cacerts", "intermediatecerts"]) {
    const dir = join(mspDir, sub);
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).sort()) pems.push(readFileSync(join(dir, file), "utf8").trim());
  }
  return `${pems.join("\n")}\n`;
}

/**
 * Writes the voter invite of each election with voter credentials to
 * .state/voter-invites/<election>.json, for the relay to serve. Its CA URL is
 * the election's CA proxy, its relay is Org1's, named as run by Weft
 * Playground, its title is the seed's, its issuer key hash is SHA-256 of the
 * CA's IssuerPublicKey, and its endorsers are the trustee organisations with
 * their CA chains. Returns
 * the elections whose invite changed, so the relay can be restarted to serve them.
 */
export function writeVoterInvites(net, state, { relayUrl, explorerUrl, https = false, network = "Weft playground" }) {
  const dir = paths(state).voterInvites;
  mkdirSync(dir, { recursive: true });
  const changed = [];
  // An election no longer in ELECTIONS has its invite removed.
  const listed = new Set(voterElections().map((e) => `${e.id}.json`));
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json") && !listed.has(f))) {
    rmSync(join(dir, file));
    changed.push(file.replace(/\.json$/, ""));
  }
  for (const election of voterElections()) {
    const { mspId, ca } = election.voterOrg;
    const invite = {
      weftVoterInvite: 1,
      network,
      organization: `${election.seed?.title ?? election.id} voters`,
      mspId,
      affiliation: VOTER_AFFILIATION,
      caUrl: caProxyUrl(election, { https }),
      caName: ca.name,
      relayUrl,
      relayOperator: RELAY_OPERATOR,
      channel: electionChannel(election),
      chaincode: PRIVATE_CONTRACT,
      electionId: election.id,
      ...(election.seed?.title ? { title: election.seed.title } : {}),
      issuerKeyHash: fileHash(join(paths(state).election(election).home, "IssuerPublicKey")),
      curve: CURVE,
      endorsers: net.orgs.map((o) => ({ mspId: o.msp, caChain: caChain(o.mspDir) })),
      ...(explorerUrl ? { explorerUrl } : {}),
    };
    const file = join(dir, `${election.id}.json`);
    const text = `${JSON.stringify(invite, null, 2)}\n`;
    if (!existsSync(file) || readFileSync(file, "utf8") !== text) changed.push(election.id);
    writeFileSync(file, text);
  }
  return changed;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** "17:00 UTC on 31 January 2027", as weft-trustee writes times. */
const when = (iso) => {
  const d = new Date(iso);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC on ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};

const list = (items) => (items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

/**
 * pnpm playground:count <election>: closes the election early with every
 * organisation's trustee (k = n in the playground), posts each decryption
 * share, publishes the tally and prints the counts. Each step that has
 * already happened is skipped, so it can run again.
 */
export function countElection(net, state, id, { step, note, fail }, { channel, acceptExtraCredentials = false } = {}) {
  const listed = ELECTIONS.find((e) => e.id === id);
  // An election that isn't in the list, such as one the e2e tests create, is counted on the channel given.
  const election = listed && (!channel || channel === electionChannel(listed)) ? listed : channel ? { id, channel } : null;
  if (!election) {
    fail(
      `There's no election ${id} in the playground's list.`,
      `The elections are ${list(ELECTIONS.map((e) => e.id))}, in ELECTIONS in devnet/experimental.mjs. For another election, give its channel: pnpm playground:count ${id} --channel <channel>.`,
    );
  }
  const files = paths(state).trustee(net.orgs[0]);
  if (!existsSync(files.connection(election))) {
    fail(
      listed || !existsSync(files.dir) ? "The playground has no trustees set up." : `The playground's trustees have no connection file for ${electionChannel(election)}.`,
      listed || !existsSync(files.dir) ? "Run pnpm playground:up --experimental first." : `Count an election on one of the channels in ELECTIONS: ${list(privateChannels())}.`,
    );
  }
  step(1, `Counting ${id} with ${list(net.orgs.map((o) => o.msp))}`);
  const show = (org, output) => {
    for (const line of output.split("\n").filter(Boolean)) console.log(`    ${org.msp.padEnd(8)} ${line}`);
  };
  const read = (org) => {
    const r = trusteeStatus(net, state, org, election);
    if (r.missing) fail(`There's no election ${id} on ${electionChannel(election)}.`, listed ? "Run pnpm playground:up --experimental to seed it." : "Check the election's ID and its channel.");
    if (r.error) fail(`Couldn't read ${id} through ${org.msp}'s peer.`, failedLines(r.error));
    return r.report;
  };
  let report = read(net.orgs[0]);
  if (report.election.state === "keygen" || report.election.state === "failed" || report.election.state === "cancelled") {
    fail(`${id} can't be counted: it is in ${report.election.state}.`);
  }
  // D14: before voting closes, no voter ID may hold more than one credential.
  if (report.election.state === "open" && election.voterOrg) {
    const count = credentialCount(state, election);
    const ca = election.voterOrg.ca.name;
    if (count.error || count.extra.length) {
      const problem = count.error
        ? `${ca}'s credentials weren't counted: ${count.error}, so ${id} may have more votes than voters.`
        : `${credentialSummary(count, election)}.`;
      if (!acceptExtraCredentials) {
        fail(problem, `Nothing was closed. Run pnpm playground:credentials ${id} to see them, or count anyway with --accept-extra-credentials.`);
      }
      note(`${problem.replace(/\.$/, "")}; counting anyway, as --accept-extra-credentials asks`);
    } else note(credentialSummary(count, election, { names: false }));
  }
  if (report.election.state === "open") {
    for (const [i, org] of net.orgs.entries()) {
      if (report.ceremony.trustees[i].closeRequested) continue;
      let r = runTrustee(net, state, org, election, "close", ["--early"]);
      // A ballot committed while the close was endorsed: the contract asks for the close again.
      if (!r.ok && /PHANTOM_READ_CONFLICT|MVCC_READ_CONFLICT/.test(r.output)) r = runTrustee(net, state, org, election, "close", ["--early"]);
      show(org, r.output);
      if (!r.ok) fail(`${org.msp}'s trustee couldn't close ${id}.`);
      report = read(org);
      if (report.election.state !== "open") break;
    }
  }
  if (report.election.state === "decrypting") {
    for (const org of net.orgs) {
      const posted = (report.shares?.shares ?? []).some((s) => s.msp === org.msp);
      if (posted) continue;
      const r = runTrustee(net, state, org, election, "decrypt");
      show(org, r.output);
      if (!r.ok) fail(`${org.msp}'s trustee couldn't post its decryption share for ${id}.`);
      report = read(org);
      if (report.election.state === "counted") break;
    }
  }
  if (report.election.state === "decrypting") {
    const r = runTrustee(net, state, net.orgs[0], election, "publish");
    show(net.orgs[0], r.output);
    if (!r.ok) fail(`Couldn't publish the tally for ${id}.`);
    report = read(net.orgs[0]);
  }
  const { tally, options, title } = report.election;
  const width = Math.max(...options.map((o) => o.length));
  console.log(`\n${title} (${id}), counted\n`);
  for (const o of options) console.log(`  ${o.padEnd(width)}   ${tally.counts[o]}`);
  console.log(`  ${tally.total} ${tally.total === 1 ? "ballot" : "ballots"}\n`);
  return tally;
}

/**
 * Everything experimental that the stack writes to .state, for playground:down.
 * Throws if a file can't be removed: on Linux the voters' CA containers write
 * their homes as root, and cli.mjs then removes those with Docker.
 */
export function clean(state) {
  const p = paths(state);
  const policies = explorerNames.map((name) => join(state, `${name}-experimental.yaml`));
  for (const path of [p.marker, p.channels, ...p.legacy, p.votersMsp, p.trustees, p.voterInvites, ...policies, p.votersCa]) rmSync(path, { recursive: true, force: true });
}
