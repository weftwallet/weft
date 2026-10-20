import "reflect-metadata";
import { X509CertificateGenerator } from "@peculiar/x509";
import { describe, expect, it } from "vitest";
import {
  buildSignInMessage,
  checkSignInParams,
  generateKeyPair,
  parseSignInMessage,
  signForFabric,
  utf8,
  verifySignIn,
} from "./index.js";

async function identity() {
  const keys = await generateKeyPair("P-256", { extractable: true });
  const cert = await X509CertificateGenerator.createSelfSigned({
    serialNumber: "01",
    name: "CN=alice",
    notBefore: new Date(Date.now() - 1000),
    notAfter: new Date(Date.now() + 86_400_000),
    signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
    keys,
  });
  return { keys, pem: cert.toString("pem") };
}

const fields = {
  origin: "https://explorer.org1.example",
  mspId: "Org1MSP",
  nonce: "abcdefghijklmnop1234",
  issuedAt: new Date("2026-10-20T05:00:00.000Z"),
  expiresAt: new Date("2026-10-20T05:05:00.000Z"),
  statement: "Sign in to Org1's explorer",
};

describe("sign-in", () => {
  it("builds and parses one canonical message", () => {
    const message = buildSignInMessage(fields);
    expect(message.startsWith("weft-sign-in:v1\norigin: https://explorer.org1.example\n")).toBe(true);
    expect(parseSignInMessage(message)).toEqual(fields);
    expect(() => parseSignInMessage(`${message}\n`)).toThrow();
    expect(() => parseSignInMessage(message.replace("msp: Org1MSP", "msp: Org1MSP\nmsp: Org2MSP"))).toThrow(/Repeated/);
    expect(() => parseSignInMessage(message.replace("weft-sign-in:v1", "weft-sign-in:v2"))).toThrow();
  });

  it("checks the site's nonce and statement", () => {
    expect(checkSignInParams({ nonce: "abcdefghijklmnop" })).toEqual({ nonce: "abcdefghijklmnop" });
    expect(() => checkSignInParams({ nonce: "short" })).toThrow(/nonce/);
    expect(() => checkSignInParams({ nonce: "abcdefghijklmnop", statement: "two\nlines" })).toThrow(/statement/);
  });

  it("verifies a signature from the certificate's key and nothing else", async () => {
    const alice = await identity();
    const mallory = await identity();
    const message = buildSignInMessage(fields);
    const signature = await signForFabric(alice.keys.privateKey, utf8(message));
    expect(await verifySignIn(message, signature, alice.pem)).toBe(true);
    expect(await verifySignIn(message, signature, mallory.pem)).toBe(false);
    expect(await verifySignIn(message.replace("Org1MSP", "Org2MSP"), signature, alice.pem)).toBe(false);
  });
});
