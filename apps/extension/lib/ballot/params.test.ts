import { ErrorCode, WeftError } from "@weftwallet/protocol";
import { describe, expect, it } from "vitest";
import { checkCastBallotParams } from "./params";

const good = { channel: "privatevote-budget-2027", chaincode: "private-ballot", electionId: "budget-2027" };

function refused(params: unknown): WeftError {
  try {
    checkCastBallotParams(params);
  } catch (error) {
    expect(error).toBeInstanceOf(WeftError);
    expect((error as WeftError).code).toBe(ErrorCode.InvalidParams);
    return error as WeftError;
  }
  throw new Error("accepted");
}

describe("weft_castBallot's params, before any window opens", () => {
  it("accepts the three fields", () => {
    expect(checkCastBallotParams(good)).toEqual(good);
  });

  it("refuses anything that isn't an object", () => {
    for (const p of [undefined, null, "budget-2027", ["a"], 7]) expect(refused(p).message).toMatch(/takes an object/);
  });

  it("names a missing field", () => {
    for (const field of ["channel", "chaincode", "electionId"] as const) {
      const { [field]: _gone, ...rest } = good;
      expect(refused(rest).message).toBe(`The "${field}" parameter is required.`);
    }
  });

  it("names a field of the wrong type", () => {
    expect(refused({ ...good, electionId: 2027 }).message).toBe('The "electionId" parameter must be a string.');
  });

  it("refuses a choice, a key or a ballot from the site", () => {
    expect(refused({ ...good, choice: 1 }).message).toBe('weft_castBallot takes only "channel", "chaincode" and "electionId", not "choice". The voter chooses in Weft.');
    expect(refused({ ...good, publicKey: "ab", ballot: "{}" }).message).toMatch(/not "ballot"/);
  });

  it("checks each field's form", () => {
    expect(refused({ ...good, electionId: "" }).message).toBe('The "electionId" parameter must be 1 to 64 letters, digits, - or _.');
    expect(refused({ ...good, electionId: "a".repeat(65) }).message).toMatch(/1 to 64/);
    expect(refused({ ...good, electionId: "budget 2027" }).message).toMatch(/1 to 64/);
    expect(checkCastBallotParams({ ...good, electionId: "A_b-9".padEnd(64, "x") }).electionId).toHaveLength(64);
    expect(refused({ ...good, channel: "PrivateVote" }).message).toMatch(/Fabric channel name/);
    expect(refused({ ...good, chaincode: "private ballot" }).message).toMatch(/Fabric contract name/);
  });

  it("writes every message without dashes between clauses", () => {
    const messages = [undefined, { ...good, choice: 1 }, { ...good, channel: "X" }, { ...good, chaincode: "-" }, { ...good, electionId: "" }].map((p) => refused(p).message);
    for (const m of messages) expect(m).not.toMatch(/[–—]/);
  });
});
