import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadPolicy, type Policy } from "./policy.ts";

export interface ExplorerConfig {
  port: number;
  host: string;
  /** Peer Gateway endpoint, as for the relay. */
  peerEndpoint: string;
  peerHostAlias: string | undefined;
  peerTlsCaCert: Buffer | undefined;
  /** The explorer's own identity: read-only, from the operator's organisation. */
  mspId: string;
  certificate: Buffer;
  privateKey: Buffer;
  databasePath: string;
  policy: Policy;
  /** Shown in the page header, e.g. "Org1". Defaults to the policy's organisation or the MSP ID. */
  name: string;
  /** The origin people open the explorer at. Sign-ins must name it. Defaults to the request's own. */
  publicUrl: string | undefined;
  /** Signs session cookies. Random per start if unset, which signs everyone out on restart. */
  sessionSecret: string | undefined;
  /** Other organisations' explorers to cross-check with, as base URLs. */
  peers: string[];
  /** The network page block pages link to, or none when set to "off". */
  networkPage: string | undefined;
}

/** The hosted docs' network page. Self-hosted docs can be named with WEFT_EXPLORER_NETWORK_PAGE. */
const DEFAULT_NETWORK_PAGE = "https://weft.ifeanyiugwu.dev/operators/network/";

function required(env: NodeJS.ProcessEnv, name: string, example: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required, e.g. ${example}`);
  return value;
}

/** A file, or a folder holding exactly one file (as in an MSP's keystore/ and signcerts/). */
function readOne(path: string, what: string): Buffer {
  if (statSync(path).isDirectory()) {
    const files = readdirSync(path).filter((f) => !f.startsWith("."));
    if (files.length !== 1) throw new Error(`${what}: expected one file in ${path}, found ${files.length}.`);
    return readFileSync(join(path, files[0]!));
  }
  return readFileSync(path);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ExplorerConfig {
  const peerEndpoint = required(env, "WEFT_PEER_ENDPOINT", "peer0.org1.example.com:7051");
  const mspId = required(env, "WEFT_EXPLORER_MSP_ID", "Org1MSP");
  const certificate = readOne(required(env, "WEFT_EXPLORER_CERT", "msp/signcerts"), "WEFT_EXPLORER_CERT");
  const privateKey = readOne(required(env, "WEFT_EXPLORER_KEY", "msp/keystore"), "WEFT_EXPLORER_KEY");
  const policyPath = required(env, "WEFT_EXPLORER_POLICY", "explorer.yaml");
  const tls = env.WEFT_PEER_TLS_CA_CERT;
  const policy = loadPolicy(policyPath);
  return {
    port: Number(env.PORT ?? env.WEFT_EXPLORER_PORT ?? 8790),
    host: env.WEFT_HOST ?? "0.0.0.0",
    peerEndpoint,
    peerHostAlias: env.WEFT_PEER_HOST_ALIAS || undefined,
    peerTlsCaCert: tls ? readFileSync(tls) : undefined,
    mspId,
    certificate,
    privateKey,
    databasePath: env.WEFT_EXPLORER_DB ?? "explorer.db",
    policy,
    name: env.WEFT_EXPLORER_NAME || policy.organisation || mspId,
    publicUrl: env.WEFT_EXPLORER_PUBLIC_URL ? new URL(env.WEFT_EXPLORER_PUBLIC_URL).origin : undefined,
    sessionSecret: env.WEFT_EXPLORER_SESSION_SECRET || undefined,
    networkPage:
      env.WEFT_EXPLORER_NETWORK_PAGE === "off" ? undefined : new URL(env.WEFT_EXPLORER_NETWORK_PAGE || DEFAULT_NETWORK_PAGE).toString(),
    peers: (env.WEFT_EXPLORER_PEERS ?? "")
      .split(",")
      .map((u) => u.trim().replace(/\/+$/, ""))
      .filter(Boolean)
      .map((u) => {
        const url = new URL(u);
        if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
          throw new Error(`WEFT_EXPLORER_PEERS: ${u} must use HTTPS (plain HTTP is only allowed for localhost).`);
        }
        return url.toString().replace(/\/+$/, "");
      }),
  };
}
