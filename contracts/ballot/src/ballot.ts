/**
 * A ballot contract built for the Weft explorer (docs/adr/0004, phase 4).
 *
 * - A ballot goes to a private data collection. The shared ledger gets only a
 *   commitment: SHA-256 of the election ID, the option and a salt the voter
 *   chose. The voter keeps the option and salt as their receipt.
 * - Each identity votes once per election.
 * - When voting closes, the contract counts the private ballot behind each
 *   public commitment and publishes the tally.
 *
 * Anyone can then count the commitments in an explorer and compare with the
 * tally, and a voter can check that their commitment is in a valid block. The
 * ledger still records which identity submitted each ballot, as every Fabric
 * transaction does; this hides the choice, not the fact of voting. See ADR
 * 0004 for the limits.
 */

import { createHash } from "node:crypto";
import { Context, Contract } from "fabric-contract-api";

export const COLLECTION = "ballots";

export interface Election {
  id: string;
  title: string;
  options: string[];
  /** ISO time after which no ballots are accepted and the count can run. */
  closesAt: string;
  /** Only identities from this MSP can close it. */
  creatorMsp: string;
  state: "open" | "closed";
  tally?: { counts: Record<string, number>; total: number };
}

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** The commitment for a ballot. Voters can recompute it from their receipt. */
export function commitmentFor(electionId: string, option: string, salt: string): string {
  return sha256(`${electionId}\n${option}\n${salt}`);
}

function txTime(ctx: Context): number {
  const ts = ctx.stub.getTxTimestamp();
  return Number(ts.seconds.toString()) * 1000 + Math.floor(ts.nanos / 1e6);
}

function json<T>(bytes: Uint8Array): T {
  return JSON.parse(Buffer.from(bytes).toString("utf8")) as T;
}

const put = (value: unknown) => Buffer.from(JSON.stringify(value));

export class BallotContract extends Contract {
  constructor() {
    super("ballot");
  }

  private async election(ctx: Context, id: string): Promise<Election> {
    const bytes = await ctx.stub.getState(ctx.stub.createCompositeKey("election", [id]));
    if (!bytes || bytes.length === 0) throw new Error(`There's no election ${id}.`);
    return json<Election>(bytes);
  }

  /** optionsJson: a JSON array of option names. closesAt: an ISO time. */
  async CreateElection(ctx: Context, id: string, title: string, optionsJson: string, closesAt: string): Promise<string> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error("Election IDs are 1 to 64 letters, digits, - or _.");
    const key = ctx.stub.createCompositeKey("election", [id]);
    const existing = await ctx.stub.getState(key);
    if (existing && existing.length > 0) throw new Error(`Election ${id} already exists.`);
    const options = JSON.parse(optionsJson) as unknown;
    if (!Array.isArray(options) || options.length < 2 || !options.every((o) => typeof o === "string" && o.length > 0)) {
      throw new Error("Options must be a JSON array of at least two names.");
    }
    if (new Set(options).size !== options.length) throw new Error("Options must be different from each other.");
    const close = Date.parse(closesAt);
    if (Number.isNaN(close) || close <= txTime(ctx)) throw new Error("closesAt must be a time in the future.");
    const election: Election = {
      id,
      title,
      options: options as string[],
      closesAt: new Date(close).toISOString(),
      creatorMsp: ctx.clientIdentity.getMSPID(),
      state: "open",
    };
    await ctx.stub.putState(key, put(election));
    return JSON.stringify(election);
  }

  /**
   * Casts a ballot. The choice travels as transient data, so it never reaches
   * the shared ledger: transient "ballot" = {"option": "...", "salt": "..."}.
   * Returns the receipt: { electionId, txId, commitment }.
   */
  async CastVote(ctx: Context, electionId: string): Promise<string> {
    const election = await this.election(ctx, electionId);
    if (election.state !== "open" || txTime(ctx) >= Date.parse(election.closesAt)) throw new Error("Voting has closed.");
    const transient = ctx.stub.getTransient().get("ballot");
    if (!transient) throw new Error('Send the ballot as transient data named "ballot".');
    const ballot = json<{ option?: unknown; salt?: unknown }>(transient);
    if (typeof ballot.option !== "string" || !election.options.includes(ballot.option)) throw new Error("That isn't one of the options.");
    if (typeof ballot.salt !== "string" || !/^[0-9a-f]{32,128}$/.test(ballot.salt)) {
      throw new Error("The salt must be 32 to 128 hex characters, chosen at random by the voter.");
    }

    // One ballot per identity. The marker shows that this identity voted, which
    // the transaction's creator field shows anyway; it doesn't show the choice.
    const voter = sha256(`${ctx.clientIdentity.getMSPID()}\n${ctx.clientIdentity.getID()}`);
    const voterKey = ctx.stub.createCompositeKey("voter", [electionId, voter]);
    const already = await ctx.stub.getState(voterKey);
    if (already && already.length > 0) throw new Error("This identity has already voted in this election.");

    const txId = ctx.stub.getTxID();
    const commitment = commitmentFor(electionId, ballot.option, ballot.salt);
    await ctx.stub.putState(voterKey, put({ voted: true }));
    await ctx.stub.putState(ctx.stub.createCompositeKey("commitment", [electionId, txId]), put({ commitment }));
    // The salt is stored with the choice so the value's hash, which every
    // member's ledger keeps, can't be matched by trying each option.
    await ctx.stub.putPrivateData(
      COLLECTION,
      ctx.stub.createCompositeKey("ballot", [electionId, txId]),
      put({ option: ballot.option, salt: ballot.salt }),
    );
    ctx.stub.setEvent("BallotCast", put({ electionId, commitment }));
    return JSON.stringify({ electionId, txId, commitment });
  }

  /** Counts the private ballots and publishes the tally. After closesAt, by the creating organisation. */
  async CloseElection(ctx: Context, electionId: string): Promise<string> {
    const election = await this.election(ctx, electionId);
    if (election.state === "closed") throw new Error("This election is already closed.");
    if (ctx.clientIdentity.getMSPID() !== election.creatorMsp) throw new Error(`Only ${election.creatorMsp} can close this election.`);
    if (txTime(ctx) < Date.parse(election.closesAt)) throw new Error(`Voting is open until ${election.closesAt}.`);

    // Count from the public commitments, reading each one's private ballot by
    // key. (Fabric refuses writes in a transaction that range-queried private
    // data, so the ballots are reached through the commitments.) Every
    // commitment must have its ballot, and only CastVote writes either.
    const counts: Record<string, number> = Object.fromEntries(election.options.map((o) => [o, 0]));
    let total = 0;
    for await (const entry of ctx.stub.getStateByPartialCompositeKey("commitment", [electionId])) {
      const { attributes } = ctx.stub.splitCompositeKey(entry.key);
      const txId = attributes[1]!;
      const bytes = await ctx.stub.getPrivateData(COLLECTION, ctx.stub.createCompositeKey("ballot", [electionId, txId]));
      if (!bytes || bytes.length === 0) {
        throw new Error(`The ballot for transaction ${txId} is missing from this peer's collection, so it can't count.`);
      }
      const { option } = json<{ option: string }>(bytes);
      if (!(option in counts)) throw new Error(`The ballot for transaction ${txId} isn't for one of the options.`);
      counts[option]!++;
      total++;
    }

    const closed: Election = { ...election, state: "closed", tally: { counts, total } };
    await ctx.stub.putState(ctx.stub.createCompositeKey("election", [electionId]), put(closed));
    ctx.stub.setEvent("ElectionClosed", put({ electionId, total }));
    return JSON.stringify(closed);
  }

  async GetElection(ctx: Context, electionId: string): Promise<string> {
    return JSON.stringify(await this.election(ctx, electionId));
  }
}
