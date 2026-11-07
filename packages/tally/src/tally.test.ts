import { describe, expect, it } from "vitest";
import { encryptBallot } from "./client.ts";
import { BadShareError, ceremonyRound1, ceremonyRound2, ceremonyRound3, decryptionShare } from "./trustee.ts";
import { addTotals, checkBallot, checkConfirmation, checkDecryptionShare, checkRound1, checkRound2, recoverTally } from "./verify.ts";
import { count, electionFingerprint, formatFingerprint, fromHex, messages, toHex, utf8, voterTagX509, type Election, type ElectionSetup, type Round2Post } from "./index.ts";
import { seededRandom } from "./testing.ts";

async function ceremony(setup: ElectionSetup) {
  const r1 = setup.trustees.map((_, i) => ceremonyRound1(setup, i));
  const round1 = r1.map((r) => r.post);
  round1.forEach((p, i) => checkRound1(setup, i, JSON.stringify(p)));
  const round2 = await Promise.all(r1.map((r) => ceremonyRound2(setup, r.secret, round1)));
  round2.forEach((p, i) => checkRound2(setup, i, JSON.stringify(p)));
  const r3 = await Promise.all(r1.map((r) => ceremonyRound3(setup, r.secret, round1, round2)));
  const election: Election = { ...setup, ...r3[0]!.keys };
  r3.forEach((r, i) => checkConfirmation(election, i, JSON.stringify(r.confirmation)));
  return { election, r1, round1, round2, keyShares: r3.map((r) => r.keyShare) };
}

/** A small deterministic generator for the property tests' shapes, not for cryptography. */
function shapes(seed: string) {
  const rand = seededRandom(seed);
  return (n: number) => rand.bytes(1)[0]! % n;
}

describe("encoding", () => {
  it("reads only lowercase hex of the right length", () => {
    expect(fromHex("00ff")).toEqual(Uint8Array.of(0, 255));
    expect(fromHex("00FF")).toBeNull();
    expect(fromHex("0ff")).toBeNull();
    expect(fromHex("00ff", 3)).toBeNull();
    expect(fromHex("zz")).toBeNull();
  });
  it("writes counts as words take them", () => {
    expect(count(1, "ciphertext")).toBe("1 ciphertext");
    expect(count(2, "ciphertext")).toBe("2 ciphertexts");
    expect(messages.tooFewShares(2, 1)).toBe("The tally needs 2 decryption shares; 1 has been posted.");
    expect(messages.shareCount(1, 3)).toBe("The decryption share has 1 entry; this election has 3 options.");
  });
  it("shows the fingerprint in five groups of four", () => {
    expect(formatFingerprint("3f9a61c208de77b1c4e0")).toBe("3f9a 61c2 08de 77b1 c4e0");
  });
});

describe("random elections, from cast to count", () => {
  const pick = shapes("property shapes");
  for (let run = 0; run < 6; run++) {
    const L = 2 + pick(19);
    const n = 2 + pick(6);
    const k = 1 + Math.max(1, pick(n));
    it(`${L} options, ${k} of ${n} trustees`, async () => {
      const setup: ElectionSetup = {
        channel: `privatevote-run-${run}`,
        chaincode: "private-ballot",
        electionId: `run-${run}`,
        options: Array.from({ length: L }, (_, j) => `Option ${j}`),
        threshold: Math.min(k, n),
        trustees: Array.from({ length: n }, (_, i) => `Org${i + 1}MSP`),
      };
      const { election, keyShares } = await ceremony(setup);
      const voters = 1 + pick(6);
      const expected = new Array<number>(L).fill(0);
      const cts = [];
      for (let v = 0; v < voters; v++) {
        const choice = pick(L);
        expected[choice]!++;
        const tag = voterTagX509(setup.channel, setup.electionId, "Org1MSP", utf8(`voter ${v}`));
        const { json, tracking } = encryptBallot(election, tag, choice);
        const checked = checkBallot(election, tag, json);
        expect(checked.tracking).toBe(tracking);
        cts.push(checked.ballot.ciphertexts);
      }
      const { totals, ballots } = addTotals(L, cts);
      const posted = keyShares.map((ks) => {
        const share = decryptionShare(election, ks, totals);
        checkDecryptionShare(election, totals, ks.index, JSON.stringify(share));
        return { index: ks.index, share };
      });
      // Every trustee from the highest down, so the quorum isn't the first k posted.
      const r = recoverTally(election, totals, ballots, [...posted].reverse());
      expect(r.counts).toEqual(expected);
      expect(r.quorum).toEqual(Array.from({ length: setup.threshold }, (_, i) => i));
      expect(recoverTally(election, totals, ballots, posted.slice(n - setup.threshold)).counts).toEqual(expected);
    });
  }
});

describe("the client", () => {
  it("returns no randomness", async () => {
    const { election } = await ceremony({ channel: "c", chaincode: "private-ballot", electionId: "e", options: ["A", "B"], threshold: 2, trustees: ["Org1MSP", "Org2MSP"] });
    const tag = voterTagX509("c", "e", "Org1MSP", utf8("pem"));
    const out = encryptBallot(election, tag, 1);
    expect(Object.keys(out).sort()).toEqual(["ballot", "json", "tracking"]);
    expect(Object.keys(JSON.parse(out.json))).toEqual(["v", "electionId", "ciphertexts", "bitProofs", "sumProof"]);
    // Two encryptions of the same choice share nothing.
    expect(encryptBallot(election, tag, 1).json).not.toBe(out.json);
    expect(() => encryptBallot(election, tag, 2)).toThrow(RangeError);
  });
});

describe("the trustees", () => {
  it("name the sender of a share that doesn't open", async () => {
    const setup: ElectionSetup = { channel: "c", chaincode: "private-ballot", electionId: "bad", options: ["A", "B"], threshold: 2, trustees: ["Org1MSP", "Org2MSP", "Org3MSP"] };
    const r1 = setup.trustees.map((_, i) => ceremonyRound1(setup, i));
    const round1 = r1.map((r) => r.post);
    const round2: Round2Post[] = await Promise.all(r1.map((r) => ceremonyRound2(setup, r.secret, round1)));
    // Org3MSP changes the share it sends to Org1MSP.
    const box = round2[2]!.shares[0]!.box;
    round2[2]!.shares[0]!.box = (box[0] === "0" ? "1" : "0") + box.slice(1);
    await expect(ceremonyRound3(setup, r1[0]!.secret, round1, round2)).rejects.toThrow(BadShareError);
    await expect(ceremonyRound3(setup, r1[0]!.secret, round1, round2)).rejects.toMatchObject({ from: 2, message: "The share from Org3MSP doesn't match Org3MSP's round 1 commitments." });
    // Org2MSP's shares are untouched.
    await expect(ceremonyRound3(setup, r1[1]!.secret, round1, round2)).resolves.toBeTruthy();
  });

  it("refuse a key share for another trustee", async () => {
    const { election, keyShares } = await ceremony({ channel: "c", chaincode: "private-ballot", electionId: "e2", options: ["A", "B"], threshold: 2, trustees: ["Org1MSP", "Org2MSP"] });
    const totals = addTotals(2, []).totals;
    expect(() => decryptionShare(election, { ...keyShares[0]!, index: 1 }, totals)).toThrow(/verifying share/);
  });

  it("count an election with no ballots", async () => {
    const { election, keyShares } = await ceremony({ channel: "c", chaincode: "private-ballot", electionId: "e3", options: ["A", "B", "C"], threshold: 2, trustees: ["Org1MSP", "Org2MSP"] });
    const { totals, ballots } = addTotals(3, []);
    const posted = keyShares.map((ks) => ({ index: ks.index, share: decryptionShare(election, ks, totals) }));
    posted.forEach((p) => checkDecryptionShare(election, totals, p.index, JSON.stringify(p.share)));
    expect(recoverTally(election, totals, ballots, posted).counts).toEqual([0, 0, 0]);
  });

  it("give every election a different fingerprint", async () => {
    const setup: ElectionSetup = { channel: "c", chaincode: "private-ballot", electionId: "e4", options: ["A", "B"], threshold: 2, trustees: ["Org1MSP", "Org2MSP"] };
    const one = await ceremony(setup);
    const two = await ceremony(setup);
    expect(electionFingerprint(one.election)).not.toBe(electionFingerprint(two.election));
    expect(electionFingerprint(one.election)).toMatch(/^[0-9a-f]{20}$/);
    expect(toHex(fromHex(one.election.publicKey)!)).toBe(one.election.publicKey);
  });
});
