/**
 * The explorer's index, in SQLite (node:sqlite). It holds only what the
 * policy published, so the database can be served or backed up without
 * re-checking the policy.
 */

import { DatabaseSync } from "node:sqlite";
import type { ChannelMember } from "./decode.ts";
import type { PublishedBlock, PublishedTransaction } from "./policy.ts";

/** Bumped when the tables change; an older index is rebuilt from block 0. */
const SCHEMA = "2";

export interface BlockRow {
  channel: string;
  number: number;
  hash: string;
  previousHash: string;
  dataHash: string;
  dataHashValid: boolean;
  /** Whether previousHash matches the stored hash of the block before. null for block 0. */
  linked: boolean | null;
  timestamp: number | null;
  txCount: number;
  validCount: number;
}

export interface TransactionRow extends PublishedTransaction {
  channel: string;
  blockNumber: number;
}

export interface ChannelSummary {
  channel: string;
  height: number;
  transactions: number;
  lastBlockAt: number | null;
  /** Blocks whose previous hash doesn't match the block before them. */
  brokenLinks: number;
  badDataHashes: number;
}

type Row = Record<string, unknown>;

function toBlock(r: Row): BlockRow {
  return {
    channel: r.channel as string,
    number: Number(r.number),
    hash: r.hash as string,
    previousHash: r.previous_hash as string,
    dataHash: r.data_hash as string,
    dataHashValid: r.data_hash_valid === 1,
    linked: r.linked === null ? null : r.linked === 1,
    timestamp: r.timestamp === null ? null : Number(r.timestamp),
    txCount: Number(r.tx_count),
    validCount: Number(r.valid_count),
  };
}

function toTransaction(r: Row): TransactionRow {
  return { ...(JSON.parse(r.body as string) as PublishedTransaction), channel: r.channel as string, blockNumber: Number(r.block_number) };
}

export class ExplorerDb {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
    const schema = this.db.prepare("SELECT value FROM meta WHERE key = 'schema'").get() as Row | undefined;
    if (schema?.value !== SCHEMA) {
      this.db.exec("DROP TABLE IF EXISTS blocks; DROP TABLE IF EXISTS transactions; DELETE FROM meta;");
      this.db.prepare("INSERT INTO meta (key, value) VALUES ('schema', ?)").run(SCHEMA);
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS blocks (
        channel TEXT NOT NULL,
        number INTEGER NOT NULL,
        hash TEXT NOT NULL,
        previous_hash TEXT NOT NULL,
        data_hash TEXT NOT NULL,
        data_hash_valid INTEGER NOT NULL,
        linked INTEGER,
        timestamp INTEGER,
        tx_count INTEGER NOT NULL,
        valid_count INTEGER NOT NULL,
        PRIMARY KEY (channel, number)
      );
      CREATE TABLE IF NOT EXISTS transactions (
        channel TEXT NOT NULL,
        tx_id TEXT NOT NULL,
        block_number INTEGER NOT NULL,
        idx INTEGER NOT NULL,
        timestamp INTEGER,
        chaincode TEXT,
        creator_msp TEXT,
        creator_name TEXT,
        level TEXT NOT NULL,
        validation TEXT NOT NULL,
        body TEXT NOT NULL,
        PRIMARY KEY (channel, block_number, idx)
      );
      CREATE INDEX IF NOT EXISTS tx_id ON transactions (tx_id);
      CREATE INDEX IF NOT EXISTS tx_chaincode ON transactions (channel, chaincode, block_number);
      CREATE INDEX IF NOT EXISTS tx_creator ON transactions (channel, creator_msp, creator_name, block_number);
    `);
  }

  /**
   * The index holds only what a policy published. When the policy changes,
   * clear it so every block is indexed again under the new one. Returns
   * whether it was cleared.
   */
  usePolicy(fingerprint: string): boolean {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'policy'").get() as Row | undefined;
    if (row?.value === fingerprint) return false;
    this.db.exec("DELETE FROM blocks; DELETE FROM transactions; DELETE FROM meta WHERE key LIKE 'members:%';");
    this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('policy', ?)").run(fingerprint);
    return row !== undefined;
  }

  /** The channel's application organisations, from its latest config block. */
  setMembers(channel: string, members: ChannelMember[]): void {
    this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(`members:${channel}`, JSON.stringify(members));
  }

  members(channel: string): ChannelMember[] {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(`members:${channel}`) as Row | undefined;
    return row ? (JSON.parse(row.value as string) as ChannelMember[]) : [];
  }

  close(): void {
    this.db.close();
  }

  /** The next block number to fetch for a channel. */
  nextBlock(channel: string): number {
    const row = this.db.prepare("SELECT MAX(number) AS n FROM blocks WHERE channel = ?").get(channel) as Row | undefined;
    return row?.n === null || row?.n === undefined ? 0 : Number(row.n) + 1;
  }

  addBlock(block: PublishedBlock): void {
    const before = this.db.prepare("SELECT hash FROM blocks WHERE channel = ? AND number = ?").get(block.channel, block.number - 1) as
      | Row
      | undefined;
    const linked = block.number === 0 ? null : before ? before.hash === block.previousHash : null;
    const insertTx = this.db.prepare(
      `INSERT OR REPLACE INTO transactions (channel, tx_id, block_number, idx, timestamp, chaincode, creator_msp, creator_name, level, validation, body)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO blocks (channel, number, hash, previous_hash, data_hash, data_hash_valid, linked, timestamp, tx_count, valid_count)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          block.channel,
          block.number,
          block.hash,
          block.previousHash,
          block.dataHash,
          block.dataHashValid ? 1 : 0,
          linked === null ? null : linked ? 1 : 0,
          block.timestamp,
          block.transactions.length,
          block.transactions.filter((t) => t.validation === "VALID").length,
        );
      for (const tx of block.transactions) {
        insertTx.run(
          block.channel,
          tx.txId,
          block.number,
          tx.index,
          tx.timestamp,
          tx.chaincode,
          tx.creator?.mspId ?? null,
          tx.creator?.name ?? null,
          tx.level,
          tx.validation,
          JSON.stringify(tx),
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  channels(names: string[]): ChannelSummary[] {
    return names.map((channel) => {
      const b = this.db
        .prepare(
          `SELECT COUNT(*) AS blocks, MAX(number) AS top, SUM(tx_count) AS txs, MAX(timestamp) AS last,
                  SUM(CASE WHEN linked = 0 THEN 1 ELSE 0 END) AS broken,
                  SUM(CASE WHEN data_hash_valid = 0 THEN 1 ELSE 0 END) AS bad
           FROM blocks WHERE channel = ?`,
        )
        .get(channel) as Row;
      return {
        channel,
        height: b.top === null ? 0 : Number(b.top) + 1,
        transactions: Number(b.txs ?? 0),
        lastBlockAt: b.last === null ? null : Number(b.last),
        brokenLinks: Number(b.broken ?? 0),
        badDataHashes: Number(b.bad ?? 0),
      };
    });
  }

  blocks(channel: string, options: { before?: number; limit?: number } = {}): BlockRow[] {
    const rows = this.db
      .prepare("SELECT * FROM blocks WHERE channel = ? AND number < ? ORDER BY number DESC LIMIT ?")
      .all(channel, options.before ?? Number.MAX_SAFE_INTEGER, options.limit ?? 20) as Row[];
    return rows.map(toBlock);
  }

  block(channel: string, number: number): { block: BlockRow; transactions: TransactionRow[] } | null {
    const row = this.db.prepare("SELECT * FROM blocks WHERE channel = ? AND number = ?").get(channel, number) as Row | undefined;
    if (!row) return null;
    const txs = this.db
      .prepare("SELECT * FROM transactions WHERE channel = ? AND block_number = ? ORDER BY idx")
      .all(channel, number) as Row[];
    return { block: toBlock(row), transactions: txs.map(toTransaction) };
  }

  transaction(channel: string, txId: string): TransactionRow | null {
    const row = this.db
      .prepare("SELECT * FROM transactions WHERE channel = ? AND tx_id = ? ORDER BY block_number LIMIT 1")
      .get(channel, txId) as Row | undefined;
    return row ? toTransaction(row) : null;
  }

  /** Recent transactions, optionally for one contract or one organisation. */
  transactions(
    channels: string[],
    options: {
      channel?: string;
      chaincode?: string;
      mspId?: string;
      creatorName?: string;
      /** Leave out members-level rows, for filters a non-member mustn't be able to probe. */
      publicOnly?: boolean;
      before?: number;
      limit?: number;
    } = {},
  ): TransactionRow[] {
    const where = [`channel IN (${channels.map(() => "?").join(",") || "''"})`];
    const params: (string | number)[] = [...channels];
    if (options.channel) (where.push("channel = ?"), params.push(options.channel));
    if (options.chaincode) (where.push("chaincode = ?"), params.push(options.chaincode));
    if (options.mspId) (where.push("creator_msp = ?"), params.push(options.mspId));
    if (options.creatorName) (where.push("creator_name = ?"), params.push(options.creatorName));
    if (options.publicOnly) where.push("level = 'public'");
    if (options.before !== undefined) (where.push("block_number < ?"), params.push(options.before));
    const rows = this.db
      .prepare(`SELECT * FROM transactions WHERE ${where.join(" AND ")} ORDER BY block_number DESC, idx DESC LIMIT ?`)
      .all(...params, options.limit ?? 20) as Row[];
    return rows.map(toTransaction);
  }

  /** Transactions whose ID starts with `prefix`, across published channels. */
  findTransactions(channels: string[], prefix: string, limit = 10): TransactionRow[] {
    if (channels.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT * FROM transactions WHERE channel IN (${channels.map(() => "?").join(",")}) AND tx_id >= ? AND tx_id < ? ORDER BY tx_id LIMIT ?`,
      )
      .all(...channels, prefix, `${prefix}￿`, limit) as Row[];
    return rows.map(toTransaction);
  }

  /** Contracts with published transactions on a channel, busiest first. Members-level ones only for members. */
  contracts(channel: string, member = false): { chaincode: string; transactions: number; lastBlock: number }[] {
    const rows = this.db
      .prepare(
        `SELECT chaincode, COUNT(*) AS n, MAX(block_number) AS last FROM transactions
         WHERE channel = ? AND chaincode IS NOT NULL ${member ? "" : "AND level = 'public'"} GROUP BY chaincode ORDER BY n DESC`,
      )
      .all(channel) as Row[];
    return rows.map((r) => ({ chaincode: r.chaincode as string, transactions: Number(r.n), lastBlock: Number(r.last) }));
  }
}
