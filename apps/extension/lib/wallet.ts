/**
 * Wallet logic that runs in the background worker: identities, networks,
 * enrolment and the signer used for transactions.
 */

import {
  FabricCaClient,
  certificateMatchesKey,
  createCsr,
  fetchInvite as fetchInviteDocument,
  generateKeyPair,
  importPrivateKeyPem,
  keyMatchesCertificate,
  parseCertificate,
  signForFabric,
  summarizeIdentity,
} from "@weftwallet/core";
import type { IdentitySummary, OrgInvite } from "@weftwallet/protocol";
import * as vault from "./vault";
import { db, newId, type IdentityRecord, type NetworkRecord, type PendingCsrRecord, type SiteRecord } from "./db";
import type { IdentityView, NetworkInput, PendingCsrView, WalletState } from "./messages";

/* ------------------------------------------------------------------ */
/* Views                                                               */
/* ------------------------------------------------------------------ */

async function toView(identity: IdentityRecord, networks: Map<string, NetworkRecord>): Promise<IdentityView> {
  const summary = await summarizeIdentity(identity);
  const network = networks.get(identity.networkId);
  return {
    ...summary,
    networkId: identity.networkId,
    networkName: network?.name ?? "Unknown network",
    organization: network?.organization ?? identity.mspId,
    channels: network?.channels ?? [],
    enrollmentId: identity.enrollmentId,
    legacyKey: !identity.wrappedKey,
  };
}

async function networkMap(): Promise<Map<string, NetworkRecord>> {
  return new Map((await db.all<NetworkRecord>("networks")).map((n) => [n.id, n]));
}

export async function identityView(id: string): Promise<IdentityView | null> {
  const identity = await db.get<IdentityRecord>("identities", id);
  return identity ? toView(identity, await networkMap()) : null;
}

export async function getState(): Promise<WalletState> {
  const [identities, networks, pending, sites, settings] = await Promise.all([
    db.all<IdentityRecord>("identities"),
    db.all<NetworkRecord>("networks"),
    db.all<PendingCsrRecord>("pendingCsrs"),
    db.all<SiteRecord>("sites"),
    db.settings(),
  ]);
  const byId = new Map(networks.map((n) => [n.id, n]));
  const views = await Promise.all(identities.sort((a, b) => a.createdAt - b.createdAt).map((i) => toView(i, byId)));
  const pendingViews: PendingCsrView[] = pending.map((p) => ({
    id: p.id,
    networkId: p.networkId,
    networkName: byId.get(p.networkId)?.name ?? "Unknown network",
    commonName: p.commonName,
    csr: p.csr,
    createdAt: p.createdAt,
  }));
  return { identities: views, networks, pendingCsrs: pendingViews, sites, settings, vault: await vault.status() };
}

export async function activeIdentity(): Promise<{ record: IdentityRecord; network: NetworkRecord; channel: string } | null> {
  const settings = await db.settings();
  if (!settings.activeIdentityId) return null;
  const record = await db.get<IdentityRecord>("identities", settings.activeIdentityId);
  if (!record) return null;
  const network = await db.get<NetworkRecord>("networks", record.networkId);
  if (!network) return null;
  const channel =
    settings.activeChannel && network.channels.includes(settings.activeChannel)
      ? settings.activeChannel
      : (network.channels[0] ?? "");
  return { record, network, channel };
}

export async function activeSummary(): Promise<IdentitySummary | null> {
  const active = await activeIdentity();
  return active ? summarizeIdentity(active.record) : null;
}

/* ------------------------------------------------------------------ */
/* Networks                                                            */
/* ------------------------------------------------------------------ */

/** Reuses an existing network with the same MSP and relay, or creates one. */
async function upsertNetwork(input: NetworkInput): Promise<NetworkRecord> {
  const existing = (await db.all<NetworkRecord>("networks")).find(
    (n) => n.mspId === input.mspId && n.relayUrl === input.relayUrl,
  );
  const record: NetworkRecord = { ...input, id: existing?.id ?? newId() };
  if (existing) {
    record.channels = Array.from(new Set([...existing.channels, ...input.channels]));
    if (!record.inviteUrl && existing.inviteUrl) record.inviteUrl = existing.inviteUrl;
  }
  await db.put("networks", record);
  return record;
}

export function inviteToNetwork(invite: OrgInvite, inviteUrl?: string): NetworkInput {
  return {
    ...(inviteUrl ? { inviteUrl } : {}),
    name: invite.network,
    organization: invite.organization,
    mspId: invite.mspId,
    caUrl: invite.caUrl,
    ...(invite.caName ? { caName: invite.caName } : {}),
    relayUrl: invite.relayUrl,
    channels: invite.channels,
    ...(invite.explorerUrl ? { explorerUrl: invite.explorerUrl } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* Adding identities                                                   */
/* ------------------------------------------------------------------ */

async function saveIdentity(input: Omit<IdentityRecord, "id" | "createdAt">): Promise<IdentityView> {
  parseCertificate(input.certificate); // throws on garbage
  const record: IdentityRecord = { ...input, id: newId(), createdAt: Date.now() };
  await db.put("identities", record);
  const settings = await db.settings();
  if (!settings.activeIdentityId) await db.saveSettings({ activeIdentityId: record.id, activeChannel: null });
  return toView(record, await networkMap());
}

export async function fetchInvite(link: string): Promise<OrgInvite> {
  return fetchInviteDocument(link);
}

/** A key pair whose private half can be encrypted once, then forgotten. */
async function newKeys(): Promise<CryptoKeyPair> {
  await vault.requireUnlocked();
  return generateKeyPair("P-256", { extractable: true });
}

export async function enroll(network: NetworkInput, enrollmentId: string, secret: string): Promise<IdentityView> {
  const keys = await newKeys();
  const ca = new FabricCaClient({ url: network.caUrl, ...(network.caName ? { caName: network.caName } : {}) });
  const issued = await ca.enroll(enrollmentId, secret, keys);
  const record = await upsertNetwork(network);
  return saveIdentity({
    networkId: record.id,
    mspId: network.mspId,
    certificate: issued.certificate,
    wrappedKey: await vault.wrap(keys.privateKey),
    enrollmentId,
  });
}

export async function importIdentity(network: NetworkInput, certificate: string, privateKeyPem: string) {
  await vault.requireUnlocked();
  const privateKey = await importPrivateKeyPem(privateKeyPem, "P-256", { extractable: true });
  if (!(await keyMatchesCertificate(privateKey, certificate))) {
    throw new Error("The private key does not belong to this certificate.");
  }
  const wrappedKey = await vault.wrap(privateKey);
  const record = await upsertNetwork(network);
  const cn = parseCertificate(certificate).subjectName.getField("CN")[0] ?? null;
  return saveIdentity({ networkId: record.id, mspId: network.mspId, certificate, wrappedKey, enrollmentId: cn });
}

export async function startCsr(network: NetworkInput, commonName: string): Promise<PendingCsrView> {
  const keys = await newKeys();
  const csr = await createCsr(keys, commonName);
  const record = await upsertNetwork(network);
  const pending: PendingCsrRecord = {
    id: newId(),
    networkId: record.id,
    commonName,
    csr,
    wrappedKey: await vault.wrap(keys.privateKey),
    publicKey: keys.publicKey,
    createdAt: Date.now(),
  };
  await db.put("pendingCsrs", pending);
  return { id: pending.id, networkId: record.id, networkName: record.name, commonName, csr, createdAt: pending.createdAt };
}

export async function completeCsr(pendingId: string, certificate: string): Promise<IdentityView> {
  const pending = await db.get<PendingCsrRecord>("pendingCsrs", pendingId);
  if (!pending) throw new Error("That request no longer exists.");
  if (!(await certificateMatchesKey(certificate, pending.publicKey))) {
    throw new Error("This certificate was not issued for this request's key.");
  }
  const network = await db.get<NetworkRecord>("networks", pending.networkId);
  if (!network) throw new Error("The network for this request was removed.");
  const view = await saveIdentity({
    networkId: network.id,
    mspId: network.mspId,
    certificate,
    ...(pending.wrappedKey ? { wrappedKey: pending.wrappedKey } : { privateKey: pending.privateKey! }),
    enrollmentId: pending.commonName,
  });
  await db.delete("pendingCsrs", pendingId);
  return view;
}

/** Gets a fresh certificate from the CA with a new key, replacing the old pair. */
export async function reenroll(identityId: string): Promise<IdentityView> {
  const identity = await db.get<IdentityRecord>("identities", identityId);
  if (!identity) throw new Error("Identity not found.");
  const network = await db.get<NetworkRecord>("networks", identity.networkId);
  if (!network) throw new Error("This identity's network was removed.");
  const commonName = identity.enrollmentId ?? parseCertificate(identity.certificate).subjectName.getField("CN")[0];
  if (!commonName) throw new Error("Weft can't tell which enrolment ID to renew this certificate for.");
  const keys = await newKeys();
  const ca = new FabricCaClient({ url: network.caUrl, ...(network.caName ? { caName: network.caName } : {}) });
  // The CA checks the request is signed with the current key.
  const current = { certificate: identity.certificate, privateKey: await vault.signingKey(identity) };
  const issued = await ca.reenroll(current, keys, commonName);
  const { privateKey: _legacy, ...rest } = identity;
  const updated: IdentityRecord = { ...rest, certificate: issued.certificate, wrappedKey: await vault.wrap(keys.privateKey) };
  await db.put("identities", updated);
  vault.forget(identity.id);
  return toView(updated, await networkMap());
}

/* ------------------------------------------------------------------ */
/* Network settings                                                    */
/* ------------------------------------------------------------------ */

function checkUrl(label: string, value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} isn't a valid URL.`);
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new Error(`${label} must use HTTPS (plain HTTP is only allowed for localhost).`);
  }
  return url.toString().replace(/\/+$/, "");
}

export async function updateNetwork(
  networkId: string,
  patch: Partial<Pick<NetworkRecord, "name" | "organization" | "relayUrl" | "caUrl" | "caName" | "explorerUrl" | "channels">>,
): Promise<NetworkRecord> {
  const network = await db.get<NetworkRecord>("networks", networkId);
  if (!network) throw new Error("That network no longer exists.");
  const next: NetworkRecord = { ...network };
  if (patch.name?.trim()) next.name = patch.name.trim();
  if (patch.organization?.trim()) next.organization = patch.organization.trim();
  if (patch.relayUrl !== undefined) next.relayUrl = checkUrl("Relay URL", patch.relayUrl);
  if (patch.caUrl !== undefined) next.caUrl = checkUrl("CA URL", patch.caUrl);
  if (patch.caName !== undefined) {
    if (patch.caName.trim()) next.caName = patch.caName.trim();
    else delete next.caName;
  }
  if (patch.explorerUrl !== undefined) {
    if (patch.explorerUrl.trim()) next.explorerUrl = checkUrl("Explorer URL", patch.explorerUrl);
    else delete next.explorerUrl;
  }
  if (patch.channels !== undefined) {
    const channels = Array.from(new Set(patch.channels.map((c) => c.trim()).filter(Boolean)));
    if (channels.length === 0) throw new Error("A network needs at least one channel.");
    next.channels = channels;
  }
  await db.put("networks", next);
  return next;
}

/** null when the endpoint answered, otherwise what went wrong. */
async function probe(url: string, expect: (response: Response) => Promise<boolean>): Promise<string | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!response.ok) return `answered HTTP ${response.status}`;
    return (await expect(response)) ? null : "answered, but not like a Weft relay or Fabric CA";
  } catch (error) {
    return error instanceof Error && error.name === "TimeoutError" ? "didn't answer within 6 seconds" : "couldn't be reached";
  }
}

export async function checkEndpoints(relayUrl: string, caUrl: string, caName?: string) {
  const relay = checkUrl("Relay URL", relayUrl);
  const ca = checkUrl("CA URL", caUrl);
  const [relayProblem, caProblem] = await Promise.all([
    probe(`${relay}/v1/health`, async () => true),
    probe(`${ca}/cainfo${caName ? `?ca=${encodeURIComponent(caName)}` : ""}`, async (r) => {
      const body = (await r.json().catch(() => null)) as { success?: boolean } | null;
      return body?.success === true;
    }),
  ]);
  return { relay: relayProblem, ca: caProblem };
}

export async function refreshInvite(networkId: string): Promise<OrgInvite> {
  const network = await db.get<NetworkRecord>("networks", networkId);
  if (!network) throw new Error("That network no longer exists.");
  if (!network.inviteUrl) throw new Error("This network wasn't added from an invite, so there's nothing to refresh from.");
  return fetchInviteDocument(network.inviteUrl);
}

/**
 * Deletes every identity, pending request, connection and activity record,
 * and the vault. Networks stay, so enrolling again is quick.
 */
export async function resetWallet(): Promise<string[]> {
  for (const store of ["identities", "pendingCsrs", "activity"] as const) {
    for (const row of await db.all<{ id: string }>(store)) await db.delete(store, row.id);
  }
  const origins = (await db.all<SiteRecord>("sites")).map((s) => s.origin);
  await db.saveSettings({ activeIdentityId: null, activeChannel: null });
  await vault.destroy();
  return origins;
}

export async function removeIdentity(identityId: string): Promise<void> {
  await db.delete("identities", identityId);
  const settings = await db.settings();
  if (settings.activeIdentityId === identityId) {
    const next = (await db.all<IdentityRecord>("identities"))[0];
    await db.saveSettings({ activeIdentityId: next?.id ?? null, activeChannel: null });
  }
}

/* ------------------------------------------------------------------ */
/* Signing                                                             */
/* ------------------------------------------------------------------ */

/**
 * Returns a signer bound to one identity, or throws VaultLockedError. The key
 * never leaves this worker.
 */
export async function signerFor(identity: IdentityRecord) {
  const key = await vault.signingKey(identity);
  await vault.touch();
  return (message: Uint8Array) => signForFabric(key, message);
}
