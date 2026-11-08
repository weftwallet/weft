/**
 * Test certificates for the voter tag vectors and other packages' tests,
 * built byte by byte so that the same inputs always give the same bytes:
 * X.509 v3 certificates with an Ed25519 key drawn from the seed, signed by
 * that key with Ed25519, which is deterministic. Go's crypto/x509 parses
 * them, so the contract's tests can use them as creators. The subject and
 * the encoding of each attribute are chosen per vector, including subjects
 * the contract refuses. Test only, through @weftwallet/tally/testing.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { utf8 } from "./encoding.ts";

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

function length(n: number): Uint8Array {
  if (n < 0x80) return Uint8Array.of(n);
  if (n < 0x100) return Uint8Array.of(0x81, n);
  if (n < 0x10000) return Uint8Array.of(0x82, n >> 8, n & 255);
  throw new RangeError("too long for a test certificate");
}

export const der = (tag: number, ...content: Uint8Array[]) => {
  const body = concat(...content);
  return concat(Uint8Array.of(tag), length(body.length), body);
};

const seq = (...c: Uint8Array[]) => der(0x30, ...c);
const set = (...c: Uint8Array[]) => der(0x31, ...c);
const ED25519 = der(0x06, Uint8Array.of(0x2b, 0x65, 0x70));
const bits = (b: Uint8Array) => der(0x03, Uint8Array.of(0), b);
const time = (s: string) => der(0x17, utf8(s));

/** DER string tags. */
export const STRING = { utf8: 0x0c, printable: 0x13, ia5: 0x16, bmp: 0x1e } as const;

/** Attribute types. */
export const ATTR = {
  CN: Uint8Array.of(0x55, 0x04, 0x03),
  C: Uint8Array.of(0x55, 0x04, 0x06),
  ST: Uint8Array.of(0x55, 0x04, 0x08),
  O: Uint8Array.of(0x55, 0x04, 0x0a),
  OU: Uint8Array.of(0x55, 0x04, 0x0b),
} as const;

/** One attribute: its type, its DER string tag and its value's bytes (a string is UTF-8). */
export type Attribute = [type: Uint8Array, tag: number, value: Uint8Array | string];

/** A Name: a list of RDNs, each a list of attributes. */
export type Name = Attribute[][];

const nameDer = (n: Name) =>
  seq(...n.map((rdn) => set(...rdn.map(([type, tag, value]) => seq(der(0x06, type), der(tag, typeof value === "string" ? utf8(value) : value))))));

/** A subject in the shape Fabric CA writes: C, ST, O, the OUs in one RDN, then CN, each a PrintableString. */
export function fabricSubject(cn: string, ous: string[] = ["client"]): Name {
  return [
    [[ATTR.C, STRING.printable, "US"]],
    [[ATTR.ST, STRING.printable, "North Carolina"]],
    [[ATTR.O, STRING.printable, "Hyperledger"]],
    ous.map((ou): Attribute => [ATTR.OU, STRING.printable, ou]),
    [[ATTR.CN, STRING.printable, cn]],
  ];
}

const ISSUER: Name = [[[ATTR.O, STRING.printable, "Weft test vectors"]], [[ATTR.CN, STRING.printable, "Weft test CA"]]];

export interface CertificateOptions {
  /** Draws the key and the serial number. */
  seed: string;
  subject: Name;
  issuer?: Name;
  /** Bytes appended to the certificate's DER, inside the PEM block. */
  trailing?: Uint8Array;
}

/** The certificate's DER. */
export function testCertificate(o: CertificateOptions): Uint8Array {
  const secret = sha256(utf8(`weft test certificate key ${o.seed}`));
  const serial = sha256(utf8(`weft test certificate serial ${o.seed}`)).slice(0, 8);
  serial[0] = (serial[0]! & 0x7f) | 0x01;
  const tbs = seq(
    der(0xa0, der(0x02, Uint8Array.of(2))),
    der(0x02, serial),
    seq(ED25519),
    nameDer(o.issuer ?? ISSUER),
    seq(time("260101000000Z"), time("360101000000Z")),
    nameDer(o.subject),
    seq(seq(ED25519), bits(ed25519.getPublicKey(secret))),
  );
  const cert = seq(tbs, seq(ED25519), bits(ed25519.sign(tbs, secret)));
  return o.trailing ? concat(cert, o.trailing) : cert;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function base64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i]! << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    s += B64[n >> 18]! + B64[(n >> 12) & 63]! + (i + 1 < b.length ? B64[(n >> 6) & 63]! : "=") + (i + 2 < b.length ? B64[n & 63]! : "=");
  }
  return s;
}

/** PEM as Go's pem.EncodeToMemory writes it: 64 characters a line and a final newline. */
export function pem(type: string, body: Uint8Array): string {
  const b64 = base64(body);
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${type}-----\n${lines.join("\n")}${lines.length ? "\n" : ""}-----END ${type}-----\n`;
}

export const certificatePem = (o: CertificateOptions) => pem("CERTIFICATE", testCertificate(o));
