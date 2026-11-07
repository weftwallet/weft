/**
 * Where weft-trustee connects, and as whom: one connection file with
 * --connection, flags, or both, with flags taking precedence.
 *
 *   peer: localhost:7051
 *   peerHostAlias: peer0.org1.example.com   # optional: the name in the peer's TLS certificate
 *   tlsCa: org1/tlsca/tlsca.org1.example.com-cert.pem
 *   msp: Org1MSP
 *   cert: trustee1/msp/signcerts           # a file, or a folder holding one
 *   key: trustee1/msp/keystore
 *   channel: privatevote-budget-2027
 *   contract: private-ballot               # optional, this by default
 *   home: trustee-state                    # optional: where state folders go
 *
 * Paths in the file are relative to the file's folder.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { parse } from "yaml";
import { Failure, list } from "./output.ts";

export interface Connection {
  peer: string;
  peerHostAlias?: string;
  tlsCa: string;
  msp: string;
  cert: string;
  key: string;
  channel: string;
  contract: string;
  /** The folder that holds every election's state folder. */
  home: string;
  /** How the messages name where these settings came from: "org1.yaml" or "--peer and --tls-ca". */
  source?: string;
}

export const DEFAULT_CONTRACT = "private-ballot";
export const defaultHome = () => join(homedir(), ".weft", "trustee");

/** The settings a file or flags can give, with the flag for each. */
const SETTINGS = {
  peer: "--peer",
  peerHostAlias: "--peer-host-alias",
  tlsCa: "--tls-ca",
  msp: "--msp",
  cert: "--cert",
  key: "--key",
  channel: "--channel",
  contract: "--contract",
  home: "--home",
} as const;
type Setting = keyof typeof SETTINGS;
const PATHS: readonly Setting[] = ["tlsCa", "cert", "key", "home"];
const REQUIRED: readonly Setting[] = ["peer", "tlsCa", "msp", "cert", "key", "channel"];

export type Flags = Partial<Record<Setting | "connection", string>>;

/** The flag names parseArgs needs, as `--tls-ca` becomes `tls-ca`. */
export const connectionOptions = Object.fromEntries(
  [...Object.values(SETTINGS), "--connection"].map((flag) => [flag.slice(2), { type: "string" as const }]),
) as Record<string, { type: "string" }>;

/** parseArgs values, keyed by flag name, as settings. */
export function flagsFrom(values: Record<string, unknown>): Flags {
  const flags: Flags = {};
  for (const [setting, flag] of Object.entries(SETTINGS)) {
    const v = values[flag.slice(2)];
    if (typeof v === "string") flags[setting as Setting] = v;
  }
  if (typeof values.connection === "string") flags.connection = values.connection;
  return flags;
}

function readFile(path: string): Partial<Record<Setting, string>> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Failure(`There's no connection file at ${path}.`);
  }
  let data: unknown;
  try {
    data = parse(text);
  } catch {
    throw new Failure(`${path} isn't YAML or JSON.`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Failure(`${path} doesn't hold settings: it should be a map of names to values.`);
  const out: Partial<Record<Setting, string>> = {};
  for (const [name, value] of Object.entries(data)) {
    if (!(name in SETTINGS)) throw new Failure(`${path} has a setting weft-trustee doesn't know, ${name}.`, `It knows ${Object.keys(SETTINGS).join(", ")}.`);
    if (typeof value !== "string" && typeof value !== "number") throw new Failure(`${path}'s ${name} isn't a string.`);
    const s = String(value);
    out[name as Setting] = PATHS.includes(name as Setting) && !isAbsolute(s) ? resolve(dirname(path), s) : s;
  }
  return out;
}

export function resolveConnection(flags: Flags, env: NodeJS.ProcessEnv = process.env): Connection {
  const file = flags.connection ? readFile(resolve(flags.connection)) : {};
  const merged: Partial<Record<Setting, string>> = { ...file };
  for (const name of Object.keys(SETTINGS) as Setting[]) {
    const v = flags[name];
    if (v !== undefined) merged[name] = PATHS.includes(name) ? resolve(v) : v;
  }
  if (flags.home === undefined && env.WEFT_TRUSTEE_HOME) merged.home = resolve(env.WEFT_TRUSTEE_HOME);
  const missing = REQUIRED.filter((name) => !merged[name]);
  if (missing.length) {
    const what = missing.map((m) => SETTINGS[m]);
    throw new Failure(
      `The connection settings have no ${list(flags.connection ? missing : what)}.`,
      flags.connection
        ? `Add ${list(missing)} to ${flags.connection}, or give ${list(what)}.`
        : "Give --connection <file> with the peer, TLS CA, MSP ID, certificate, key and channel, or each flag.",
    );
  }
  return {
    peer: merged.peer!,
    ...(merged.peerHostAlias ? { peerHostAlias: merged.peerHostAlias } : {}),
    tlsCa: merged.tlsCa!,
    msp: merged.msp!,
    cert: merged.cert!,
    key: merged.key!,
    channel: merged.channel!,
    contract: merged.contract ?? DEFAULT_CONTRACT,
    home: merged.home ?? defaultHome(),
    source: flags.connection ? basename(flags.connection) : "--peer and --tls-ca",
  };
}
