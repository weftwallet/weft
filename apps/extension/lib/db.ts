/**
 * IndexedDB storage for the background worker.
 *
 * Private keys are stored encrypted with the vault key (docs/adr/0005).
 * Records saved before the lock hold a non-extractable CryptoKey instead
 * (docs/adr/0002), which still works but isn't encrypted at rest. A kept
 * ballot receipt's choice and salt are encrypted with a key derived from the
 * vault key (docs/adr/0006).
 */

import type { Sealed, WrappedKey } from "@weftwallet/core";
import type { ContractCall, RECEIPT_TYPE } from "@weftwallet/protocol";

export interface NetworkRecord {
  id: string;
  name: string;
  organization: string;
  mspId: string;
  caUrl: string;
  caName?: string;
  relayUrl: string;
  channels: string[];
  /** The organisation's explorer, from the invite. Activity links to it. */
  explorerUrl?: string;
  /** Where the invite came from, for "Refresh from invite". */
  inviteUrl?: string;
}

export interface IdentityRecord {
  id: string;
  networkId: string;
  mspId: string;
  certificate: string;
  /** The private key, encrypted with the vault key. */
  wrappedKey?: WrappedKey;
  /** Legacy: a non-extractable key saved before the lock. */
  privateKey?: CryptoKey;
  /** The enrollment ID used with the CA, needed for re-enrolment. */
  enrollmentId: string | null;
  createdAt: number;
  /**
   * Weft Experimental only: the PEM CA chain Fabric CA returned when this
   * identity was enrolled or re-enrolled, for checking a peer's signature on
   * a private election it reads (docs/adr/0007). Absent for imported
   * identities, CSRs, identities enrolled before it was kept, and every
   * identity in Weft.
   */
  caChain?: string;
}

/** A key pair waiting for the CA administrator to return a certificate. */
export interface PendingCsrRecord {
  id: string;
  networkId: string;
  commonName: string;
  csr: string;
  wrappedKey?: WrappedKey;
  /** Legacy, as on IdentityRecord. */
  privateKey?: CryptoKey;
  publicKey: CryptoKey;
  createdAt: number;
}

export interface SiteRecord {
  origin: string;
  connectedAt: number;
  /** Identities the user has approved for this site. Missing on records from before 0.1. */
  identityIds?: string[];
}

export type ActivityStatus = "committed" | "evaluated" | "failed" | "rejected";

export interface ActivityRecord {
  id: string;
  at: number;
  origin: string;
  identityId: string;
  kind: "evaluate" | "submit";
  /** The call as approved, without private input values. */
  call: ContractCall;
  /** Names of the call's private (transient) inputs. Their values aren't kept. */
  privateInputs?: string[];
  status: ActivityStatus;
  transactionId?: string;
  blockNumber?: string;
  /** Fabric code, for example "VALID", "MVCC_READ_CONFLICT", "ENDORSE_FAILED". */
  code?: string;
  title?: string;
  detail?: string;
  /** Per-organisation endorsement errors, when the network returned them. */
  endorsers?: { mspId?: string; address?: string; message: string }[];
  /** The network's own words about a failure, shown behind "Details". */
  raw?: string;
  /** True while a ballot receipt is kept for this transaction (the receipts store). */
  receipt?: true;
}

/**
 * A ballot receipt kept at the user's request (docs/adr/0006). Everything but
 * the choice and salt is public already, on the ledger or in the activity
 * record, so it stays readable while Weft is locked.
 */
export interface ReceiptRecord {
  /** The activity record's ID: one receipt per transaction. */
  id: string;
  /** Indexed, so removing the identity removes its receipts. */
  identityId: string;
  origin: string;
  type: typeof RECEIPT_TYPE;
  version: 1;
  channel: string;
  electionId: string;
  txId: string;
  blockNumber: number;
  commitment: string;
  /** { option, salt } as JSON, sealed with the receipt key, `id` as additional data. */
  sealed: Sealed;
  keptAt: number;
}

/**
 * Weft Experimental only: a kept version 2 receipt (docs/adr/0007). The
 * tracking code is public; the voter's note of the choice is sealed with the
 * receipt key, `id` as additional data, and proves nothing to anyone else.
 */
export interface ReceiptRecordV2 {
  id: string;
  identityId: string;
  origin: string;
  type: typeof RECEIPT_TYPE;
  version: 2;
  channel: string;
  electionId: string;
  txId: string;
  blockNumber: number;
  tracking: string;
  /** { option } as JSON. */
  sealed: Sealed;
  keptAt: number;
}

export interface Settings {
  activeIdentityId: string | null;
  activeChannel: string | null;
}

const DB_NAME = "weft";
// 2: the receipts store.
const DB_VERSION = 2;
const STORES = ["networks", "identities", "pendingCsrs", "sites", "activity", "settings", "receipts"] as const;
type StoreName = (typeof STORES)[number];

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of STORES) {
        if (db.objectStoreNames.contains(name)) continue;
        const keyPath = name === "sites" ? "origin" : name === "settings" ? "key" : "id";
        const store = db.createObjectStore(name, { keyPath });
        if (name === "activity") store.createIndex("at", "at");
        if (name === "receipts") store.createIndex("identityId", "identityId");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function store(name: StoreName, mode: IDBTransactionMode = "readonly"): Promise<IDBObjectStore> {
  return (await open()).transaction(name, mode).objectStore(name);
}

export const db = {
  async all<T>(name: StoreName): Promise<T[]> {
    return promisify((await store(name)).getAll()) as Promise<T[]>;
  },
  async get<T>(name: StoreName, key: string): Promise<T | undefined> {
    return promisify((await store(name)).get(key)) as Promise<T | undefined>;
  },
  async put<T>(name: StoreName, value: T): Promise<void> {
    await promisify((await store(name, "readwrite")).put(value));
  },
  async delete(name: StoreName, key: string): Promise<void> {
    await promisify((await store(name, "readwrite")).delete(key));
  },
  /**
   * Most recent activity first: the `limit` most recent, and every record
   * with a kept receipt however old, since a receipt is kept until removed.
   */
  async recentActivity(limit = 50): Promise<ActivityRecord[]> {
    const index = (await store("activity")).index("at");
    const recent = await new Promise<ActivityRecord[]>((resolve, reject) => {
      const out: ActivityRecord[] = [];
      const cursor = index.openCursor(null, "prev");
      cursor.onsuccess = () => {
        const c = cursor.result;
        if (!c || out.length >= limit) return resolve(out);
        out.push(c.value as ActivityRecord);
        c.continue();
      };
      cursor.onerror = () => reject(cursor.error);
    });
    const have = new Set(recent.map((a) => a.id));
    const kept = (await promisify((await store("receipts")).getAllKeys())) as string[];
    const older = await Promise.all(kept.filter((id) => !have.has(id)).map((id) => this.get<ActivityRecord>("activity", id)));
    const all = [...recent, ...older.filter((a): a is ActivityRecord => !!a)];
    return all.sort((a, b) => b.at - a.at);
  },
  /** The receipts kept for an identity's transactions. */
  async receiptsOf(identityId: string): Promise<(ReceiptRecord | ReceiptRecordV2)[]> {
    return promisify((await store("receipts")).index("identityId").getAll(identityId)) as Promise<(ReceiptRecord | ReceiptRecordV2)[]>;
  },
  /** Saves an activity record and its receipt together: both are written, or neither. */
  async putWithReceipt(activity: ActivityRecord, receipt: ReceiptRecord | ReceiptRecordV2): Promise<void> {
    const tx = (await open()).transaction(["activity", "receipts"], "readwrite");
    tx.objectStore("activity").put(activity);
    tx.objectStore("receipts").put(receipt);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(tx.error ?? new Error("The browser stopped the write."));
    });
  },
  /** Deletes receipts and clears their activity records' flag, together. */
  async removeReceipts(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const tx = (await open()).transaction(["activity", "receipts"], "readwrite");
    const activity = tx.objectStore("activity");
    for (const id of ids) {
      tx.objectStore("receipts").delete(id);
      const read = activity.get(id);
      read.onsuccess = () => {
        const record = read.result as ActivityRecord | undefined;
        if (!record?.receipt) return;
        const { receipt: _flag, ...rest } = record;
        activity.put(rest);
      };
    }
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(tx.error ?? new Error("The browser stopped the write."));
    });
  },
  async settings(): Promise<Settings> {
    const row = await this.get<Settings & { key: string }>("settings", "settings");
    return { activeIdentityId: row?.activeIdentityId ?? null, activeChannel: row?.activeChannel ?? null };
  },
  async saveSettings(patch: Partial<Settings>): Promise<Settings> {
    const next = { ...(await this.settings()), ...patch };
    await this.put("settings", { key: "settings", ...next });
    return next;
  },
};

export function newId(): string {
  return crypto.randomUUID();
}
