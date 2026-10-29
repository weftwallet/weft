/**
 * ECDSA keys and Fabric-compatible signatures using WebCrypto.
 * See docs/adr/0002 for why signatures are converted to low-S DER.
 */

import { toArrayBuffer } from "./bytes.ts";

export type FabricCurve = "P-256" | "P-384";

const CURVE_ORDER: Record<FabricCurve, bigint> = {
  "P-256": 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n,
  "P-384":
    0xffffffffffffffffffffffffffffffffffffffffffffffffc7634d81f4372ddf581a0db248b0a77aecec196accc52973n,
};

const HASH: Record<FabricCurve, "SHA-256" | "SHA-384"> = {
  "P-256": "SHA-256",
  // Fabric's default BCCSP hashes with SHA-256 for every curve.
  "P-384": "SHA-256",
};

function bytesToBigInt(bytes: Uint8Array): bigint {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n;
}

function bigIntToBytes(n: bigint): Uint8Array {
  if (n === 0n) return new Uint8Array([0]);
  const out: number[] = [];
  while (n > 0n) {
    out.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  return new Uint8Array(out);
}

/** Encodes a positive integer as an ASN.1 INTEGER. */
function derInteger(n: bigint): Uint8Array {
  let body = bigIntToBytes(n);
  if ((body[0]! & 0x80) !== 0) {
    const padded = new Uint8Array(body.length + 1);
    padded.set(body, 1);
    body = padded;
  }
  return new Uint8Array([0x02, body.length, ...body]);
}

function derLength(length: number): number[] {
  if (length < 0x80) return [length];
  if (length < 0x100) return [0x81, length];
  return [0x82, length >> 8, length & 0xff];
}

/**
 * Converts a WebCrypto (IEEE P1363, r || s) signature to DER, flipping S to
 * the lower half of the curve order as Fabric requires.
 */
export function p1363ToLowSDer(signature: Uint8Array, curve: FabricCurve = "P-256"): Uint8Array {
  const half = signature.length / 2;
  if (!Number.isInteger(half) || half === 0) throw new Error("Malformed ECDSA signature");
  const order = CURVE_ORDER[curve];
  const r = bytesToBigInt(signature.subarray(0, half));
  let s = bytesToBigInt(signature.subarray(half));
  if (s > order >> 1n) s = order - s;
  const body = [...derInteger(r), ...derInteger(s)];
  return new Uint8Array([0x30, ...derLength(body.length), ...body]);
}

/** Reads r and s back out of a DER signature. Used by tests and diagnostics. */
export function parseDerSignature(der: Uint8Array): { r: bigint; s: bigint } {
  let pos = 0;
  const expect = (tag: number) => {
    if (der[pos++] !== tag) throw new Error("Malformed DER signature");
  };
  const length = (): number => {
    const first = der[pos++]!;
    if (first < 0x80) return first;
    const count = first & 0x7f;
    let len = 0;
    for (let i = 0; i < count; i++) len = (len << 8) | der[pos++]!;
    return len;
  };
  expect(0x30);
  length();
  expect(0x02);
  const rLen = length();
  const r = bytesToBigInt(der.subarray(pos, pos + rLen));
  pos += rLen;
  expect(0x02);
  const sLen = length();
  const s = bytesToBigInt(der.subarray(pos, pos + sLen));
  return { r, s };
}

export function isLowS(der: Uint8Array, curve: FabricCurve = "P-256"): boolean {
  return parseDerSignature(der).s <= CURVE_ORDER[curve] >> 1n;
}

/**
 * A WebCrypto key pair and an EC key's algorithm. Named here rather than taken
 * from the DOM's types, so core type-checks in Node apps without them.
 */
export interface KeyPair {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
}
export interface EcKeyAlgorithm {
  name: string;
  namedCurve: string;
}

/**
 * Generates a key pair. By default the private key is non-extractable: it can
 * sign but its material can never be read back by script. The wallet asks for
 * an extractable key only to encrypt it with the vault key straight away
 * (see vault.ts); what it keeps and signs with is non-extractable.
 */
export async function generateKeyPair(
  curve: FabricCurve = "P-256",
  options: { extractable?: boolean } = {},
): Promise<KeyPair> {
  return crypto.subtle.generateKey({ name: "ECDSA", namedCurve: curve }, options.extractable ?? false, ["sign", "verify"]);
}

/**
 * Imports a PKCS#8 PEM private key as a signing key, non-extractable unless
 * asked (the wallet asks only to encrypt it with the vault key).
 */
export async function importPrivateKeyPem(
  pem: string,
  curve: FabricCurve = "P-256",
  options: { extractable?: boolean } = {},
): Promise<CryptoKey> {
  const body = pem
    .replace(/-----BEGIN (?:EC )?PRIVATE KEY-----/, "")
    .replace(/-----END (?:EC )?PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  if (pem.includes("BEGIN EC PRIVATE KEY")) {
    throw new Error(
      "This is a SEC1 'EC PRIVATE KEY'. Convert it to PKCS#8 first: openssl pkcs8 -topk8 -nocrypt -in key.pem",
    );
  }
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("pkcs8", toArrayBuffer(der), { name: "ECDSA", namedCurve: curve }, options.extractable ?? false, ["sign"]);
}

export function curveOf(key: CryptoKey): FabricCurve {
  const curve = (key.algorithm as EcKeyAlgorithm).namedCurve;
  if (curve !== "P-256" && curve !== "P-384") throw new Error(`Unsupported curve ${curve}`);
  return curve;
}

/**
 * Signs `message` the way Fabric verifies it: ECDSA over SHA-256(message),
 * DER-encoded, low-S. Pass the message bytes, not a digest: WebCrypto hashes.
 */
export async function signForFabric(privateKey: CryptoKey, message: Uint8Array): Promise<Uint8Array> {
  const curve = curveOf(privateKey);
  const raw = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: HASH[curve] }, privateKey, toArrayBuffer(message)),
  );
  return p1363ToLowSDer(raw, curve);
}

/** SHA-256 helper, used for fingerprints and tests. */
export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", toArrayBuffer(data)));
}
