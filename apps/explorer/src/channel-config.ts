/**
 * Channel configuration: what a config transaction leaves the channel with,
 * and what changed from the one before, in words.
 *
 * Fabric stores the whole configuration in every config block. The explorer
 * keeps a summary of the latest one per channel and compares each new one
 * with it. Settings it doesn't summarise still count: if the configuration
 * changed and the summary didn't, it says so.
 */

import { createHash, X509Certificate } from "node:crypto";
import { common, msp, orderer, peer } from "@hyperledger/fabric-protos";
import { parseCrl } from "./crl.ts";

export interface CaSummary {
  subject: string;
  /** First 16 hex digits of the certificate's SHA-256. */
  fingerprint: string;
}

export interface OrgSummary {
  mspId: string;
  rootCas: CaSummary[];
  intermediateCas: CaSummary[];
  /** host:port, application organisations only. */
  anchorPeers: string[];
  /** Serial numbers (hex) on the organisation's CRLs. */
  revoked?: string[];
  /** host:port, orderer organisations only. */
  endpoints: string[];
}

export interface ConfigSummary {
  organisations: OrgSummary[];
  ordererOrganisations: OrgSummary[];
  consensus: string | null;
  /** host:port of each orderer that takes part in consensus. */
  consenters: string[];
  batch: { timeout: string; maxMessages: number; absoluteMaxBytes: number; preferredMaxBytes: number } | null;
  capabilities: { channel: string[]; application: string[]; orderer: string[] };
  /** "Application/Endorsement" and the like, written out. */
  policies: Record<string, string>;
  /** SHA-256 of the whole configuration, to notice changes the summary leaves out. */
  digest: string;
}

/* Reading ------------------------------------------------------------ */

function ca(pemOrDer: Uint8Array): CaSummary {
  const text = Buffer.from(pemOrDer).toString("utf8");
  try {
    const cert = new X509Certificate(text.includes("BEGIN CERTIFICATE") ? text : Buffer.from(pemOrDer));
    const cn = /(?:^|\n)CN=([^\n]+)/.exec(cert.subject)?.[1];
    const o = /(?:^|\n)O=([^\n]+)/.exec(cert.subject)?.[1];
    return { subject: cn ?? o ?? cert.subject.replace(/\n/g, ", "), fingerprint: cert.fingerprint256.replace(/:/g, "").slice(0, 16).toLowerCase() };
  } catch {
    return { subject: "unreadable certificate", fingerprint: createHash("sha256").update(pemOrDer).digest("hex").slice(0, 16) };
  }
}

function orgSummary(group: common.ConfigGroup, key: string): OrgSummary {
  const summary: OrgSummary = { mspId: key, rootCas: [], intermediateCas: [], anchorPeers: [], endpoints: [] };
  const mspValue = group.getValuesMap().get("MSP");
  if (mspValue) {
    const config = msp.MSPConfig.deserializeBinary(mspValue.getValue_asU8());
    if (config.getType() === 0) {
      const fabric = msp.FabricMSPConfig.deserializeBinary(config.getConfig_asU8());
      summary.mspId = fabric.getName() || key;
      summary.rootCas = fabric.getRootCertsList_asU8().map(ca);
      summary.intermediateCas = fabric.getIntermediateCertsList_asU8().map(ca);
      summary.revoked = [
        ...new Set(
          fabric.getRevocationListList_asU8().flatMap((der) => {
            try {
              const text = Buffer.from(der).toString("utf8");
              return [...parseCrl(/-----BEGIN/.test(text) ? text : `-----BEGIN X509 CRL-----\n${Buffer.from(der).toString("base64")}\n-----END X509 CRL-----`).serials];
            } catch {
              return [];
            }
          }),
        ),
      ].sort();
    }
  }
  const anchors = group.getValuesMap().get("AnchorPeers");
  if (anchors) {
    summary.anchorPeers = peer.AnchorPeers.deserializeBinary(anchors.getValue_asU8())
      .getAnchorPeersList()
      .map((a) => `${a.getHost()}:${a.getPort()}`);
  }
  const endpoints = group.getValuesMap().get("Endpoints");
  if (endpoints) summary.endpoints = common.OrdererAddresses.deserializeBinary(endpoints.getValue_asU8()).getAddressesList();
  return summary;
}

function capabilities(group: common.ConfigGroup | undefined): string[] {
  const value = group?.getValuesMap().get("Capabilities");
  if (!value) return [];
  return [...common.Capabilities.deserializeBinary(value.getValue_asU8()).getCapabilitiesMap().keys()].sort();
}

const ROLES = ["member", "admin", "client", "peer", "orderer"];
const RULES = ["ANY", "ALL", "MAJORITY"];

function principal(p: msp.MSPPrincipal): string {
  if (p.getPrincipalClassification() === msp.MSPPrincipal.Classification.ROLE) {
    const role = msp.MSPRole.deserializeBinary(p.getPrincipal_asU8());
    return `${role.getMspIdentifier()}.${ROLES[role.getRole()] ?? role.getRole()}`;
  }
  return "a specific identity";
}

function signatureRule(rule: common.SignaturePolicy, identities: string[]): string {
  if (rule.hasSignedBy()) return identities[rule.getSignedBy()] ?? "?";
  const n = rule.getNOutOf();
  if (!n) return "?";
  const parts = n.getRulesList().map((r) => signatureRule(r, identities));
  if (n.getN() === 1 && parts.length > 1) return `OR(${parts.join(", ")})`;
  if (n.getN() === parts.length && parts.length > 1) return `AND(${parts.join(", ")})`;
  if (parts.length === 1) return parts[0]!;
  return `${n.getN()} of (${parts.join(", ")})`;
}

/** A policy written out: "MAJORITY of Endorsement", or "OR(Org1MSP.admin, Org2MSP.admin)". */
export function describePolicy(policy: common.Policy): string {
  const type = policy.getType();
  if (type === common.Policy.PolicyType.IMPLICIT_META) {
    const meta = common.ImplicitMetaPolicy.deserializeBinary(policy.getValue_asU8());
    return `${RULES[meta.getRule()] ?? meta.getRule()} of ${meta.getSubPolicy()}`;
  }
  if (type === common.Policy.PolicyType.SIGNATURE) {
    const envelope = common.SignaturePolicyEnvelope.deserializeBinary(policy.getValue_asU8());
    const rule = envelope.getRule();
    return rule ? signatureRule(rule, envelope.getIdentitiesList().map(principal)) : "?";
  }
  return `policy of type ${type}`;
}

function policies(group: common.ConfigGroup | undefined, prefix: string, into: Record<string, string>) {
  group?.getPoliciesMap().forEach((p, name) => {
    const policy = p.getPolicy();
    if (policy) into[`${prefix}${name}`] = describePolicy(policy);
  });
}

/** Summarises a ConfigEnvelope's configuration. */
export function summariseConfig(configEnvelope: Uint8Array): ConfigSummary | null {
  const config = common.ConfigEnvelope.deserializeBinary(configEnvelope).getConfig();
  const channel = config?.getChannelGroup();
  if (!config || !channel) return null;
  const application = channel.getGroupsMap().get("Application");
  const ordererGroup = channel.getGroupsMap().get("Orderer");

  const organisations: OrgSummary[] = [];
  application?.getGroupsMap().forEach((g, key) => organisations.push(orgSummary(g, key)));
  const ordererOrganisations: OrgSummary[] = [];
  ordererGroup?.getGroupsMap().forEach((g, key) => ordererOrganisations.push(orgSummary(g, key)));

  let consensus: string | null = null;
  let consenters: string[] = [];
  const consensusValue = ordererGroup?.getValuesMap().get("ConsensusType");
  if (consensusValue) {
    const type = orderer.ConsensusType.deserializeBinary(consensusValue.getValue_asU8());
    consensus = type.getType();
    if (consensus === "etcdraft" && type.getMetadata_asU8().length) {
      consenters = orderer.etcdraft.ConfigMetadata.deserializeBinary(type.getMetadata_asU8())
        .getConsentersList()
        .map((c) => `${c.getHost()}:${c.getPort()}`);
    }
  }
  const bftOrderers = ordererGroup?.getValuesMap().get("Orderers");
  if (bftOrderers) {
    consenters = common.Orderers.deserializeBinary(bftOrderers.getValue_asU8())
      .getConsenterMappingList()
      .map((c) => `${c.getHost()}:${c.getPort()}`);
  }

  let batch: ConfigSummary["batch"] = null;
  const size = ordererGroup?.getValuesMap().get("BatchSize");
  const timeout = ordererGroup?.getValuesMap().get("BatchTimeout");
  if (size || timeout) {
    const s = size ? orderer.BatchSize.deserializeBinary(size.getValue_asU8()) : null;
    batch = {
      timeout: timeout ? orderer.BatchTimeout.deserializeBinary(timeout.getValue_asU8()).getTimeout() : "",
      maxMessages: s?.getMaxMessageCount() ?? 0,
      absoluteMaxBytes: s?.getAbsoluteMaxBytes() ?? 0,
      preferredMaxBytes: s?.getPreferredMaxBytes() ?? 0,
    };
  }

  const policyMap: Record<string, string> = {};
  policies(channel, "Channel/", policyMap);
  policies(application, "Application/", policyMap);
  policies(ordererGroup, "Orderer/", policyMap);

  const byMsp = (a: OrgSummary, b: OrgSummary) => a.mspId.localeCompare(b.mspId);
  return {
    organisations: organisations.sort(byMsp),
    ordererOrganisations: ordererOrganisations.sort(byMsp),
    consensus,
    consenters: consenters.sort(),
    batch,
    capabilities: { channel: capabilities(channel), application: capabilities(application), orderer: capabilities(ordererGroup) },
    policies: Object.fromEntries(Object.entries(policyMap).sort(([a], [b]) => a.localeCompare(b))),
    digest: createHash("sha256").update(config.serializeBinary()).digest("hex"),
  };
}

/** The identities that signed the configuration update a config transaction applied. */
export function configUpdateSigners(configEnvelope: Uint8Array): Uint8Array[] {
  const update = common.ConfigEnvelope.deserializeBinary(configEnvelope).getLastUpdate();
  if (!update) return [];
  try {
    const payload = common.Payload.deserializeBinary(update.getPayload_asU8());
    const updateEnvelope = common.ConfigUpdateEnvelope.deserializeBinary(payload.getData_asU8());
    // Each signer's SerializedIdentity, as in any signature header.
    return updateEnvelope.getSignaturesList().map((s) => common.SignatureHeader.deserializeBinary(s.getSignatureHeader_asU8()).getCreator_asU8());
  } catch {
    return [];
  }
}

/* Comparing ---------------------------------------------------------- */

const list = (items: string[]) => (items.length ? items.join(", ") : "none");
const added = (before: string[], after: string[]) => after.filter((x) => !before.includes(x));
const removed = (before: string[], after: string[]) => before.filter((x) => !after.includes(x));
const caLabel = (c: CaSummary) => `${c.subject} (${c.fingerprint})`;

function setChange(what: string, before: string[], after: string[], out: string[]) {
  const plus = added(before, after);
  const minus = removed(before, after);
  if (plus.length && minus.length) out.push(`${what}: added ${list(plus)}; removed ${list(minus)}.`);
  else if (plus.length) out.push(`${what}: added ${list(plus)}.`);
  else if (minus.length) out.push(`${what}: removed ${list(minus)}.`);
}

function orgChanges(kind: string, before: OrgSummary[], after: OrgSummary[], out: string[]) {
  for (const org of after) {
    const old = before.find((o) => o.mspId === org.mspId);
    if (!old) {
      out.push(`${org.mspId} joined as ${kind}.`);
      continue;
    }
    setChange(`${org.mspId}'s root CAs`, old.rootCas.map(caLabel), org.rootCas.map(caLabel), out);
    setChange(`${org.mspId}'s intermediate CAs`, old.intermediateCas.map(caLabel), org.intermediateCas.map(caLabel), out);
    setChange(`${org.mspId}'s anchor peers`, old.anchorPeers, org.anchorPeers, out);
    setChange(`${org.mspId}'s orderer endpoints`, old.endpoints, org.endpoints, out);
    const newlyRevoked = added(old.revoked ?? [], org.revoked ?? []);
    const restored = removed(old.revoked ?? [], org.revoked ?? []);
    if (newlyRevoked.length) out.push(`${org.mspId} revoked ${newlyRevoked.length === 1 ? "a certificate" : `${newlyRevoked.length} certificates`} (serial ${newlyRevoked.join(", ")}).`);
    if (restored.length) out.push(`${org.mspId}'s revocation list no longer lists serial ${restored.join(", ")}.`);
  }
  for (const org of before) if (!after.some((o) => o.mspId === org.mspId)) out.push(`${org.mspId} left (was ${kind}).`);
}

/** What changed from `before` to `after`, in sentences. With no `before`, what the channel started with. */
export function configChanges(before: ConfigSummary | null, after: ConfigSummary): string[] {
  if (!before) {
    const out = [`The channel starts with ${list(after.organisations.map((o) => o.mspId))} as members.`];
    if (after.ordererOrganisations.length) {
      out.push(`Ordering by ${list(after.ordererOrganisations.map((o) => o.mspId))}${after.consensus ? `, using ${after.consensus}` : ""}.`);
    }
    return out;
  }
  const out: string[] = [];
  orgChanges("a member", before.organisations, after.organisations, out);
  orgChanges("an orderer organisation", before.ordererOrganisations, after.ordererOrganisations, out);
  if (before.consensus !== after.consensus) out.push(`Consensus changed from ${before.consensus ?? "none"} to ${after.consensus ?? "none"}.`);
  setChange("Consenters", before.consenters, after.consenters, out);
  if (before.batch && after.batch) {
    if (before.batch.timeout !== after.batch.timeout) out.push(`Batch timeout changed from ${before.batch.timeout} to ${after.batch.timeout}.`);
    if (before.batch.maxMessages !== after.batch.maxMessages) {
      out.push(`Most transactions per block changed from ${before.batch.maxMessages} to ${after.batch.maxMessages}.`);
    }
    if (before.batch.absoluteMaxBytes !== after.batch.absoluteMaxBytes || before.batch.preferredMaxBytes !== after.batch.preferredMaxBytes) {
      out.push(
        `Block size limits changed from ${before.batch.preferredMaxBytes} preferred, ${before.batch.absoluteMaxBytes} most, to ${after.batch.preferredMaxBytes} and ${after.batch.absoluteMaxBytes} bytes.`,
      );
    }
  }
  for (const level of ["channel", "application", "orderer"] as const) {
    setChange(`${level[0]!.toUpperCase()}${level.slice(1)} capabilities`, before.capabilities[level], after.capabilities[level], out);
  }
  for (const name of new Set([...Object.keys(before.policies), ...Object.keys(after.policies)])) {
    const b = before.policies[name];
    const a = after.policies[name];
    if (b === a) continue;
    if (b === undefined) out.push(`Policy ${name} added: ${a}.`);
    else if (a === undefined) out.push(`Policy ${name} removed (was ${b}).`);
    else out.push(`Policy ${name} changed from ${b} to ${a}.`);
  }
  if (out.length === 0 && before.digest !== after.digest) out.push("Settings this explorer doesn't summarise changed.");
  return out;
}
