/**
 * Experimental (docs/adr/0008): checking a voter invite, the document an
 * election's organisers publish so a voter can get a voter credential in Weft
 * Experimental. The election's relay checks each invite it serves when it
 * starts, and Weft Experimental checks the one a voter opens, with the same
 * rules. Normal Weft never reads one: parseInvite recognises it and says what
 * it is (invite.ts).
 */
import type { VoterInvite } from "@weftwallet/protocol";
import { InviteError } from "./invite.ts";

const HEX64 = /^[0-9a-f]{64}$/;
/** The longest title a voter invite may give, in UTF-16 code units: the review card shows it whole. */
export const VOTER_INVITE_TITLE_MAX = 200;

function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function url(value: unknown): boolean {
  if (!text(value)) return false;
  try {
    const u = new URL(value);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

/** Whether a JSON document says it is a voter invite, whatever else is wrong with it. */
export function isVoterInviteDocument(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value) && "weftVoterInvite" in value;
}

/**
 * Checks one voter invite and returns it with only the fields the type
 * names, URLs without a trailing slash. Throws an InviteError that says what
 * is wrong with it, naming `source`.
 */
export function parseVoterInvite(value: unknown, source = "This document"): VoterInvite {
  const bad = (problem: string) => new InviteError(`${source} isn't a voter invite Weft Experimental can use: ${problem}.`, problem);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw bad("it isn't a JSON object");
  const v = value as Record<string, unknown>;
  if (v.weftVoterInvite !== 1) throw bad('"weftVoterInvite" must be 1');
  if ("weft" in v) throw bad('it has a "weft" field, which only an organisation\'s invite has');
  for (const field of ["network", "organization", "mspId", "affiliation", "relayOperator", "channel", "chaincode", "electionId"] as const) {
    if (!text(v[field])) throw bad(`"${field}" is missing or empty`);
  }
  for (const field of ["caUrl", "relayUrl"] as const) {
    if (!url(v[field])) throw bad(`"${field}" must be an http or https URL`);
  }
  if (v.explorerUrl !== undefined && !url(v.explorerUrl)) throw bad('"explorerUrl" must be an http or https URL');
  if (v.caName !== undefined && !text(v.caName)) throw bad('"caName" must be a name');
  if (v.title !== undefined && (!text(v.title) || v.title.trim() === "" || v.title.length > VOTER_INVITE_TITLE_MAX)) {
    throw bad(`"title" must be text of 1 to ${VOTER_INVITE_TITLE_MAX} characters`);
  }
  if (!text(v.issuerKeyHash) || !HEX64.test(v.issuerKeyHash)) throw bad('"issuerKeyHash" must be 64 lowercase hex characters');
  if (v.curve !== "FP256BN_AMCL") throw bad('"curve" must be FP256BN_AMCL');
  if (!Array.isArray(v.endorsers) || v.endorsers.length === 0) throw bad('"endorsers" must list at least one organisation');
  const endorsers = v.endorsers.map((e: unknown, i: number) => {
    const o = (e ?? {}) as Record<string, unknown>;
    if (!text(o.mspId)) throw bad(`endorsers[${i}] has no "mspId"`);
    if (!text(o.caChain) || !o.caChain.includes("BEGIN CERTIFICATE")) throw bad(`endorsers[${i}]'s "caChain" must be PEM`);
    return { mspId: o.mspId, caChain: o.caChain };
  });
  const trim = (u: unknown) => (u as string).replace(/\/+$/, "");
  return {
    weftVoterInvite: 1,
    network: v.network as string,
    organization: v.organization as string,
    mspId: v.mspId as string,
    affiliation: v.affiliation as string,
    caUrl: trim(v.caUrl),
    ...(v.caName ? { caName: v.caName as string } : {}),
    relayUrl: trim(v.relayUrl),
    relayOperator: v.relayOperator as string,
    channel: v.channel as string,
    chaincode: v.chaincode as string,
    electionId: v.electionId as string,
    ...(v.title !== undefined ? { title: v.title as string } : {}),
    issuerKeyHash: v.issuerKeyHash as string,
    curve: "FP256BN_AMCL",
    endorsers,
    ...(v.explorerUrl ? { explorerUrl: trim(v.explorerUrl) } : {}),
  };
}
