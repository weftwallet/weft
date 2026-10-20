/**
 * Cross-checking between organisations (docs/adr/0004, phase 3).
 *
 * Each explorer signs a checkpoint: the latest block it has for a channel and
 * that block's header hash, signed with its own identity. Because every block
 * carries the hash of the one before, one matching checkpoint at block N
 * means two organisations' ledgers agree on every block up to N.
 *
 * Each instance polls the other organisations' explorers, checks their
 * checkpoints (signature, and a certificate issued by an organisation in the
 * channel's configuration), and records how far each one agrees.
 */

import { createPrivateKey, sign as signBytes, verify as verifyBytes, X509Certificate } from "node:crypto";
import { chainsTo } from "./auth.ts";
import type { ExplorerDb } from "./db.ts";

export const CHECKPOINT_PREFIX = "weft-checkpoint:v1";

export interface Checkpoint {
  channel: string;
  mspId: string;
  number: number;
  hash: string;
  signedAt: string;
}

export interface SignedCheckpoint extends Checkpoint {
  /** The exact text signed. */
  message: string;
  /** Base64 DER ECDSA over the message, SHA-256. */
  signature: string;
  /** PEM of the signing explorer's certificate. */
  certificate: string;
}

export function checkpointMessage(c: Checkpoint): string {
  return [CHECKPOINT_PREFIX, `channel: ${c.channel}`, `msp: ${c.mspId}`, `number: ${c.number}`, `hash: ${c.hash}`, `signed: ${c.signedAt}`].join(
    "\n",
  );
}

export function parseCheckpointMessage(message: string): Checkpoint {
  const lines = message.split("\n");
  if (lines[0] !== CHECKPOINT_PREFIX || lines.length !== 6) throw new Error("Not a Weft checkpoint.");
  const field = (i: number, key: string) => {
    const line = lines[i]!;
    if (!line.startsWith(`${key}: `)) throw new Error(`Expected "${key}".`);
    return line.slice(key.length + 2);
  };
  const number = Number(field(3, "number"));
  const hash = field(4, "hash");
  if (!Number.isSafeInteger(number) || number < 0) throw new Error("Bad block number.");
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error("Bad block hash.");
  const parsed = { channel: field(1, "channel"), mspId: field(2, "msp"), number, hash, signedAt: field(5, "signed") };
  if (checkpointMessage(parsed) !== message) throw new Error("Checkpoint isn't in canonical form.");
  return parsed;
}

/** Signs this explorer's latest block for a channel. */
export class CheckpointSigner {
  private readonly key: ReturnType<typeof createPrivateKey>;
  private readonly certificate: string;
  private readonly mspId: string;

  constructor(options: { mspId: string; certificate: Buffer | string; privateKey: Buffer | string }) {
    this.key = createPrivateKey(options.privateKey);
    this.certificate = options.certificate.toString().trim();
    this.mspId = options.mspId;
  }

  sign(channel: string, number: number, hash: string, now = new Date()): SignedCheckpoint {
    const checkpoint: Checkpoint = { channel, mspId: this.mspId, number, hash, signedAt: now.toISOString() };
    const message = checkpointMessage(checkpoint);
    const signature = signBytes("sha256", Buffer.from(message, "utf8"), this.key).toString("base64");
    return { ...checkpoint, message, signature, certificate: this.certificate };
  }
}

export type PeerState =
  /** Their ledger matches ours up to `agreedUpTo`. */
  | "agree"
  /** They're ahead of us, or we haven't seen a checkpoint we can compare yet. */
  | "pending"
  /** Their signed block hash differs from ours. */
  | "mismatch"
  /** The checkpoint failed a check (signature, certificate, channel). */
  | "invalid"
  | "unreachable";

export interface PeerStatus {
  url: string;
  mspId: string | null;
  state: PeerState;
  /** The highest block both ledgers agree on, if any. */
  agreedUpTo: number | null;
  /** The block whose hash differed, when state is "mismatch". */
  mismatchAt: number | null;
  /** Their latest checkpoint height (block number). */
  theirHeight: number | null;
  detail: string | null;
  checkedAt: number | null;
}

/** Checks one peer's checkpoint against our own index. Pure, for testing. */
export function comparePeer(
  db: ExplorerDb,
  channel: string,
  url: string,
  body: unknown,
  previous: PeerStatus | undefined,
  now = Date.now(),
): PeerStatus {
  const base: PeerStatus = {
    url,
    mspId: previous?.mspId ?? null,
    state: "invalid",
    agreedUpTo: previous?.agreedUpTo ?? null,
    mismatchAt: null,
    theirHeight: null,
    detail: null,
    checkedAt: now,
  };
  const b = (body ?? {}) as Partial<SignedCheckpoint>;
  if (typeof b.message !== "string" || typeof b.signature !== "string" || typeof b.certificate !== "string") {
    return { ...base, detail: "The response isn't a checkpoint." };
  }
  let checkpoint: Checkpoint;
  try {
    checkpoint = parseCheckpointMessage(b.message);
  } catch (error) {
    return { ...base, detail: (error as Error).message };
  }
  if (checkpoint.channel !== channel) return { ...base, detail: `The checkpoint is for ${checkpoint.channel}, not ${channel}.` };
  let valid = false;
  try {
    valid = verifyBytes("sha256", Buffer.from(b.message, "utf8"), new X509Certificate(b.certificate).publicKey, Buffer.from(b.signature, "base64"));
  } catch {
    valid = false;
  }
  if (!valid) return { ...base, mspId: checkpoint.mspId, detail: "The signature doesn't match the certificate." };
  const member = db.members(channel).find((m) => m.mspId === checkpoint.mspId);
  if (!member) return { ...base, mspId: checkpoint.mspId, detail: `${checkpoint.mspId} isn't a member of ${channel}.` };
  if (!chainsTo(b.certificate, member, now)) {
    return { ...base, mspId: checkpoint.mspId, detail: `The certificate wasn't issued by ${checkpoint.mspId}'s CA, or has expired.` };
  }

  const signed = { ...base, mspId: checkpoint.mspId, theirHeight: checkpoint.number, detail: null };
  const ours = db.blockHash(channel, checkpoint.number);
  if (ours === null) {
    // They're ahead. Whatever we agreed on before still stands.
    return { ...signed, state: previous?.state === "mismatch" ? "mismatch" : previous?.agreedUpTo != null ? "agree" : "pending", mismatchAt: previous?.mismatchAt ?? null };
  }
  if (ours !== checkpoint.hash) {
    return { ...signed, state: "mismatch", mismatchAt: checkpoint.number, detail: `Block #${checkpoint.number} has a different hash in ${checkpoint.mspId}'s ledger.` };
  }
  return { ...signed, state: "agree", agreedUpTo: Math.max(checkpoint.number, previous?.agreedUpTo ?? -1), mismatchAt: null };
}

type FetchJson = (url: string) => Promise<unknown>;

const defaultFetch: FetchJson = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
};

/** Polls the other organisations' explorers and keeps each one's status per channel. */
export class CrossCheck {
  private readonly status = new Map<string, Map<string, PeerStatus>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly db: ExplorerDb;
  private readonly channels: string[];
  private readonly peers: string[];
  private readonly fetchJson: FetchJson;

  constructor(db: ExplorerDb, channels: string[], peers: string[], fetchJson: FetchJson = defaultFetch) {
    this.db = db;
    this.channels = channels;
    this.peers = peers;
    this.fetchJson = fetchJson;
    for (const channel of channels) {
      const saved = db.peerStatuses(channel);
      this.status.set(channel, new Map(saved.map((s) => [s.url, s])));
    }
  }

  start(intervalMs = 15_000): void {
    if (this.peers.length === 0) return;
    void this.checkAll();
    this.timer = setInterval(() => void this.checkAll(), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  peersFor(channel: string): PeerStatus[] {
    const known = this.status.get(channel) ?? new Map<string, PeerStatus>();
    return this.peers.map(
      (url) => known.get(url) ?? { url, mspId: null, state: "pending", agreedUpTo: null, mismatchAt: null, theirHeight: null, detail: null, checkedAt: null },
    );
  }

  async checkAll(): Promise<void> {
    for (const channel of this.channels) {
      for (const url of this.peers) await this.check(channel, url);
      this.db.savePeerStatuses(channel, this.peersFor(channel));
    }
  }

  /**
   * Narrows a disagreement to the first block that differs, by binary search
   * over the peer's public block hashes. Their signed checkpoint proves the
   * disagreement; this only says where it starts.
   */
  private async firstDifference(channel: string, base: string, agreed: number, differs: number): Promise<number> {
    let lo = agreed + 1;
    let hi = differs;
    try {
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        const body = (await this.fetchJson(`${base}/api/v1/channels/${encodeURIComponent(channel)}/blocks/${mid}`)) as { block?: { hash?: string } };
        if (body.block?.hash === this.db.blockHash(channel, mid)) lo = mid + 1;
        else hi = mid;
      }
    } catch {
      /* keep the narrowest range found */
    }
    return hi;
  }

  async check(channel: string, url: string): Promise<PeerStatus> {
    const map = this.status.get(channel) ?? new Map<string, PeerStatus>();
    this.status.set(channel, map);
    const previous = map.get(url);
    let next: PeerStatus;
    const base = url.replace(/\/+$/, "");
    try {
      const body = await this.fetchJson(`${base}/api/v1/channels/${encodeURIComponent(channel)}/checkpoint`);
      next = comparePeer(this.db, channel, url, body, previous);
      if (next.state === "mismatch" && next.mismatchAt !== null) {
        next = { ...next, mismatchAt: await this.firstDifference(channel, base, next.agreedUpTo ?? -1, next.mismatchAt) };
        next.detail = `From block #${next.mismatchAt}, ${next.mspId}'s ledger has different blocks.`;
      }
    } catch (error) {
      next = {
        ...(previous ?? { url, mspId: null, agreedUpTo: null, mismatchAt: null, theirHeight: null }),
        url,
        state: "unreachable",
        detail: error instanceof Error ? error.message : String(error),
        checkedAt: Date.now(),
      } as PeerStatus;
    }
    map.set(url, next);
    return next;
  }
}

/** How many organisations, counting this one, report block `number` as we have it. */
export function agreementFor(number: number, peers: PeerStatus[]): { agree: number; total: number; mismatched: string[] } {
  const agree = 1 + peers.filter((p) => p.agreedUpTo !== null && p.agreedUpTo >= number && !(p.mismatchAt !== null && p.mismatchAt <= number)).length;
  const mismatched = peers.filter((p) => p.state === "mismatch" && p.mismatchAt !== null && p.mismatchAt <= number).map((p) => p.mspId ?? p.url);
  return { agree, total: 1 + peers.length, mismatched };
}
