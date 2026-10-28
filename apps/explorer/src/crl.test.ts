import { X509Certificate } from "node:crypto";
import { describe, expect, it } from "vitest";
import { certificateProblem } from "./auth.ts";
import { parseCrl, revokedBy } from "./crl.ts";
import { ExplorerDb } from "./db.ts";
import { decodeBlock } from "./decode.ts";
import { ca, crl, user } from "./test/certs.ts";
import { chain } from "./test/blocks.ts";

describe("revocation", () => {
  it("reads a CRL's serial numbers and checks who signed it", async () => {
    const org1 = await ca("ca.org1");
    const other = await ca("ca.other");
    const carol = await user(org1, "carol");
    const alice = await user(org1, "alice");
    const list = await crl(org1, [carol.serial]);
    expect(parseCrl(list).serials.has(carol.serial.toLowerCase().replace(/^0+/, ""))).toBe(true);

    const issuer = new X509Certificate(org1.pem);
    expect(revokedBy(new X509Certificate(carol.pem), issuer, [list])).toBe(true);
    expect(revokedBy(new X509Certificate(alice.pem), issuer, [list])).toBe(false);
    // A list signed by another CA doesn't count, whatever it says.
    expect(revokedBy(new X509Certificate(carol.pem), issuer, [await crl(other, [carol.serial])])).toBe(false);
    expect(revokedBy(new X509Certificate(carol.pem), issuer, ["not a crl"])).toBe(false);
  });

  it("comes from the channel configuration, as peers read it", async () => {
    const org1 = await ca("ca.org1");
    const carol = await user(org1, "carol");
    const alice = await user(org1, "alice");
    const list = await crl(org1, [carol.serial]);
    const db = new ExplorerDb(":memory:");
    for (const b of chain("ch", [{ txs: [{ txId: "cfg", chaincode: "", args: [], config: true, members: [{ mspId: "Org1MSP", rootCerts: [org1.pem], crls: [list] }] }] }])) {
      const config = decodeBlock(b).transactions[0]!;
      db.setMembers("ch", config.members!);
    }
    const [member] = db.members("ch");
    expect(member!.crls).toHaveLength(1);
    expect(certificateProblem(carol.pem, member!)).toBe("revoked");
    expect(certificateProblem(alice.pem, member!)).toBeNull();
  });
});
