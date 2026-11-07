/**
 * The explorer's index, in SQLite (node:sqlite). It holds only what the
 * policy published, so the database can be served or backed up without
 * re-checking the policy.
 */

import { DatabaseSync } from "node:sqlite";
import type { PeerStatus } from "./checkpoints.ts";
import type { ChannelMember } from "./decode.ts";
import type { ConfigSummary } from "./channel-config.ts";
import type { PublishedBlock, PublishedTransaction } from "./policy.ts";

/** Bumped when the tables change; an older index is rebuilt from block 0. */
const SCHEMA = "5";

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

/**
 * Private elections (docs/adr/0007, private-elections.ts), indexed only when
 * the explorer runs with WEFT_EXPERIMENTAL=1 and a channel names
 * privateElections. Everything in them is published by the contract's design.
 */
export interface PrivateElectionRow {
  channel: string;
  id: string;
  /** The election record as the contract last wrote it, parsed. */
  record: Record<string, unknown>;
  state: string;
  /** The block of the transaction that created it, and of the one that last wrote its record. */
  firstBlock: number;
  lastBlock: number;
}

/** One step of a private election: a ceremony post, a close request, a decryption share and so on. */
export interface PrivateStepRow {
  channel: string;
  election: string;
  kind: "create" | "round1" | "round2" | "confirm" | "report" | "cancel" | "open" | "close" | "closed" | "dshare" | "publish";
  /** The trustee organisation it is for, or "" for a step that isn't a trustee's. */
  trustee: string;
  txId: string;
  block: number;
  index: number;
  timestamp: number | null;
  /** What the contract stored for it, parsed: the post itself, or null. */
  body: unknown;
  /** This explorer's own check of it, as it indexed the block: null when there is nothing to check. */
  verified: boolean | null;
  error: string | null;
}

export interface PrivateBallotRow {
  channel: string;
  election: string;
  txId: string;
  block: number;
  index: number;
  timestamp: number | null;
  tracking: string;
  /** 64 lowercase hex characters, published even when submitters are hidden. */
  voterTag: string;
  /** The ballot as the contract stored it, parsed. */
  ballot: Record<string, unknown>;
  /** This explorer's check of the ballot as it indexed the block. */
  verified: boolean;
  error: string | null;
  /** The submitter, only when the policy shows submitters: its MSP ID and id_bytes, base64. */
  creator: { mspId: string; idBytes: string } | null;
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
      this.db.exec(
        "DROP TABLE IF EXISTS blocks; DROP TABLE IF EXISTS transactions; DROP TABLE IF EXISTS pe_elections; DROP TABLE IF EXISTS pe_steps; DROP TABLE IF EXISTS pe_ballots; DROP TABLE IF EXISTS pe_ciphertexts; DELETE FROM meta;",
      );
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
      CREATE TABLE IF NOT EXISTS pe_elections (
        channel TEXT NOT NULL,
        id TEXT NOT NULL,
        record TEXT NOT NULL,
        state TEXT NOT NULL,
        first_block INTEGER NOT NULL,
        last_block INTEGER NOT NULL,
        PRIMARY KEY (channel, id)
      );
      CREATE TABLE IF NOT EXISTS pe_steps (
        channel TEXT NOT NULL,
        election TEXT NOT NULL,
        kind TEXT NOT NULL,
        trustee TEXT NOT NULL,
        tx_id TEXT NOT NULL,
        block_number INTEGER NOT NULL,
        idx INTEGER NOT NULL,
        timestamp INTEGER,
        body TEXT,
        verified INTEGER,
        error TEXT,
        PRIMARY KEY (channel, election, kind, trustee, tx_id)
      );
      CREATE TABLE IF NOT EXISTS pe_ballots (
        channel TEXT NOT NULL,
        election TEXT NOT NULL,
        tx_id TEXT NOT NULL,
        block_number INTEGER NOT NULL,
        idx INTEGER NOT NULL,
        timestamp INTEGER,
        tracking TEXT NOT NULL,
        voter_tag TEXT NOT NULL,
        ballot TEXT NOT NULL,
        verified INTEGER NOT NULL,
        error TEXT,
        creator_msp TEXT,
        creator_id TEXT,
        PRIMARY KEY (channel, election, tx_id)
      );
      CREATE INDEX IF NOT EXISTS pe_ballot_order ON pe_ballots (channel, election, block_number, idx);
      CREATE INDEX IF NOT EXISTS pe_ballot_tracking ON pe_ballots (channel, election, tracking);
      CREATE INDEX IF NOT EXISTS pe_ballot_tag ON pe_ballots (channel, election, voter_tag);
      CREATE TABLE IF NOT EXISTS pe_ciphertexts (
        channel TEXT NOT NULL,
        election TEXT NOT NULL,
        a TEXT NOT NULL,
        tx_id TEXT NOT NULL,
        PRIMARY KEY (channel, election, a, tx_id)
      );
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
    this.db.exec(
      "DELETE FROM blocks; DELETE FROM transactions; DELETE FROM pe_elections; DELETE FROM pe_steps; DELETE FROM pe_ballots; DELETE FROM pe_ciphertexts; DELETE FROM meta WHERE key LIKE 'members:%' OR key LIKE 'peers:%' OR key LIKE 'config:%';",
    );
    this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('policy', ?)").run(fingerprint);
    return row !== undefined;
  }

  /** A block's header hash, or null when it isn't indexed (yet). */
  blockHash(channel: string, number: number): string | null {
    const row = this.db.prepare("SELECT hash FROM blocks WHERE channel = ? AND number = ?").get(channel, number) as Row | undefined;
    return row ? (row.hash as string) : null;
  }

  /** What the other organisations' explorers last reported for a channel. */
  savePeerStatuses(channel: string, statuses: PeerStatus[]): void {
    this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(`peers:${channel}`, JSON.stringify(statuses));
  }

  peerStatuses(channel: string): PeerStatus[] {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(`peers:${channel}`) as Row | undefined;
    return row ? (JSON.parse(row.value as string) as PeerStatus[]) : [];
  }

  /** The channel's application organisations, from its latest config block. */
  setMembers(channel: string, members: ChannelMember[]): void {
    this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(`members:${channel}`, JSON.stringify(members));
  }

  /** The latest channel configuration indexed, summarised. */
  configSummary(channel: string): ConfigSummary | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(`config:${channel}`) as Row | undefined;
    return row ? (JSON.parse(row.value as string) as ConfigSummary) : null;
  }

  setConfigSummary(channel: string, summary: ConfigSummary): void {
    this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(`config:${channel}`, JSON.stringify(summary));
  }

  members(channel: string): ChannelMember[] {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(`members:${channel}`) as Row | undefined;
    return row ? (JSON.parse(row.value as string) as ChannelMember[]) : [];
  }

  close(): void {
    this.db.close();
  }

  /** Block headers from `from` to `to`, inclusive, oldest first. */
  headers(channel: string, from: number, to: number): { number: number; previousHash: string; dataHash: string; hash: string }[] {
    const rows = this.db
      .prepare("SELECT number, previous_hash, data_hash, hash FROM blocks WHERE channel = ? AND number BETWEEN ? AND ? ORDER BY number")
      .all(channel, from, to) as Row[];
    return rows.map((r) => ({ number: Number(r.number), previousHash: r.previous_hash as string, dataHash: r.data_hash as string, hash: r.hash as string }));
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
      /** From this block on, oldest first: the page after an older one. */
      after?: number;
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
    if (options.after !== undefined) (where.push("block_number >= ?"), params.push(options.after));
    const order = options.after !== undefined ? "block_number, idx" : "block_number DESC, idx DESC";
    const rows = this.db
      .prepare(`SELECT * FROM transactions WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ?`)
      .all(...params, options.limit ?? 20) as Row[];
    return rows.map(toTransaction);
  }

  /** Every transaction that called one contract on a channel, oldest first. */
  contractRows(channel: string, chaincode: string): TransactionRow[] {
    const rows = this.db
      .prepare("SELECT * FROM transactions WHERE channel = ? AND chaincode = ? ORDER BY block_number, idx")
      .all(channel, chaincode) as Row[];
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

  /* Private elections (private-elections.ts) ------------------------------ */

  privateElection(channel: string, id: string): PrivateElectionRow | null {
    const r = this.db.prepare("SELECT * FROM pe_elections WHERE channel = ? AND id = ?").get(channel, id) as Row | undefined;
    return r ? toPrivateElection(r) : null;
  }

  /** A channel's private elections, oldest first. */
  privateElections(channel: string): PrivateElectionRow[] {
    return (this.db.prepare("SELECT * FROM pe_elections WHERE channel = ? ORDER BY first_block, id").all(channel) as Row[]).map(toPrivateElection);
  }

  putPrivateElection(channel: string, id: string, record: Record<string, unknown>, block: number): void {
    this.db
      .prepare(
        `INSERT INTO pe_elections (channel, id, record, state, first_block, last_block) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (channel, id) DO UPDATE SET record = excluded.record, state = excluded.state, last_block = excluded.last_block`,
      )
      .run(channel, id, JSON.stringify(record), String(record.state ?? ""), block, block);
  }

  addPrivateStep(s: PrivateStepRow): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO pe_steps (channel, election, kind, trustee, tx_id, block_number, idx, timestamp, body, verified, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(s.channel, s.election, s.kind, s.trustee, s.txId, s.block, s.index, s.timestamp, s.body === null ? null : JSON.stringify(s.body), s.verified === null ? null : s.verified ? 1 : 0, s.error);
  }

  /** Every step of an election, in ledger order. */
  privateSteps(channel: string, election: string): PrivateStepRow[] {
    const rows = this.db.prepare("SELECT * FROM pe_steps WHERE channel = ? AND election = ? ORDER BY block_number, idx, kind").all(channel, election) as Row[];
    return rows.map((r) => ({
      channel: r.channel as string,
      election: r.election as string,
      kind: r.kind as PrivateStepRow["kind"],
      trustee: r.trustee as string,
      txId: r.tx_id as string,
      block: Number(r.block_number),
      index: Number(r.idx),
      timestamp: r.timestamp === null ? null : Number(r.timestamp),
      body: r.body === null ? null : JSON.parse(r.body as string),
      verified: r.verified === null ? null : r.verified === 1,
      error: (r.error as string | null) ?? null,
    }));
  }

  addPrivateBallot(b: PrivateBallotRow, ciphertexts: string[]): void {
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO pe_ballots (channel, election, tx_id, block_number, idx, timestamp, tracking, voter_tag, ballot, verified, error, creator_msp, creator_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(b.channel, b.election, b.txId, b.block, b.index, b.timestamp, b.tracking, b.voterTag, JSON.stringify(b.ballot), b.verified ? 1 : 0, b.error, b.creator?.mspId ?? null, b.creator?.idBytes ?? null);
      const insert = this.db.prepare("INSERT OR REPLACE INTO pe_ciphertexts (channel, election, a, tx_id) VALUES (?, ?, ?, ?)");
      for (const a of ciphertexts) insert.run(b.channel, b.election, a, b.txId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Whether another ballot of the election already has a ciphertext with this first component. */
  privateCiphertextSeen(channel: string, election: string, a: string, exceptTx: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM pe_ciphertexts WHERE channel = ? AND election = ? AND a = ? AND tx_id <> ? LIMIT 1").get(channel, election, a, exceptTx);
  }

  /** Whether another ballot of the election already has this voter tag. */
  privateTagSeen(channel: string, election: string, tag: string, exceptTx: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM pe_ballots WHERE channel = ? AND election = ? AND voter_tag = ? AND tx_id <> ? LIMIT 1").get(channel, election, tag, exceptTx);
  }

  /** An election's ballots in ledger order, or newest first, a page at a time. */
  privateBallots(channel: string, election: string, options: { offset?: number; limit?: number; newestFirst?: boolean } = {}): PrivateBallotRow[] {
    const order = options.newestFirst ? "block_number DESC, idx DESC" : "block_number, idx";
    const rows = this.db
      .prepare(`SELECT * FROM pe_ballots WHERE channel = ? AND election = ? ORDER BY ${order} LIMIT ? OFFSET ?`)
      .all(channel, election, options.limit ?? -1, options.offset ?? 0) as Row[];
    return rows.map(toPrivateBallot);
  }

  /**
   * A page of an election's ballots for the page's table, newest first,
   * older than `before` (a block and a position in it) when given, or newer
   * than `after`, oldest first, for the link to the newer page.
   */
  privateBallotPage(channel: string, election: string, options: { before?: [number, number]; after?: [number, number]; limit: number }): PrivateBallotRow[] {
    if (options.after) {
      const [b, i] = options.after;
      const rows = this.db
        .prepare("SELECT * FROM pe_ballots WHERE channel = ? AND election = ? AND (block_number > ? OR (block_number = ? AND idx > ?)) ORDER BY block_number, idx LIMIT ?")
        .all(channel, election, b, b, i, options.limit) as Row[];
      return rows.map(toPrivateBallot);
    }
    const [b, i] = options.before ?? [Number.MAX_SAFE_INTEGER, 0];
    const rows = this.db
      .prepare("SELECT * FROM pe_ballots WHERE channel = ? AND election = ? AND (block_number < ? OR (block_number = ? AND idx < ?)) ORDER BY block_number DESC, idx DESC LIMIT ?")
      .all(channel, election, b, b, i, options.limit) as Row[];
    return rows.map(toPrivateBallot);
  }

  /** How many ballots an election has, and how many failed this explorer's check. */
  privateBallotCount(channel: string, election: string): { total: number; failed: number } {
    const r = this.db
      .prepare("SELECT COUNT(*) AS n, SUM(CASE WHEN verified = 0 THEN 1 ELSE 0 END) AS bad FROM pe_ballots WHERE channel = ? AND election = ?")
      .get(channel, election) as Row;
    return { total: Number(r.n ?? 0), failed: Number(r.bad ?? 0) };
  }

  /** A ballot by its tracking code, or by its transaction ID. */
  privateBallot(channel: string, election: string, code: string): PrivateBallotRow | null {
    const r = (this.db.prepare("SELECT * FROM pe_ballots WHERE channel = ? AND election = ? AND tracking = ? ORDER BY block_number LIMIT 1").get(channel, election, code) ??
      this.db.prepare("SELECT * FROM pe_ballots WHERE channel = ? AND election = ? AND tx_id = ? LIMIT 1").get(channel, election, code)) as Row | undefined;
    return r ? toPrivateBallot(r) : null;
  }

  /** How many of an election's ballots are newer than this one, for the page of the ballots table it is on. */
  privateBallotsNewer(channel: string, election: string, b: { block: number; index: number }): number {
    const r = this.db
      .prepare("SELECT COUNT(*) AS n FROM pe_ballots WHERE channel = ? AND election = ? AND (block_number > ? OR (block_number = ? AND idx > ?))")
      .get(channel, election, b.block, b.block, b.index) as Row;
    return Number(r.n ?? 0);
  }
}

function toPrivateElection(r: Row): PrivateElectionRow {
  return {
    channel: r.channel as string,
    id: r.id as string,
    record: JSON.parse(r.record as string) as Record<string, unknown>,
    state: r.state as string,
    firstBlock: Number(r.first_block),
    lastBlock: Number(r.last_block),
  };
}

function toPrivateBallot(r: Row): PrivateBallotRow {
  return {
    channel: r.channel as string,
    election: r.election as string,
    txId: r.tx_id as string,
    block: Number(r.block_number),
    index: Number(r.idx),
    timestamp: r.timestamp === null ? null : Number(r.timestamp),
    tracking: r.tracking as string,
    voterTag: r.voter_tag as string,
    ballot: JSON.parse(r.ballot as string) as Record<string, unknown>,
    verified: r.verified === 1,
    error: (r.error as string | null) ?? null,
    creator: r.creator_msp ? { mspId: r.creator_msp as string, idBytes: r.creator_id as string } : null,
  };
}
