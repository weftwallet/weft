import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Failure } from "./output.ts";
import { DEFAULT_KDF, ElectionState, WrongPassphrase, open, seal } from "./store.ts";
import { TEST_KDF } from "./test/harness.ts";

const where = { kind: "key-share" as const, msp: "Org1MSP", channel: "privatevote-budget-2027", electionId: "budget-2027" };

describe("the state folder", () => {
  it("round-trips a secret, and refuses another passphrase", async () => {
    const sealed = await seal({ share: "ab" }, "one passphrase", where, TEST_KDF);
    expect(await open(sealed, "one passphrase")).toEqual({ share: "ab" });
    await expect(open(sealed, "another passphrase")).rejects.toBeInstanceOf(WrongPassphrase);
    expect(JSON.stringify(sealed)).not.toContain('"ab"');
  });

  it("binds the header, so a file can't be moved to another election or organisation", async () => {
    const sealed = await seal({ share: "ab" }, "one passphrase", where, TEST_KDF);
    await expect(open({ ...sealed, electionId: "budget-2028" }, "one passphrase")).rejects.toBeInstanceOf(WrongPassphrase);
    await expect(open({ ...sealed, msp: "Org2MSP" }, "one passphrase")).rejects.toBeInstanceOf(WrongPassphrase);
  });

  it("uses scrypt with N = 2^17 by default, and refuses settings that would take minutes to read", async () => {
    expect(DEFAULT_KDF).toEqual({ N: 131072, r: 8, p: 1 });
    const sealed = await seal({}, "one passphrase", where, TEST_KDF);
    await expect(open({ ...sealed, kdf: { ...sealed.kdf, N: 2 ** 24 } }, "one passphrase")).rejects.toThrow(RangeError);
  });

  it("refuses a file written for another organisation", async () => {
    const home = mkdtempSync(join(tmpdir(), "weft-store-"));
    const mine = new ElectionState(home, "Org1MSP", where.channel, where.electionId, TEST_KDF);
    await mine.write("key-share", { share: "ab" }, "one passphrase");
    const theirs = new ElectionState(home, "Org2MSP", where.channel, where.electionId, TEST_KDF);
    await expect(theirs.read("key-share", "one passphrase")).rejects.toThrow(Failure);
    await expect(theirs.read("key-share", "one passphrase")).rejects.toThrow("The state in");
  });

  it("overwrites a file before deleting it, and removes the folder", async () => {
    const home = mkdtempSync(join(tmpdir(), "weft-store-"));
    const s = new ElectionState(home, "Org1MSP", where.channel, where.electionId, TEST_KDF);
    await s.write("ceremony", { ceremonyKey: "cd" }, "one passphrase");
    s.writePublic("round1", { commitments: [] });
    expect(s.exists()).toBe(true);
    s.remove("ceremony");
    expect(s.has("ceremony")).toBe(false);
    s.destroy();
    expect(s.exists()).toBe(false);
  });

  it("won't make a state folder from a name with a path in it", () => {
    expect(() => new ElectionState("/tmp", "Org1MSP", "../etc", "x")).toThrow("can't name a state folder");
    expect(() => new ElectionState("/tmp", "Org1MSP", "ch", "a/b")).toThrow("can't name a state folder");
  });

  it("writes the passphrase nowhere", async () => {
    const home = mkdtempSync(join(tmpdir(), "weft-store-"));
    const s = new ElectionState(home, "Org1MSP", where.channel, where.electionId, TEST_KDF);
    await s.write("key-share", { share: "ab" }, "a passphrase to look for");
    expect(readFileSync(join(s.dir, "key-share.json"), "utf8")).not.toContain("a passphrase to look for");
  });
});
