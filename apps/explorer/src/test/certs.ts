/** Test CAs and identities, like a Fabric organisation's. */
import "reflect-metadata";
import { randomBytes } from "node:crypto";
import { BasicConstraintsExtension, KeyUsageFlags, KeyUsagesExtension, X509CertificateGenerator, X509CrlGenerator } from "@peculiar/x509";
import { generateKeyPair } from "@weftwallet/core";

export async function ca(name: string) {
  const keys = await generateKeyPair("P-256", { extractable: true });
  const cert = await X509CertificateGenerator.createSelfSigned({
    serialNumber: "01",
    name: `CN=${name}`,
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 86_400_000),
    signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
    keys,
    extensions: [new BasicConstraintsExtension(true, undefined, true), new KeyUsagesExtension(KeyUsageFlags.keyCertSign, true)],
  });
  return { keys, cert, pem: cert.toString("pem") };
}

export async function user(issuer: Awaited<ReturnType<typeof ca>>, name: string, validFor = 86_400_000) {
  const keys = await generateKeyPair("P-256", { extractable: true });
  const cert = await X509CertificateGenerator.create({
    // Each its own serial, so a CRL lists one identity.
    serialNumber: `7f${randomBytes(8).toString("hex")}`,
    subject: `CN=${name}`,
    issuer: issuer.cert.subject,
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + validFor),
    signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
    publicKey: keys.publicKey,
    signingKey: issuer.keys.privateKey,
  });
  return { keys, pem: cert.toString("pem"), serial: cert.serialNumber };
}

/** A CRL from `issuer` listing these serial numbers (hex). */
export async function crl(issuer: Awaited<ReturnType<typeof ca>>, serials: string[]) {
  const list = await X509CrlGenerator.create({
    issuer: issuer.cert.subject,
    thisUpdate: new Date(Date.now() - 60_000),
    nextUpdate: new Date(Date.now() + 86_400_000),
    entries: serials.map((serialNumber) => ({ serialNumber, revocationDate: new Date() })),
    signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
    signingKey: issuer.keys.privateKey,
  });
  return list.toString("pem");
}
