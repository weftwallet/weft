/**
 * TEST ONLY: weft-trustee's commands against the fake contract, with each
 * trustee's state folder in a temporary home, a scripted terminal and the
 * output kept as the lines a person would see.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Env } from "../commands.ts";
import { Failure, type Output } from "../output.ts";
import type { Prompt } from "../prompt.ts";
import { FakeContract } from "./fake-contract.ts";

/** Light scrypt settings, so tests don't spend seconds per file. */
export const TEST_KDF = { N: 1024, r: 8, p: 1 };

export interface Trustee {
  env: Env;
  lines: string[];
  /** The questions the terminal was asked. */
  asked: string[];
  /** What the terminal answers next, in order. */
  answers: string[];
  home: string;
}

export function trustee(contract: FakeContract, msp: string, name: string, opts: { trustee?: boolean; now?: Date; home?: string } = {}): Trustee {
  const home = opts.home ?? mkdtempSync(join(tmpdir(), `weft-trustee-${name}-`));
  const lines: string[] = [];
  const asked: string[] = [];
  const answers: string[] = [];
  const out: Output = {
    line: (t = "") => lines.push(t),
    done: (t) => lines.push(`✓ ${t}`),
    failed: (t, ...hints) => lines.push(`✗ ${t}`, ...hints.map((h) => `  ${h}`)),
  };
  const answer = (q: string) => {
    asked.push(q);
    const a = answers.shift();
    if (a === undefined) throw new Error(`the test gave no answer to "${q}"`);
    return Promise.resolve(a);
  };
  const prompt: Prompt = { secret: answer, line: answer };
  const isTrustee = opts.trustee ?? true;
  const env: Env = {
    connection: { peer: "localhost:7051", tlsCa: "/dev/null", msp, cert: "", key: "", channel: contract.channel, contract: contract.chaincode, home, source: "org1.yaml" },
    identity: { msp, name, certificate: "", privateKey: "", trustee: isTrustee },
    ledger: async () => contract.ledgerFor({ msp, trustee: isTrustee }),
    prompt,
    out,
    now: () => opts.now ?? new Date("2026-11-07T12:00:00.000Z"),
    kdf: TEST_KDF,
  };
  return { env, lines, asked, answers, home };
}

/** Runs a command as the CLI does: a Failure becomes ✗ lines and exit status 1. */
export async function run(t: Trustee, command: (env: Env) => Promise<number>): Promise<{ code: number; lines: string[] }> {
  const start = t.lines.length;
  let code: number;
  try {
    code = await command(t.env);
  } catch (err) {
    if (!(err instanceof Failure)) throw err;
    t.env.out.failed(err.lines[0]!, ...err.lines.slice(1));
    code = 1;
  }
  return { code, lines: t.lines.slice(start) };
}
