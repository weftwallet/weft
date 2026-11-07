import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { encryptBallot } from "@weftwallet/tally/client";
import { electionFingerprint, formatFingerprint, utf8, voterTagX509, type Election } from "@weftwallet/tally";
import { beforeEach, describe, expect, it } from "vitest";
import * as cmd from "./commands.ts";
import { FakeContract } from "./test/fake-contract.ts";
import { run, trustee, type Trustee } from "./test/harness.ts";

const ID = "budget-2027";
const CHANNEL = "privatevote-budget-2027";
const PASS1 = "correct horse battery";
const PASS2 = "staple paper clip";
const e = { election: ID };

let contract: FakeContract;
let t1: Trustee;
let t2: Trustee;

const folder = (t: Trustee) => join(t.home, CHANNEL, ID);

async function create(t = t1) {
  return run(t, (env) =>
    cmd.create(env, { election: ID, title: "Budget 2027", options: ["Plan A", "Plan B", "Plan C"], closesAt: "2027-01-31T17:00:00.000Z", trustees: ["Org1MSP", "Org2MSP"] }),
  );
}

/** Rounds 1 and 2 for both trustees, with the passphrases typed. */
async function rounds12() {
  t1.answers.push(PASS1, PASS1);
  await run(t1, (env) => cmd.commit(env, e));
  t2.answers.push(PASS2, PASS2);
  await run(t2, (env) => cmd.commit(env, e));
  t1.answers.push(PASS1);
  await run(t1, (env) => cmd.share(env, e));
  t2.answers.push(PASS2);
  await run(t2, (env) => cmd.share(env, e));
}

async function ceremony() {
  await create();
  await rounds12();
  t1.answers.push(PASS1);
  await run(t1, (env) => cmd.confirm(env, e));
  t2.answers.push(PASS2);
  return run(t2, (env) => cmd.confirm(env, e));
}

function electionOf(): Election {
  const rec = contract.record(ID);
  return { channel: CHANNEL, chaincode: "private-ballot", electionId: ID, options: rec.options, threshold: rec.threshold, trustees: rec.trustees.map((x) => x.msp), publicKey: rec.publicKey!, verifyingShares: rec.verifyingShares! };
}

/** Casts one ballot per choice, from voters with made-up certificates. */
async function vote(choices: number[]) {
  const election = electionOf();
  for (const [n, choice] of choices.entries()) {
    const msp = n % 2 ? "Org2MSP" : "Org1MSP";
    const idBytes = utf8(`voter ${n}`);
    const ballot = encryptBallot(election, voterTagX509(CHANNEL, ID, msp, idBytes), choice);
    await contract.ledgerFor({ msp, trustee: false, idBytes }).submit("CastBallot", ID, ballot.json);
  }
}

beforeEach(() => {
  contract = new FakeContract(CHANNEL);
  t1 = trustee(contract, "Org1MSP", "trustee1");
  t2 = trustee(contract, "Org2MSP", "trustee2");
});

describe("the transcripts in the step 4 model", () => {
  it("runs the whole election, 2 of 2, with the model's messages", async () => {
    expect((await create()).lines[0]).toMatch(/^✓ Created budget-2027 in block 3\. It stays in keygen until the key ceremony ends\. Transaction /);

    expect((await run(t1, (env) => cmd.status(env, e))).lines).toEqual([
      "Budget 2027 (budget-2027) on privatevote-budget-2027",
      "State      keygen: the key ceremony is running",
      "Trustees   Org1MSP (1) and Org2MSP (2). Any 2 of 2 can decrypt.",
      "You        trustee1, for Org1MSP",
      "",
      "Round 1    Org1MSP waiting   Org2MSP waiting",
      "Round 2    not started",
      "Round 3    not started",
      "",
      "Run weft-trustee commit --election budget-2027 to post round 1.",
    ]);

    t1.answers.push(PASS1, PASS1);
    const c1 = await run(t1, (env) => cmd.commit(env, e));
    expect(t1.asked).toEqual([`Passphrase for ${folder(t1)}: `, "Passphrase again: "]);
    expect(c1.lines).toEqual([
      `Drew a polynomial of degree 1 and a one-time ceremony key, and saved them, encrypted, in ${folder(t1)}.`,
      expect.stringMatching(/^✓ Posted round 1 in block 4: 2 commitments, a proof of knowledge and the one-time public key\. Transaction [0-9a]{8}…[0-9a]{8}\.$/),
      "",
      "Waiting for Org2MSP to post round 1. weft-trustee status says when it has; then run weft-trustee share --election budget-2027.",
    ]);

    // Round 2 too early: refused from the ceremony record, with no passphrase and nothing signed.
    const asked = t1.asked.length;
    const submits = contract.submitted().length;
    const early = await run(t1, (env) => cmd.share(env, e));
    expect(early).toEqual({ code: 1, lines: ["✗ Round 1 isn't finished: waiting for Org2MSP.", "  Nothing was posted. Run this again once Org2MSP has posted round 1."] });
    expect(t1.asked.length).toBe(asked);
    expect(contract.submitted().length).toBe(submits);

    t2.answers.push(PASS2, PASS2);
    expect((await run(t2, (env) => cmd.commit(env, e))).lines.slice(-1)).toEqual(["Every trustee has posted round 1. Run weft-trustee share --election budget-2027 to post round 2."]);
    t2.answers.push(PASS2);
    const s2 = await run(t2, (env) => cmd.share(env, e));
    expect(s2.lines[0]).toBe("Encrypted a share for Org1MSP to its one-time key.");
    expect(s2.lines[1]).toMatch(/^✓ Posted round 2 in block 6: 1 encrypted share\./);
    t1.answers.push(PASS1);
    await run(t1, (env) => cmd.share(env, e));

    t1.answers.push(PASS1);
    const r3a = await run(t1, (env) => cmd.confirm(env, e));
    expect(r3a.lines).toEqual([
      "Decrypted the share from Org2MSP and checked it against Org2MSP's round 1 commitments.",
      "Saved your key share, encrypted, and deleted the one-time ceremony key.",
      expect.stringMatching(/^✓ Posted round 3 in block 8: a proof that you hold your key share\./),
      "",
      "Waiting for Org2MSP to confirm. The election opens once it has.",
    ]);
    expect(readdirSync(folder(t1)).sort()).toEqual(["confirmation.json", "key-share.json", "round1.json"]);

    t2.answers.push(PASS2);
    const r3b = await run(t2, (env) => cmd.confirm(env, e));
    const fingerprint = electionFingerprint(electionOf());
    expect(contract.record(ID).fingerprint).toBe(fingerprint);
    expect(r3b.lines.slice(2)).toEqual([
      "✓ Posted round 3 in block 9.",
      "✓ Every trustee has confirmed. Opened budget-2027 in block 10.",
      "",
      `Election key fingerprint   ${formatFingerprint(fingerprint)}`,
      "Compare it with the fingerprint on any explorer's page for budget-2027.",
      "Voting is open until 17:00 UTC on 31 January 2027.",
    ]);

    await vote([0, 1, 1, 2, 1, 0, 0, 1, 1, 1, 0, 2, 0]);

    // Close before closesAt needs --early, and needs no passphrase.
    expect((await run(t1, (env) => cmd.close(env, e))).lines).toEqual([
      "✗ Voting is open until 2027-01-31T17:00:00.000Z.",
      "  Nothing was posted. Run this again after 17:00 UTC on 31 January 2027, or add --early to close it now.",
    ]);
    const asks = t1.asked.length;
    expect((await run(t1, (env) => cmd.close(env, { ...e, early: true }))).lines).toEqual([
      "✓ Asked to close budget-2027 in block 24. 1 of 2 trustees have asked; voting closes when 2 have.",
    ]);
    expect((await run(t2, (env) => cmd.close(env, { ...e, early: true }))).lines).toEqual([
      "✓ Closed budget-2027 in block 25: 2 of 2 trustees asked. Added up 13 ballots per option.",
      "That is before its planned closing time, 17:00 UTC on 31 January 2027. Explorers show the block it closed in beside that time.",
      "Each trustee can now post its decryption share with weft-trustee decrypt.",
    ]);
    expect(t1.asked.length).toBe(asks);

    t1.answers.push(PASS1);
    expect((await run(t1, (env) => cmd.decrypt(env, e))).lines).toEqual([
      "Made a decryption share of each of the 3 totals, with a proof for each.",
      expect.stringMatching(/^✓ Posted your decryption share in block 26\./),
      "",
      "The tally needs 2 of 2 shares: waiting for Org2MSP.",
    ]);
    t2.answers.push(PASS2);
    expect((await run(t2, (env) => cmd.decrypt(env, e))).lines.slice(1)).toEqual([
      expect.stringMatching(/^✓ Posted your decryption share in block 27\./),
      "✓ 2 of 2 shares are in. Published the tally in block 28.",
      "",
      "Plan A   5",
      "Plan B   6",
      "Plan C   2",
      "13 ballots, and the counts add up to them.",
      "",
      "Run weft-trustee destroy --election budget-2027 to delete your key share.",
    ]);

    t1.answers.push(ID);
    expect((await run(t1, (env) => cmd.destroy(env, e))).lines).toEqual([
      `This deletes Org1MSP's key share for budget-2027 from ${folder(t1)}. Without it, Org1MSP can't take part in decrypting anything from this election again. No one else can check that it was deleted.`,
      "✓ Deleted the key share and the state folder.",
    ]);
    expect(t1.asked.at(-1)).toBe("Type the election ID to delete it: ");
    expect(existsSync(folder(t1))).toBe(false);

    expect(contract.submitted()).toEqual([
      "Org1MSP CreateElection",
      "Org1MSP PostCommitments",
      "Org2MSP PostCommitments",
      "Org2MSP PostShares",
      "Org1MSP PostShares",
      "Org1MSP ConfirmShares",
      "Org2MSP ConfirmShares",
      "Org2MSP OpenElection",
      ...Array(13).fill(expect.stringMatching(/CastBallot$/)),
      "Org1MSP CloseElection",
      "Org2MSP CloseElection",
      "Org1MSP PostDecryptionShare",
      "Org2MSP PostDecryptionShare",
      "Org2MSP PublishTally",
    ]);
  });

  it("shows the status of an open, a closed and a counted election", async () => {
    await ceremony();
    const fp = formatFingerprint(electionFingerprint(electionOf()));
    expect((await run(t1, (env) => cmd.status(env, e))).lines).toEqual([
      "Budget 2027 (budget-2027) on privatevote-budget-2027",
      "State      open: voting is open until 17:00 UTC on 31 January 2027",
      "Trustees   Org1MSP (1) and Org2MSP (2). Any 2 of 2 can decrypt.",
      "You        trustee1, for Org1MSP",
      `Key        ${fp}, the election fingerprint`,
      `Saved      your key share, encrypted, in ${folder(t1)}`,
      "",
      "Closing    Org1MSP not yet   Org2MSP not yet. Voting closes when 2 have asked.",
      "",
      "Run weft-trustee close --election budget-2027 after 17:00 UTC on 31 January 2027, or with --early to close it now.",
    ]);
    await vote([1, 2]);
    await run(t1, (env) => cmd.close(env, { ...e, early: true }));
    expect((await run(t1, (env) => cmd.status(env, e))).lines.at(-1)).toBe("You have asked to close. Voting closes when 1 more trustee asks.");
    await run(t2, (env) => cmd.close(env, { ...e, early: true }));
    const closed = (await run(t2, (env) => cmd.status(env, e))).lines;
    expect(closed[1]).toBe("State      decrypting: voting closed with 2 ballots, and the trustees are decrypting the totals");
    expect(closed.slice(-4)).toEqual(["Closed by  Org1MSP and Org2MSP", "Shares     Org1MSP waiting   Org2MSP waiting", "", "Run weft-trustee decrypt --election budget-2027 to post your decryption share."]);
    t1.answers.push(PASS1);
    await run(t1, (env) => cmd.decrypt(env, e));
    t2.answers.push(PASS2);
    await run(t2, (env) => cmd.decrypt(env, e));
    const counted = (await run(t1, (env) => cmd.status(env, e))).lines;
    expect(counted.slice(-8)).toEqual([
      "Shares     Org1MSP posted   Org2MSP posted",
      "",
      "Plan A   0",
      "Plan B   1",
      "Plan C   1",
      "2 ballots, and the counts add up to them.",
      "",
      "Run weft-trustee destroy --election budget-2027 to delete your key share.",
    ]);
    const json = JSON.parse((await run(t1, (env) => cmd.status(env, { ...e, json: true }))).lines[0]!) as cmd.StatusReport;
    expect(json.election.state).toBe("counted");
    expect(json.you).toEqual({ msp: "Org1MSP", name: "trustee1", trustee: true, index: 0 });
    expect(json.saved.keyShare).toBe(true);
  });
});

describe("the failure messages in the step 4 model", () => {
  it("refuses a passphrase that doesn't open the state folder, and posts nothing", async () => {
    await create();
    t1.answers.push(PASS1, PASS1);
    await run(t1, (env) => cmd.commit(env, e));
    t2.answers.push(PASS2, PASS2);
    await run(t2, (env) => cmd.commit(env, e));
    const before = contract.submitted().length;
    t1.answers.push("wrong passphrase");
    expect(await run(t1, (env) => cmd.share(env, e))).toEqual({
      code: 1,
      lines: [`✗ That passphrase doesn't open ${folder(t1)}.`, "  Nothing was posted. Run the command again with the passphrase you set in round 1."],
    });
    expect(contract.submitted().length).toBe(before);
  });

  it("refuses an identity without weft.trustee=true before reading or signing anything", async () => {
    await create();
    const alice = trustee(contract, "Org1MSP", "alice", { trustee: false });
    const calls = contract.calls.length;
    expect(await run(alice, (env) => cmd.commit(env, e))).toEqual({
      code: 1,
      lines: ["✗ This identity can't act as a trustee: its certificate doesn't carry weft.trustee=true.", "  Register a trustee identity with that attribute at Org1MSP's CA, as for an explorer."],
    });
    expect(contract.calls.length).toBe(calls);
    expect((await run(alice, (env) => cmd.status(env, e))).lines[3]).toBe("You        alice, for Org1MSP. Its certificate doesn't carry weft.trustee=true, so it can only read");
  });

  it("reports a share that doesn't match its sender's commitments, and the election fails", async () => {
    await create();
    await rounds12();
    contract.tamperRound2(ID, "Org1MSP");
    t2.answers.push(PASS2);
    const r = await run(t2, (env) => cmd.confirm(env, e));
    expect(r).toEqual({
      code: 1,
      lines: [
        "✗ The share from Org1MSP doesn't match Org1MSP's round 1 commitments.",
        "✓ Posted a report in block 8. budget-2027 is now failed, and it can't open.",
        "  Find out why with Org1MSP, then create a new election under a new ID.",
      ],
    });
    expect(contract.record(ID).state).toBe("failed");
    const last = contract.calls.filter((c) => c.kind === "submit").at(-1)!;
    expect(last).toMatchObject({ fn: "ReportBadShare", args: [ID, contract.record(ID).trustees[0]!.id] });
  });

  it("says when the one-time ceremony key is gone before round 3", async () => {
    await create();
    await rounds12();
    rmSync(join(folder(t1), "ceremony.json"));
    expect((await run(t1, (env) => cmd.confirm(env, e))).lines).toEqual([
      "✗ The state folder has no one-time ceremony key, so Weft can't decrypt the share Org2MSP sent you. The creator can cancel budget-2027 with weft-trustee cancel and create a new election.",
    ]);
  });

  it("refuses to decrypt an election that is still open", async () => {
    await ceremony();
    expect((await run(t1, (env) => cmd.decrypt(env, e))).lines).toEqual([
      "✗ budget-2027 isn't counting yet: it is open until 17:00 UTC on 31 January 2027.",
      "  Run weft-trustee close after that time, then this command.",
    ]);
  });

  it("says when the key share is missing", async () => {
    await ceremony();
    await run(t1, (env) => cmd.close(env, { ...e, early: true }));
    await run(t2, (env) => cmd.close(env, { ...e, early: true }));
    rmSync(join(folder(t1), "key-share.json"));
    expect((await run(t1, (env) => cmd.decrypt(env, e))).lines).toEqual([
      `✗ There's no key share for budget-2027 in ${folder(t1)}.`,
      "  This election needs 2 of 2 trustees, so it can't be counted without Org1MSP's share.",
    ]);
  });

  it("says to close again after a PHANTOM_READ_CONFLICT", async () => {
    await ceremony();
    contract.failNext = { fn: "CloseElection", code: "PHANTOM_READ_CONFLICT" };
    expect((await run(t1, (env) => cmd.close(env, { ...e, early: true }))).lines).toEqual([
      "✗ The close failed validation: a ballot was committed while it was being endorsed (PHANTOM_READ_CONFLICT). Run weft-trustee close again.",
    ]);
    expect((await run(t1, (env) => cmd.close(env, { ...e, early: true }))).code).toBe(0);
  });

  it("keeps the key share until the tally is published, unless forced", async () => {
    await ceremony();
    expect((await run(t1, (env) => cmd.destroy(env, e))).lines).toEqual([
      "✗ The tally for budget-2027 isn't published yet, so Weft kept your key share.",
      "  Without it the election may not be counted. Run this again after the tally, or add --force to delete it now.",
    ]);
    expect(existsSync(join(folder(t1), "key-share.json"))).toBe(true);
    t1.answers.push("budget-2028");
    expect((await run(t1, (env) => cmd.destroy(env, { ...e, force: true }))).lines.at(-1)).toBe("✗ That isn't budget-2027, so nothing was deleted.");
    expect((await run(t1, (env) => cmd.destroy(env, { ...e, force: true, yes: true }))).code).toBe(0);
    expect(existsSync(folder(t1))).toBe(false);
  });
});

describe("the other paths", () => {
  it("keeps the state folder private", async () => {
    await create();
    t1.answers.push(PASS1, PASS1);
    await run(t1, (env) => cmd.commit(env, e));
    expect(statSync(folder(t1)).mode & 0o777).toBe(0o700);
    for (const f of readdirSync(folder(t1))) expect(statSync(join(folder(t1), f)).mode & 0o777).toBe(0o600);
  });

  it("posts the saved round 1 again when posting failed", async () => {
    await create();
    contract.failNext = { fn: "PostCommitments", code: "MVCC_READ_CONFLICT" };
    t1.answers.push(PASS1, PASS1);
    expect((await run(t1, (env) => cmd.commit(env, e))).lines.slice(1)).toEqual(["✗ The transaction failed validation (MVCC_READ_CONFLICT), so it changed nothing.", "  Run this again."]);
    const saved = contract.calls.filter((c) => c.fn === "PostCommitments")[0]!.args[1];
    t1.answers.push(PASS1);
    const again = await run(t1, (env) => cmd.commit(env, e));
    expect(again.lines[0]).toBe(`Found the round 1 an earlier run saved in ${folder(t1)}, and posted it.`);
    expect(contract.calls.filter((c) => c.fn === "PostCommitments")[1]!.args[1]).toBe(saved);
    expect(t1.asked.at(-1)).toBe(`Passphrase for ${folder(t1)}: `);
  });

  it("refuses two passphrases that don't match, and saves nothing", async () => {
    await create();
    t1.answers.push(PASS1, PASS2);
    expect((await run(t1, (env) => cmd.commit(env, e))).lines).toEqual(["✗ The two passphrases don't match.", "  Nothing was saved or posted. Run the command again."]);
    expect(existsSync(folder(t1))).toBe(false);
  });

  it("reads the passphrase from WEFT_TRUSTEE_PASSPHRASE without asking", async () => {
    await create();
    t1.env.passphrase = PASS1;
    expect((await run(t1, (env) => cmd.commit(env, e))).code).toBe(0);
    expect(t1.asked).toEqual([]);
  });

  it("opens the election with open when the last confirm couldn't", async () => {
    await create();
    await rounds12();
    t1.answers.push(PASS1);
    await run(t1, (env) => cmd.confirm(env, e));
    expect((await run(t1, (env) => cmd.open(env, e))).lines).toEqual(["✗ Round 3 isn't finished: waiting for Org2MSP.", "  Nothing was posted. The election opens once Org2MSP has posted round 3."]);
    contract.failNext = { fn: "OpenElection", code: "MVCC_READ_CONFLICT" };
    t2.answers.push(PASS2);
    expect((await run(t2, (env) => cmd.confirm(env, e))).lines.slice(-2)).toEqual(["✗ Opening budget-2027 failed validation (MVCC_READ_CONFLICT), so it changed nothing.", "  Run weft-trustee open --election budget-2027."]);
    expect((await run(t1, (env) => cmd.open(env, e))).lines[0]).toBe("✓ Opened budget-2027 in block 11.");
    expect((await run(t2, (env) => cmd.open(env, e))).lines[0]).toBe("✓ budget-2027 is already open.");
  });

  it("publishes the tally with publish when the k-th decrypt couldn't", async () => {
    await ceremony();
    await vote([2]);
    await run(t1, (env) => cmd.close(env, { ...e, early: true }));
    await run(t2, (env) => cmd.close(env, { ...e, early: true }));
    expect((await run(t1, (env) => cmd.publish(env, e))).lines).toEqual(["✗ The tally needs 2 decryption shares; 0 have been posted.", "  Each trustee posts its share with weft-trustee decrypt."]);
    t1.answers.push(PASS1);
    await run(t1, (env) => cmd.decrypt(env, e));
    contract.failNext = { fn: "PublishTally", code: "MVCC_READ_CONFLICT" };
    t2.answers.push(PASS2);
    expect((await run(t2, (env) => cmd.decrypt(env, e))).code).toBe(1);
    const pub = await run(t2, (env) => cmd.publish(env, e));
    expect(pub.lines.slice(0, 6)).toEqual(["✓ Published the tally in block 17.", "", "Plan A   0", "Plan B   0", "Plan C   1", "1 ballot, and the counts add up to it."]);
  });

  it("lets only the creator's organisation cancel, during the ceremony", async () => {
    await create();
    expect((await run(t2, (env) => cmd.cancel(env, e))).lines).toEqual(["✗ Org2MSP didn't create this election, so it can't cancel it.", "  Ask Org1MSP's trustee."]);
    expect((await run(t1, (env) => cmd.cancel(env, e))).lines).toEqual([
      "✓ Cancelled budget-2027 in block 4. It can't open, and no one can vote in it.",
      "Each trustee can delete what it saved for budget-2027 with weft-trustee destroy --election budget-2027.",
    ]);
    expect((await run(t1, (env) => cmd.commit(env, e))).lines).toEqual(["✗ The key ceremony has ended: the election is in cancelled."]);
  });

  it("refuses a second round 1 and a second decryption share", async () => {
    await ceremony();
    expect((await run(t1, (env) => cmd.commit(env, e))).lines).toEqual(["✗ The key ceremony has ended: the election is in open."]);
    await run(t1, (env) => cmd.close(env, { ...e, early: true }));
    await run(t2, (env) => cmd.close(env, { ...e, early: true }));
    t1.env.passphrase = PASS1;
    await run(t1, (env) => cmd.decrypt(env, e));
    expect((await run(t1, (env) => cmd.decrypt(env, e))).lines).toEqual(["✗ Org1MSP has already posted its decryption share.", "  Nothing was posted."]);
  });

  it("says when the election doesn't exist, and when the organisation isn't a trustee", async () => {
    expect((await run(t1, (env) => cmd.status(env, e))).lines).toEqual([
      "✗ There's no election budget-2027.",
      "  Check the election ID, and that privatevote-budget-2027 is its channel.",
    ]);
    await create();
    const org3 = trustee(contract, "Org3MSP", "trustee3");
    expect((await run(org3, (env) => cmd.commit(env, e))).lines).toEqual(["✗ Org3MSP isn't a trustee of this election.", "  Its trustees are Org1MSP and Org2MSP."]);
  });

  it("passes the contract's refusal of a new election through", async () => {
    await create();
    expect((await create(t2)).lines).toEqual(["✗ Election budget-2027 already exists.", "  Nothing was posted."]);
  });

  it("refuses a closing time that has passed before signing, and passes the contract's own check through", async () => {
    const calls = contract.calls.length;
    const make = (t: Trustee, closesAt: string, title = "Budget 2027", voters?: string[]) =>
      run(t, (env) => cmd.create(env, { election: ID, title, options: ["Plan A", "Plan B"], closesAt, trustees: ["Org1MSP", "Org2MSP"], voters }));
    expect((await make(t1, "2026-11-07T12:00:00.000Z")).lines).toEqual(["✗ 12:00 UTC on 7 November 2026 has already passed.", "  Nothing was posted. Give a --closes-at in the future."]);
    expect(contract.calls.length).toBe(calls);
    // A machine whose clock is behind the transaction's timestamp gets the contract's refusal.
    const slow = trustee(contract, "Org1MSP", "trustee1", { now: new Date("2026-11-01T00:00:00.000Z") });
    expect((await make(slow, "2026-11-05T00:00:00.000Z")).lines).toEqual(["✗ closesAt isn't later than this transaction's timestamp, 2026-11-07T12:00:00.000Z.", "  Nothing was posted."]);
    expect((await make(t1, "2027-01-31T17:00:00.000Z", "")).lines).toEqual(["✗ Election titles are 1 to 200 characters.", "  Nothing was posted."]);
    expect((await make(t1, "2027-01-31T17:00:00.000Z", "Budget 2027", ["Org1MSP", "Org1MSP"])).lines).toEqual(["✗ An election has at least one voter organisation, all different.", "  Nothing was posted."]);
  });

  it("refuses a second close from the same trustee before signing", async () => {
    await ceremony();
    await run(t1, (env) => cmd.close(env, { ...e, early: true }));
    const submits = contract.submitted().length;
    expect((await run(t1, (env) => cmd.close(env, { ...e, early: true }))).lines).toEqual([
      "✗ Org1MSP has already asked to close voting.",
      "  Nothing was posted. Voting closes when 1 more trustee asks.",
    ]);
    expect(contract.submitted().length).toBe(submits);
    // The contract refuses it too, for a client that doesn't check first.
    await expect(contract.ledgerFor({ msp: "Org1MSP", trustee: true }).submit("CloseElection", ID)).rejects.toThrow("Org1MSP has already asked to close voting.");
  });

  it("refuses a decryption share during the key ceremony", async () => {
    await create();
    expect((await run(t1, (env) => cmd.decrypt(env, e))).lines).toEqual(["✗ Voting hasn't closed yet: the election is in keygen, and decryption shares are posted once it is in decrypting."]);
    expect(contract.submitted()).toEqual(["Org1MSP CreateElection"]);
    await expect(contract.ledgerFor({ msp: "Org1MSP", trustee: true }).submit("PostDecryptionShare", ID, "{}")).rejects.toThrow(
      "Voting hasn't closed yet: the election is in keygen, and decryption shares are posted once it is in decrypting.",
    );
  });

  it("names the reporting organisation in status, and doesn't report once confirmed", async () => {
    await create();
    await rounds12();
    t1.answers.push(PASS1);
    await run(t1, (env) => cmd.confirm(env, e));
    // Org1MSP has confirmed: a share changed now can't make it report.
    contract.tamperRound2(ID, "Org2MSP");
    expect((await run(t1, (env) => cmd.confirm(env, e))).lines).toEqual([
      "✗ Org1MSP has already posted round 3.",
      "  Nothing was posted. Run weft-trustee status --election budget-2027 to see what the ceremony is waiting for.",
    ]);
    expect(contract.submitted()).not.toContain("Org1MSP ReportBadShare");
    // The contract refuses it too, for a client that doesn't check first.
    await expect(contract.ledgerFor({ msp: "Org1MSP", trustee: true }).submit("ReportBadShare", ID, contract.record(ID).trustees[1]!.id)).rejects.toThrow(
      "Org1MSP has already confirmed its shares, so it can't report a bad share.",
    );
    // Org2MSP hasn't confirmed, so it can.
    contract.tamperRound2(ID, "Org1MSP");
    t2.answers.push(PASS2);
    expect((await run(t2, (env) => cmd.confirm(env, e))).code).toBe(1);
    expect(contract.record(ID)).toMatchObject({ state: "failed", reportedBy: "Org2MSP" });
    expect((await run(t1, (env) => cmd.status(env, e))).lines[1]).toBe("State      failed: Org2MSP reported a bad share in the key ceremony, so it can't open");
  });
});
