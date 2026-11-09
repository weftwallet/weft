#!/usr/bin/env node
/**
 * `pnpm playground:smoke`: checks a running experimental playground
 * (`pnpm playground:up --experimental`) from end to end, without a browser,
 * and prints PASS or FAIL for each step, then a summary. It exits with 1 if
 * any step failed. A step that needs an earlier one that failed is skipped,
 * and says which.
 *
 *   1. The relay's invite for Org1, and the voter invite of each election with
 *      voter credentials, checked as Weft checks them.
 *   2. Each voters' CA proxy: its issuer key is the one the voter invite pins.
 *   3. A new voter, registered for this run on the voters' CA with the CA's
 *      admin, enrols through the proxy with the idemix WebAssembly module,
 *      as Weft Experimental does.
 *   4. A new Org1 user, registered for this run, enrols through Org1's CA
 *      proxy with a key made here.
 *   5. That user reads an open election with X.509 voters through the relay
 *      and casts a private ballot in it.
 *   6. The new voter reads the open election with voter credentials through
 *      the relay with a one-off identity, and casts an anonymous ballot.
 *   7. Both explorers find each ballot by its tracking code, and their own
 *      checks of it passed.
 *
 * Each run registers new IDs, so it can run again on the same stack. When
 * the playground's own election of a kind (budget-2027, chair-2027) isn't
 * open any more, it creates a fresh one on that election's channel, with the
 * playground's trustees, as the e2e tests do, and votes in that. It uses the
 * built packages (pnpm build) and the idemix module, which
 * `playground:up --experimental` builds. With WEFT_SMOKE_STATE, it reads the
 * playground's files from another folder than devnet/.state.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as experimental from "./experimental.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");
const state = resolve(process.env.WEFT_SMOKE_STATE ?? join(here, ".state"));
const samples = resolve(process.env.WEFT_FABRIC_SAMPLES ?? join(here, ".fabric", "fabric-samples"));
const testNetwork = join(samples, "test-network");
const RELAY = process.env.WEFT_SMOKE_RELAY ?? "http://localhost:8787";
const EXPLORERS = [
  { name: "Org1's explorer", url: process.env.WEFT_SMOKE_EXPLORER ?? "http://localhost:8790" },
  { name: "Org2's explorer", url: process.env.WEFT_SMOKE_EXPLORER_ORG2 ?? "http://localhost:8791" },
];
/** Org1's CA as test-network sets it up, for registering this run's user with its registrar. */
const ORG1_CA = {
  home: process.env.WEFT_SMOKE_ORG1_CA_HOME ?? join(testNetwork, "organizations", "peerOrganizations", "org1.example.com"),
  tls: process.env.WEFT_SMOKE_ORG1_CA_TLS ?? join(testNetwork, "organizations", "fabric-ca", "org1", "ca-cert.pem"),
  url: process.env.WEFT_SMOKE_ORG1_CA_URL ?? "https://localhost:7054",
  name: "ca-org1",
};
const caClient = join(process.env.FABRIC_CA_BIN ?? join(samples, "bin"), "fabric-ca-client");

// Colours only on a terminal, so a log file reads as plain text.
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = paint(1);
const green = paint(32);
const red = paint(31);
const dim = paint(2);

/* ------------------------------------------------------------------ */
/* Steps                                                               */
/* ------------------------------------------------------------------ */

const results = [];
/**
 * Runs one step. `needs` names the steps it depends on; if one of them
 * failed or was skipped, this one is skipped. A step returns what it found,
 * which is printed under its line, and throws to fail.
 */
async function step(name, needs, run) {
  const missing = needs.find((n) => results.find((r) => r.name === n)?.outcome !== "pass");
  if (missing) {
    results.push({ name, outcome: "skip", detail: `Not run: "${missing}" didn't pass.` });
    console.log(`${dim("SKIP")} ${name}\n     ${dim(`Not run: "${missing}" didn't pass.`)}`);
    return;
  }
  const t = performance.now();
  try {
    const detail = await run();
    const ms = performance.now() - t;
    results.push({ name, outcome: "pass", detail, ms });
    console.log(`${green("PASS")} ${name} ${dim(`(${seconds(ms)})`)}${detail ? `\n     ${detail}` : ""}`);
  } catch (error) {
    const ms = performance.now() - t;
    const detail = error instanceof Error ? error.message : String(error);
    results.push({ name, outcome: "fail", detail, ms });
    console.log(`${red("FAIL")} ${name} ${dim(`(${seconds(ms)})`)}\n     ${detail}`);
  }
}
const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;

async function getJson(url, init) {
  let response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  } catch (error) {
    throw new Error(`${url} didn't answer (${error.cause?.code ?? error.name}). Check that the playground is running: pnpm playground:status.`);
  }
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* reported below */
  }
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}: ${json?.error?.message ?? json?.error ?? text.slice(0, 200)}`);
  if (json === null) throw new Error(`${url} didn't answer with JSON.`);
  return json;
}

/** Registers an ID on a Fabric CA with its admin's fabric-ca-client home, as the playground registers its demo users. */
function register({ home, tls, url, name }, id, secret, extra) {
  if (!existsSync(caClient)) throw new Error(`There's no fabric-ca-client at ${caClient}. Run pnpm playground:up first, which downloads it.`);
  const r = spawnSync(caClient, ["register", "-u", url, "--caname", name, "--id.name", id, "--id.secret", secret, "--id.type", "client", ...extra, "--tls.certfiles", tls], {
    encoding: "utf8",
    env: { ...process.env, FABRIC_CA_CLIENT_HOME: home },
    timeout: 30_000,
  });
  if (r.status !== 0) throw new Error(`fabric-ca-client couldn't register ${id} on ${name}: ${`${r.stdout}${r.stderr}`.trim().split("\n").pop()}`);
}

const basic = (id, secret) => `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;
const b64 = (bytes) => Buffer.from(bytes).toString("base64");
const unb64 = (s) => new Uint8Array(Buffer.from(s, "base64"));

/** The reason a relay call failed, in the contract's words when it gave some. */
function reason(error) {
  const details = (error.details ?? []).map((d) => d.message).filter(Boolean);
  const m = (details[0] ?? error.message ?? String(error)).match(/chaincode response \d+, (.*)$/s);
  return m ? m[1] : (details[0] ?? error.message ?? String(error));
}

/* ------------------------------------------------------------------ */
/* The run                                                             */
/* ------------------------------------------------------------------ */

console.log(bold("Weft playground smoke test"));
console.log(dim(`Relay ${RELAY}, explorers ${EXPLORERS.map((e) => e.url).join(" and ")}, files in ${state}\n`));

const dist = (pkg, file) => pathToFileURL(join(repo, "packages", pkg, "dist", file)).href;
let core, tally, tallyClient, idemix;
await step("The packages are built", [], async () => {
  for (const [pkg, file] of [["core", "index.js"], ["tally", "client.js"], ["idemix", "node.js"]]) {
    if (!existsSync(fileURLToPath(dist(pkg, file)))) throw new Error(`packages/${pkg}/dist/${file} isn't built. Run pnpm build first.`);
  }
  if (!existsSync(join(repo, "packages", "idemix", "dist", "wasm", "weft-idemix.wasm"))) {
    throw new Error("The idemix module isn't built. Run pnpm --filter @weftwallet/idemix build:wasm, or pnpm playground:up --experimental, which builds it.");
  }
  core = await import(dist("core", "index.js"));
  tally = await import(dist("tally", "index.js"));
  tallyClient = await import(dist("tally", "client.js"));
  idemix = await import(dist("idemix", "node.js"));
  return "core, tally and idemix, with the idemix module";
});

let x509Election = experimental.ELECTIONS.find((e) => !e.voterOrg);
let voterElection = experimental.voterElections()[0];
/** The election whose voters' CA the run's voter registers on: the playground's own, even when it votes in a fresh election on its channel. */
const voterCa = experimental.voterElections()[0];
const relay = () => new core.RelayClient(RELAY);
const run = `smoke-${Date.now().toString(36)}-${randomBytes(2).toString("hex")}`;

let invite;
await step("Org1's invite, from the relay", ["The packages are built"], async () => {
  invite = core.parseInvite(await getJson(`${RELAY}/.well-known/weft-invite.json`), `${RELAY}/.well-known/weft-invite.json`);
  const want = experimental.ELECTIONS.map(experimental.electionChannel);
  const missing = want.filter((c) => !invite.channels.includes(c));
  if (missing.length) throw new Error(`The invite doesn't list ${missing.join(", ")}. Start the stack with pnpm playground:up --experimental.`);
  return `${invite.organization} (${invite.mspId}), CA proxy ${invite.caUrl}, channels ${invite.channels.join(", ")}`;
});

/**
 * An open election of a kind: the playground's own when Org1's explorer says
 * it's open, or a fresh one on its channel, which the trustees create and open.
 */
async function openElection(election, kind) {
  const channel = experimental.electionChannel(election);
  const view = await getJson(`${EXPLORERS[0].url}/api/v1/channels/${encodeURIComponent(channel)}/private-elections/${encodeURIComponent(election.id)}`).catch(() => null);
  if (view?.state === "open") return { election, said: `${election.id} is open` };
  const id = `${run}-${kind}`;
  const fresh = { id, channel, seed: { title: `Smoke ${kind} ${run.slice(6)}`, options: election.seed?.options ?? ["Plan A", "Plan B", "Plan C"], openForDays: 1 }, ...(election.voterOrg ? { voterOrg: election.voterOrg } : {}) };
  const seeded = experimental.seedElection({ orgs: [{ msp: "Org1MSP" }, { msp: "Org2MSP" }] }, state, fresh, { msp: "Org1MSP" });
  if (!String(seeded).startsWith("created")) throw new Error(`${election.id} is ${view?.state ?? "unknown to Org1's explorer"}, and a fresh election couldn't be created on ${channel}: ${seeded}`);
  if (election.voterOrg) {
    // Its voter invite, beside the playground's, which the relay reads when first asked for it.
    const dir = experimental.paths(state).voterInvites;
    const template = JSON.parse(readFileSync(join(dir, `${election.id}.json`), "utf8"));
    writeFileSync(join(dir, `${id}.json`), `${JSON.stringify({ ...template, electionId: id, title: fresh.seed.title, organization: `${fresh.seed.title} voters` }, null, 2)}\n`);
  }
  return { election: fresh, said: `${election.id} is ${view?.state ?? "not in Org1's explorer"}, so ${id} was created on ${channel} and opened` };
}

await step("An open election with X.509 voters", ["The packages are built"], async () => {
  if (!x509Election) throw new Error("No election in ELECTIONS has X.509 voters.");
  const open = await openElection(x509Election, "x509");
  x509Election = open.election;
  return open.said;
});

await step("An open election with voter credentials", ["The packages are built"], async () => {
  if (!voterElection) throw new Error("No election in ELECTIONS has voter credentials.");
  const open = await openElection(voterElection, "anonymous");
  voterElection = open.election;
  return open.said;
});

let voterInvite;
await step("The voter invite, from the relay", ["An open election with voter credentials"], async () => {
  const url = `${RELAY}/.well-known/weft-voter-invite/${voterElection.id}.json`;
  voterInvite = core.parseVoterInvite(await getJson(url), url);
  return `${voterInvite.title ?? voterInvite.electionId}: ${voterInvite.mspId}, CA proxy ${voterInvite.caUrl}, relay run by ${voterInvite.relayOperator}`;
});

let issuerKey;
await step("The voters' CA proxy serves the issuer key the voter invite pins", ["The voter invite, from the relay"], async () => {
  const info = await getJson(`${voterInvite.caUrl}/api/v1/cainfo`);
  issuerKey = info.result?.IssuerPublicKey;
  if (!issuerKey) throw new Error(`${voterInvite.caUrl}/api/v1/cainfo has no IssuerPublicKey.`);
  const hash = createHash("sha256").update(Buffer.from(issuerKey, "base64")).digest("hex");
  if (hash !== voterInvite.issuerKeyHash) throw new Error(`SHA-256 of the CA's issuer key is ${hash}, and the invite pins ${voterInvite.issuerKeyHash}.`);
  return `SHA-256 ${hash.slice(0, 16)}…`;
});

let api;
let credential;
const voter = { id: `${run}-voter`, secret: `${run}-voter-pw` };
await step("A new voter enrols through the voters' CA proxy with the idemix module", ["The voters' CA proxy serves the issuer key the voter invite pins"], async () => {
  const files = experimental.paths(state).election(voterCa);
  register(
    { home: files.admin, tls: join(files.home, "ca-cert.pem"), url: `https://localhost:${voterCa.voterOrg.ca.port}`, name: voterCa.voterOrg.ca.name },
    voter.id,
    voter.secret,
    ["--id.affiliation", experimental.VOTER_AFFILIATION, "--id.maxenrollments", "1"],
  );
  const started = await idemix.startIdemixNode();
  api = started.api;
  const loaded = await api.loadIssuerKey(issuerKey);
  if (loaded.issuerKeyHash !== voterInvite.issuerKeyHash) throw new Error("The module's issuer key hash isn't the invite's.");
  const post = (body) => getJson(`${voterInvite.caUrl}/api/v1/idemix/credential`, { method: "POST", headers: { authorization: basic(voter.id, voter.secret), "content-type": "application/json" }, body: JSON.stringify(body) });
  const first = await post({});
  if (!first.success) throw new Error(`The CA refused the enrolment: ${JSON.stringify(first.errors)}`);
  const req = await api.credentialRequest(first.result.Nonce);
  const second = await post({ request: req.request, ...(voterInvite.caName ? { caname: voterInvite.caName } : {}) });
  if (!second.success) throw new Error(`The CA refused the credential request: ${JSON.stringify(second.errors)}`);
  const a = second.result.Attrs;
  credential = { secretKey: req.secretKey, credential: second.result.Credential, cri: second.result.CRI, ou: a.OU, role: a.Role, enrollmentId: a.EnrollmentID };
  await api.checkCredential(credential);
  // A second enrolment: the CA refuses it (HTTP 401, code 20), as each ID enrols once.
  const again = await fetch(`${voterInvite.caUrl}/api/v1/idemix/credential`, { method: "POST", headers: { authorization: basic(voter.id, voter.secret), "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(15_000) });
  const refusal = await again.json().catch(() => null);
  if (again.ok || refusal?.success) throw new Error(`The CA enrolled ${voter.id} a second time.`);
  return `${voter.id}: OU ${credential.ou}, role ${credential.role}; the module started in ${seconds(started.timings.read + started.timings.hash + started.timings.compile + started.timings.run)}; a second enrolment is refused`;
});

let user;
await step("A new Org1 user enrols through Org1's CA proxy", ["Org1's invite, from the relay"], async () => {
  const id = `${run}-user`;
  const secret = `${run}-user-pw`;
  register(ORG1_CA, id, secret, []);
  const keys = await core.generateKeyPair();
  const ca = new core.FabricCaClient({ url: invite.caUrl, caName: invite.caName });
  const enrolled = await ca.enroll(id, secret, keys);
  user = { id, certificate: enrolled.certificate, privateKey: keys.privateKey };
  return `${id}, certificate from ${enrolled.caName ?? ORG1_CA.name}`;
});

/** An election's record, read through the relay with `signer`, and its open setup. */
async function readElection(signer, sign, election, id) {
  const r = await core.evaluateCall(relay(), signer, { channel: experimental.electionChannel(election), chaincode: experimental.PRIVATE_CONTRACT, fn: "GetElection", args: [id] }, sign);
  const record = JSON.parse(r.text);
  if (record.state !== "open") throw new Error(`${id} is ${record.state}, not open. Start a fresh stack with pnpm playground:down and pnpm playground:up --experimental.`);
  return {
    record,
    setup: {
      channel: experimental.electionChannel(election),
      chaincode: experimental.PRIVATE_CONTRACT,
      electionId: id,
      options: record.options,
      threshold: record.threshold,
      trustees: record.trustees.map((t) => t.msp),
      publicKey: record.publicKey,
      verifyingShares: record.verifyingShares,
    },
  };
}

const cast = {};
await step("The Org1 user casts a private ballot through the relay", ["A new Org1 user enrols through Org1's CA proxy", "An open election with X.509 voters"], async () => {
  const signer = { mspId: invite.mspId, certificate: user.certificate };
  const sign = (m) => core.signForFabric(user.privateKey, m);
  const { record, setup } = await readElection(signer, sign, x509Election, x509Election.id);
  const tag = tally.voterTagFromCertificate(setup.channel, x509Election.id, invite.mspId, Buffer.from(user.certificate.trim()));
  const ballot = tallyClient.encryptBallot(setup, tag, 0);
  try {
    const r = await core.submitCall(relay(), signer, { channel: setup.channel, chaincode: setup.chaincode, fn: "CastBallot", args: [x509Election.id, ballot.json] }, sign);
    cast.x509 = { channel: setup.channel, id: x509Election.id, tracking: ballot.tracking, block: r.blockNumber };
    return `${record.title}: ${r.status} in block ${r.blockNumber}, tracking code ${ballot.tracking.slice(0, 16)}…`;
  } catch (error) {
    throw new Error(`The ballot wasn't committed: ${reason(error)}`);
  }
});

await step("The new voter casts an anonymous ballot through the relay", ["A new voter enrols through the voters' CA proxy with the idemix module"], async () => {
  const mspId = voterInvite.mspId;
  const oneOff = async () => {
    const id = await api.newIdentity(credential, mspId);
    return { id, signer: { mspId, idemixIdentity: id.idBytes }, sign: async (m) => unb64(await api.sign(id.handle, b64(m))), dispose: () => api.dispose(id.handle) };
  };
  const reader = await oneOff();
  let read;
  try {
    read = await readElection(reader.signer, reader.sign, voterElection, voterInvite.electionId);
  } finally {
    await reader.dispose();
  }
  const o = await oneOff();
  try {
    const P = await api.pseudonym(o.id.handle, voterInvite.channel, voterInvite.electionId);
    const tag = tally.voterTagIdemix(voterInvite.channel, voterInvite.electionId, mspId, tally.fromHex(P));
    const ballot = tallyClient.encryptBallot(read.setup, tag, 1);
    const proof = await api.pseudonymProof(o.id.handle, voterInvite.channel, voterInvite.electionId, ballot.tracking);
    const call = { channel: voterInvite.channel, chaincode: voterInvite.chaincode, fn: "CastAnonymousBallot", args: [voterInvite.electionId, ballot.json, JSON.stringify(proof)] };
    const r = await core.submitCall(relay(), o.signer, call, o.sign);
    cast.anonymous = { channel: voterInvite.channel, id: voterInvite.electionId, tracking: ballot.tracking, block: r.blockNumber };
    return `${read.record.title}: ${r.status} in block ${r.blockNumber}, signed by a one-off identity of ${mspId}, tracking code ${ballot.tracking.slice(0, 16)}…`;
  } catch (error) {
    throw new Error(`The ballot wasn't committed: ${reason(error)}`);
  } finally {
    await o.dispose();
  }
});

/** Waits until an explorer has indexed the ballot with that tracking code, and returns its check. */
async function found(explorer, b) {
  const url = `${explorer.url}/api/v1/channels/${encodeURIComponent(b.channel)}/private-elections/${encodeURIComponent(b.id)}/tracking/${b.tracking}`;
  const until = Date.now() + 60_000;
  for (;;) {
    const r = await getJson(url);
    if (r.found) {
      if (!r.ballot.verified) throw new Error(`${explorer.name} indexed the ballot in block ${r.ballot.block}, and its check failed: ${r.ballot.error}`);
      return r.ballot;
    }
    if (Date.now() > until) throw new Error(`${explorer.name} hasn't indexed the ballot in block ${b.block} after 60 seconds.`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

for (const [label, key, needs] of [
  ["the private ballot", "x509", "The Org1 user casts a private ballot through the relay"],
  ["the anonymous ballot", "anonymous", "The new voter casts an anonymous ballot through the relay"],
]) {
  await step(`Both explorers find ${label} and their checks of it passed`, [needs], async () => {
    const seen = [];
    for (const explorer of EXPLORERS) {
      const b = await found(explorer, cast[key]);
      seen.push(`${explorer.name} in block ${b.block}${b.anonymousCreator ? `, anonymous submitter of ${b.anonymousCreator.mspId}` : ""}`);
    }
    return seen.join("; ");
  });
}

/* ------------------------------------------------------------------ */
/* Summary                                                             */
/* ------------------------------------------------------------------ */

const count = (o) => results.filter((r) => r.outcome === o).length;
console.log(`\n${bold("Summary")}: ${count("pass")} passed, ${count("fail")} failed, ${count("skip")} skipped.`);
for (const r of results.filter((x) => x.outcome !== "pass")) console.log(`  ${r.outcome === "fail" ? red("FAIL") : dim("SKIP")} ${r.name}`);
process.exit(count("fail") + count("skip") > 0 ? 1 : 0);
