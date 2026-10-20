/**
 * The wallet lock (docs/adr/0005).
 *
 * The vault record (in IndexedDB) holds the vault key sealed by the password
 * and by each passkey. While unlocked, the raw vault key sits in
 * chrome.storage.session, which is in memory, cleared when the browser closes,
 * and not readable by content scripts, so a restarted worker stays unlocked.
 */

import {
  PASSWORD_ITERATIONS,
  VaultLockedError,
  deriveKeyFromPassword,
  deriveKeyFromPrf,
  importVaultKey,
  open,
  randomBytes,
  seal,
  unwrapSigningKey,
  wrapSigningKey,
  type Sealed,
  type WrappedKey,
} from "@weftwallet/core";
import { browser } from "wxt/browser";
import { db } from "./db";

export interface PasskeyRecord {
  /** base64url credential ID. */
  id: string;
  name: string;
  /** PRF input for this passkey. */
  salt: Uint8Array;
  sealed: Sealed;
  createdAt: number;
}

export interface VaultRecord {
  key: "vault";
  salt: Uint8Array;
  iterations: number;
  password: Sealed;
  passkeys: PasskeyRecord[];
  /** 0 means only when the browser closes. */
  autoLockMinutes: number;
}

export type VaultState = "none" | "locked" | "unlocked";

export interface VaultStatus {
  state: VaultState;
  autoLockMinutes: number;
  passkeys: { id: string; name: string; createdAt: number }[];
}

export const AUTO_LOCK_CHOICES = [5, 15, 60, 240, 0] as const;
const DEFAULT_AUTO_LOCK = 15;
const MIN_PASSWORD = 8;
const ALARM = "weft-auto-lock";
const SESSION_KEY = "vaultKey";
const SESSION_LOCK_AT = "lockAt";

/** Decrypted signing keys, by identity or CSR id. Cleared on lock. */
const cache = new Map<string, CryptoKey>();
let vaultKeyCache: CryptoKey | null = null;

async function record(): Promise<VaultRecord | undefined> {
  return db.get<VaultRecord>("settings", "vault");
}

async function sessionKey(): Promise<Uint8Array | null> {
  const stored = (await browser.storage.session.get(SESSION_KEY))[SESSION_KEY] as number[] | undefined;
  return stored ? new Uint8Array(stored) : null;
}

export async function status(): Promise<VaultStatus> {
  const vault = await record();
  if (!vault) return { state: "none", autoLockMinutes: DEFAULT_AUTO_LOCK, passkeys: [] };
  return {
    state: (await sessionKey()) ? "unlocked" : "locked",
    autoLockMinutes: vault.autoLockMinutes,
    passkeys: vault.passkeys.map(({ id, name, createdAt }) => ({ id, name, createdAt })),
  };
}

function checkPassword(password: string) {
  if (password.length < MIN_PASSWORD) throw new Error(`Use at least ${MIN_PASSWORD} characters.`);
}

async function sealWithPassword(password: string, raw: Uint8Array) {
  const salt = randomBytes(16);
  const sealed = await seal(await deriveKeyFromPassword(password, salt, PASSWORD_ITERATIONS), raw);
  return { salt, iterations: PASSWORD_ITERATIONS, password: sealed };
}

async function becomeUnlocked(raw: Uint8Array, minutes: number): Promise<void> {
  vaultKeyCache = await importVaultKey(raw);
  await browser.storage.session.set({ [SESSION_KEY]: Array.from(raw) });
  await touch(minutes);
}

/** Creates the vault with its password, unlocked. */
export async function setup(password: string): Promise<void> {
  if (await record()) throw new Error("Weft already has a password.");
  checkPassword(password);
  const raw = randomBytes(32);
  const vault: VaultRecord = { key: "vault", ...(await sealWithPassword(password, raw)), passkeys: [], autoLockMinutes: DEFAULT_AUTO_LOCK };
  await db.put("settings", vault);
  await becomeUnlocked(raw, vault.autoLockMinutes);
}

async function requireVault(): Promise<VaultRecord> {
  const vault = await record();
  if (!vault) throw new Error("Set a password for Weft first.");
  return vault;
}

export async function unlockWithPassword(password: string): Promise<void> {
  const vault = await requireVault();
  const key = await deriveKeyFromPassword(password, vault.salt, vault.iterations);
  await becomeUnlocked(await open(key, vault.password, "password"), vault.autoLockMinutes);
}

/** What an unlock page passes to navigator.credentials.get. */
export async function passkeyRequest(): Promise<{ id: string; salt: number[] }[]> {
  const vault = await requireVault();
  return vault.passkeys.map((p) => ({ id: p.id, salt: Array.from(p.salt) }));
}

export async function unlockWithPasskey(credentialId: string, prfOutput: Uint8Array): Promise<void> {
  const vault = await requireVault();
  const passkey = vault.passkeys.find((p) => p.id === credentialId);
  if (!passkey) throw new Error("That passkey isn't set up for this wallet.");
  const key = await deriveKeyFromPrf(prfOutput, passkey.salt);
  await becomeUnlocked(await open(key, passkey.sealed, "passkey"), vault.autoLockMinutes);
}

export async function lock(): Promise<void> {
  vaultKeyCache = null;
  cache.clear();
  await browser.storage.session.remove([SESSION_KEY, SESSION_LOCK_AT]);
  await browser.alarms.clear(ALARM);
}

/** Pushes the auto-lock back. Called whenever Weft is used. */
export async function touch(minutes?: number): Promise<void> {
  if (!(await sessionKey())) return;
  const wait = minutes ?? (await record())?.autoLockMinutes ?? DEFAULT_AUTO_LOCK;
  if (wait === 0) {
    await browser.alarms.clear(ALARM);
    await browser.storage.session.remove(SESSION_LOCK_AT);
    return;
  }
  const when = Date.now() + wait * 60_000;
  await browser.storage.session.set({ [SESSION_LOCK_AT]: when });
  await browser.alarms.create(ALARM, { when });
}

/** Call once at worker startup. */
export function registerAutoLock(): void {
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM) void lock();
  });
  // An alarm can be missed while the browser sleeps; catch up on wake.
  void browser.storage.session.get(SESSION_LOCK_AT).then((stored) => {
    const at = stored[SESSION_LOCK_AT] as number | undefined;
    if (at && at <= Date.now()) void lock();
  });
}

async function vaultKey(): Promise<CryptoKey> {
  const raw = await sessionKey();
  if (!raw) {
    vaultKeyCache = null;
    cache.clear();
    throw new VaultLockedError();
  }
  vaultKeyCache ??= await importVaultKey(raw);
  return vaultKeyCache;
}

/** Fails unless Weft is unlocked. */
export async function requireUnlocked(): Promise<void> {
  await requireVault();
  await vaultKey();
}

/** Encrypts a freshly generated or imported (extractable) key. */
export async function wrap(privateKey: CryptoKey): Promise<WrappedKey> {
  await requireVault();
  return wrapSigningKey(await vaultKey(), privateKey);
}

/**
 * The signing key for an identity or pending CSR. Legacy records (from before
 * the lock) hold a non-extractable key directly; they still need Weft unlocked.
 */
export async function signingKey(owner: { id: string; wrappedKey?: WrappedKey; privateKey?: CryptoKey }): Promise<CryptoKey> {
  const key = await vaultKey();
  if (!owner.wrappedKey) {
    if (!owner.privateKey) throw new Error("This identity has no key.");
    return owner.privateKey;
  }
  const cached = cache.get(owner.id);
  if (cached) return cached;
  const unwrapped = await unwrapSigningKey(key, owner.wrappedKey);
  cache.set(owner.id, unwrapped);
  return unwrapped;
}

/** Drops a cached key, e.g. after re-enrolment replaced it. */
export function forget(ownerId: string): void {
  cache.delete(ownerId);
}

/* Settings, all needing Weft unlocked. -------------------------------- */

export async function changePassword(current: string, next: string): Promise<void> {
  const vault = await requireVault();
  checkPassword(next);
  const raw = await open(await deriveKeyFromPassword(current, vault.salt, vault.iterations), vault.password, "password");
  await db.put("settings", { ...vault, ...(await sealWithPassword(next, raw)) });
}

export async function setAutoLock(minutes: number): Promise<void> {
  if (!(AUTO_LOCK_CHOICES as readonly number[]).includes(minutes)) throw new Error("Pick one of the listed times.");
  const vault = await requireVault();
  await requireUnlocked();
  await db.put("settings", { ...vault, autoLockMinutes: minutes });
  await touch(minutes);
}

export async function addPasskey(input: { id: string; name: string; salt: Uint8Array; prfOutput: Uint8Array }): Promise<void> {
  const vault = await requireVault();
  const raw = await sessionKey();
  if (!raw) throw new VaultLockedError();
  if (vault.passkeys.some((p) => p.id === input.id)) throw new Error("That passkey is already set up.");
  const sealed = await seal(await deriveKeyFromPrf(input.prfOutput, input.salt), raw);
  const passkey: PasskeyRecord = { id: input.id, name: input.name.trim() || "Passkey", salt: input.salt, sealed, createdAt: Date.now() };
  await db.put("settings", { ...vault, passkeys: [...vault.passkeys, passkey] });
}

export async function removePasskey(id: string): Promise<void> {
  const vault = await requireVault();
  await requireUnlocked();
  await db.put("settings", { ...vault, passkeys: vault.passkeys.filter((p) => p.id !== id) });
}
