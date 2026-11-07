/**
 * What this organisation publishes (docs/adr/0004). Everything starts
 * hidden; the operator turns channels and contracts on in a policy file.
 *
 *   organisation: Org1
 *   channels:
 *     mychannel:
 *       level: public          # public | members | hidden
 *       values: show           # show | hash: arguments and written values as SHA-256 only
 *       submitter: show        # show | hide: who submitted each transaction
 *       contracts:             # contracts not listed take the channel's level
 *         basic: public
 *         private-thing: hidden
 *       elections: ballot      # optional: the ballot contract, for election pages
 *       privateData: names     # names | hashes: private data collections by name and
 *                              # count only, or with each key's and value's SHA-256
 *       privateElections: private-ballot
 *                              # experimental, needs WEFT_EXPERIMENTAL=1: the
 *                              # private-ballot contract (docs/adr/0007). Parsed
 *                              # only; private election pages aren't built yet.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import type { ConfigSummary } from "./channel-config.ts";
import type { DecodedBlock, DecodedTransaction, Party, PrivateDataSet } from "./decode.ts";

export type Level = "public" | "members" | "hidden";
const LEVELS: Level[] = ["public", "members", "hidden"];

export interface ChannelPolicy {
  level: Level;
  values: "show" | "hash";
  submitter: "show" | "hide";
  contracts: Record<string, Level>;
  /** The ballot contract on this channel (examples/ballot-contract), whose elections the explorer shows. */
  elections?: string;
  /**
   * Experimental (docs/adr/0009): the private-ballot contract on this channel
   * (examples/private-ballot-contract). Allowed only when the explorer is
   * started with WEFT_EXPERIMENTAL=1 (config.ts). Nothing reads it yet.
   */
  privateElections?: string;
  /**
   * Private data collections are always named, with how many keys a
   * transaction read and wrote. "hashes" also publishes each key's and value's
   * SHA-256, which lets anyone holding a value prove it's the one recorded,
   * but also lets anyone guess a value that has few possibilities.
   */
  privateData: "names" | "hashes";
}

export interface Policy {
  organisation: string | null;
  channels: Record<string, ChannelPolicy>;
}

function level(value: unknown, where: string): Level {
  if (value === undefined) return "hidden";
  if (typeof value === "string" && (LEVELS as string[]).includes(value)) return value as Level;
  throw new Error(`${where} must be one of ${LEVELS.join(", ")}.`);
}

export function parsePolicy(source: unknown): Policy {
  const root = (source ?? {}) as { organisation?: unknown; channels?: unknown };
  if (typeof root !== "object" || Array.isArray(root)) throw new Error("The policy must be a mapping.");
  const channels: Record<string, ChannelPolicy> = {};
  for (const [name, raw] of Object.entries((root.channels ?? {}) as Record<string, unknown>)) {
    const c = (raw ?? {}) as Record<string, unknown>;
    const values = c.values ?? "show";
    const submitter = c.submitter ?? "show";
    if (values !== "show" && values !== "hash") throw new Error(`channels.${name}.values must be show or hash.`);
    const privateData = c.privateData ?? "names";
    if (privateData !== "names" && privateData !== "hashes") throw new Error(`channels.${name}.privateData must be names or hashes.`);
    if (submitter !== "show" && submitter !== "hide") throw new Error(`channels.${name}.submitter must be show or hide.`);
    const contracts: Record<string, Level> = {};
    for (const [contract, l] of Object.entries((c.contracts ?? {}) as Record<string, unknown>)) {
      contracts[contract] = level(l, `channels.${name}.contracts.${contract}`);
    }
    if (c.elections !== undefined && (typeof c.elections !== "string" || !c.elections)) {
      throw new Error(`channels.${name}.elections must be the ballot contract's name.`);
    }
    if (c.privateElections !== undefined && (typeof c.privateElections !== "string" || !c.privateElections)) {
      throw new Error(`channels.${name}.privateElections must be the private-ballot contract's name.`);
    }
    channels[name] = {
      level: level(c.level, `channels.${name}.level`),
      values,
      submitter,
      privateData,
      contracts,
      ...(typeof c.elections === "string" ? { elections: c.elections } : {}),
      ...(typeof c.privateElections === "string" ? { privateElections: c.privateElections } : {}),
    };
  }
  return { organisation: typeof root.organisation === "string" ? root.organisation : null, channels };
}

/** Changes whenever what the policy publishes changes. */
export function policyFingerprint(policy: Policy): string {
  const sorted = Object.keys(policy.channels)
    .sort()
    .map((name) => {
      const c = policy.channels[name]!;
      const entry: unknown[] = [name, c.level, c.values, c.submitter, Object.entries(c.contracts).sort(), c.elections ?? null, c.privateData];
      // Added only when set, so every policy without it keeps its fingerprint.
      if (c.privateElections) entry.push({ privateElections: c.privateElections });
      return entry;
    });
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}

export function loadPolicy(path: string): Policy {
  return parsePolicy(parse(readFileSync(path, "utf8")));
}

/** Channels the explorer indexes: everything not hidden. */
export function publishedChannels(policy: Policy): string[] {
  return Object.entries(policy.channels)
    .filter(([, c]) => c.level !== "hidden")
    .map(([name]) => name);
}

export function channelLevel(policy: Policy, channel: string): Level {
  return policy.channels[channel]?.level ?? "hidden";
}

const OPENNESS: Record<Level, number> = { hidden: 0, members: 1, public: 2 };

/** A contract is never more open than its channel. */
export function contractLevel(policy: Policy, channel: string, contract: string | null): Level {
  const c = policy.channels[channel];
  if (!c || c.level === "hidden") return "hidden";
  if (contract === null) return c.level;
  const own = c.contracts[contract] ?? c.level;
  return OPENNESS[own] < OPENNESS[c.level] ? own : c.level;
}

/** A value as it's stored and shown: text where it's text, otherwise hex, or only its hash. */
export interface ShownValue {
  text?: string;
  hex?: string;
  sha256?: string;
}

function shown(bytes: Uint8Array, mode: "show" | "hash"): ShownValue {
  if (mode === "hash") return { sha256: createHash("sha256").update(bytes).digest("hex") };
  const text = Buffer.from(bytes).toString("utf8");
  // Round-trips and has no control characters other than whitespace: show as text.
  const printable = Buffer.from(text, "utf8").equals(Buffer.from(bytes)) && !/[\u0000-\u0008\u000e-\u001f]/.test(text);
  return printable ? { text } : { hex: Buffer.from(bytes).toString("hex") };
}

export interface PublishedParty {
  mspId: string;
  name: string | null;
}

export interface PublishedTransaction {
  txId: string;
  index: number;
  type: DecodedTransaction["type"];
  typeName: string;
  timestamp: number | null;
  validation: string;
  /** Who may see the details: "members" means signed-in members of the channel. */
  level: "public" | "members";
  /** Details withheld: a hidden contract, or members-only details for someone not signed in as a member. */
  redacted: boolean;
  /** Set when the details are withheld only because the viewer isn't a signed-in member. */
  membersOnly?: boolean;
  creator: PublishedParty | null;
  chaincode: string | null;
  fn: string | null;
  args: ShownValue[];
  endorsers: PublishedParty[];
  reads: number;
  writes: { namespace: string; key: string; isDelete: boolean; value: ShownValue | null; level: "public" | "members" }[];
  /** Private data collections touched. `hashes` only when the policy publishes them. */
  privateData: PublishedPrivateData[];
  /** Config transactions: the configuration, what changed, and who signed the update. */
  config?: { summary: ConfigSummary; changes: string[]; signers: PublishedParty[]; first?: boolean };
  response: { status: number; message: string; payload: ShownValue } | null;
  event: { name: string; payload: ShownValue } | null;
}

export interface PublishedPrivateData {
  namespace: string;
  collection: string;
  reads: number;
  writes: number;
  deletes: number;
  hashes?: PrivateDataSet["writes"];
  level: "public" | "members";
}

export interface PublishedBlock extends Omit<DecodedBlock, "transactions"> {
  transactions: PublishedTransaction[];
}

const partyView = (p: Party): PublishedParty => ({ mspId: p.mspId, name: p.name });

/** Applies the channel's policy to one decoded transaction. */
export function publishTransaction(policy: Policy, channel: string, tx: DecodedTransaction): PublishedTransaction {
  const c = policy.channels[channel]!;
  const base = {
    txId: tx.txId,
    index: tx.index,
    type: tx.type,
    typeName: tx.typeName,
    timestamp: tx.timestamp,
    validation: tx.validation,
  };
  const empty = { creator: null, chaincode: null, fn: null, args: [], endorsers: [], reads: 0, writes: [], privateData: [], response: null, event: null };
  const channelOpen = c.level === "public" ? "public" : "members";

  // Channel configuration: who made the change, what it changed, and who signed it.
  if (tx.type !== "endorser") {
    const people = (p: Party): PublishedParty => (c.submitter === "show" ? partyView(p) : { mspId: p.mspId, name: null });
    return {
      ...base,
      ...empty,
      level: channelOpen,
      redacted: false,
      creator: c.submitter === "show" && tx.creator ? partyView(tx.creator) : null,
      ...(tx.config
        ? { config: { summary: tx.config.summary, changes: tx.config.changes ?? [], signers: tx.config.signers.map(people), first: tx.config.first ?? false } }
        : {}),
    };
  }
  const level = contractLevel(policy, channel, tx.chaincode);
  // A hidden contract's transaction is listed with its ID, time and status, so block counts stay true.
  if (level === "hidden") return { ...base, ...empty, level: channelOpen, redacted: true };

  return {
    ...base,
    level,
    redacted: false,
    creator: c.submitter === "show" && tx.creator ? partyView(tx.creator) : null,
    chaincode: tx.chaincode,
    fn: tx.fn,
    args: tx.args.map((a) => shown(a, c.values)),
    // Endorsers are organisations' peers, not people, so they're always shown.
    endorsers: tx.endorsers.map(partyView),
    reads: tx.reads,
    // A transaction can write to other contracts it called; each keeps its own level.
    writes: tx.writes.flatMap((w) => {
      const writeLevel = contractLevel(policy, channel, w.namespace);
      if (writeLevel === "hidden") return [];
      return [{ namespace: w.namespace, key: w.key, isDelete: w.isDelete, value: w.isDelete ? null : shown(w.value, c.values), level: writeLevel }];
    }),
    privateData: (tx.privateData ?? []).flatMap((p) => {
      const pLevel = contractLevel(policy, channel, p.namespace);
      if (pLevel === "hidden") return [];
      return [
        {
          namespace: p.namespace,
          collection: p.collection,
          reads: p.reads,
          writes: p.writes.filter((w) => !w.isDelete).length,
          deletes: p.writes.filter((w) => w.isDelete).length,
          ...(c.privateData === "hashes" ? { hashes: p.writes } : {}),
          level: pLevel,
        },
      ];
    }),
    response: tx.response
      ? { status: tx.response.status, message: tx.response.message, payload: shown(tx.response.payload, c.values) }
      : null,
    event: tx.event ? { name: tx.event.name, payload: shown(tx.event.payload, c.values) } : null,
  };
}

export function publishBlock(policy: Policy, block: DecodedBlock): PublishedBlock {
  return { ...block, transactions: block.transactions.map((tx) => publishTransaction(policy, block.channel, tx)) };
}

/**
 * What one viewer sees of a stored transaction. Members of the channel, signed
 * in, see members-level details; everyone else sees those as withheld.
 */
export function viewTransaction<T extends PublishedTransaction>(tx: T, member: boolean): T {
  if (member) return { ...tx, privateData: tx.privateData ?? [] };
  if (tx.level === "members") {
    return {
      ...tx,
      redacted: true,
      membersOnly: true,
      creator: null,
      chaincode: null,
      fn: null,
      args: [],
      endorsers: [],
      reads: 0,
      writes: [],
      privateData: [],
      response: null,
      event: null,
      config: undefined,
    };
  }
  // Rows stored before private data was published have none.
  return { ...tx, writes: tx.writes.filter((w) => w.level === "public"), privateData: (tx.privateData ?? []).filter((p) => p.level === "public") };
}
