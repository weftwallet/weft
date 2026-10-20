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
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import type { DecodedBlock, DecodedTransaction, Party } from "./decode.ts";

export type Level = "public" | "members" | "hidden";
const LEVELS: Level[] = ["public", "members", "hidden"];

export interface ChannelPolicy {
  level: Level;
  values: "show" | "hash";
  submitter: "show" | "hide";
  contracts: Record<string, Level>;
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
    if (submitter !== "show" && submitter !== "hide") throw new Error(`channels.${name}.submitter must be show or hide.`);
    const contracts: Record<string, Level> = {};
    for (const [contract, l] of Object.entries((c.contracts ?? {}) as Record<string, unknown>)) {
      contracts[contract] = level(l, `channels.${name}.contracts.${contract}`);
    }
    channels[name] = { level: level(c.level, `channels.${name}.level`), values, submitter, contracts };
  }
  return { organisation: typeof root.organisation === "string" ? root.organisation : null, channels };
}

/** Changes whenever what the policy publishes changes. */
export function policyFingerprint(policy: Policy): string {
  const sorted = Object.keys(policy.channels)
    .sort()
    .map((name) => {
      const c = policy.channels[name]!;
      return [name, c.level, c.values, c.submitter, Object.entries(c.contracts).sort()];
    });
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}

export function loadPolicy(path: string): Policy {
  return parsePolicy(parse(readFileSync(path, "utf8")));
}

/**
 * Phase 1 shows `public` only. `members` needs sign-in with Weft (phase 2),
 * so until then it's treated as hidden: nothing is shown that the policy
 * didn't make public.
 */
export function publishedChannels(policy: Policy): string[] {
  return Object.entries(policy.channels)
    .filter(([, c]) => c.level === "public")
    .map(([name]) => name);
}

export function contractLevel(policy: Policy, channel: string, contract: string | null): Level {
  const c = policy.channels[channel];
  if (!c || c.level !== "public") return "hidden";
  if (contract === null) return c.level;
  return c.contracts[contract] ?? c.level;
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
  /** The contract isn't published: only the ID, time and status are shown. */
  redacted: boolean;
  creator: PublishedParty | null;
  chaincode: string | null;
  fn: string | null;
  args: ShownValue[];
  endorsers: PublishedParty[];
  reads: number;
  writes: { namespace: string; key: string; isDelete: boolean; value: ShownValue | null }[];
  response: { status: number; message: string; payload: ShownValue } | null;
  event: { name: string; payload: ShownValue } | null;
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
  const empty = { creator: null, chaincode: null, fn: null, args: [], endorsers: [], reads: 0, writes: [], response: null, event: null };

  // Channel configuration: who made the change matters; the config itself is a later feature.
  if (tx.type !== "endorser") {
    return { ...base, ...empty, redacted: false, creator: c.submitter === "show" && tx.creator ? partyView(tx.creator) : null };
  }
  if (contractLevel(policy, channel, tx.chaincode) !== "public") return { ...base, ...empty, redacted: true };

  return {
    ...base,
    redacted: false,
    creator: c.submitter === "show" && tx.creator ? partyView(tx.creator) : null,
    chaincode: tx.chaincode,
    fn: tx.fn,
    args: tx.args.map((a) => shown(a, c.values)),
    // Endorsers are organisations' peers, not people, so they're always shown.
    endorsers: tx.endorsers.map(partyView),
    reads: tx.reads,
    // A transaction can write to other contracts it called; each keeps its own level.
    writes: tx.writes
      .filter((w) => contractLevel(policy, channel, w.namespace) === "public")
      .map((w) => ({ namespace: w.namespace, key: w.key, isDelete: w.isDelete, value: w.isDelete ? null : shown(w.value, c.values) })),
    response: tx.response
      ? { status: tx.response.status, message: tx.response.message, payload: shown(tx.response.payload, c.values) }
      : null,
    event: tx.event ? { name: tx.event.name, payload: shown(tx.event.payload, c.values) } : null,
  };
}

export function publishBlock(policy: Policy, block: DecodedBlock): PublishedBlock {
  return { ...block, transactions: block.transactions.map((tx) => publishTransaction(policy, block.channel, tx)) };
}
