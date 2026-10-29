/**
 * Builds a Weft invite from a Fabric common connection profile, the JSON or
 * YAML file organisations already hand to SDK users
 * (e.g. fabric-samples' connection-org1.json).
 *
 * A connection profile describes peers, orderers and CAs. Weft only needs the
 * organisation's MSP ID and CA; the relay URL and channels usually aren't in
 * the profile, so the caller supplies them.
 */

import type { OrgInvite } from "@weftwallet/protocol";
import { InviteError, parseInvite } from "./invite.ts";

interface ProfileOrganization {
  mspid?: string;
  certificateAuthorities?: string[];
}

interface ProfileCertificateAuthority {
  url?: string;
  caName?: string;
}

/** The parts of a Fabric connection profile Weft reads. */
export interface ConnectionProfile {
  name?: string;
  client?: { organization?: string };
  organizations?: Record<string, ProfileOrganization>;
  certificateAuthorities?: Record<string, ProfileCertificateAuthority>;
  channels?: Record<string, unknown>;
}

export interface InviteFromProfileOptions {
  /** Base URL of the organisation's Weft relay. Required: profiles don't contain it. */
  relayUrl: string;
  /** Organisation key in the profile. Defaults to client.organization, or the only organisation. */
  organization?: string;
  /** Channels to offer. Defaults to the profile's `channels` keys. */
  channels?: string[];
  /** Display name for the network. Defaults to the profile's `name`. */
  network?: string;
  /** CA key in the profile, when the organisation lists several. Defaults to the first. */
  certificateAuthority?: string;
  enrollmentId?: string;
  /** The organisation's explorer, if it runs one. */
  explorerUrl?: string;
}

/** Strips the "test-network-" style prefixes fabric-samples puts on profile names. */
function displayName(profileName: string | undefined, organization: string): string {
  if (!profileName) return `${organization} network`;
  return profileName;
}

export function inviteFromConnectionProfile(profile: ConnectionProfile, options: InviteFromProfileOptions): OrgInvite {
  const organizations = profile.organizations ?? {};
  const names = Object.keys(organizations);
  if (names.length === 0) throw new InviteError("The connection profile has no organizations.");

  const orgKey = options.organization ?? profile.client?.organization ?? (names.length === 1 ? names[0] : undefined);
  if (!orgKey) {
    throw new InviteError(`The profile lists several organizations (${names.join(", ")}). Choose one.`);
  }
  const org = organizations[orgKey];
  if (!org) throw new InviteError(`Organization "${orgKey}" is not in the profile. It has: ${names.join(", ")}.`);
  if (!org.mspid) throw new InviteError(`Organization "${orgKey}" has no mspid.`);

  const caKeys = org.certificateAuthorities ?? [];
  const caKey = options.certificateAuthority ?? caKeys[0];
  if (!caKey) throw new InviteError(`Organization "${orgKey}" lists no certificate authority.`);
  const ca = profile.certificateAuthorities?.[caKey];
  if (!ca?.url) throw new InviteError(`Certificate authority "${caKey}" has no url in the profile.`);

  const channels = options.channels?.length ? options.channels : Object.keys(profile.channels ?? {});
  if (channels.length === 0) {
    throw new InviteError("The profile lists no channels. Name the channels this organisation uses.");
  }

  return parseInvite({
    weft: 1,
    network: options.network ?? displayName(profile.name, orgKey),
    organization: orgKey,
    mspId: org.mspid,
    caUrl: ca.url,
    ...(ca.caName ? { caName: ca.caName } : {}),
    relayUrl: options.relayUrl,
    channels,
    ...(options.enrollmentId ? { enrollmentId: options.enrollmentId } : {}),
    ...(options.explorerUrl ? { explorerUrl: options.explorerUrl } : {}),
  });
}

/* ------------------------------------------------------------------ */
/* Links                                                               */
/* ------------------------------------------------------------------ */

/** Where the hosted "join" page lives. Override for self-hosted docs. */
export const DEFAULT_JOIN_PAGE = "https://weft.ifeanyiugwu.dev/join/";

export interface InviteLinks {
  /** The invite JSON itself. */
  url: string;
  /** Opens the hosted join page, which hands the invite to the extension. Best for email and chat. */
  join: string;
  /** Compact form for QR codes and pasting into Weft. */
  weft: string;
}

export function inviteLinks(inviteUrl: string, joinPage: string = DEFAULT_JOIN_PAGE): InviteLinks {
  const url = new URL(inviteUrl).toString();
  const join = new URL(joinPage);
  join.searchParams.set("weft-invite", url);
  return { url, join: join.toString(), weft: `weft://invite?u=${encodeURIComponent(url)}` };
}
