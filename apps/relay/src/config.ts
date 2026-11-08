import { readFileSync } from "node:fs";
import type { OrgInvite, VoterInvite } from "@weftwallet/protocol";
import { loadInvite } from "./invite.ts";
import { loadVoterInvites } from "./voter-invites.ts";

export interface RelayConfig {
  /** Port the HTTP server listens on. */
  port: number;
  host: string;
  /** Peer Gateway endpoint, for example "peer0.org1.example.com:7051". */
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
  /**
   * Experimental (docs/adr/0009): WEFT_EXPERIMENTAL=1. Off by default. Only
   * then may the relay accept idemix signers, from idemixMspIds.
   */
  experimental: boolean;
  /**
   * Experimental (docs/adr/0008): WEFT_IDEMIX_MSP_IDS, the voter MSPs whose
   * idemix signers the relay may accept, one per election, for example
   * ChairVoters2027MSP. Empty unless experimental. The relay keeps no
   * request logs for requests from these signers (server.ts, QuietLog).
   */
  idemixMspIds: string[];
  /**
   * Experimental (docs/adr/0008): the voter invites in the folder
   * WEFT_VOTER_INVITES, by election ID, served at
   * /.well-known/weft-voter-invite/<election>.json. Empty unless set.
   */
  voterInvites: Map<string, VoterInvite>;
  /** WEFT_VOTER_INVITES, where an invite added after startup is read from when first asked for. */
  voterInviteDir?: string;
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
    throw new Error("WEFT_PEER_ENDPOINT is required. Set it, for example to peer0.org1.example.com:7051.");
  }
  const tlsPath = env.WEFT_PEER_TLS_CA_CERT;
  const origins = list(env.WEFT_ALLOWED_ORIGINS);
  const experimental = env.WEFT_EXPERIMENTAL === "1";
  const idemixMspIds = list(env.WEFT_IDEMIX_MSP_IDS) ?? [];
  if (idemixMspIds.length > 0 && !experimental) {
    throw new Error(
      "WEFT_IDEMIX_MSP_IDS is set, but the relay accepts idemix signers only when it's started with WEFT_EXPERIMENTAL=1. Set WEFT_EXPERIMENTAL=1, or remove WEFT_IDEMIX_MSP_IDS.",
    );
  }
  const voterInvites = loadVoterInvites(env.WEFT_VOTER_INVITES, { experimental, idemixMspIds });
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
    experimental,
    idemixMspIds,
    voterInvites,
    ...(env.WEFT_VOTER_INVITES ? { voterInviteDir: env.WEFT_VOTER_INVITES } : {}),
  };
}
