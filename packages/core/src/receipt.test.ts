import type { ContractCall } from "@weftwallet/protocol";
import { describe, expect, it } from "vitest";
import {
  ReceiptError,
  ballotCommitment,
  checkReceiptRequest,
  contractCommitment,
  deriveReceiptKey,
  fillGeneratedSalt,
  finishReceipt,
  openBound,
  randomBytes,
  randomSalt,
  receiptInput,
  sealBound,
  verifyProposal,
  VerificationError,
  type DecodedProposal,
} from "./index.ts";

const SALT = "7c1e94a0b3d25f86e0a4c9172bd35e6f";
const call: ContractCall = {
  channel: "mychannel",
  chaincode: "ballot",
  fn: "CastVote",
  args: ["board-2026"],
  transient: { ballot: JSON.stringify({ option: "Ada", salt: SALT }) },
};
const receipt = { type: "weft-ballot-receipt", version: 1, channel: "mychannel", electionId: "board-2026", option: "Ada", salt: SALT };
const rejects = (value: unknown, message: string | RegExp, c: ContractCall = call) => {
  expect(() => checkReceiptRequest(c, value)).toThrow(ReceiptError);
  expect(() => checkReceiptRequest(c, value)).toThrow(message);
};

describe("checking a receipt request", () => {
  it("accepts one that matches what is signed, and names the input it comes from", () => {
    expect(checkReceiptRequest(call, receipt)).toEqual(receipt);
    expect(receiptInput(call, receipt)).toBe("ballot");
  });

  it("checks in order, naming the first thing wrong", () => {
    rejects("receipt", 'The "receipt" parameter must be an object.');
    rejects([receipt], 'The "receipt" parameter must be an object.');
    const { type: _t, ...noType } = receipt;
    rejects(noType, `The receipt's "type" must be "weft-ballot-receipt" and its "version" 1.`);
    rejects({ ...receipt, version: 2 }, /"version" 1/);
    rejects({ ...receipt, voter: "alice" }, `The receipt has a field Weft doesn't keep: "voter". Send only type, version, channel, electionId, option and salt.`);
    const { option: _o, ...noOption } = receipt;
    rejects(noOption, 'The receipt needs "option".');
    rejects({ ...receipt, option: 7 }, `The receipt's "option" must be a string.`);
    rejects({ ...receipt, channel: "elections" }, `The receipt is for the channel "elections", but the call is on "mychannel".`);
    rejects({ ...receipt, electionId: "board-2025" }, `The receipt's electionId "board-2025" isn't one of the call's arguments.`);
    rejects({ ...receipt, salt: SALT.toUpperCase() }, /32 to 128 lowercase hex characters, or "generate"/);
    rejects({ ...receipt, salt: "abc" }, /32 to 128 lowercase hex/);
    rejects({ ...receipt, option: "" }, "The receipt's option must be 1 to 200 characters.");
    rejects({ ...receipt, option: "x".repeat(201) }, /1 to 200 characters/);
  });

  it("keeps only what is signed: the option and salt must be in a private input", () => {
    rejects({ ...receipt, salt: "0d5b8e21c4f97a36b1e0d2c58f4a7391" }, "The receipt's option and salt aren't the ones in any private input of this call. Weft keeps only what the user signs.");
    rejects({ ...receipt, option: "Grace" }, /aren't the ones in any private input/);
    rejects(receipt, /aren't the ones in any private input/, { ...call, transient: { ballot: "not json" } });
    rejects(receipt, /aren't the ones in any private input/, { ...call, transient: undefined });
  });
});

describe("a salt Weft generates", () => {
  const marked: ContractCall = { ...call, transient: { note: "hello", ballot: JSON.stringify({ option: "Ada", salt: "generate" }) } };
  const asks = { ...receipt, salt: "generate" };

  it("is asked for in both places, the receipt and one private input", () => {
    expect(checkReceiptRequest(marked, asks)).toEqual(asks);
    rejects(asks, /no private input of this call is a JSON object with its option and "salt": "generate"/);
    rejects({ ...asks, option: "Grace" }, /no private input/, marked);
    const twice = { ...marked, transient: { ...marked.transient, again: JSON.stringify({ option: "Ada", salt: "generate" }) } };
    rejects(asks, `More than one private input has "salt": "generate". Weft fills in the salt of one.`, twice);
    rejects(receipt, `A private input has "salt": "generate", but the receipt's salt doesn't. Send "generate" in both, or the same salt in both.`, {
      ...marked,
      transient: { ...marked.transient, mine: JSON.stringify({ option: "Ada", salt: SALT }) },
    });
  });

  it("goes into the private input and the receipt alike, and nothing else changes", () => {
    const filled = fillGeneratedSalt(marked, checkReceiptRequest(marked, asks), SALT);
    expect(filled.generated).toBe(true);
    expect(filled.receipt).toEqual(receipt);
    expect(filled.call.transient).toEqual({ note: "hello", ballot: `{"option":"Ada","salt":"${SALT}"}` });
    expect({ ...filled.call, transient: undefined }).toEqual({ ...marked, transient: undefined });
    // The filled request passes the same checks a dApp's own salt does.
    expect(checkReceiptRequest(filled.call, filled.receipt)).toEqual(receipt);
    expect(receiptInput(filled.call, filled.receipt)).toBe("ballot");
    // The dApp's own salt is left alone.
    expect(fillGeneratedSalt(call, receipt)).toEqual({ call, receipt, generated: false });
  });

  it("keeps the input's other fields and their order", () => {
    const withMore: ContractCall = { ...call, transient: { ballot: JSON.stringify({ salt: "generate", option: "Ada", note: 1 }) } };
    const filled = fillGeneratedSalt(withMore, checkReceiptRequest(withMore, asks), SALT);
    expect(filled.call.transient!.ballot).toBe(`{"salt":"${SALT}","option":"Ada","note":1}`);
  });

  it("is 16 random bytes, which the ballot contract accepts", () => {
    const salts = new Set(Array.from({ length: 50 }, () => randomSalt()));
    expect(salts.size).toBe(50);
    for (const s of salts) expect(s).toMatch(/^[0-9a-f]{32}$/);
    const filled = fillGeneratedSalt(marked, asks);
    expect(filled.receipt.salt).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.parse(filled.call.transient!.ballot!).salt).toBe(filled.receipt.salt);
  });

  it("is checked against the signed bytes after it is filled in", () => {
    const filled = fillGeneratedSalt(marked, asks, SALT);
    const enc = (v: string) => new TextEncoder().encode(v);
    const decoded = (transient: Record<string, string>): DecodedProposal => ({
      transactionId: "tx1",
      headerTransactionId: "tx1",
      channel: "mychannel",
      chaincode: "ballot",
      fn: "CastVote",
      args: ["board-2026"],
      transientKeys: Object.keys(transient),
      transient: Object.entries(transient).map(([key, value]) => ({ key, value: enc(value) })),
      creatorMspId: "Org1MSP",
      creatorCertificate: "PEM",
      endorsingOrganizations: [],
      signable: new Uint8Array(),
    });
    const signer = { mspId: "Org1MSP", certificate: "PEM" };
    expect(() => verifyProposal(filled.call, signer, decoded(filled.call.transient!))).not.toThrow();
    // A relay that sends back the placeholder, or a salt of its own, is refused.
    expect(() => verifyProposal(filled.call, signer, decoded(marked.transient!))).toThrow(VerificationError);
    const other = { ...filled.call.transient!, ballot: `{"option":"Ada","salt":"${"0".repeat(32)}"}` };
    expect(() => verifyProposal(filled.call, signer, decoded(other))).toThrow(/private input "ballot"/);
  });
});

describe("the commitment", () => {
  it("is the ballot contract's: SHA-256 of election, option and salt, joined by newlines", async () => {
    // node:crypto, as examples/ballot-contract computes it.
    const { createHash } = await import("node:crypto");
    const expected = createHash("sha256").update(`board-2026\nAda\n${SALT}`, "utf8").digest("hex");
    expect(await ballotCommitment("board-2026", "Ada", SALT)).toBe(expected);
  });

  it("is read from what the contract returned", () => {
    const c = "348fb0f843ed08a3fd1a39e9b6c54e2b1392b421768c9a1ccf353540b1d4e333";
    expect(contractCommitment(JSON.stringify({ electionId: "board-2026", txId: "tx1", commitment: c }))).toBe(c);
    expect(contractCommitment(JSON.stringify({ commitment: c.toUpperCase() }))).toBe(c);
    expect(contractCommitment(JSON.stringify({ commitment: "abc" }))).toBeNull();
    expect(contractCommitment("not json")).toBeNull();
    expect(contractCommitment(null)).toBeNull();
  });

  it("finishes the receipt with Weft's own commitment, and says whether the contract's matches", async () => {
    const commitment = await ballotCommitment("board-2026", "Ada", SALT);
    const committed = { transactionId: "tx1", blockNumber: "85", text: JSON.stringify({ electionId: "board-2026", txId: "tx1", commitment }) };
    const done = await finishReceipt(receipt as never, committed);
    expect(done).toEqual({
      receipt: { type: "weft-ballot-receipt", version: 1, channel: "mychannel", electionId: "board-2026", txId: "tx1", blockNumber: 85, commitment, option: "Ada", salt: SALT },
      matches: true,
      returned: commitment,
    });
    // Same order of keys as the playground's file, which the explorer reads.
    expect(Object.keys(done.receipt)).toEqual(["type", "version", "channel", "electionId", "txId", "blockNumber", "commitment", "option", "salt"]);
    const wrong = await finishReceipt(receipt as never, { ...committed, text: JSON.stringify({ commitment: "0".repeat(64) }) });
    expect(wrong).toMatchObject({ matches: false, returned: "0".repeat(64), receipt: { commitment } });
    expect(await finishReceipt(receipt as never, { ...committed, text: null })).toMatchObject({ matches: false, returned: null });
  });
});

describe("the receipt key", () => {
  it("comes from the vault key, and opens only what it sealed for the same record", async () => {
    const raw = randomBytes(32);
    const key = await deriveReceiptKey(raw);
    expect(key.extractable).toBe(false);
    const secret = new TextEncoder().encode(JSON.stringify({ option: "Ada", salt: SALT }));
    const sealed = await sealBound(key, secret, "activity-1");
    expect(await openBound(await deriveReceiptKey(raw), sealed, "activity-1")).toEqual(secret);
    // Moved onto another record, it doesn't open.
    await expect(openBound(key, sealed, "activity-2")).rejects.toThrow();
    // Nor with another vault's key.
    await expect(openBound(await deriveReceiptKey(randomBytes(32)), sealed, "activity-1")).rejects.toThrow();
  });
});
