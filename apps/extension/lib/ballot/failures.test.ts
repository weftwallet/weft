import { CommitError, RelayError, VaultLockedError, VerificationError } from "@weftwallet/core";
import { ErrorCode } from "@weftwallet/protocol";
import { describe, expect, it } from "vitest";
import { castFailure, contractMessage, identityFailures, listOf, mayHaveCommitted, moduleFailure, readFailure, stateFailure } from "./failures";
import { RecordError, parseElectionRecord } from "./read";
import { recordOf, testElection } from "./test/fabric";

const ctx = { params: { channel: "privatevote-budget-2027", chaincode: "private-ballot", electionId: "budget-2027" }, siteHost: "localhost:4323", relayHost: "localhost:8787" };
const relayError = (kind: string, message: string, details?: { message: string }[]) => new RelayError(kind === "unreachable" ? 0 : 500, { kind, message, ...(details ? { details } : {}) }, "http://localhost:8787");
const refused = (said: string) => relayError("proposals_endorse", "failed to endorse transaction", [{ message: `chaincode response 500, ${said}` }]);

/** Every sentence a person reads. */
const texts: string[] = [];
const said = <T extends { view?: { title: string; detail: string }; outcome?: { title: string; detail: string; next?: string } }>(f: T) => {
  if (f.view) texts.push(f.view.title, f.view.detail);
  if (f.outcome) texts.push(f.outcome.title, f.outcome.detail, f.outcome.next ?? "");
  return f;
};

describe("failures before the vote", () => {
  it("keeps the request waiting for Try again when the relay or the peers don't answer", () => {
    for (const e of [relayError("unreachable", "fetch failed"), relayError("timeout", "no answer"), relayError("http", "HTTP 502"), relayError("proposals_endorse", "no peers available")]) {
      const f = said(readFailure(e, ctx));
      expect(f.view.kind).toBe("unreachable");
      expect(f.error?.code).toBe(ErrorCode.NetworkUnavailable);
    }
  });

  it("maps the contract's and the record's refusals to 4400", () => {
    const cases: [unknown, string][] = [
      [refused("There's no election budget-2027."), "There's no election budget-2027"],
      [relayError("proposals_endorse", "chaincode private-ballot not found"), "Weft couldn't read this election"],
      [relayError("proposals_endorse", "access denied: creator org unknown"), "Weft couldn't read this election"],
      [new RecordError("unreadable", "The record isn't in the version 1 format."), "Weft can't read this election"],
      [new RecordError("mismatch", "x", { field: "fingerprint", computed: "3f9a61c208de77b1c4e0", recorded: "9024ad93227cf4189289" }), "Weft won't cast a ballot in this election"],
      [new RecordError("signature", "No peer of Org1MSP signed the answer."), "Weft won't trust what it read"],
    ];
    for (const [error, title] of cases) {
      const f = said(readFailure(error, ctx));
      expect(f.view).toMatchObject({ kind: "final", title });
      expect(f.error?.code).toBe(4400);
      expect(f.view.technical).toMatch(/^4400 ElectionUnavailable\. /);
    }
    expect(readFailure(new RecordError("mismatch", "x", { field: "fingerprint", computed: "3f9a61c208de77b1c4e0", recorded: "9024ad93227cf4189289" }), ctx).view.detail).toContain(
      "Weft worked out the fingerprint 3f9a 61c2 08de 77b1 c4e0, and the record gives 9024 ad93 227c f418 9289.",
    );
  });

  it("maps a relay that sent the wrong read to -32603, and a lock to the unlock screen", () => {
    expect(said(readFailure(new VerificationError("arguments", "a", "b"), ctx)).error?.code).toBe(ErrorCode.Internal);
    const locked = readFailure(new VaultLockedError(), ctx);
    expect(locked.view.kind).toBe("locked");
    expect(locked.error).toBeNull();
  });

  it("names the state of an election that isn't open, with data.state", () => {
    const e = testElection();
    for (const [state, title] of [
      ["keygen", "Budget 2027 isn't open yet"],
      ["decrypting", "Budget 2027 has closed"],
      ["counted", "Budget 2027 has closed"],
      ["failed", "Budget 2027 can't open"],
      ["cancelled", "Budget 2027 was cancelled"],
    ] as const) {
      const record = parseElectionRecord(JSON.stringify(recordOf(e, { state, reportedBy: "Org2MSP" })), "budget-2027");
      const f = said(stateFailure(record, ctx));
      expect(f.view.title).toBe(title);
      expect(f.error).toMatchObject({ code: 4400, data: { state } });
    }
  });

  it("maps identities that can't vote to 4300, and an expired one to 4301", () => {
    expect(said(identityFailures.none(ctx)).error?.code).toBe(4300);
    expect(said(identityFailures.expired(ctx, "alice", "2026-01-01T00:00:00.000Z")).error?.code).toBe(4301);
    const waiting = said(identityFailures.channelPending(ctx, "Weft playground", "http://localhost:8787/v1/invite"));
    expect(waiting.view.kind).toBe("noChannel");
    expect(waiting.error?.code).toBe(4300);
    expect(said(identityFailures.channel(ctx, "Weft playground", true)).view.detail).toMatch(/^The latest invite for Weft playground still doesn't list/);
    expect(said(identityFailures.notVoter({ ...ctx, title: "Budget 2027" }, ["Org1MSP", "Org2MSP"], "carol", "Org3MSP")).error).toMatchObject({ code: 4300, data: { voterMsps: ["Org1MSP", "Org2MSP"] } });
    expect(said(identityFailures.noCredential(ctx, "ChairVoters2027MSP")).error).toMatchObject({ code: 4300, data: { voterMsps: ["ChairVoters2027MSP"] } });
  });
});

describe("failures for voter credentials", () => {
  it("say what the credential lacks, with 4300 and the voter MSP", () => {
    const none = said(identityFailures.noCredential({ ...ctx, title: "Chair 2027" }, "ChairVoters2027MSP"));
    expect(none.view).toMatchObject({ title: "This election needs a voter credential", technical: "4300 NoIdentity. data.voterMsps: ChairVoters2027MSP." });
    expect(none.view.detail).toBe("Chair 2027's voters vote with credentials from ChairVoters2027MSP, and Weft holds none for it. Join from the voter invite the organisers sent you, then vote again from localhost:4323. No ballot was cast.");
    const key = said(identityFailures.wrongKey(ctx, "ChairVoters2027MSP", "0c55e7a9".padEnd(56, "0") + "31f4d206", "f1642101".padEnd(56, "0") + "b0b87480"));
    expect(key.view.title).toBe("Your voter credential is for another issuer key");
    expect(key.view.technical).toBe("4300 NoIdentity. Your credential's issuer key: 0c55e7a9…31f4d206. budget-2027 pinned f1642101…b0b87480.");
    expect(key.error).toMatchObject({ code: 4300, data: { voterMsps: ["ChairVoters2027MSP"] } });
    expect(said(identityFailures.onlyCredentials(ctx)).error?.code).toBe(4300);
    expect(said(identityFailures.notCredentialElection(ctx, ["Org1MSP"], "ChairVoters2027MSP")).error).toMatchObject({ code: 4300, data: { voterMsps: ["Org1MSP"] } });
  });

  it("say the module failed with -32603", () => {
    const f = said(moduleFailure(ctx, "RuntimeError: memory access out of bounds"));
    expect(f.view).toMatchObject({ kind: "final", title: "Weft couldn't start its voting module", technical: "-32603 Internal. RuntimeError: memory access out of bounds" });
    expect(f.error?.code).toBe(-32603);
  });

  it("name the invite's organisations when a signature doesn't check out", () => {
    const f = said(readFailure(new RecordError("signature", "The endorsement from Org1MSP doesn't check out."), { ...ctx, endorsers: ["Org1MSP", "Org2MSP"] }));
    expect(f.view.detail).toMatch(/a peer of Org1MSP or Org2MSP, the organisations your voter invite names, so it may have been changed on the way\. No ballot was cast\. Tell the organisers\.$/);
    expect(f.error?.code).toBe(4400);
  });

  it("pass on the credential rows of the contract's errors", () => {
    const cast = { ...ctx, title: "Chair 2027", voterName: "your voter credential", tracking: "5e0c19a2".padEnd(56, "0") + "b80d7f31", anonymous: true };
    const voted = said(castFailure(refused("This credential has already voted in this election."), "endorsing", cast));
    expect(voted.outcome).toMatchObject({ title: "You've already voted in Chair 2027", next: "Nothing was written to the ledger. Your first ballot stands." });
    expect(voted.error).toMatchObject({ code: 5001, message: "This credential has already voted in this election." });
    const proof = said(castFailure(refused("The pseudonym proof is not valid."), "endorsing", cast));
    expect(proof.outcome.title).toBe("The contract refused your ballot's pseudonym proof");
    expect(proof.outcome.detail).toBe("The endorsing peers didn't accept the proof that ties your pseudonym to this ballot's one-off identity. That points to a fault in Weft, not in your credential.");
    const lost = said(castFailure(new RelayError(0, { kind: "unreachable", message: "fetch failed" }, "http://localhost:8787", "/v1/commits/status"), "committing", cast));
    expect(lost.outcome.next).toMatch(/the contract refuses a second one from this credential, so voting again is safe\.$/);
  });
});

describe("failures after Sign and vote", () => {
  const cast = { ...ctx, title: "Budget 2027", voterName: "alice", tracking: "5e0c19a2".padEnd(56, "0") + "b80d7f31" };

  it("passes the contract's refusals on as 5001 with its own sentence", () => {
    const voted = said(castFailure(refused("This identity has already voted in this election."), "endorsing", cast));
    expect(voted.outcome).toMatchObject({ title: "You've already voted in Budget 2027", next: "Nothing was written to the ledger. Your first ballot stands." });
    expect(voted.error).toMatchObject({ code: 5001, message: "This identity has already voted in this election." });
    const closed = said(castFailure(refused("Voting has closed."), "endorsing", cast));
    expect(closed.outcome.title).toBe("Voting closed before your ballot arrived");
    expect(closed.error.code).toBe(5001);
    const other = said(castFailure(refused("Ciphertext 0 is not a 0 or a 1."), "endorsing", cast));
    expect(other.outcome).toMatchObject({ title: "The contract refused your ballot", raw: "Ciphertext 0 is not a 0 or a 1." });
  });

  it("reports a ballot that failed validation because the election closed first", () => {
    const f = said(castFailure(new CommitError({ transactionId: "t", blockNumber: "50", status: "MVCC_READ_CONFLICT", successful: false }), "committing", cast));
    expect(f.outcome.title).toBe("Voting closed before your ballot arrived");
    expect(f.error).toMatchObject({ code: 5001, data: { status: "MVCC_READ_CONFLICT" } });
  });

  it("says when the ballot may have committed, with the tracking code to check", () => {
    const lost = said(castFailure(relayError("unreachable", "fetch failed"), "committing", cast));
    expect(lost.outcome).toMatchObject({ uncertain: true, title: "Weft couldn't tell if your ballot was committed" });
    expect(lost.outcome.next).toContain("5e0c19a2…b80d7f31");
    expect(lost.error.code).toBe(5002);
    const before = said(castFailure(relayError("unreachable", "fetch failed"), "proposing", cast));
    expect(before.outcome).toMatchObject({ uncertain: false, title: "Weft couldn't reach the relay" });
    expect(mayHaveCommitted("submitting", relayError("submit", "orderer refused"))).toBe(false);
  });

  it("refuses to sign, or stops at a lock, with the documented codes", () => {
    expect(said(castFailure(new VerificationError("ballot", "a", "b"), "proposing", cast)).error.code).toBe(ErrorCode.Internal);
    expect(said(castFailure(new VaultLockedError(), null, cast)).error.code).toBe(ErrorCode.UserRejected);
    expect(said(castFailure(new Error("boom"), null, cast)).error.code).toBe(ErrorCode.Internal);
  });
});

describe("the words", () => {
  it("lists organisations in prose", () => {
    expect(listOf(["Org1MSP"])).toBe("Org1MSP");
    expect(listOf(["Org1MSP", "Org2MSP"])).toBe("Org1MSP and Org2MSP");
    expect(listOf(["Org1MSP", "Org2MSP", "Org3MSP"])).toBe("Org1MSP, Org2MSP and Org3MSP");
  });

  it("finds the contract's sentence in a peer's error", () => {
    expect(contractMessage(refused("Voting has closed."))).toBe("Voting has closed.");
    expect(contractMessage(relayError("unreachable", "fetch failed"))).toBeNull();
  });

  it("uses no dashes between clauses, no exclamation marks and British spelling", () => {
    expect(texts.length).toBeGreaterThan(30);
    for (const t of texts) {
      expect(t).not.toMatch(/[–—!]/);
      expect(t).not.toMatch(/\borganization|\benroll(?:ment|ed|ing)?\b|\bcolor\b/i);
    }
  });
});
