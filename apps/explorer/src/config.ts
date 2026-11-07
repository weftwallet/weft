import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { domain as REGISTRY_DOMAIN, productUrl, type ProductId } from "@weftwallet/brand/products";
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
  /** Shown in the page header, for example "Org1". Defaults to the policy's organisation or the MSP ID. */
  name: string;
  /** The origin people open the explorer at. Sign-ins must name it. Defaults to the request's own. */
  publicUrl: string | undefined;
  /** Signs session cookies. Random per start if unset, which signs everyone out on restart. */
  sessionSecret: string | undefined;
  /** Other organisations' explorers to cross-check with, as base URLs. */
  peers: string[];
  /** The network page block pages link to, or none when set to "off". */
  networkPage: string | undefined;
  /** Where the other Weft products are, for the switcher, the footer and "Get Weft". */
  products: ProductAddresses;
  /**
   * The web pages that may hand an election page a receipt's choice and
   * salt (receipt.ts, acceptHandoff): Weft Playground where the products
   * are, and WEFT_EXPLORER_RECEIPT_ORIGINS. Weft's own pages are accepted as
   * a browser extension's.
   */
  receiptOrigins: string[];
  /**
   * Experimental (docs/adr/0009): WEFT_EXPERIMENTAL=1. Off by default. Only
   * then may the policy name a channel's privateElections.
   */
  experimental: boolean;
}

/**
 * Where the other Weft products live: their public addresses under a domain
 * (products.json's, unless WEFT_EXPLORER_PRODUCTS_DOMAIN names another), or
 * the local dev servers (`dev`).
 */
export type ProductAddresses = { local: true } | { local: false; domain: string };

/** The products' public addresses, as products.json gives them. */
export const PUBLIC_PRODUCTS: ProductAddresses = { local: false, domain: REGISTRY_DOMAIN };

/** One label of a domain name: letters, digits and inner hyphens, at most 63 characters. */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** WEFT_EXPLORER_PRODUCTS_DOMAIN: a domain such as weft.example.org, or dev for the local sites. */
export function parseProductAddresses(value: string | undefined): ProductAddresses {
  const given = value?.trim() ?? "";
  if (given === "") return PUBLIC_PRODUCTS;
  if (given.toLowerCase() === "dev") return { local: true };
  const name = given.toLowerCase().replace(/\.$/, "");
  const labels = name.split(".");
  if (name.length > 253 || labels.length < 2 || !labels.every((l) => LABEL.test(l))) {
    throw new Error(
      `WEFT_EXPLORER_PRODUCTS_DOMAIN: ${given} isn't a domain. Give the domain the Weft sites are under, such as weft.example.org, or dev for the local sites.`,
    );
  }
  return { local: false, domain: name };
}

/** A product's address, wherever the products are. Null for one with no site (the explorer, the wallet). */
export function productAddress(id: ProductId, where: ProductAddresses, path = "/"): string | null {
  return where.local ? productUrl(id, { dev: true, path }) : productUrl(id, { domain: where.domain, path });
}

/**
 * Who may hand an election page a receipt's choice and salt: Weft Playground,
 * where the products are, and the origins in WEFT_EXPLORER_RECEIPT_ORIGINS
 * (comma-separated, for an organisation's own voting app).
 */
export function receiptOrigins(where: ProductAddresses, extra: string | undefined): string[] {
  const playground = productAddress("playground", where);
  const given = (extra ?? "")
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean)
    .map((u) => {
      let url: URL;
      try {
        url = new URL(u);
      } catch {
        throw new Error(`WEFT_EXPLORER_RECEIPT_ORIGINS: ${u} isn't an address. Give origins such as https://vote.example.org, separated by commas.`);
      }
      const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
      if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
        throw new Error(`WEFT_EXPLORER_RECEIPT_ORIGINS: ${u} must use https://. Plain http:// works only for localhost.`);
      }
      return url.origin;
    });
  return [...new Set([...(playground ? [new URL(playground).origin] : []), ...given])];
}

function required(env: NodeJS.ProcessEnv, name: string, example: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required. Set it, for example to ${example}.`);
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
  const experimental = env.WEFT_EXPERIMENTAL === "1";
  const privateChannel = Object.entries(policy.channels).find(([, c]) => c.privateElections)?.[0];
  if (privateChannel && !experimental) {
    throw new Error(
      `channels.${privateChannel}.privateElections is set in ${policyPath}, but the explorer shows private elections only when it's started with WEFT_EXPERIMENTAL=1. Set WEFT_EXPERIMENTAL=1, or remove privateElections from the policy.`,
    );
  }
  const products = parseProductAddresses(env.WEFT_EXPLORER_PRODUCTS_DOMAIN);
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
    // Weft Network's network page, where the products are, unless another copy is named.
    networkPage:
      env.WEFT_EXPLORER_NETWORK_PAGE === "off"
        ? undefined
        : new URL(env.WEFT_EXPLORER_NETWORK_PAGE || productAddress("network", products)!).toString(),
    products,
    receiptOrigins: receiptOrigins(products, env.WEFT_EXPLORER_RECEIPT_ORIGINS),
    experimental,
    peers: (env.WEFT_EXPLORER_PEERS ?? "")
      .split(",")
      .map((u) => u.trim().replace(/\/+$/, ""))
      .filter(Boolean)
      .map((u) => {
        const url = new URL(u);
        if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
          throw new Error(`WEFT_EXPLORER_PEERS: ${u} must use https://. Plain http:// works only for localhost.`);
        }
        return url.toString().replace(/\/+$/, "");
      }),
  };
}
