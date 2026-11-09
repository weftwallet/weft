/**
 * The experimental stack's election for a run (docs/adr/0007, 0009): the
 * experimental-setup project creates a fresh private election on an
 * existing election channel, with the playground's own seeding code and its
 * trustees, and the experimental-stack project's tests vote in it, count it
 * and check it. A fresh election each run means alice and bob can always
 * vote, and nothing depends on what earlier runs left on the ledger.
 *
 * Needs `pnpm playground:up --experimental` (WEFT_E2E_STACK=playground).
 * For a stack started another way:
 *   WEFT_E2E_PLAYGROUND_STATE   the folder with the trustees' files, trustees/<org>
 *                               (devnet/.state by default)
 *   WEFT_E2E_ELECTION_CHANNEL   the election channel to create it on
 *                               (privatevote-budget-2027 by default)
 *   WEFT_E2E_PLAYGROUND_COUNT   the command that counts an election, given
 *                               `<election> --channel <channel>` after it
 *                               (node devnet/cli.mjs count by default)
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "./stack.ts";

export interface RunElection {
  channel: string;
  electionId: string;
  title: string;
  options: string[];
  /** What the playground's seeding code said it did. */
  seeded: string;
}

export const PLAYGROUND_STATE = process.env.WEFT_E2E_PLAYGROUND_STATE ?? join(ROOT, "devnet", ".state");
export const ELECTION_CHANNEL = process.env.WEFT_E2E_ELECTION_CHANNEL ?? "privatevote-budget-2027";
export const CONTRACT = "private-ballot";
/** Where the setup project leaves the run's election for the tests: in Playwright's output folder, which each run empties. */
const FILE = join(ROOT, "e2e", "test-results", "experimental-election.json");
const ORGS = [{ msp: "Org1MSP" }, { msp: "Org2MSP" }];

/** Why the experimental stack can't make an election here, or null when it can. */
export function missingStack(): string | null {
  const connection = join(PLAYGROUND_STATE, "trustees", "org1", `${ELECTION_CHANNEL}.yaml`);
  if (!existsSync(connection)) {
    return `No trustee connection file at ${connection}. Start the stack with pnpm playground:up --experimental, or set WEFT_E2E_PLAYGROUND_STATE.`;
  }
  if (!existsSync(join(ROOT, "packages", "trustee", "dist", "cli.js"))) return "Build weft-trustee first (pnpm --filter @weftwallet/trustee... build).";
  return null;
}

/**
 * Creates and opens a new election with Org1MSP and Org2MSP as trustees, 2 of
 * 2, with the playground's seedElection (devnet/experimental.mjs), which
 * runs weft-trustee create, commit, share and confirm as each organisation's
 * trustee.
 */
export async function createRunElection(): Promise<RunElection> {
  const playground = (await import(pathToFileURL(join(ROOT, "devnet", "experimental.mjs")).href)) as {
    seedElection: (net: { orgs: { msp: string }[] }, state: string, election: unknown, creator: { msp: string }) => string;
  };
  const electionId = `e2e-${Date.now().toString(36)}`;
  const title = `End-to-end ${electionId.slice(4)}`;
  const options = ["Plan A", "Plan B", "Plan C"];
  const seeded = playground.seedElection(
    { orgs: ORGS },
    PLAYGROUND_STATE,
    { id: electionId, channel: ELECTION_CHANNEL, seed: { title, options, openForDays: 1 } },
    ORGS[0]!,
  );
  if (!seeded.startsWith("created")) throw new Error(`The playground couldn't create ${electionId} on ${ELECTION_CHANNEL}: ${seeded}`);
  const election = { channel: ELECTION_CHANNEL, electionId, title, options, seeded };
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(election, null, 2));
  return election;
}

/** The run's election, once the setup project has made it. */
export function runElection(): RunElection | null {
  return existsSync(FILE) ? (JSON.parse(readFileSync(FILE, "utf8")) as RunElection) : null;
}

/** Counts the election with pnpm playground:count's command, and returns what it printed. */
export function countRunElection(e: RunElection): string {
  const [command, ...args] = (process.env.WEFT_E2E_PLAYGROUND_COUNT ?? `node ${join(ROOT, "devnet", "cli.mjs")} count`).split(/\s+/).filter(Boolean);
  const r = spawnSync(command!, [...args, e.electionId, "--channel", e.channel], { cwd: ROOT, encoding: "utf8", timeout: 120_000 });
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (r.status !== 0) throw new Error(`Counting ${e.electionId} failed:\n${output}`);
  return output;
}

/* Elections with voter credentials (docs/adr/0008) ------------------------ */

export interface CredentialsElection extends RunElection {
  /** The voter organisation, and the voter invite the relay serves for this election. */
  voterMsp: string;
  inviteUrl: string;
  /** Two IDs registered for this run on the voters' CA, one enrolment each. */
  voters: { id: string; secret: string }[];
}

/** The playground's election whose voters' CA, channel and voter organisation the run's election shares. */
export const CREDENTIALS_TEMPLATE = process.env.WEFT_E2E_CREDENTIALS_ELECTION ?? "chair-2027";
const CREDENTIALS_FILE = join(ROOT, "e2e", "test-results", "credentials-election.json");

interface Playground {
  ELECTIONS: { id: string; seed?: unknown; voterOrg?: { mspId: string; ca: { name: string; port: number } } }[];
  electionChannel: (e: { id: string; channel?: string }) => string;
  paths: (state: string) => { election: (e: unknown) => { home: string; admin: string; msp: string }; voterInvites: string };
  seedElection: (net: { orgs: { msp: string }[] }, state: string, election: unknown, creator: { msp: string }) => string;
  VOTER_AFFILIATION: string;
}
const playground = async () => (await import(pathToFileURL(join(ROOT, "devnet", "experimental.mjs")).href)) as Playground;

/** fabric-ca-client: FABRIC_CA_BIN's, or the one the playground downloaded with Fabric's binaries. */
function caClientBin(): string {
  for (const dir of [process.env.FABRIC_CA_BIN, join(ROOT, "devnet", ".fabric", "fabric-samples", "bin")]) {
    if (dir && existsSync(join(dir, "fabric-ca-client"))) return join(dir, "fabric-ca-client");
  }
  throw new Error("fabric-ca-client isn't in FABRIC_CA_BIN or devnet/.fabric/fabric-samples/bin, so the run's voters can't be registered.");
}

/** Why the stack can't make an election with voter credentials here, or null when it can. */
export async function missingCredentialsStack(): Promise<string | null> {
  const p = await playground();
  const template = p.ELECTIONS.find((e) => e.id === CREDENTIALS_TEMPLATE);
  if (!template?.voterOrg) return `The playground has no election ${CREDENTIALS_TEMPLATE} with voter credentials in ELECTIONS.`;
  const files = p.paths(PLAYGROUND_STATE).election(template);
  if (!existsSync(join(files.admin, "msp", "signcerts", "cert.pem"))) return `No admin of ${template.voterOrg.ca.name} in ${files.admin}. Start the stack with pnpm playground:up --experimental.`;
  if (!existsSync(join(p.paths(PLAYGROUND_STATE).voterInvites, `${CREDENTIALS_TEMPLATE}.json`))) return `No voter invite for ${CREDENTIALS_TEMPLATE} in ${p.paths(PLAYGROUND_STATE).voterInvites}.`;
  return missingStack();
}

/**
 * A fresh election with voter credentials for this run, on the template
 * election's channel and under its voters' CA and issuer key: two new voter
 * IDs registered on that CA in the voters' affiliation, one enrolment each;
 * the election created, its key ceremony run and opened by Org1MSP's and
 * Org2MSP's trustees with the playground's seedElection; and its voter
 * invite, the template's with this election's ID, written to the folder the
 * relay serves voter invites from, which the relay reads when it is first
 * asked for.
 */
export async function createCredentialsElection(): Promise<CredentialsElection> {
  const p = await playground();
  const template = p.ELECTIONS.find((e) => e.id === CREDENTIALS_TEMPLATE)!;
  const vo = template.voterOrg!;
  const stamp = Date.now().toString(36);
  const electionId = `e2e-vc-${stamp}`;
  const title = `Credentials ${stamp}`;
  const options = ["Ada Obi", "Ben Carter", "Chioma Ude"];
  const channel = p.electionChannel(template);

  const files = p.paths(PLAYGROUND_STATE).election(template);
  const voters = ["a", "b"].map((x) => ({ id: `e2e-${stamp}-${x}`, secret: `e2e-${stamp}-${x}-pw` }));
  for (const v of voters) {
    const r = spawnSync(
      caClientBin(),
      [
        "register", "-u", `https://localhost:${vo.ca.port}`, "--caname", vo.ca.name, "--tls.certfiles", join(files.home, "ca-cert.pem"),
        "--id.name", v.id, "--id.secret", v.secret, "--id.type", "client", "--id.affiliation", p.VOTER_AFFILIATION, "--id.maxenrollments", "1",
      ],
      { encoding: "utf8", env: { ...process.env, FABRIC_CA_CLIENT_HOME: files.admin }, timeout: 30_000 },
    );
    if (r.status !== 0) throw new Error(`Couldn't register ${v.id} on ${vo.ca.name}:\n${r.stdout}${r.stderr}`);
  }

  const seeded = p.seedElection({ orgs: ORGS }, PLAYGROUND_STATE, { id: electionId, channel, seed: { title, options, openForDays: 1 }, voterOrg: vo }, ORGS[0]!);
  if (!/^created in block/.test(seeded) || !/opened/.test(seeded)) throw new Error(`The playground couldn't create ${electionId} on ${channel}:\n${seeded}`);

  const dir = p.paths(PLAYGROUND_STATE).voterInvites;
  const invite = JSON.parse(readFileSync(join(dir, `${CREDENTIALS_TEMPLATE}.json`), "utf8")) as { relayUrl: string; organization: string };
  writeFileSync(join(dir, `${electionId}.json`), `${JSON.stringify({ ...invite, electionId, title, organization: `${title} voters` }, null, 2)}\n`);
  const election: CredentialsElection = {
    channel,
    electionId,
    title,
    options,
    seeded,
    voterMsp: vo.mspId,
    inviteUrl: `${invite.relayUrl.replace(/\/+$/, "")}/.well-known/weft-voter-invite/${electionId}.json`,
    voters,
  };
  mkdirSync(dirname(CREDENTIALS_FILE), { recursive: true });
  writeFileSync(CREDENTIALS_FILE, JSON.stringify(election, null, 2));
  return election;
}

/** The run's election with voter credentials, once its setup project has made it. */
export function credentialsElection(): CredentialsElection | null {
  return existsSync(CREDENTIALS_FILE) ? (JSON.parse(readFileSync(CREDENTIALS_FILE, "utf8")) as CredentialsElection) : null;
}
