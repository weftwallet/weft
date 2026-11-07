/**
 * The trustee identity: an X.509 certificate and private key of one of the
 * election's trustee organisations, with the Fabric CA attribute
 * weft.trustee=true.
 */
import { X509Certificate } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Failure } from "./output.ts";

export interface Identity {
  msp: string;
  /** PEM. */
  certificate: string;
  /** PEM. */
  privateKey: string;
  /** The certificate's common name, such as trustee1. */
  name: string;
  /** Whether the certificate carries weft.trustee=true. */
  trustee: boolean;
}

/** A file, or a folder holding exactly one file, as an MSP's signcerts/ and keystore/ do. */
export function readOne(path: string, what: string): string {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    throw new Failure(`There's no ${what} at ${path}.`);
  }
  if (stat.isDirectory()) {
    const files = readdirSync(path).filter((f) => !f.startsWith("."));
    if (files.length !== 1) throw new Failure(`The ${what} folder ${path} should hold one file, and it holds ${files.length}.`);
    return readFileSync(join(path, files[0]!), "utf8");
  }
  return readFileSync(path, "utf8");
}

/** The OID Fabric CA writes attributes under, 1.2.3.4.5.6.7.8.1, as DER. */
const ATTRS_OID = Buffer.from([0x06, 0x08, 0x2a, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x01]);

/** The attributes Fabric CA put in a certificate, from the extension's JSON, or {} if it has none. */
export function caAttributes(cert: X509Certificate): Record<string, string> {
  const der = cert.raw;
  const at = der.indexOf(ATTRS_OID);
  if (at < 0) return {};
  let i = at + ATTRS_OID.length;
  // An optional critical flag, BOOLEAN.
  if (der[i] === 0x01) i += 2 + der[i + 1]!;
  if (der[i] !== 0x04) return {};
  i++;
  let len = der[i++]!;
  if (len & 0x80) {
    const bytes = len & 0x7f;
    len = 0;
    for (let b = 0; b < bytes; b++) len = (len << 8) | der[i++]!;
  }
  try {
    const parsed = JSON.parse(der.subarray(i, i + len).toString("utf8")) as { attrs?: Record<string, unknown> };
    return Object.fromEntries(Object.entries(parsed.attrs ?? {}).map(([k, v]) => [k, String(v)]));
  } catch {
    return {};
  }
}

export function commonName(cert: X509Certificate): string {
  const cn = cert.subject.split("\n").find((part) => part.startsWith("CN="));
  return cn ? cn.slice(3) : cert.subject;
}

export function loadIdentity(msp: string, certPath: string, keyPath: string): Identity {
  const certificate = readOne(certPath, "certificate");
  const privateKey = readOne(keyPath, "private key");
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(certificate);
  } catch {
    throw new Failure(`${certPath} isn't an X.509 certificate in PEM.`);
  }
  return { msp, certificate, privateKey, name: commonName(cert), trustee: caAttributes(cert)["weft.trustee"] === "true" };
}

/** Refuses before anything is signed if the certificate lacks weft.trustee=true, as the contract would. */
export function requireTrustee(id: Identity): void {
  if (!id.trustee) {
    throw new Failure(
      "This identity can't act as a trustee: its certificate doesn't carry weft.trustee=true.",
      `Register a trustee identity with that attribute at ${id.msp}'s CA, as for an explorer.`,
    );
  }
}
