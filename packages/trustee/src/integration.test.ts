/**
 * Against a running network: a whole election through each organisation's
 * own peer, with weft-trustee's commands and the Fabric Gateway. Skipped
 * unless WEFT_TRUSTEE_IT_ORG1 and WEFT_TRUSTEE_IT_ORG2 name each trustee's
 * connection file, as `pnpm playground:up --experimental` writes them in
 * playground/.state/trustees/<org>/<channel>.yaml:
 *
 *   WEFT_TRUSTEE_IT_ORG1=playground/.state/trustees/org1/privatevote-budget-2027.yaml \
 *   WEFT_TRUSTEE_IT_ORG2=playground/.state/trustees/org2/privatevote-budget-2027.yaml \
 *   pnpm --filter @weftwallet/trustee test integration
 *
 * Each run creates a new election, it-<time>, on that channel.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encryptBallot } from "@weftwallet/tally/client";
import { electionFingerprint, formatFingerprint, pemIdBytes, voterTagX509 } from "@weftwallet/tally";
import { afterAll, describe, expect, it } from "vitest";
import * as cmd from "./commands.ts";
import { resolveConnection } from "./connection.ts";
import { loadIdentity } from "./identity.ts";
import { gatewayLedger, type Ledger } from "./ledger.ts";
import { Failure, type Output } from "./output.ts";

const files = [process.env.WEFT_TRUSTEE_IT_ORG1, process.env.WEFT_TRUSTEE_IT_ORG2];
const ready = files.every(Boolean);
const ID = `it-${Date.now().toString(36)}`;
const ledgers: Ledger[] = [];

function trustee(file: string) {
  const connection = { ...resolveConnection({ connection: file }, {}), home: mkdtempSync(join(tmpdir(), "weft-trustee-it-")) };
  const identity = loadIdentity(connection.msp, connection.cert, connection.key);
  const lines: string[] = [];
  const out: Output = { line: (t = "") => lines.push(t), done: (t) => lines.push(`✓ ${t}`), failed: (t, ...h) => lines.push(`✗ ${t}`, ...h.map((x) => `  ${x}`)) };
  let ledger: Ledger | null = null;
  const env: cmd.Env = {
    connection,
    identity,
    ledger: async () => {
      if (!ledger) ledgers.push((ledger = await gatewayLedger(connection, identity)));
      return ledger;
    },
    prompt: { secret: async () => "integration passphrase", line: async () => ID },
    out,
    passphrase: `integration passphrase for ${connection.msp}`,
    now: () => new Date(),
  };
  const run = async (f: (env: cmd.Env) => Promise<number>) => {
    const start = lines.length;
    try {
      expect(await f(env)).toBe(0);
    } catch (err) {
      if (err instanceof Failure) throw new Error(err.lines.join("\n"));
      throw err;
    }
    return lines.slice(start);
  };
  return { env, run, identity };
}

afterAll(() => ledgers.forEach((l) => l.close()));

describe.skipIf(!ready)("weft-trustee on a running network", () => {
  it("runs an election from create to tally through each organisation's peer", async () => {
    const [t1, t2] = files.map((f) => trustee(f!)) as [ReturnType<typeof trustee>, ReturnType<typeof trustee>];
    const e = { election: ID };
    const closesAt = new Date(Date.now() + 30 * 86_400_000).toISOString();
    await t1.run((env) => cmd.create(env, { election: ID, title: "Integration", options: ["Plan A", "Plan B", "Plan C"], closesAt, trustees: [t1.identity.msp, t2.identity.msp] }));
    for (const step of [cmd.commit, cmd.share, cmd.confirm]) {
      await t1.run((env) => step(env, e));
      const last = await t2.run((env) => step(env, e));
      if (step === cmd.confirm) {
        const ledger = await t1.env.ledger();
        const rec = JSON.parse(await ledger.evaluate("GetElection", ID)) as cmd.ElectionRecord;
        const fp = electionFingerprint({ channel: t1.env.connection.channel, chaincode: t1.env.connection.contract, electionId: ID, options: rec.options, threshold: 2, trustees: rec.trustees.map((t) => t.msp), publicKey: rec.publicKey!, verifyingShares: rec.verifyingShares! });
        expect(rec.state).toBe("open");
        expect(last).toContain(`Election key fingerprint   ${formatFingerprint(fp)}`);
      }
    }
    // The two trustee identities vote, one ballot each.
    const rec = JSON.parse(await (await t1.env.ledger()).evaluate("GetElection", ID)) as cmd.ElectionRecord;
    const election = { channel: t1.env.connection.channel, chaincode: t1.env.connection.contract, electionId: ID, options: rec.options, threshold: 2, trustees: rec.trustees.map((t) => t.msp), publicKey: rec.publicKey!, verifyingShares: rec.verifyingShares! };
    for (const [t, choice] of [[t1, 0], [t2, 2]] as const) {
      const tag = voterTagX509(election.channel, ID, t.identity.msp, pemIdBytes(t.identity.certificate));
      await (await t.env.ledger()).submit("CastBallot", ID, encryptBallot(election, tag, choice).json);
    }
    await t1.run((env) => cmd.close(env, { ...e, early: true }));
    expect((await t2.run((env) => cmd.close(env, { ...e, early: true })))[0]).toMatch(/: 2 of 2 trustees asked\. Added up 2 ballots per option\.$/);
    await t1.run((env) => cmd.decrypt(env, e));
    const tally = await t2.run((env) => cmd.decrypt(env, e));
    expect(tally).toEqual(expect.arrayContaining(["Plan A   1", "Plan B   0", "Plan C   1", "2 ballots, and the counts add up to them."]));
    for (const t of [t1, t2]) await t.run((env) => cmd.destroy(env, { ...e, yes: true }));
  });
});
