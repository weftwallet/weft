// @peculiar/x509 uses tsyringe, which needs the Reflect metadata polyfill loaded first.
import "reflect-metadata";
import { Name, Pkcs10CertificateRequestGenerator, X509Certificate } from "@peculiar/x509";
import type { IdentitySummary } from "@weftwallet/protocol";
import { toHex, tryUtf8 } from "./bytes.js";
import { sha256 } from "./signing.js";

/** OID Fabric CA uses to embed attributes as JSON: {"attrs": {...}}. */
export const FABRIC_ATTRS_OID = "1.2.3.4.5.6.7.8.1";

const NODE_OU_ROLES = new Set(["client", "admin", "peer", "orderer"]);

export function parseCertificate(pem: string): X509Certificate {
  return new X509Certificate(pem.trim());
}

/** Reads the Fabric CA attribute extension, if present. */
export function readFabricAttributes(cert: X509Certificate): Record<string, string> {
  const ext = cert.getExtension(FABRIC_ATTRS_OID);
  if (!ext) return {};
  const json = tryUtf8(new Uint8Array(ext.value));
  if (!json) return {};
  try {
    const parsed = JSON.parse(json) as { attrs?: Record<string, unknown> };
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed.attrs ?? {})) out[key] = String(value);
    return out;
  } catch {
    return {};
  }
}

/** The NodeOU role ("client", "admin", "peer", "orderer"), if the cert carries one. */
export function readRole(cert: X509Certificate): string | null {
  const ous = cert.subjectName.getField("OU");
  return ous.find((ou) => NODE_OU_ROLES.has(ou)) ?? null;
}

export async function fingerprint(cert: X509Certificate): Promise<string> {
  return toHex(await sha256(new Uint8Array(cert.rawData)), ":").toUpperCase();
}

export async function summarizeIdentity(input: {
  id: string;
  mspId: string;
  certificate: string;
}): Promise<IdentitySummary> {
  const cert = parseCertificate(input.certificate);
  return {
    id: input.id,
    name: cert.subjectName.getField("CN")[0] ?? "(no common name)",
    mspId: input.mspId,
    role: readRole(cert),
    attributes: readFabricAttributes(cert),
    issuer: cert.issuer,
    notAfter: cert.notAfter.toISOString(),
    fingerprint: await fingerprint(cert),
    certificate: input.certificate.trim(),
  };
}

export type CertificateHealth =
  | { state: "valid"; daysLeft: number }
  | { state: "expiring"; daysLeft: number }
  | { state: "expired"; daysAgo: number }
  | { state: "not-yet-valid" };

/** How close a certificate is to expiry. "expiring" means 30 days or fewer. */
export function certificateHealth(
  summary: Pick<IdentitySummary, "notAfter">,
  now: Date = new Date(),
  warnDays = 30,
): CertificateHealth {
  const ms = new Date(summary.notAfter).getTime() - now.getTime();
  const days = Math.floor(ms / 86_400_000);
  if (ms <= 0) return { state: "expired", daysAgo: Math.max(0, -days) };
  if (days <= warnDays) return { state: "expiring", daysLeft: days };
  return { state: "valid", daysLeft: days };
}

/** Builds a PKCS#10 CSR (PEM) for enrolment with a Fabric CA. */
export async function createCsr(keys: CryptoKeyPair, commonName: string): Promise<string> {
  const csr = await Pkcs10CertificateRequestGenerator.create({
    name: new Name([{ CN: [commonName] }]),
    keys,
    signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
  });
  return csr.toString("pem");
}

/**
 * True when the private key belongs to the certificate. Works with
 * non-extractable keys: signs a random challenge and verifies it with the
 * certificate's public key.
 */
export async function keyMatchesCertificate(privateKey: CryptoKey, certificatePem: string): Promise<boolean> {
  const cert = parseCertificate(certificatePem);
  const namedCurve = (privateKey.algorithm as EcKeyAlgorithm).namedCurve;
  const publicKey = await cert.publicKey.export({ name: "ECDSA", namedCurve }, ["verify"]);
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const algorithm = { name: "ECDSA", hash: "SHA-256" };
  const signature = await crypto.subtle.sign(algorithm, privateKey, challenge);
  return crypto.subtle.verify(algorithm, publicKey, signature, challenge);
}

/** True when the certificate's public key matches the given public key. */
export async function certificateMatchesKey(certificatePem: string, publicKey: CryptoKey): Promise<boolean> {
  const cert = parseCertificate(certificatePem);
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", publicKey));
  const certSpki = new Uint8Array(cert.publicKey.rawData);
  return toHex(spki) === toHex(certSpki);
}
