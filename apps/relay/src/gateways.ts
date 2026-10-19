import { createHash } from "node:crypto";
import * as grpc from "@grpc/grpc-js";
import { connect, type Gateway } from "@hyperledger/fabric-gateway";
import type { RelaySigner } from "@weftwallet/protocol";
import type { RelayConfig } from "./config.ts";

/**
 * One gRPC channel to the peer, shared by every request, and one Gateway per
 * signing identity. Gateways are connected WITHOUT a signer: that puts
 * fabric-gateway in offline-signing mode, so this process never holds keys.
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

  get(signer: RelaySigner): Gateway {
    const key = `${signer.mspId}:${createHash("sha256").update(signer.certificate.trim()).digest("hex")}`;
    const existing = this.gateways.get(key);
    if (existing) {
      // Refresh recency for the simple LRU below.
      this.gateways.delete(key);
      this.gateways.set(key, existing);
      return existing;
    }
    const gateway = connect({
      client: this.client,
      identity: { mspId: signer.mspId, credentials: Buffer.from(signer.certificate.trim()) },
      evaluateOptions: () => ({ deadline: Date.now() + 5_000 }),
      endorseOptions: () => ({ deadline: Date.now() + 15_000 }),
      submitOptions: () => ({ deadline: Date.now() + 5_000 }),
      commitStatusOptions: () => ({ deadline: Date.now() + 60_000 }),
    });
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
