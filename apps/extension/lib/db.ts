/**
 * IndexedDB storage for the background worker.
 *
 * Private keys are stored as non-extractable CryptoKey objects: IndexedDB's
 * structured clone keeps them opaque, so nothing here can ever read key
 * material back out (docs/adr/0002).
 */

import type { ContractCall } from "@weftwallet/protocol";

export interface NetworkRecord {
  id: string;
  name: string;
  organization: string;
  mspId: string;
  caUrl: string;
  caName?: string;
  relayUrl: string;
  channels: string[];
}

export interface IdentityRecord {
  id: string;
  networkId: string;
  mspId: string;
  certificate: string;
  privateKey: CryptoKey;
  /** The enrollment ID used with the CA, needed for re-enrolment. */
  enrollmentId: string | null;
  createdAt: number;
}

/** A key pair waiting for the CA administrator to return a certificate. */
export interface PendingCsrRecord {
  id: string;
  networkId: string;
  commonName: string;
  csr: string;
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  createdAt: number;
}

export interface SiteRecord {
  origin: string;
  connectedAt: number;
}

export type ActivityStatus = "committed" | "evaluated" | "failed" | "rejected";

export interface ActivityRecord {
  id: string;
  at: number;
  origin: string;
  identityId: string;
  kind: "evaluate" | "submit";
  call: ContractCall;
  status: ActivityStatus;
  transactionId?: string;
  blockNumber?: string;
  /** Fabric code, e.g. "VALID", "MVCC_READ_CONFLICT", "ENDORSE_FAILED". */
  code?: string;
  title?: string;
  detail?: string;
  /** Per-organisation endorsement errors, when the network returned them. */
  endorsers?: { mspId?: string; address?: string; message: string }[];
}

export interface Settings {
  activeIdentityId: string | null;
  activeChannel: string | null;
}

const DB_NAME = "weft";
const DB_VERSION = 1;
const STORES = ["networks", "identities", "pendingCsrs", "sites", "activity", "settings"] as const;
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
  /** Most recent activity first. */
  async recentActivity(limit = 50): Promise<ActivityRecord[]> {
    const index = (await store("activity")).index("at");
    return new Promise((resolve, reject) => {
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
