import { readFileSync } from "node:fs";
import type { OrgInvite } from "@weftwallet/protocol";
import { loadInvite } from "./invite.ts";

export interface RelayConfig {
  /** Port the HTTP server listens on. */
  port: number;
  host: string;
  /** Peer Gateway endpoint, e.g. "peer0.org1.example.com:7051". */
  peerEndpoint: string;
  /** TLS server name override, for when the endpoint is an IP or a tunnel. */
  peerHostAlias: string | undefined;
  /** PEM of the CA that signed the peer's TLS certificate. Plaintext if absent. */
  peerTlsCaCert: Buffer | undefined;
  /** Browser origins allowed to call the relay. "*" allows any. */
  allowedOrigins: string[] | "*";
  /** If set, the relay refuses signers from any other MSP. */
  allowedMspIds: string[] | undefined;
  /** Maximum number of cached gateway connections (one per signer). */
  maxGateways: number;
  /** The organisation's invite, served at /.well-known/weft-invite.json. Null when not configured. */
  invite: OrgInvite | null;
  /** Public base URL of this relay, used to print invite links at startup. */
  publicUrl: string | undefined;
  /** Hosted join page used in printed links. */
  joinPage: string | undefined;
}

function list(value: string | undefined): string[] | undefined {
  const items = value
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return items && items.length > 0 ? items : undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  const peerEndpoint = env.WEFT_PEER_ENDPOINT;
  if (!peerEndpoint) {
    throw new Error("WEFT_PEER_ENDPOINT is required, e.g. peer0.org1.example.com:7051");
  }
  const tlsPath = env.WEFT_PEER_TLS_CA_CERT;
  const origins = list(env.WEFT_ALLOWED_ORIGINS);
  return {
    port: Number(env.PORT ?? env.WEFT_PORT ?? 8787),
    host: env.WEFT_HOST ?? "0.0.0.0",
    peerEndpoint,
    peerHostAlias: env.WEFT_PEER_HOST_ALIAS || undefined,
    peerTlsCaCert: tlsPath ? readFileSync(tlsPath) : undefined,
    allowedOrigins: !origins || origins.includes("*") ? "*" : origins,
    allowedMspIds: list(env.WEFT_ALLOWED_MSP_IDS),
    maxGateways: Number(env.WEFT_MAX_GATEWAYS ?? 256),
    invite: loadInvite(env),
    publicUrl: env.WEFT_PUBLIC_URL?.replace(/\/+$/, "") || undefined,
    joinPage: env.WEFT_JOIN_PAGE || undefined,
  };
}
