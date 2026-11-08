import { createHash } from "node:crypto";
import * as grpc from "@grpc/grpc-js";
import { connect, type Gateway } from "@hyperledger/fabric-gateway";
import type { RelaySigner } from "@weftwallet/protocol";
import type { RelayConfig } from "./config.ts";

/** A Gateway for one request, and what to call when the request is done with it. */
export interface Lease {
  gateway: Gateway;
  release(): void;
}

/** The signer's identity as fabric-gateway takes it: the creator's id_bytes. */
function credentialsOf(signer: RelaySigner): Uint8Array {
  return "idemixIdentity" in signer ? new Uint8Array(Buffer.from(signer.idemixIdentity, "base64")) : Buffer.from(signer.certificate.trim());
}

/**
 * One gRPC channel to the peer, shared by every request, and one Gateway per
 * signing identity. Gateways are connected WITHOUT a signer: that puts
 * fabric-gateway in offline-signing mode, so this process never holds keys.
 *
 * Experimental (docs/adr/0008): an idemix signer is a one-off identity, used
 * for one transaction and never again, so its Gateway isn't cached: each
 * request gets a new one, closed when the request is done. A cache would only
 * hold every voter's identities.
 */
export class GatewayPool {
  private readonly client: grpc.Client;
  private readonly gateways = new Map<string, Gateway>();
  private readonly max: number;

  constructor(config: Pick<RelayConfig, "peerEndpoint" | "peerHostAlias" | "peerTlsCaCert" | "maxGateways">) {
    const credentials = config.peerTlsCaCert
      ? grpc.credentials.createSsl(config.peerTlsCaCert)
      : grpc.credentials.createInsecure();
    const options: grpc.ChannelOptions = config.peerHostAlias
      ? { "grpc.ssl_target_name_override": config.peerHostAlias }
      : {};
    this.client = new grpc.Client(config.peerEndpoint, credentials, options);
    this.max = config.maxGateways;
  }

  /** How many gateways are cached, for tests. */
  get cached(): number {
    return this.gateways.size;
  }

  private connect(signer: RelaySigner): Gateway {
    return connect({
      client: this.client,
      identity: { mspId: signer.mspId, credentials: credentialsOf(signer) },
      evaluateOptions: () => ({ deadline: Date.now() + 5_000 }),
      endorseOptions: () => ({ deadline: Date.now() + 15_000 }),
      submitOptions: () => ({ deadline: Date.now() + 5_000 }),
      commitStatusOptions: () => ({ deadline: Date.now() + 60_000 }),
    });
  }

  /** A Gateway for this request: the cached one for an X.509 signer, a new one for an idemix signer. */
  acquire(signer: RelaySigner): Lease {
    if ("idemixIdentity" in signer) {
      const gateway = this.connect(signer);
      return { gateway, release: () => gateway.close() };
    }
    return { gateway: this.get(signer), release: () => {} };
  }

  get(signer: RelaySigner): Gateway {
    if ("idemixIdentity" in signer) throw new Error("An idemix signer's gateway isn't cached: use acquire.");
    const key = `${signer.mspId}:${createHash("sha256").update(signer.certificate.trim()).digest("hex")}`;
    const existing = this.gateways.get(key);
    if (existing) {
      // Refresh recency for the simple LRU below.
      this.gateways.delete(key);
      this.gateways.set(key, existing);
      return existing;
    }
    const gateway = this.connect(signer);
    this.gateways.set(key, gateway);
    if (this.gateways.size > this.max) {
      const oldest = this.gateways.keys().next().value as string;
      this.gateways.get(oldest)?.close();
      this.gateways.delete(oldest);
    }
    return gateway;
  }

  close(): void {
    for (const gateway of this.gateways.values()) gateway.close();
    this.gateways.clear();
    this.client.close();
  }
}
