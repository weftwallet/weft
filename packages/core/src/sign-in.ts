/**
 * Sign-in with Weft (docs/adr/0004, phase 2). The wallet builds the message
 * itself from fixed fields and signs those bytes with the identity's key.
 * The message is UTF-8 text starting with "weft-sign-in:v1", which no Fabric
 * proposal or transaction can begin with (both are protobuf, and 'w' is not a
 * valid protobuf tag here), so a sign-in signature can't be replayed as a
 * transaction signature.
 */

import { toArrayBuffer, utf8 } from "./bytes.ts";
import { parseCertificate } from "./certificate.ts";
import { parseDerSignature, type EcKeyAlgorithm, type FabricCurve } from "./signing.ts";

export const SIGN_IN_PREFIX = "weft-sign-in:v1";
/** How long a sign-in message stays valid. Sites exchange it for a session straight away. */
export const SIGN_IN_LIFETIME_MS = 5 * 60_000;

export interface SignInFields {
  /** The site asking, as the browser reports it. */
  origin: string;
  mspId: string;
  /** Chosen by the site, used once. */
  nonce: string;
  issuedAt: Date;
  expiresAt: Date;
  /** Optional one-line text from the site, shown in the approval window. */
  statement?: string;
}

const NONCE = /^[A-Za-z0-9_-]{16,128}$/;

export class SignInError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignInError";
  }
}

/** Checks a site's nonce and statement before anything is shown or signed. */
export function checkSignInParams(params: unknown): { nonce: string; statement?: string } {
  const p = (params ?? {}) as { nonce?: unknown; statement?: unknown };
  if (typeof p.nonce !== "string" || !NONCE.test(p.nonce)) {
    throw new SignInError('"nonce" must be 16 to 128 letters, digits, "-" or "_".');
  }
  if (p.statement === undefined) return { nonce: p.nonce };
  if (typeof p.statement !== "string" || p.statement.length > 200 || /[\u0000-\u001f\u007f]/.test(p.statement)) {
    throw new SignInError('"statement" must be one line of text, at most 200 characters.');
  }
  return { nonce: p.nonce, statement: p.statement.trim() || undefined } as { nonce: string; statement?: string };
}

export function buildSignInMessage(fields: SignInFields): string {
  const lines = [
    SIGN_IN_PREFIX,
    `origin: ${fields.origin}`,
    `msp: ${fields.mspId}`,
    `nonce: ${fields.nonce}`,
    `issued: ${fields.issuedAt.toISOString()}`,
    `expires: ${fields.expiresAt.toISOString()}`,
  ];
  if (fields.statement) lines.push(`statement: ${fields.statement}`);
  return lines.join("\n");
}

export function parseSignInMessage(message: string): SignInFields {
  const [prefix, ...rest] = message.split("\n");
  if (prefix !== SIGN_IN_PREFIX) throw new SignInError("Not a Weft sign-in message.");
  const fields = new Map<string, string>();
  for (const line of rest) {
    const at = line.indexOf(": ");
    if (at < 1) throw new SignInError("Malformed sign-in message.");
    const key = line.slice(0, at);
    if (fields.has(key)) throw new SignInError(`Repeated field "${key}".`);
    fields.set(key, line.slice(at + 2));
  }
  const need = (key: string) => {
    const value = fields.get(key);
    if (!value) throw new SignInError(`Missing "${key}".`);
    return value;
  };
  const date = (key: string) => {
    const d = new Date(need(key));
    if (Number.isNaN(d.getTime())) throw new SignInError(`Bad date in "${key}".`);
    return d;
  };
  const allowed = new Set(["origin", "msp", "nonce", "issued", "expires", "statement"]);
  for (const key of fields.keys()) if (!allowed.has(key)) throw new SignInError(`Unknown field "${key}".`);
  const parsed: SignInFields = {
    origin: need("origin"),
    mspId: need("msp"),
    nonce: need("nonce"),
    issuedAt: date("issued"),
    expiresAt: date("expires"),
  };
  if (fields.has("statement")) parsed.statement = fields.get("statement")!;
  // Rebuilding must give the same bytes, so there's one way to write each message.
  if (buildSignInMessage(parsed) !== message) throw new SignInError("Sign-in message isn't in canonical form.");
  return parsed;
}

// Fabric signs over SHA-256 on every curve (see signing.ts), and so does the wallet.
const HASHES: Record<FabricCurve, string> = { "P-256": "SHA-256", "P-384": "SHA-256" };
const SIZES: Record<FabricCurve, number> = { "P-256": 32, "P-384": 48 };

function toP1363(der: Uint8Array, size: number): Uint8Array {
  const { r, s } = parseDerSignature(der);
  const out = new Uint8Array(size * 2);
  const put = (n: bigint, offset: number) => {
    for (let i = size - 1; i >= 0; i--) {
      out[offset + i] = Number(n & 0xffn);
      n >>= 8n;
    }
  };
  put(r, 0);
  put(s, size);
  return out;
}

/** Whether `signature` (DER) over `message` was made by the certificate's key. */
export async function verifySignIn(message: string, signature: Uint8Array, certificatePem: string): Promise<boolean> {
  const cert = parseCertificate(certificatePem);
  const key = await cert.publicKey.export();
  const curve = (key.algorithm as EcKeyAlgorithm).namedCurve as FabricCurve;
  if (!(curve in HASHES)) return false;
  try {
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: HASHES[curve] },
      key,
      toArrayBuffer(toP1363(signature, SIZES[curve])),
      toArrayBuffer(utf8(message)),
    );
  } catch {
    return false;
  }
}
