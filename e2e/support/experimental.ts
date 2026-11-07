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
 *                               (playground/.state by default)
 *   WEFT_E2E_ELECTION_CHANNEL   the election channel to create it on
 *                               (privatevote-budget-2027 by default)
 *   WEFT_E2E_PLAYGROUND_COUNT   the command that counts an election, given
 *                               `<election> --channel <channel>` after it
 *                               (node playground/cli.mjs count by default)
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

export const PLAYGROUND_STATE = process.env.WEFT_E2E_PLAYGROUND_STATE ?? join(ROOT, "playground", ".state");
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
 * 2, with the playground's seedElection (playground/experimental.mjs), which
 * runs weft-trustee create, commit, share and confirm as each organisation's
 * trustee.
 */
export async function createRunElection(): Promise<RunElection> {
  const playground = (await import(pathToFileURL(join(ROOT, "playground", "experimental.mjs")).href)) as {
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
  const [command, ...args] = (process.env.WEFT_E2E_PLAYGROUND_COUNT ?? `node ${join(ROOT, "playground", "cli.mjs")} count`).split(/\s+/).filter(Boolean);
  const r = spawnSync(command!, [...args, e.electionId, "--channel", e.channel], { cwd: ROOT, encoding: "utf8", timeout: 120_000 });
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (r.status !== 0) throw new Error(`Counting ${e.electionId} failed:\n${output}`);
  return output;
}
