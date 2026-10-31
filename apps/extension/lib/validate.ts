/**
 * Field checks for the wallet's forms. Each returns the error to show under
 * the field, or null. They mirror what the worker checks (lib/wallet.ts), so
 * a mistake is caught at the field instead of after a round trip.
 */

import { resolveInviteUrl } from "@weftwallet/core";

export type Check = string | null;

export function required(value: string, message: string): Check {
  return value.trim() ? null : message;
}

/** An https URL, or http for localhost only. Empty is fine unless `missing` says what to ask for. */
export function url(value: string, missing?: string): Check {
  const text = value.trim();
  if (!text) return missing ?? null;
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return "Enter the full address, starting with https://.";
  }
  const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (parsed.protocol === "https:" || (parsed.protocol === "http:" && local)) return null;
  if (parsed.protocol === "http:") return "The address must use https://. Plain http:// works only for localhost.";
  return "Enter the full address, starting with https://.";
}

export function channels(value: string): Check {
  return value.split(",").some((c) => c.trim()) ? null : "Enter at least one channel.";
}

export function inviteLink(value: string): Check {
  if (!value.trim()) return "Paste the invite link from your administrator.";
  try {
    resolveInviteUrl(value);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "That doesn't look like an invite link. Paste the link that starts with weft://invite or https://.";
  }
}

export function certificatePem(value: string): Check {
  if (!value.trim()) return "Paste the certificate.";
  return value.includes("-----BEGIN CERTIFICATE-----") ? null : "Paste the whole certificate, from -----BEGIN CERTIFICATE----- to the end.";
}

export function privateKeyPem(value: string): Check {
  if (!value.trim()) return "Paste the private key.";
  if (value.includes("-----BEGIN PRIVATE KEY-----")) return null;
  if (/-----BEGIN (EC |RSA )?PRIVATE KEY-----/.test(value) || value.includes("ENCRYPTED PRIVATE KEY")) {
    return "Weft needs an unencrypted PKCS#8 key, which starts with -----BEGIN PRIVATE KEY-----. Convert it with openssl pkcs8 -topk8 -nocrypt.";
  }
  return "Paste the whole key, from -----BEGIN PRIVATE KEY----- to the end.";
}

export const MIN_PASSWORD = 8;

export function newPassword(value: string): Check {
  if (!value) return "Choose a password.";
  return value.length >= MIN_PASSWORD ? null : `Use at least ${MIN_PASSWORD} characters.`;
}

export function samePassword(value: string, first: string): Check {
  if (!value) return "Type the password again.";
  return value === first ? null : "The passwords don't match.";
}
