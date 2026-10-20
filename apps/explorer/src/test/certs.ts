/** Test CAs and identities, like a Fabric organisation's. */
import "reflect-metadata";
import { BasicConstraintsExtension, KeyUsageFlags, KeyUsagesExtension, X509CertificateGenerator } from "@peculiar/x509";
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
    serialNumber: "02",
    subject: `CN=${name}`,
    issuer: issuer.cert.subject,
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + validFor),
    signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
    publicKey: keys.publicKey,
    signingKey: issuer.keys.privateKey,
  });
  return { keys, pem: cert.toString("pem") };
}
