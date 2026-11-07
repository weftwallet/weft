/**
 * Kept ballot receipts (docs/adr/0006). The worker writes one when a vote
 * commits and the user turned on "Keep the receipt in Weft"; the popup reads
 * it back while Weft is unlocked. No provider method reads receipts: a site
 * never gets a kept receipt back.
 */

import { RECEIPT_TYPE, type BallotReceipt, type BallotReceiptV2 } from "@weftwallet/protocol";
import { db, type ActivityRecord, type IdentityRecord, type NetworkRecord, type ReceiptRecord, type ReceiptRecordV2 } from "./db";
import { EXPERIMENTAL } from "./experimental";
import * as vault from "./vault";

/** A kept receipt as the popup shows it, with its choice and salt opened. */
export type ReceiptView = {
  id: string;
  origin: string;
  keptAt: number;
  /** The network's explorer, from its invite, for Check in the explorer. */
  explorerUrl?: string;
} & (
  | { receipt: BallotReceipt }
  /** Weft Experimental (docs/adr/0007): a version 2 receipt, with the voter's note of the choice opened. */
  | { receipt: BallotReceiptV2; choice: string }
);

/** The record for a receipt whose secret was sealed when the user signed. */
export function receiptRecord(
  activity: Pick<ActivityRecord, "id" | "identityId" | "origin">,
  receipt: BallotReceipt,
  sealed: ReceiptRecord["sealed"],
): ReceiptRecord {
  return {
    id: activity.id,
    identityId: activity.identityId,
    origin: activity.origin,
    type: RECEIPT_TYPE,
    version: 1,
    channel: receipt.channel,
    electionId: receipt.electionId,
    txId: receipt.txId,
    blockNumber: receipt.blockNumber,
    commitment: receipt.commitment,
    sealed,
    keptAt: Date.now(),
  };
}

/** The receipt kept for a transaction, opened. Null when there is none. Throws when Weft is locked. */
export async function receiptView(id: string): Promise<ReceiptView | null> {
  const record = await db.get<ReceiptRecord | ReceiptRecordV2>("receipts", id);
  if (!record) return null;
  const identity = await db.get<IdentityRecord>("identities", record.identityId);
  const network = identity ? await db.get<NetworkRecord>("networks", identity.networkId) : undefined;
  if (record.version === 2) {
    if (!EXPERIMENTAL) return null;
    const note = JSON.parse(new TextDecoder().decode(await vault.openReceipt(id, record.sealed))) as { option: string };
    return {
      id,
      origin: record.origin,
      keptAt: record.keptAt,
      receipt: {
        type: RECEIPT_TYPE,
        version: 2,
        channel: record.channel,
        electionId: record.electionId,
        txId: record.txId,
        blockNumber: record.blockNumber,
        tracking: record.tracking,
      },
      choice: note.option,
      ...(network?.explorerUrl ? { explorerUrl: network.explorerUrl } : {}),
    };
  }
  const secret = JSON.parse(new TextDecoder().decode(await vault.openReceipt(id, record.sealed))) as { option: string; salt: string };
  return {
    id,
    origin: record.origin,
    keptAt: record.keptAt,
    receipt: {
      type: RECEIPT_TYPE,
      version: 1,
      channel: record.channel,
      electionId: record.electionId,
      txId: record.txId,
      blockNumber: record.blockNumber,
      commitment: record.commitment,
      option: secret.option,
      salt: secret.salt,
    },
    ...(network?.explorerUrl ? { explorerUrl: network.explorerUrl } : {}),
  };
}

/** How many receipts an identity's activity keeps, and for which elections, for the removal sheet. */
export async function receiptsOf(identityId: string): Promise<{ count: number; elections: string[] }> {
  const records = await db.receiptsOf(identityId);
  return { count: records.length, elections: [...new Set(records.map((r) => r.electionId))] };
}

export async function removeReceipt(id: string): Promise<void> {
  await db.removeReceipts([id]);
}

/** Called when the identity is removed: its receipts go with it. */
export async function removeReceiptsOf(identityId: string): Promise<void> {
  await db.removeReceipts((await db.receiptsOf(identityId)).map((r) => r.id));
}
