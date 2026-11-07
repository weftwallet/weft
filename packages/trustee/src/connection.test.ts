import { X509Certificate } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveConnection } from "./connection.ts";
import { caAttributes, loadIdentity } from "./identity.ts";

const dir = mkdtempSync(join(tmpdir(), "weft-connection-"));
const fixtures = new URL("./test/fixtures/", import.meta.url).pathname;

describe("the connection file", () => {
  const file = join(dir, "org1.yaml");
  writeFileSync(
    file,
    "peer: localhost:7051\npeerHostAlias: peer0.org1.example.com\ntlsCa: tls/ca.crt\nmsp: Org1MSP\ncert: trustee1/msp/signcerts\nkey: trustee1/msp/keystore\nchannel: privatevote-budget-2027\nhome: state\n",
  );

  it("reads every setting, with paths relative to the file", () => {
    expect(resolveConnection({ connection: file }, {})).toEqual({
      peer: "localhost:7051",
      peerHostAlias: "peer0.org1.example.com",
      tlsCa: join(dir, "tls/ca.crt"),
      msp: "Org1MSP",
      cert: join(dir, "trustee1/msp/signcerts"),
      key: join(dir, "trustee1/msp/keystore"),
      channel: "privatevote-budget-2027",
      contract: "private-ballot",
      home: join(dir, "state"),
      source: "org1.yaml",
    });
  });

  it("lets flags override it, and WEFT_TRUSTEE_HOME override its home", () => {
    const c = resolveConnection({ connection: file, channel: "privatevote-chair-2027" }, { WEFT_TRUSTEE_HOME: "/srv/trustee" });
    expect(c.channel).toBe("privatevote-chair-2027");
    expect(c.home).toBe("/srv/trustee");
  });

  it("says which settings are missing", () => {
    expect(() => resolveConnection({ peer: "localhost:7051" }, {})).toThrow("The connection settings have no --tls-ca, --msp, --cert, --key and --channel.");
  });

  it("refuses a setting it doesn't know", () => {
    const bad = join(dir, "bad.yaml");
    writeFileSync(bad, "peer: x\nmspId: Org1MSP\n");
    expect(() => resolveConnection({ connection: bad }, {})).toThrow("has a setting weft-trustee doesn't know, mspId.");
  });
});

describe("the trustee identity", () => {
  it("reads weft.trustee=true from a Fabric CA certificate", () => {
    const cert = new X509Certificate(readFileSync(join(fixtures, "trustee-cert.pem")));
    expect(caAttributes(cert)).toMatchObject({ "weft.trustee": "true", "hf.EnrollmentID": "trustee1" });
  });

  it("finds no weft.trustee in an ordinary member's certificate", () => {
    const cert = new X509Certificate(readFileSync(join(fixtures, "voter-cert.pem")));
    expect(caAttributes(cert)["weft.trustee"]).toBeUndefined();
  });

  it("reads the certificate and key from MSP folders", () => {
    const msp = join(dir, "msp");
    mkdirSync(join(msp, "signcerts"), { recursive: true });
    mkdirSync(join(msp, "keystore"), { recursive: true });
    writeFileSync(join(msp, "signcerts", "cert.pem"), readFileSync(join(fixtures, "trustee-cert.pem")));
    writeFileSync(join(msp, "keystore", "abc_sk"), "not read until signing");
    const id = loadIdentity("Org1MSP", join(msp, "signcerts"), join(msp, "keystore"));
    expect(id).toMatchObject({ msp: "Org1MSP", name: "trustee1", trustee: true });
  });
});
