import { readFileSync } from "node:fs";
import { enrolmentId, formatFingerprint, voterTagFromCertificate, voterTagX509, toHex } from "@weftwallet/tally";
import { describe, expect, it } from "vitest";
import { RecordError, chainCas, electionFrom, parseElectionRecord } from "./read";
import { makeOrg, recordOf, testElection } from "./test/fabric";

const vectors = JSON.parse(readFileSync(new URL("../../../../packages/tally/vectors/v1/context.json", import.meta.url), "utf8")) as {
  elections: { channel: string; chaincode: string; electionId: string; options: string[]; threshold: number; trustees: string[]; publicKey: string; verifyingShares: string[]; ctx: string; fingerprint: string }[];
  voterTags: { channel: string; electionId: string; mspId: string; kind: string; idBytes: string; enrolmentId: string; tag: string }[];
};

const read = (record: Record<string, unknown>) => parseElectionRecord(JSON.stringify(record), "budget-2027");

describe("the election fingerprint", () => {
  it("is the one the vectors fix, worked out from the record's fields", () => {
    for (const v of vectors.elections) {
      const e = { ...v };
      const record = parseElectionRecord(
        JSON.stringify({ ...recordOf(e), id: v.electionId, context: v.ctx, fingerprint: v.fingerprint }),
        v.electionId,
      );
      const { fingerprint } = electionFrom(record, v.channel, v.chaincode);
      expect(fingerprint).toBe(v.fingerprint);
    }
  });

  it("shows in five groups of four", () => {
    expect(formatFingerprint("3f9a61c208de77b1c4e0")).toBe("3f9a 61c2 08de 77b1 c4e0");
  });

  it("refuses a record whose fingerprint isn't the one Weft computes", () => {
    const e = testElection();
    const record = read(recordOf(e, { fingerprint: "00000000000000000000" }));
    const error = (() => {
      try {
        electionFrom(record, e.channel, e.chaincode);
      } catch (err) {
        return err as RecordError;
      }
    })();
    expect(error?.reason).toBe("mismatch");
    expect(error?.extra.field).toBe("fingerprint");
  });

  it("refuses a record whose key, options or setup its context doesn't cover", () => {
    const e = testElection();
    const changes: Record<string, unknown>[] = [
      { options: ["Plan A", "Plan B", "Plan D"] },
      { publicKey: e.verifyingShares[0] },
      { verifyingShares: [...e.verifyingShares].reverse() },
    ];
    for (const change of changes) {
      expect(() => electionFrom(read(recordOf(e, change)), e.channel, e.chaincode)).toThrow(RecordError);
    }
    // The site named another channel or contract: the context the contract wrote doesn't match.
    expect(() => electionFrom(read(recordOf(e)), "privatevote-other", e.chaincode)).toThrow(/context/);
    expect(() => electionFrom(read(recordOf(e)), e.channel, "ballot")).toThrow(/context/);
  });

  it("doesn't cover the title or the planned closing time", () => {
    const e = testElection();
    const { fingerprint } = electionFrom(read(recordOf(e, { title: "Another title", closesAt: "2030-01-01T00:00:00.000Z" })), e.channel, e.chaincode);
    expect(fingerprint).toBe(electionFrom(read(recordOf(e)), e.channel, e.chaincode).fingerprint);
  });
});

describe("the election record", () => {
  const e = testElection();

  it("reads an open record", () => {
    const r = read(recordOf(e));
    expect(r.state).toBe("open");
    expect(r.voters).toEqual({ kind: "x509", msps: ["Org1MSP", "Org2MSP"] });
  });

  it("reads a record that isn't open without its key", () => {
    const { publicKey: _k, verifyingShares: _s, context: _c, fingerprint: _f, ...keygen } = recordOf(e, { state: "keygen" });
    expect(read(keygen).state).toBe("keygen");
    expect(read(recordOf(e, { state: "failed", reportedBy: "Org2MSP" })).reportedBy).toBe("Org2MSP");
  });

  it("reads voter credentials with the affiliation, role and issuer key they pin", () => {
    const voters = { kind: "idemix", msp: "ChairVoters2027MSP", affiliation: "voters", role: "member", issuerKeyHash: "f".repeat(64), curve: "FP256BN_AMCL", issuerPublicKey: "AAAA" };
    expect(read(recordOf(e, { voters })).voters).toEqual({ kind: "idemix", msp: "ChairVoters2027MSP", affiliation: "voters", role: "member", issuerKeyHash: "f".repeat(64), curve: "FP256BN_AMCL" });
    expect(() => read(recordOf(e, { voters: { ...voters, affiliation: undefined } }))).toThrow(/voters.affiliation/);
    expect(() => read(recordOf(e, { voters: { ...voters, issuerKeyHash: "F".repeat(64) } }))).toThrow(/voters.issuerKeyHash/);
  });

  it("refuses anything that isn't a version 1 record of this election", () => {
    const bad: [unknown, RegExp][] = [
      ["not json", /isn't JSON/],
      [[], /isn't a JSON object/],
      [recordOf(e, { v: 2 }), /version 1/],
      [recordOf(e, { id: "chair-2027" }), /not budget-2027/],
      [recordOf(e, { state: "closed" }), /isn't one Weft knows/],
      [recordOf(e, { options: ["Only"] }), /fewer than two/],
      [recordOf(e, { trustees: [{ id: "02".padEnd(64, "0"), msp: "Org1MSP" }, { id: "01".padEnd(64, "0"), msp: "Org2MSP" }] }), /identifier 1/],
      [recordOf(e, { threshold: 3 }), /threshold/],
      [recordOf(e, { voters: { kind: "anyone" } }), /voters/],
      [recordOf(e, { publicKey: "AB".repeat(32) }), /publicKey/],
      [recordOf(e, { fingerprint: "3f9a 61c2 08de 77b1 c4e0" }), /fingerprint/],
    ];
    for (const [value, message] of bad) {
      expect(() => parseElectionRecord(typeof value === "string" ? value : JSON.stringify(value), "budget-2027")).toThrow(message);
    }
  });
});

describe("the voter tag's enrolment ID", () => {
  it("is the common name in the creator's certificate, however its PEM is written", () => {
    const x509 = vectors.voterTags.filter((t) => t.kind === "x509");
    expect(x509.length).toBeGreaterThan(0);
    for (const v of x509) {
      const bytes = Uint8Array.from(Buffer.from(v.idBytes, "hex"));
      expect(enrolmentId(bytes)).toBe(v.enrolmentId);
      expect(toHex(voterTagX509(v.channel, v.electionId, v.mspId, v.enrolmentId))).toBe(v.tag);
      // The same certificate without its trailing newline is the same voter.
      const text = new TextDecoder().decode(bytes);
      expect(text.endsWith("\n")).toBe(true);
      expect(toHex(voterTagFromCertificate(v.channel, v.electionId, v.mspId, new TextEncoder().encode(text.trimEnd())))).toBe(v.tag);
    }
  });
});

describe("the CA chain kept at enrolment", () => {
  it("splits into roots and intermediates", async () => {
    const org = await makeOrg("Org1MSP");
    const cas = chainCas("Org1MSP", `${org.chain}${org.peer.pem}`);
    expect(cas.rootCerts).toHaveLength(1);
    expect(cas.intermediateCerts).toHaveLength(1);
  });
});
