import { VerificationError, signForFabric, CommitError, RelayError } from "@weftwallet/core";
import { encryptBallot } from "@weftwallet/tally/client";
import { voterTagX509, toHex } from "@weftwallet/tally";
import { beforeAll, describe, expect, it } from "vitest";
import { castBallotCall, readElection, returnedTracking } from "./cast";
import { RecordError, creatorIdBytes } from "./read";
import { FakeRelay, makeOrg, testElection, type Org } from "./test/fabric";

const params = { channel: "privatevote-budget-2027", chaincode: "private-ballot", electionId: "budget-2027" };

let org1: Org;
let org2: Org;
let stranger: Org;

beforeAll(async () => {
  [org1, org2, stranger] = await Promise.all([makeOrg("Org1MSP"), makeOrg("Org2MSP"), makeOrg("Org1MSP")]);
});

/** The voter's signer, counting what it signs. */
function voter() {
  const signed: Uint8Array[] = [];
  return {
    signer: { mspId: "Org1MSP", certificate: org1.voter.pem },
    sign: async (m: Uint8Array) => (signed.push(m), signForFabric(org1.voter.keys.privateKey, m)),
    signed,
  };
}

const relay = () => new FakeRelay(testElection(), [org1, org2], stranger);

describe("reading the election", () => {
  it("endorses GetElection, submits nothing, and checks the voter's own organisation's peer", async () => {
    const r = relay();
    const v = voter();
    const read = await readElection(r, v.signer, params, v.sign, org1.chain);
    expect(r.calls).toEqual(["propose GetElection", "endorse"]);
    expect(read.peerChecked).toBe(true);
    expect(read.record.title).toBe("Budget 2027");
    expect(read.open?.fingerprint).toBe(r.record.fingerprint);
    // The voter signed the read and nothing else.
    expect(v.signed).toHaveLength(1);
  });

  it("reads without the check when Weft kept no CA chain, and says so", async () => {
    const v = voter();
    const read = await readElection(relay(), v.signer, params, v.sign, null);
    expect(read.peerChecked).toBe(false);
    expect(read.open).not.toBeNull();
  });

  it("keeps the creator's id_bytes exactly as the relay built them", async () => {
    const v = voter();
    const read = await readElection(relay(), v.signer, params, v.sign, null);
    // The relay trims the PEM, so its trailing newline isn't in id_bytes.
    expect(new TextDecoder().decode(read.idBytes)).toBe(org1.voter.pem.trim());
    expect(org1.voter.pem.endsWith("\n")).toBe(true);
  });

  const lies: [string, Partial<FakeRelay["lies"]>, RegExp][] = [
    ["an answer to another proposal", { otherProposal: true }, /isn't for the proposal Weft signed/],
    ["a record no peer signed", { record: { changed: true }, signer: "none" }, /No peer of Org1MSP signed/],
    ["a signature from a client of the same CA", { signer: "client" }, /isn't a peer's/],
    ["a signature from another CA's peer", { signer: "stranger" }, /wasn't issued by Org1MSP's CA/],
    ["a signature over other bytes", { badSignature: true }, /doesn't verify/],
  ];
  for (const [what, lie, message] of lies) {
    it(`refuses ${what}`, async () => {
      const r = relay();
      r.lies = lie;
      const v = voter();
      const error = await readElection(r, v.signer, params, v.sign, org1.chain).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RecordError);
      expect((error as RecordError).reason).toBe("signature");
      expect((error as Error).message).toMatch(message);
    });
  }

  it("takes the record from inside the signed bytes, so a changed record fails the signature", async () => {
    const r = relay();
    // A relay that swaps the key and re-signs with a key it holds can't produce Org1's peer signature.
    r.lies = { record: { ...r.record, publicKey: r.election.verifyingShares[0] }, signer: "stranger" };
    const v = voter();
    await expect(readElection(r, v.signer, params, v.sign, org1.chain)).rejects.toThrow(RecordError);
  });

  it("refuses a request to read another election before signing it", async () => {
    const r = relay();
    r.lies = { args: () => ["chair-2027"] };
    const v = voter();
    await expect(readElection(r, v.signer, params, v.sign, org1.chain)).rejects.toThrow(VerificationError);
    expect(v.signed).toHaveLength(0);
  });
});

describe("casting", () => {
  async function prepared(r = relay()) {
    const v = voter();
    const read = await readElection(r, v.signer, params, v.sign, org1.chain);
    const tag = voterTagX509(params.channel, params.electionId, "Org1MSP", read.idBytes);
    const ballot = encryptBallot(read.open!.election, tag, 1);
    const call = { ...params, fn: "CastBallot", args: [params.electionId, ballot.json] };
    return { r, v, read, ballot, call };
  }

  it("casts a ballot the contract accepts, with the tracking code Weft computed", async () => {
    const { r, v, read, ballot, call } = await prepared();
    const stages: string[] = [];
    const result = await castBallotCall(r, v.signer, call, v.sign, read.idBytes, { onStage: (s) => stages.push(s) });
    expect(result.status).toBe("VALID");
    expect(result.blockNumber).toBe("41");
    expect(returnedTracking(result.text)).toBe(ballot.tracking);
    expect(r.ballots).toHaveLength(1);
    expect(r.ballots[0]!.tracking).toBe(ballot.tracking);
    expect(stages).toEqual(["proposing", "endorsing", "submitting", "committing", "done"]);
    // The read, then the proposal, the transaction and the commit request.
    expect(v.signed).toHaveLength(4);
  });

  it("computes the voter tag from the bytes the contract reads", async () => {
    const { r, read } = await prepared();
    expect(creatorIdBytes).toBeTypeOf("function");
    const tag = toHex(voterTagX509(params.channel, params.electionId, "Org1MSP", read.idBytes));
    const { v, call } = await prepared(r);
    await castBallotCall(r, v.signer, call, v.sign, read.idBytes);
    expect(r.ballots[0]!.tag).toBe(tag);
  });

  it("refuses to sign a proposal whose creator bytes differ from the ones the tag was made from", async () => {
    const { r, v, read, call } = await prepared();
    // The same certificate, with the PEM's trailing newline kept this time.
    r.lies = { creator: (pem) => pem };
    const before = v.signed.length;
    const error = await castBallotCall(r, v.signer, call, v.sign, read.idBytes).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VerificationError);
    expect((error as Error).message).toMatch(/signing certificate's bytes/);
    expect(v.signed.length).toBe(before);
    expect(r.ballots).toHaveLength(0);
  });

  it("refuses to sign a proposal that isn't exactly the ballot Weft made", async () => {
    const { r, v, read, call } = await prepared();
    r.lies = { args: (args) => [args[0]!, args[1]!.replace(/"v":1/, '"v":1 ')] };
    const before = v.signed.length;
    await expect(castBallotCall(r, v.signer, call, v.sign, read.idBytes)).rejects.toThrow(VerificationError);
    expect(v.signed.length).toBe(before);
  });

  it("reports the contract's refusal of a second ballot", async () => {
    const { r, v, read, call } = await prepared();
    await castBallotCall(r, v.signer, call, v.sign, read.idBytes);
    const again = await prepared(r);
    const error = await castBallotCall(r, again.v.signer, again.call, again.v.sign, again.read.idBytes).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RelayError);
    expect((error as RelayError).details?.[0]?.message).toMatch(/already voted/);
  });

  it("reports a ballot that failed validation", async () => {
    const { r, v, read, call } = await prepared();
    r.commitStatusCode = "MVCC_READ_CONFLICT";
    await expect(castBallotCall(r, v.signer, call, v.sign, read.idBytes)).rejects.toThrow(CommitError);
  });

  it("returns the contract's tracking code, which may differ", async () => {
    const { r, v, read, ballot, call } = await prepared();
    r.lies = { tracking: "00".repeat(32) };
    const result = await castBallotCall(r, v.signer, call, v.sign, read.idBytes);
    expect(returnedTracking(result.text)).not.toBe(ballot.tracking);
  });

  it("holds no choice and no randomness in what it returns", async () => {
    const { ballot } = await prepared();
    expect(Object.keys(ballot).sort()).toEqual(["ballot", "json", "tracking"]);
    expect(ballot.json).not.toMatch(/Plan/);
  });
});
