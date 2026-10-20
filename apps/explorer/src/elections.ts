/**
 * Elections run with the ballot contract (examples/ballot-contract; docs/adr/0004,
 * phase 4), read back from the indexed transactions. Nothing here is secret:
 * the ledger holds commitments and the published tally, never ballots.
 */

import { createHash } from "node:crypto";
import type { TransactionRow } from "./db.ts";

export interface ElectionView {
  id: string;
  title: string;
  options: string[];
  closesAt: string;
  creatorMsp: string;
  state: "open" | "closed";
  tally: { counts: Record<string, number>; total: number } | null;
  /** Commitments in valid transactions. */
  commitments: number;
  /** Whether the published total matches the commitments counted here. */
  tallyMatches: boolean | null;
  createdIn: { txId: string; blockNumber: number } | null;
  closedIn: { txId: string; blockNumber: number } | null;
}

export interface ReceiptCheck {
  found: boolean;
  /** The transaction is in a block and the network accepted it. */
  valid: boolean;
  validation: string | null;
  blockNumber: number | null;
  timestamp: number | null;
  /** The commitment the ledger holds for this transaction. */
  commitment: string | null;
  electionId: string | null;
}

/** Fabric composite keys: \0type\0attr1\0attr2\0 */
export function splitKey(key: string): { type: string; attrs: string[] } | null {
  if (!key.startsWith("\u0000") || !key.endsWith("\u0000")) return null;
  const parts = key.slice(1, -1).split("\u0000");
  return { type: parts[0]!, attrs: parts.slice(1) };
}

function text(value: { text?: string } | null): string | null {
  return value && typeof value.text === "string" ? value.text : null;
}

/** All elections a channel's ballot contract has, oldest first. `rows` are that contract's transactions. */
export function elections(rows: TransactionRow[]): ElectionView[] {
  const byId = new Map<string, ElectionView>();
  const commitments = new Map<string, number>();
  const ordered = [...rows].sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index);
  for (const tx of ordered) {
    if (tx.validation !== "VALID" || tx.redacted) continue;
    for (const w of tx.writes) {
      const key = splitKey(w.key);
      if (!key) continue;
      if (key.type === "election" && key.attrs[0]) {
        try {
          const e = JSON.parse(text(w.value) ?? "") as Omit<ElectionView, "commitments" | "tallyMatches" | "createdIn" | "closedIn">;
          const before = byId.get(key.attrs[0]);
          byId.set(key.attrs[0], {
            id: e.id,
            title: e.title,
            options: e.options,
            closesAt: e.closesAt,
            creatorMsp: e.creatorMsp,
            state: e.state,
            tally: e.tally ?? null,
            commitments: 0,
            tallyMatches: null,
            createdIn: before?.createdIn ?? { txId: tx.txId, blockNumber: tx.blockNumber },
            closedIn: e.state === "closed" ? { txId: tx.txId, blockNumber: tx.blockNumber } : null,
          });
        } catch {
          /* not the ballot contract's shape */
        }
      }
      if (key.type === "commitment" && key.attrs[0]) commitments.set(key.attrs[0], (commitments.get(key.attrs[0]) ?? 0) + 1);
    }
  }
  return [...byId.values()].map((e) => {
    const count = commitments.get(e.id) ?? 0;
    return { ...e, commitments: count, tallyMatches: e.tally ? e.tally.total === count : null };
  });
}

/** Looks up one receipt's transaction. The voter's choice and salt never reach the server. */
export function checkReceipt(electionId: string, tx: TransactionRow | null): ReceiptCheck {
  const empty: ReceiptCheck = { found: false, valid: false, validation: null, blockNumber: null, timestamp: null, commitment: null, electionId: null };
  if (!tx || tx.redacted) return empty;
  const write = tx.writes.find((w) => {
    const key = splitKey(w.key);
    return key?.type === "commitment" && key.attrs[0] === electionId && key.attrs[1] === tx.txId;
  });
  if (!write) return { ...empty, found: true, validation: tx.validation, blockNumber: tx.blockNumber, timestamp: tx.timestamp };
  let commitment: string | null = null;
  try {
    commitment = (JSON.parse(text(write.value) ?? "") as { commitment?: string }).commitment ?? null;
  } catch {
    commitment = null;
  }
  return {
    found: true,
    valid: tx.validation === "VALID",
    validation: tx.validation,
    blockNumber: tx.blockNumber,
    timestamp: tx.timestamp,
    commitment,
    electionId,
  };
}

/** The same formula as the contract's commitmentFor. */
export function commitmentFor(electionId: string, option: string, salt: string): string {
  return createHash("sha256").update(`${electionId}\n${option}\n${salt}`, "utf8").digest("hex");
}
