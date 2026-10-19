import { readFileSync } from "node:fs";
import { inviteFromConnectionProfile, parseInvite, type ConnectionProfile } from "@weftwallet/core";
import type { OrgInvite } from "@weftwallet/protocol";
import { parse as parseYaml } from "yaml";

/** Path the relay serves its organisation's invite on. */
export const INVITE_PATH = "/.well-known/weft-invite.json";

/** Reads a JSON or YAML file. */
export function readStructuredFile(path: string): unknown {
  const text = readFileSync(path, "utf8");
  return /\.ya?ml$/i.test(path) ? parseYaml(text) : JSON.parse(text);
}

function list(value: string | undefined): string[] | undefined {
  const items = value
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return items?.length ? items : undefined;
}

/**
 * Builds the invite the relay serves, from (in order of preference):
 *   WEFT_INVITE_FILE           a ready-made invite JSON, or
 *   WEFT_CONNECTION_PROFILE    the org's Fabric connection profile (JSON or YAML),
 *                              plus WEFT_PUBLIC_URL and, if the profile has none, WEFT_INVITE_CHANNELS.
 * Returns null when neither is set: serving an invite is optional.
 */
export function loadInvite(env: NodeJS.ProcessEnv = process.env): OrgInvite | null {
  if (env.WEFT_INVITE_FILE) return parseInvite(readStructuredFile(env.WEFT_INVITE_FILE));
  if (!env.WEFT_CONNECTION_PROFILE) return null;
  if (!env.WEFT_PUBLIC_URL) {
    throw new Error("WEFT_PUBLIC_URL is required with WEFT_CONNECTION_PROFILE: it is the relay URL users' wallets will call.");
  }
  const channels = list(env.WEFT_INVITE_CHANNELS);
  return inviteFromConnectionProfile(readStructuredFile(env.WEFT_CONNECTION_PROFILE) as ConnectionProfile, {
    relayUrl: env.WEFT_PUBLIC_URL,
    ...(env.WEFT_INVITE_ORGANIZATION ? { organization: env.WEFT_INVITE_ORGANIZATION } : {}),
    ...(channels ? { channels } : {}),
    ...(env.WEFT_INVITE_NETWORK ? { network: env.WEFT_INVITE_NETWORK } : {}),
  });
}
