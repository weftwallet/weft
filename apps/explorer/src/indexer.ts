/**
 * Reads blocks from the organisation's peer with a read-only identity and
 * stores what the policy publishes. One block stream per published channel;
 * a stream that fails reconnects from the last stored block.
 */

import { createPrivateKey } from "node:crypto";
import * as grpc from "@grpc/grpc-js";
import { connect, signers, type Gateway } from "@hyperledger/fabric-gateway";
import { common } from "@hyperledger/fabric-protos";
import type { ExplorerConfig } from "./config.ts";
import type { ExplorerDb } from "./db.ts";
import { configChanges } from "./channel-config.ts";
import { decodeBlock, type DecodedBlock } from "./decode.ts";
import { publishBlock, publishedChannels, type Policy } from "./policy.ts";
import { indexPrivateBlock } from "./private-elections.ts";
import type { IdemixSync } from "@weftwallet/idemix";

export interface ChannelStatus {
  channel: string;
  state: "starting" | "following" | "retrying" | "stopped";
  /** The peer's height, from qscc. null until known. */
  peerHeight: number | null;
  lastError: string | null;
  lastBlockAt: number | null;
}

type Log = { info: (msg: string) => void; warn: (msg: string) => void };

export class Indexer {
  private readonly client: grpc.Client;
  private readonly gateway: Gateway;
  private readonly status = new Map<string, ChannelStatus>();
  private stopped = false;
  private readonly closers: (() => void)[] = [];

  private readonly policy: Policy;
  private readonly db: ExplorerDb;
  private readonly log: Log;
  private readonly experimental: boolean;
  private readonly idemix: IdemixSync | null;

  /** `idemix` is the idemix module, started in this process, which checks anonymous ballots (docs/adr/0008). */
  constructor(config: ExplorerConfig, policy: Policy, db: ExplorerDb, log: Log = { info: console.log, warn: console.warn }, idemix: IdemixSync | null = null) {
    this.policy = policy;
    this.db = db;
    this.log = log;
    this.experimental = config.experimental;
    this.idemix = idemix;
    const credentials = config.peerTlsCaCert
      ? grpc.credentials.createSsl(config.peerTlsCaCert)
      : grpc.credentials.createInsecure();
    const options: grpc.ChannelOptions = config.peerHostAlias ? { "grpc.ssl_target_name_override": config.peerHostAlias } : {};
    this.client = new grpc.Client(config.peerEndpoint, credentials, options);
    this.gateway = connect({
      client: this.client,
      identity: { mspId: config.mspId, credentials: config.certificate },
      signer: signers.newPrivateKeySigner(createPrivateKey(config.privateKey)),
      evaluateOptions: () => ({ deadline: Date.now() + 5_000 }),
    });
  }

  statuses(): ChannelStatus[] {
    return [...this.status.values()];
  }

  start(): void {
    for (const channel of publishedChannels(this.policy)) {
      this.status.set(channel, { channel, state: "starting", peerHeight: null, lastError: null, lastBlockAt: null });
      void this.follow(channel);
      void this.pollHeight(channel);
    }
  }

  stop(): void {
    this.stopped = true;
    for (const close of this.closers) close();
    this.gateway.close();
    this.client.close();
  }

  private update(channel: string, patch: Partial<ChannelStatus>) {
    this.status.set(channel, { ...this.status.get(channel)!, ...patch });
  }

  /**
   * The index must come from this network. A playground that was torn down
   * and recreated starts again at block 0 with different hashes.
   */
  private async sameNetwork(channel: string): Promise<boolean> {
    const stored = this.db.block(channel, 0)?.block.hash;
    if (!stored) return true;
    const qscc = this.gateway.getNetwork(channel).getContract("qscc");
    const genesis = common.Block.deserializeBinary(await qscc.evaluateTransaction("GetBlockByNumber", channel, "0"));
    return decodeBlock(genesis).hash === stored;
  }

  private async follow(channel: string): Promise<void> {
    let delay = 1000;
    let checked = false;
    while (!this.stopped) {
      if (!checked) {
        try {
          if (!(await this.sameNetwork(channel))) {
            const message = `The index for ${channel} was built from a different network (block 0 doesn't match). Delete the database to start again.`;
            this.update(channel, { state: "stopped", lastError: message });
            this.log.warn(message);
            return;
          }
          checked = true;
        } catch {
          /* peer not reachable yet; the block stream below reports it */
        }
      }
      const network = this.gateway.getNetwork(channel);
      const startBlock = BigInt(this.db.nextBlock(channel));
      try {
        const blocks = await network.getBlockEvents({ startBlock });
        this.closers.push(() => blocks.close());
        this.update(channel, { state: "following", lastError: null });
        this.log.info(`Following ${channel} from block ${startBlock}`);
        for await (const block of blocks) {
          indexBlock(this.db, this.policy, decodeBlock(block), { experimental: this.experimental, idemix: this.idemix });
          this.update(channel, { lastBlockAt: Date.now() });
          delay = 1000;
        }
      } catch (error) {
        if (this.stopped) return;
        const message = error instanceof Error ? error.message : String(error);
        this.update(channel, { state: "retrying", lastError: message });
        this.log.warn(`Lost the block stream for ${channel} (${message}). Retrying in ${delay / 1000}s.`);
      }
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 30_000);
    }
  }

  /** How far the peer has got, so the page can say when the index is behind. */
  private async pollHeight(channel: string): Promise<void> {
    while (!this.stopped) {
      try {
        const qscc = this.gateway.getNetwork(channel).getContract("qscc");
        const bytes = await qscc.evaluateTransaction("GetChainInfo", channel);
        const info = common.BlockchainInfo.deserializeBinary(bytes);
        this.update(channel, { peerHeight: Number(info.getHeight()) });
      } catch {
        /* the block stream reports connection problems */
      }
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
}

/**
 * Stores one decoded block. Config blocks also update who the channel's
 * members are (who may sign in) and the configuration each later config
 * block is compared with. With `experimental` (WEFT_EXPERIMENTAL=1), a
 * channel whose policy names privateElections also has its private-ballot
 * transactions indexed as elections (private-elections.ts), with `idemix`
 * checking anonymous ballots.
 */
export function indexBlock(db: ExplorerDb, policy: Policy, decoded: DecodedBlock, options: { experimental?: boolean; idemix?: IdemixSync | null } = {}): void {
  for (const tx of decoded.transactions) {
    if (tx.members) db.setMembers(decoded.channel, tx.members);
    if (tx.config) {
      const before = db.configSummary(decoded.channel);
      tx.config.changes = configChanges(before, tx.config.summary);
      tx.config.first = before === null;
      db.setConfigSummary(decoded.channel, { ...tx.config.summary, block: decoded.number });
    }
  }
  db.addBlock(publishBlock(policy, decoded));
  if (options.experimental) indexPrivateBlock(db, policy, decoded, options.idemix ?? null);
}
