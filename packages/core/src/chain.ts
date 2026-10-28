/**
 * Checks a Fabric ledger's block hashes and an explorer's signed checkpoint
 * without trusting whoever served them (docs/adr/0004). Browser-safe: it uses
 * WebCrypto only, so a page from anywhere can run it against any explorer's
 * public API. Exported as "@weftwallet/core/chain".
 *
 * What it proves: that a run of block headers links hash by hash, and that an
 * organisation, by a certificate its CA issued, signed the hash of the last
 * one. What it can't prove alone: that a block's transactions are the ones in
 * its data hash, since that needs the block's raw bytes, which an explorer
 * doesn't publish.
 */

import "reflect-metadata";
import { X509Certificate } from "@peculiar/x509";

export interface BlockHeader {
  number: number;
  /** Hex. */
  previousHash: string;
  /** Hex. */
  dataHash: string;
  /** Hex: the hash the explorer says this header has. */
  hash: string;
}

export type ChainResult = { ok: true; from: number; to: number } | { ok: false; at: number; reason: string };

const fromHex = (hex: string) => {
  if (!/^(?:[0-9a-f]{2})*$/i.test(hex)) throw new Error("Not hex.");
  return Uint8Array.from(hex.match(/../g) ?? [], (b) => parseInt(b, 16));
};
const toHex = (bytes: ArrayBuffer | Uint8Array) => Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");

function derLength(length: number): number[] {
  if (length < 0x80) return [length];
  const bytes: number[] = [];
  for (let n = length; n > 0; n = Math.floor(n / 256)) bytes.unshift(n & 0xff);
  return [0x80 | bytes.length, ...bytes];
}

const derElement = (tag: number, content: number[]) => [tag, ...derLength(content.length), ...content];

function derInteger(value: bigint): number[] {
  const bytes: number[] = [];
  let n = value;
  do {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  } while (n > 0n);
  if (bytes[0]! & 0x80) bytes.unshift(0);
  return derElement(0x02, bytes);
}

/** A block header's hash, as Fabric computes it: SHA-256 of DER(number, previous hash, data hash). */
export async function blockHeaderHash(number: number | bigint, previousHash: string, dataHash: string): Promise<string> {
  const der = derElement(0x30, [
    ...derInteger(BigInt(number)),
    ...derElement(0x04, [...fromHex(previousHash)]),
    ...derElement(0x04, [...fromHex(dataHash)]),
  ]);
  return toHex(await crypto.subtle.digest("SHA-256", new Uint8Array(der)));
}

/** Recomputes each header's hash and checks each one names the one before. Headers must be consecutive. */
export async function checkHeaders(headers: BlockHeader[]): Promise<ChainResult> {
  const sorted = [...headers].sort((a, b) => a.number - b.number);
  if (sorted.length === 0) return { ok: false, at: -1, reason: "No headers to check." };
  for (let i = 0; i < sorted.length; i++) {
    const h = sorted[i]!;
    if (i > 0 && h.number !== sorted[i - 1]!.number + 1) return { ok: false, at: h.number, reason: `Block ${h.number - 1} is missing.` };
    let computed: string;
    try {
      computed = await blockHeaderHash(h.number, h.previousHash, h.dataHash);
    } catch {
      return { ok: false, at: h.number, reason: `Block ${h.number}'s header isn't valid hex.` };
    }
    if (computed !== h.hash.toLowerCase()) return { ok: false, at: h.number, reason: `Block ${h.number}'s hash doesn't match its header.` };
    if (i > 0 && h.previousHash.toLowerCase() !== sorted[i - 1]!.hash.toLowerCase()) {
      return { ok: false, at: h.number, reason: `Block ${h.number} doesn't name block ${h.number - 1}'s hash as the one before it.` };
    }
  }
  return { ok: true, from: sorted[0]!.number, to: sorted[sorted.length - 1]!.number };
}

/* Checkpoints ------------------------------------------------------ */

export const CHECKPOINT_PREFIX = "weft-checkpoint:v1";

export interface Checkpoint {
  channel: string;
  mspId: string;
  number: number;
  hash: string;
  signedAt: string;
}

/** As served at /api/v1/channels/:channel/checkpoint. */
export interface SignedCheckpoint {
  message: string;
  /** Base64 DER ECDSA over the message's UTF-8 bytes, SHA-256. */
  signature: string;
  /** PEM. */
  certificate: string;
}

/** A channel member's CAs, from the channel configuration. */
export interface MemberCas {
  mspId: string;
  rootCerts: string[];
  intermediateCerts: string[];
}

export function parseCheckpoint(message: string): Checkpoint {
  const lines = message.split("\n");
  const field = (i: number, key: string) => {
    const line = lines[i] ?? "";
    if (!line.startsWith(`${key}: `)) throw new Error(`Expected "${key}".`);
    return line.slice(key.length + 2);
  };
  if (lines[0] !== CHECKPOINT_PREFIX || lines.length !== 6) throw new Error("Not a Weft checkpoint.");
  const number = Number(field(3, "number"));
  const hash = field(4, "hash");
  if (!Number.isSafeInteger(number) || number < 0) throw new Error("Bad block number.");
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error("Bad block hash.");
  return { channel: field(1, "channel"), mspId: field(2, "msp"), number, hash, signedAt: field(5, "signed") };
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/** DER ECDSA-Sig-Value to the r‖s form WebCrypto verifies. */
export function derSignatureToP1363(der: Uint8Array, size: number): Uint8Array<ArrayBuffer> {
  let i = 0;
  /** Reads a tag and length, leaving `i` at the start of the content. */
  const header = (tag: number) => {
    if (der[i++] !== tag) throw new Error("Not a DER ECDSA signature.");
    let length = der[i++]!;
    if (length & 0x80) {
      const n = length & 0x7f;
      length = 0;
      for (let k = 0; k < n; k++) length = length * 256 + der[i++]!;
    }
    return length;
  };
  header(0x30);
  const out = new Uint8Array(size * 2);
  for (const offset of [0, size]) {
    const length = header(0x02);
    let n = der.subarray(i, i + length);
    i += length;
    while (n.length > size && n[0] === 0) n = n.subarray(1);
    if (n.length > size) throw new Error("Signature value too long.");
    out.set(n, offset + size - n.length);
  }
  return out;
}

const CURVE_SIZES: Record<string, number> = { "P-256": 32, "P-384": 48, "P-521": 66 };

/** Whether `certificate` was issued, through any intermediates, by one of the member's roots, all in date. */
async function issuedBy(certificate: X509Certificate, member: MemberCas, now: Date): Promise<boolean> {
  const roots = member.rootCerts.map((p) => new X509Certificate(p));
  const pool = [...member.intermediateCerts.map((p) => new X509Certificate(p)), ...roots];
  const inDate = (c: X509Certificate) => c.notBefore <= now && now <= c.notAfter;
  let current = certificate;
  for (let depth = 0; depth < 6; depth++) {
    if (!inDate(current)) return false;
    let issuer: X509Certificate | undefined;
    for (const candidate of pool) {
      if (candidate.subject !== current.issuer) continue;
      if (await current.verify({ publicKey: candidate.publicKey, signatureOnly: true })) {
        issuer = candidate;
        break;
      }
    }
    if (!issuer) return false;
    if (roots.some((r) => r.equal(issuer!))) return inDate(issuer);
    current = issuer;
  }
  return false;
}

export type CheckpointResult = { ok: true; checkpoint: Checkpoint } | { ok: false; reason: string; checkpoint?: Checkpoint };

/**
 * Checks a signed checkpoint: its message is well formed, its signature
 * matches its certificate, and the certificate was issued by the CA of the
 * organisation it names, according to `members` (the channel configuration).
 */
export async function verifyCheckpoint(signed: SignedCheckpoint, members: MemberCas[], now = new Date()): Promise<CheckpointResult> {
  let checkpoint: Checkpoint;
  try {
    checkpoint = parseCheckpoint(signed.message);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(signed.certificate);
  } catch {
    return { ok: false, checkpoint, reason: "Its certificate can't be read." };
  }
  const algorithm = certificate.publicKey.algorithm as EcKeyAlgorithm;
  const size = CURVE_SIZES[algorithm.namedCurve];
  if (algorithm.name !== "ECDSA" || !size) return { ok: false, checkpoint, reason: "Its certificate isn't an ECDSA key Weft can check." };
  let valid = false;
  try {
    const key = await certificate.publicKey.export({ name: "ECDSA", namedCurve: algorithm.namedCurve }, ["verify"]);
    valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      derSignatureToP1363(fromBase64(signed.signature), size),
      new TextEncoder().encode(signed.message),
    );
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, checkpoint, reason: "The signature doesn't match its certificate." };
  const member = members.find((m) => m.mspId === checkpoint.mspId);
  if (!member) return { ok: false, checkpoint, reason: `${checkpoint.mspId} isn't a member of ${checkpoint.channel}.` };
  if (!(await issuedBy(certificate, member, now))) {
    return { ok: false, checkpoint, reason: `Its certificate wasn't issued by ${checkpoint.mspId}'s CA, or has expired.` };
  }
  return { ok: true, checkpoint };
}
