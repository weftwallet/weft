/**
 * Weft Experimental only (docs/adr/0008): the activity of anonymous ballots,
 * sealed.
 *
 * Weft keeps a transaction's activity readable on disk, and a voter
 * credential's record names its election. A readable transaction ID beside
 * the credential would tie the voter to the ballot for anyone who can read
 * the browser's files, so an anonymous ballot's whole record, and its kept
 * receipt with the voter's note of the choice, are sealed under the voter
 * credentials' key (seal.ts) in the anonymousActivity store. Only the row's
 * ID is readable. They are opened only while Weft is unlocked, and shown with
 * the rest of the activity then.
 */
import { RECEIPT_TYPE } from "@weftwallet/protocol";
import { db, type ActivityRecord } from "../db";
import type { ReceiptView } from "../receipts";
import { openText, sealText, voterKey } from "./seal";
import type { SealedText, VoterCredentialRecord } from "./types";

/** A kept receipt of an anonymous ballot, with the voter's note of the choice. */
export interface AnonymousReceipt {
  channel: string;
  electionId: string;
  txId: string;
  blockNumber: number;
  tracking: string;
  option: string;
  keptAt: number;
}

export interface AnonymousEntry {
  activity: ActivityRecord;
  receipt: AnonymousReceipt | null;
}

interface Row {
  id: string;
  sealed: SealedText;
}

const BOUND = (id: string) => `${id} activity`;

/** Seals and saves an entry. `key` is the voter credentials' key, taken before the vote so a lock during the commit loses nothing. */
export async function saveAnonymous(key: CryptoKey, entry: AnonymousEntry): Promise<void> {
  const id = entry.activity.id;
  await db.put<Row>("anonymousActivity", { id, sealed: await sealText(key, BOUND(id), JSON.stringify(entry)) });
}

async function open(key: CryptoKey, row: Row): Promise<AnonymousEntry | null> {
  try {
    return JSON.parse(await openText(key, BOUND(row.id), row.sealed)) as AnonymousEntry;
  } catch {
    // Sealed under a vault key from before a reset: nothing can open it.
    return null;
  }
}

/** Every entry, opened, newest first. Empty while Weft is locked. */
export async function anonymousEntries(): Promise<AnonymousEntry[]> {
  let key: CryptoKey;
  try {
    key = await voterKey();
  } catch {
    return [];
  }
  const rows = await db.all<Row>("anonymousActivity");
  const entries = (await Promise.all(rows.map((r) => open(key, r)))).filter((e): e is AnonymousEntry => e !== null);
  return entries.sort((a, b) => b.activity.at - a.activity.at);
}

const asActivity = (e: AnonymousEntry): ActivityRecord => {
  const { receipt: _flag, ...rest } = e.activity;
  return e.receipt ? { ...rest, receipt: true } : rest;
};

/** The anonymous ballots as activity records, for the popup. Empty while locked. */
export async function anonymousActivity(): Promise<ActivityRecord[]> {
  return (await anonymousEntries()).map(asActivity);
}

export async function anonymousEntry(id: string): Promise<AnonymousEntry | null> {
  const row = await db.get<Row>("anonymousActivity", id);
  if (!row) return null;
  return open(await voterKey(), row);
}

export async function anonymousItem(id: string): Promise<ActivityRecord | null> {
  const row = await db.get<Row>("anonymousActivity", id);
  if (!row) return null;
  let key: CryptoKey;
  try {
    key = await voterKey();
  } catch {
    return null;
  }
  const entry = await open(key, row);
  return entry ? asActivity(entry) : null;
}

/** The kept receipt of an anonymous ballot, as the popup shows it. Null when none is kept. Throws while locked. */
export async function anonymousReceiptView(id: string): Promise<ReceiptView | null> {
  const entry = await anonymousEntry(id);
  if (!entry?.receipt) return null;
  const r = entry.receipt;
  const credentialId = entry.activity.anonymous?.credentialId;
  const credential = credentialId ? await db.get<VoterCredentialRecord>("voterCredentials", credentialId) : undefined;
  const explorerUrl = credential?.invite.explorerUrl;
  return {
    id,
    origin: entry.activity.origin,
    keptAt: r.keptAt,
    receipt: { type: RECEIPT_TYPE, version: 2, channel: r.channel, electionId: r.electionId, txId: r.txId, blockNumber: r.blockNumber, tracking: r.tracking },
    choice: r.option,
    ...(explorerUrl ? { explorerUrl } : {}),
  };
}

/** Removes the kept receipt, and the note with it, and keeps the rest of the entry sealed. */
export async function removeAnonymousReceipt(id: string): Promise<boolean> {
  const entry = await anonymousEntry(id);
  if (!entry) return false;
  await saveAnonymous(await voterKey(), { ...entry, receipt: null });
  return true;
}

/** This credential's committed ballot in this election, from the sealed activity. */
export function votedWith(entries: AnonymousEntry[], credentialId: string, electionId: string): { blockNumber: string | null } | null {
  const found = entries.find(
    (e) => e.activity.anonymous?.credentialId === credentialId && e.activity.status === "committed" && e.activity.call.fn === "CastAnonymousBallot" && e.activity.call.args?.[0] === electionId,
  );
  return found ? { blockNumber: found.activity.blockNumber ?? null } : null;
}
