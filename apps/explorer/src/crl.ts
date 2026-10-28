/**
 * Certificate revocation lists, as Fabric keeps them: each organisation's
 * MSP in the channel configuration carries the CRLs its CAs issued, and peers
 * refuse certificates listed there. The explorer reads the same lists.
 *
 * Only what's needed is parsed: the signed part, the signature, and the
 * serial numbers listed. A CRL counts only if its CA's key verifies it.
 */

import { verify, type X509Certificate } from "node:crypto";

interface Der {
  tag: number;
  /** The whole element, header included. */
  raw: Buffer;
  content: Buffer;
}

function read(buf: Buffer, at = 0): Der & { end: number } {
  const tag = buf[at]!;
  let length = buf[at + 1]!;
  let offset = at + 2;
  if (length & 0x80) {
    const n = length & 0x7f;
    length = 0;
    for (let i = 0; i < n; i++) length = length * 256 + buf[offset + i]!;
    offset += n;
  }
  const end = offset + length;
  if (end > buf.length) throw new Error("Truncated DER.");
  return { tag, raw: buf.subarray(at, end), content: buf.subarray(offset, end), end };
}

function children(content: Buffer): Der[] {
  const out: Der[] = [];
  for (let at = 0; at < content.length; ) {
    const el = read(content, at);
    out.push(el);
    at = el.end;
  }
  return out;
}

const HASHES: Record<string, string> = {
  "2a8648ce3d040302": "sha256", // ecdsa-with-SHA256
  "2a8648ce3d040303": "sha384", // ecdsa-with-SHA384
  "2a8648ce3d040304": "sha512", // ecdsa-with-SHA512
  "2a864886f70d01010b": "sha256", // sha256WithRSAEncryption
  "2a864886f70d01010c": "sha384",
  "2a864886f70d01010d": "sha512",
};

export interface ParsedCrl {
  tbs: Buffer;
  hash: string | null;
  signature: Buffer;
  /** Hex, lower case, no leading zeros. */
  serials: Set<string>;
}

export const normalSerial = (hex: string) => hex.toLowerCase().replace(/^0+(?=.)/, "");

function pemBody(pem: string): Buffer {
  return Buffer.from(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""), "base64");
}

export function parseCrl(pem: string): ParsedCrl {
  const [tbs, algorithm, signature] = children(read(pemBody(pem)).content);
  if (!tbs || !algorithm || !signature) throw new Error("Not a CRL.");
  const oid = children(algorithm.content)[0]!.content.toString("hex");
  const fields = children(tbs.content);
  // version (optional INTEGER), signature, issuer, thisUpdate, nextUpdate (optional), revokedCertificates (optional SEQUENCE)
  let i = fields[0]!.tag === 0x02 ? 1 : 0;
  i += 3; // signature, issuer, thisUpdate
  if (fields[i] && (fields[i]!.tag === 0x17 || fields[i]!.tag === 0x18)) i++; // nextUpdate: UTCTime or GeneralizedTime
  const serials = new Set<string>();
  const revoked = fields[i];
  if (revoked && revoked.tag === 0x30) {
    for (const entry of children(revoked.content)) {
      const serial = children(entry.content)[0];
      if (serial?.tag === 0x02) serials.add(normalSerial(serial.content.toString("hex")));
    }
  }
  // BIT STRING: first byte is the number of unused bits.
  return { tbs: tbs.raw, hash: HASHES[oid] ?? null, signature: signature.content.subarray(1), serials };
}

/** Whether a CRL issued by `issuer`, among `crls`, lists `certificate`. CRLs that don't verify are ignored. */
export function revokedBy(certificate: X509Certificate, issuer: X509Certificate, crls: string[]): boolean {
  const serial = normalSerial(certificate.serialNumber);
  for (const pem of crls) {
    let crl: ParsedCrl;
    try {
      crl = parseCrl(pem);
    } catch {
      continue;
    }
    if (!crl.hash || !crl.serials.has(serial)) continue;
    try {
      if (verify(crl.hash, crl.tbs, issuer.publicKey, crl.signature)) return true;
    } catch {
      /* not this issuer's CRL */
    }
  }
  return false;
}
