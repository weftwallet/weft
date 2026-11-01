import { ErrorCode, WeftError, type ContractCall } from "@weftwallet/protocol";
import { describe, expect, it } from "vitest";
import { parseReceipt, receiptSecret } from "./receipt-request";

const SALT = "7c1e94a0b3d25f86e0a4c9172bd35e6f";
const vote = (salt: string): ContractCall => ({
  channel: "mychannel",
  chaincode: "ballot",
  fn: "CastVote",
  args: ["board-2026"],
  transient: { ballot: JSON.stringify({ option: "Ada", salt }) },
});
const asks = (salt: string) => ({ type: "weft-ballot-receipt", version: 1, channel: "mychannel", electionId: "board-2026", option: "Ada", salt });
const invalid = (run: () => unknown, message: string | RegExp) => {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(WeftError);
    expect((error as WeftError).code).toBe(ErrorCode.InvalidParams);
    expect((error as WeftError).message).toMatch(message);
    return;
  }
  throw new Error("expected InvalidParams");
};

describe("a receipt sent with a call", () => {
  it("is optional, and leaves the call as it was without one", () => {
    expect(parseReceipt("weft_submit", vote(SALT), { ...vote(SALT) })).toEqual({ call: vote(SALT), receipt: null });
    expect(parseReceipt("weft_evaluate", vote(SALT), undefined)).toEqual({ call: vote(SALT), receipt: null });
  });

  it("goes with weft_submit only", () => {
    invalid(() => parseReceipt("weft_evaluate", vote(SALT), { receipt: asks(SALT) }), 'Only weft_submit takes a "receipt": a read has nothing to record.');
  });

  it("fails with InvalidParams, naming the field, when it doesn't fit the call", () => {
    invalid(() => parseReceipt("weft_submit", vote(SALT), { receipt: null }), 'The "receipt" parameter must be an object.');
    invalid(() => parseReceipt("weft_submit", vote(SALT), { receipt: { ...asks(SALT), extra: 1 } }), /field Weft doesn't keep: "extra"/);
    invalid(() => parseReceipt("weft_submit", vote(SALT), { receipt: asks("0".repeat(32)) }), /aren't the ones in any private input/);
  });

  it("names the private input it comes from", () => {
    expect(parseReceipt("weft_submit", vote(SALT), { receipt: asks(SALT) })).toEqual({
      call: vote(SALT),
      receipt: { request: asks(SALT), input: "ballot", generated: false },
    });
  });

  it("gets the salt Weft chose, in the call the window shows and the receipt alike", () => {
    const { call, receipt } = parseReceipt("weft_submit", vote("generate"), { receipt: asks("generate") }, SALT);
    expect(call).toEqual(vote(SALT));
    expect(receipt).toEqual({ request: asks(SALT), input: "ballot", generated: true });
  });

  it("seals the choice and salt only", () => {
    expect(new TextDecoder().decode(receiptSecret(asks(SALT) as never))).toBe(`{"option":"Ada","salt":"${SALT}"}`);
  });
});
