import { describe, expect, it } from "vitest";
import { readReceipt } from "./receipt.ts";

const receipt = {
  type: "weft-ballot-receipt",
  version: 1,
  channel: "mychannel",
  electionId: "board-2026",
  txId: "9f3a1c07b25e4d18a6c3f09e7b21d45c8e60a93f1b7d2c45e8f06a1b3c9de41b",
  blockNumber: 85,
  commitment: "047cf61deb481e1a531ad439317bd0b26dd972226a1acc1ae541cf65ede471be",
  option: "Ada",
  salt: "6f1c9a42d07e83b5c2a1f4e9d8b03c71",
};
const text = (r: unknown) => JSON.stringify(r, null, 2);

describe("reading a receipt file", () => {
  it("reads a receipt the playground saved", () => {
    expect(readReceipt(text(receipt), "board-2026")).toEqual({ ok: true, txId: receipt.txId, commitment: receipt.commitment, option: "Ada", salt: receipt.salt });
  });

  it("reads a receipt copied before type, version and channel were added", () => {
    const { type, version, channel, ...old } = receipt;
    expect(readReceipt(text(old), "board-2026")).toMatchObject({ ok: true, txId: receipt.txId, salt: receipt.salt });
  });

  it("fills what it can when the choice and salt are missing", () => {
    const { option, salt, ...ids } = receipt;
    expect(readReceipt(text(ids), "board-2026")).toEqual({ ok: true, txId: receipt.txId, commitment: receipt.commitment, option: null, salt: null });
  });

  it("says when the file isn't JSON", () => {
    expect(readReceipt("Voted for Ada on 1 November. Keep the receipt.", "board-2026")).toEqual({
      ok: false,
      message: "Weft Explorer couldn't read that file. Choose the receipt your voting app saved, a .json file.",
    });
  });

  it("says when the JSON isn't a receipt", () => {
    const noIds = { ok: false, message: "That file isn't a ballot receipt. It has no transaction ID or commitment." };
    expect(readReceipt(text({ name: "invite" }), "board-2026")).toEqual(noIds);
    expect(readReceipt("[1, 2]", "board-2026")).toEqual(noIds);
    expect(readReceipt('"a string"', "board-2026")).toEqual(noIds);
    expect(readReceipt(text({ ...receipt, txId: "" }), "board-2026")).toEqual(noIds);
  });

  it("says when the file is another kind of document", () => {
    expect(readReceipt(text({ ...receipt, type: "weft-invite" }), "board-2026")).toEqual({
      ok: false,
      message: "That file isn't a ballot receipt. Choose the receipt your voting app saved.",
    });
  });

  it("says which versions it reads", () => {
    expect(readReceipt(text({ ...receipt, version: 2 }), "board-2026")).toEqual({ ok: false, message: "That receipt is version 2. This explorer reads version 1 receipts only." });
    expect(readReceipt(text({ ...receipt, version: "1" }), "board-2026")).toMatchObject({ ok: false });
  });

  it("names the election a receipt for another one is for", () => {
    expect(readReceipt(text({ ...receipt, electionId: "team-lunch" }), "board-2026")).toEqual({
      ok: false,
      message: "That receipt is for team-lunch, not this election. Open team-lunch's page to check it.",
    });
  });

  it("works from its own source, as the election page inlines it", () => {
    const inlined = new Function(`return (${readReceipt.toString()})`)() as typeof readReceipt;
    expect(inlined(text(receipt), "board-2026")).toMatchObject({ ok: true, option: "Ada" });
    expect(inlined("{", "board-2026")).toMatchObject({ ok: false });
  });
});
