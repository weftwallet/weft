/**
 * Encryption at rest for private keys (docs/adr/0005).
 *
 * A random 256-bit vault key encrypts every private key (AES-GCM key
 * wrapping, PKCS#8). The vault key is itself sealed once per way of
 * unlocking: with a key derived from the password (PBKDF2-SHA-256) and with
 * a key derived from each passkey's PRF output (HKDF-SHA-256). Opening any
 * seal yields the vault key; a wrong password or passkey fails AES-GCM's
 * authentication check, so it can't produce a wrong key silently.
 */

import { toArrayBuffer } from "./bytes.ts";
import type { EcKeyAlgorithm, FabricCurve } from "./signing.ts";

/** OWASP's 2023 recommendation for PBKDF2-HMAC-SHA256. */
export const PASSWORD_ITERATIONS = 600_000;

export interface Sealed {
  iv: Uint8Array;
  data: Uint8Array;
}

export interface WrappedKey extends Sealed {
  curve: FabricCurve;
}

export class VaultLockedError extends Error {
  constructor() {
    super("Weft is locked. Unlock it to sign.");
    this.name = "VaultLockedError";
  }
}

export class WrongSecretError extends Error {
  constructor(what: "password" | "passkey") {
    super(what === "password" ? "That password isn't right." : "That passkey can't unlock Weft.");
    this.name = "WrongSecretError";
  }
}

const encoder = new TextEncoder();

export function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

/** A key-encryption key from a password. */
export async function deriveKeyFromPassword(password: string, salt: Uint8Array, iterations = PASSWORD_ITERATIONS): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", toArrayBuffer(encoder.encode(password)), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: toArrayBuffer(salt), iterations },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** A key-encryption key from a passkey's PRF output. */
export async function deriveKeyFromPrf(prfOutput: Uint8Array, salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", toArrayBuffer(prfOutput), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: toArrayBuffer(salt), info: toArrayBuffer(encoder.encode("weft vault key v1")) },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function seal(key: CryptoKey, bytes: Uint8Array): Promise<Sealed> {
  const iv = randomBytes(12);
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: toArrayBuffer(iv) }, key, toArrayBuffer(bytes)));
  return { iv, data };
}

/** Throws WrongSecretError when `key` didn't seal it. */
export async function open(key: CryptoKey, sealed: Sealed, what: "password" | "passkey"): Promise<Uint8Array> {
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt({ name: "AES-GCM", iv: toArrayBuffer(sealed.iv) }, key, toArrayBuffer(sealed.data)),
    );
  } catch {
    throw new WrongSecretError(what);
  }
}

/** The vault key as a usable AES-GCM key. Non-extractable once imported. */
export async function importVaultKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", toArrayBuffer(raw), { name: "AES-GCM", length: 256 }, false, ["wrapKey", "unwrapKey"]);
}

/** Encrypts an (extractable) private key with the vault key. */
export async function wrapSigningKey(vaultKey: CryptoKey, privateKey: CryptoKey): Promise<WrappedKey> {
  if (!privateKey.extractable) throw new Error("Only extractable keys can be wrapped.");
  const curve = (privateKey.algorithm as EcKeyAlgorithm).namedCurve as FabricCurve;
  const iv = randomBytes(12);
  const data = new Uint8Array(await crypto.subtle.wrapKey("pkcs8", privateKey, vaultKey, { name: "AES-GCM", iv: toArrayBuffer(iv) }));
  return { iv, data, curve };
}

/** Decrypts a private key as a non-extractable signing key. */
export async function unwrapSigningKey(vaultKey: CryptoKey, wrapped: WrappedKey): Promise<CryptoKey> {
  return crypto.subtle.unwrapKey(
    "pkcs8",
    toArrayBuffer(wrapped.data),
    vaultKey,
    { name: "AES-GCM", iv: toArrayBuffer(wrapped.iv) },
    { name: "ECDSA", namedCurve: wrapped.curve },
    false,
    ["sign"],
  );
}
