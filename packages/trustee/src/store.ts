/**
 * The trustee's state folder for one election, <home>/<channel>/<election>,
 * on the organisation's own machine. The folder is created 0700 and every
 * file 0600. The secrets are encrypted at rest with a key from the
 * passphrase: scrypt (N = 2^17, r = 8, p = 1) and AES-256-GCM, with the
 * file's header as additional data, so a header can't be moved to another
 * file or election.
 *
 *   ceremony.json      encrypted: the polynomial and the one-time ceremony key, rounds 1 to 3
 *   round1.json        public: the round 1 post, to post again if posting failed
 *   key-share.json     encrypted: the key share, from round 3 until destroy
 *   confirmation.json  public: the round 3 post, to post again if posting failed
 *
 * Nothing in the folder is sent anywhere. Deleting a file first overwrites
 * it once with random bytes; on SSDs and journaling or copy-on-write file
 * systems the old blocks can survive that, which keeping-a-share in
 * key-ceremony.md covers.
 */
import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCb, type ScryptOptions } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync, writeSync, closeSync, fsyncSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { Failure } from "./output.ts";

export interface KdfParams {
  N: number;
  r: number;
  p: number;
}
export const DEFAULT_KDF: KdfParams = { N: 2 ** 17, r: 8, p: 1 };
/** Files claiming more than this are refused, so a changed file can't make reading it take minutes. */
const MAX_N = 2 ** 20;

export type SecretKind = "ceremony" | "key-share";
const FILES = { ceremony: "ceremony.json", "key-share": "key-share.json" } as const;

interface Sealed {
  v: 1;
  kind: SecretKind;
  msp: string;
  channel: string;
  electionId: string;
  kdf: { name: "scrypt"; N: number; r: number; p: number; salt: string };
  cipher: "aes-256-gcm";
  nonce: string;
  ciphertext: string;
  tag: string;
}

/** The passphrase doesn't open a file. */
export class WrongPassphrase extends Error {
  override name = "WrongPassphrase";
}

function scrypt(passphrase: string, salt: Buffer, { N, r, p }: KdfParams): Promise<Buffer> {
  const options: ScryptOptions = { N, r, p, maxmem: 256 * N * r + 1024 * 1024 };
  return new Promise((done, fail) => scryptCb(passphrase.normalize("NFC"), salt, 32, options, (err, key) => (err ? fail(err) : done(key))));
}

const header = (s: Omit<Sealed, "nonce" | "ciphertext" | "tag">) =>
  Buffer.from(JSON.stringify({ v: s.v, kind: s.kind, msp: s.msp, channel: s.channel, electionId: s.electionId, kdf: s.kdf, cipher: s.cipher }));

/** Encrypts a secret for the file it goes in. */
export async function seal(value: unknown, passphrase: string, where: { kind: SecretKind; msp: string; channel: string; electionId: string }, kdf = DEFAULT_KDF): Promise<Sealed> {
  const salt = randomBytes(16);
  const key = await scrypt(passphrase, salt, kdf);
  const nonce = randomBytes(12);
  const base = { v: 1 as const, ...where, kdf: { name: "scrypt" as const, ...kdf, salt: salt.toString("hex") }, cipher: "aes-256-gcm" as const };
  const c = createCipheriv("aes-256-gcm", key, nonce);
  c.setAAD(header(base));
  const ciphertext = Buffer.concat([c.update(JSON.stringify(value), "utf8"), c.final()]);
  key.fill(0);
  return { ...base, nonce: nonce.toString("hex"), ciphertext: ciphertext.toString("hex"), tag: c.getAuthTag().toString("hex") };
}

/** Decrypts a sealed file; throws WrongPassphrase if the passphrase doesn't open it. */
export async function open<T>(sealed: Sealed, passphrase: string): Promise<T> {
  const { N, r, p, salt } = sealed.kdf;
  if (!Number.isInteger(N) || N < 2 || N > MAX_N || !Number.isInteger(r) || r < 1 || r > 32 || !Number.isInteger(p) || p < 1 || p > 16) {
    throw new RangeError("the file's scrypt settings are out of range");
  }
  const key = await scrypt(passphrase, Buffer.from(salt, "hex"), { N, r, p });
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.nonce, "hex"));
  d.setAAD(header(sealed));
  d.setAuthTag(Buffer.from(sealed.tag, "hex"));
  try {
    const plain = Buffer.concat([d.update(Buffer.from(sealed.ciphertext, "hex")), d.final()]);
    return JSON.parse(plain.toString("utf8")) as T;
  } catch {
    throw new WrongPassphrase();
  } finally {
    key.fill(0);
  }
}

/** "~/.weft/trustee/privatevote-budget-2027/budget-2027". */
export function displayPath(path: string): string {
  const home = homedir();
  return path === home || path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
}

/** Writes a file with mode 0600, through a temporary file and a rename. */
function writePrivate(path: string, text: string): void {
  const tmp = `${path}.tmp-${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

/** Overwrites a file once with random bytes, then removes it. */
function shred(path: string): void {
  if (!existsSync(path)) return;
  const size = statSync(path).size;
  const fd = openSync(path, "r+");
  try {
    writeSync(fd, randomBytes(size), 0, size, 0);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  unlinkSync(path);
}

/** One election's state folder, for one trustee organisation. */
export class ElectionState {
  readonly dir: string;
  readonly shown: string;
  readonly msp: string;
  readonly channel: string;
  readonly electionId: string;
  private readonly kdf: KdfParams;
  constructor(home: string, msp: string, channel: string, electionId: string, kdf: KdfParams = DEFAULT_KDF) {
    this.msp = msp;
    this.channel = channel;
    this.electionId = electionId;
    this.kdf = kdf;
    for (const [what, part] of [["channel", channel], ["election ID", electionId]] as const) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,248}$/.test(part)) throw new Failure(`The ${what} ${part} can't name a state folder.`);
    }
    this.dir = join(home, channel, electionId);
    this.shown = displayPath(this.dir);
  }

  private path(name: string): string {
    return join(this.dir, name);
  }

  exists(): boolean {
    return existsSync(this.dir) && readdirSync(this.dir).length > 0;
  }

  has(kind: SecretKind): boolean {
    return existsSync(this.path(FILES[kind]));
  }

  private ensureDir(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
  }

  private readSealed(kind: SecretKind): Sealed {
    const sealed = JSON.parse(readFileSync(this.path(FILES[kind]), "utf8")) as Sealed;
    if (sealed.v !== 1 || sealed.kind !== kind || sealed.channel !== this.channel || sealed.electionId !== this.electionId) {
      throw new Failure(`${this.shown}/${FILES[kind]} isn't this election's ${kind === "ceremony" ? "ceremony key" : "key share"}.`);
    }
    if (sealed.msp !== this.msp) {
      throw new Failure(`The state in ${this.shown} belongs to ${sealed.msp}, not ${this.msp}.`, "Give the connection settings of that organisation's trustee, or another --home.");
    }
    return sealed;
  }

  /** Checks a passphrase against one sealed file, and returns what it holds. */
  async read<T>(kind: SecretKind, passphrase: string): Promise<T> {
    return open<T>(this.readSealed(kind), passphrase);
  }

  async write(kind: SecretKind, value: unknown, passphrase: string): Promise<void> {
    this.ensureDir();
    const sealed = await seal(value, passphrase, { kind, msp: this.msp, channel: this.channel, electionId: this.electionId }, this.kdf);
    writePrivate(this.path(FILES[kind]), `${JSON.stringify(sealed, null, 2)}\n`);
  }

  /** A public file: a post kept to send again. */
  readPublic<T>(name: "round1" | "confirmation"): T | null {
    const p = this.path(`${name}.json`);
    return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as T) : null;
  }

  writePublic(name: "round1" | "confirmation", value: unknown): void {
    this.ensureDir();
    writePrivate(this.path(`${name}.json`), `${JSON.stringify(value)}\n`);
  }

  remove(kind: SecretKind): void {
    shred(this.path(FILES[kind]));
  }

  /** Deletes every file in the folder, and the folder. */
  destroy(): void {
    if (!existsSync(this.dir)) return;
    for (const name of readdirSync(this.dir)) shred(join(this.dir, name));
    rmdirSync(this.dir);
  }
}
