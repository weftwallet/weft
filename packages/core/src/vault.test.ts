import { describe, expect, it } from "vitest";
import {
  deriveKeyFromPassword,
  deriveKeyFromPrf,
  generateKeyPair,
  importVaultKey,
  open,
  randomBytes,
  seal,
  signForFabric,
  unwrapSigningKey,
  utf8,
  wrapSigningKey,
  WrongSecretError,
} from "./index.js";

// Fewer PBKDF2 rounds keep the tests fast; the algorithm is the same.
const ROUNDS = 1000;

describe("vault", () => {
  it("seals the vault key with a password and opens it only with that password", async () => {
    const salt = randomBytes(16);
    const vaultKey = randomBytes(32);
    const sealed = await seal(await deriveKeyFromPassword("correct horse", salt, ROUNDS), vaultKey);
    expect(await open(await deriveKeyFromPassword("correct horse", salt, ROUNDS), sealed, "password")).toEqual(vaultKey);
    await expect(open(await deriveKeyFromPassword("wrong horse", salt, ROUNDS), sealed, "password")).rejects.toBeInstanceOf(WrongSecretError);
  });

  it("derives the same key from the same passkey PRF output", async () => {
    const salt = randomBytes(32);
    const prf = randomBytes(32);
    const vaultKey = randomBytes(32);
    const sealed = await seal(await deriveKeyFromPrf(prf, salt), vaultKey);
    expect(await open(await deriveKeyFromPrf(prf, salt), sealed, "passkey")).toEqual(vaultKey);
    await expect(open(await deriveKeyFromPrf(randomBytes(32), salt), sealed, "passkey")).rejects.toBeInstanceOf(WrongSecretError);
  });

  it("wraps a signing key and unwraps it as a non-extractable key that still signs", async () => {
    const vaultKey = await importVaultKey(randomBytes(32));
    const { privateKey, publicKey } = await generateKeyPair("P-256", { extractable: true });
    const wrapped = await wrapSigningKey(vaultKey, privateKey);
    expect(wrapped.curve).toBe("P-256");

    const unwrapped = await unwrapSigningKey(vaultKey, wrapped);
    expect(unwrapped.extractable).toBe(false);
    const message = utf8("hello fabric");
    const der = await signForFabric(unwrapped, message);
    expect(der[0]).toBe(0x30);
    // Verify with the original public key (WebCrypto wants P1363, so re-sign raw for the check).
    const raw = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, unwrapped, message);
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, raw, message)).toBe(true);
  });

  it("refuses to unwrap with another vault key", async () => {
    const { privateKey } = await generateKeyPair("P-256", { extractable: true });
    const wrapped = await wrapSigningKey(await importVaultKey(randomBytes(32)), privateKey);
    await expect(unwrapSigningKey(await importVaultKey(randomBytes(32)), wrapped)).rejects.toThrow();
  });

  it("won't wrap a key that is already non-extractable", async () => {
    const { privateKey } = await generateKeyPair();
    await expect(wrapSigningKey(await importVaultKey(randomBytes(32)), privateKey)).rejects.toThrow(/extractable/);
  });
});
