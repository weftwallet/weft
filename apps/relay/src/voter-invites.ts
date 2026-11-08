/**
 * Experimental (docs/adr/0008, D8 of step 5): the voter invites the
 * election's relay serves, one per election, from the folder
 * WEFT_VOTER_INVITES. Each file is <election>.json and holds a VoterInvite.
 * They are read and checked once, at startup, as the organisation's invite is.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { VoterInvite } from "@weftwallet/protocol";

/** The route the relay serves voter invites on; the file name is <election>.json. */
export const VOTER_INVITE_ROUTE = "/.well-known/weft-voter-invite/:file";

const HEX64 = /^[0-9a-f]{64}$/;

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

/**
 * Checks one voter invite and returns it with only the fields the type
 * names. Throws an Error that says what is wrong with it, naming `source`.
 */
export function parseVoterInvite(value: unknown, source: string): VoterInvite {
  const bad = (problem: string) => new Error(`${source} isn't a voter invite Weft Experimental can use: ${problem}.`);
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
  if (!text(v.issuerKeyHash) || !HEX64.test(v.issuerKeyHash)) throw bad('"issuerKeyHash" must be 64 lowercase hex characters');
  if (v.curve !== "FP256BN_AMCL") throw bad('"curve" must be FP256BN_AMCL');
  if (!Array.isArray(v.endorsers) || v.endorsers.length === 0) throw bad('"endorsers" must list at least one organisation');
  const endorsers = v.endorsers.map((e: unknown, i: number) => {
    const o = (e ?? {}) as Record<string, unknown>;
    if (!text(o.mspId)) throw bad(`endorsers[${i}] has no "mspId"`);
    if (!text(o.caChain) || !o.caChain.includes("BEGIN CERTIFICATE")) throw bad(`endorsers[${i}]'s "caChain" must be PEM`);
    return { mspId: o.mspId, caChain: o.caChain };
  });
  return {
    weftVoterInvite: 1,
    network: v.network as string,
    organization: v.organization as string,
    mspId: v.mspId as string,
    affiliation: v.affiliation as string,
    caUrl: v.caUrl as string,
    ...(v.caName ? { caName: v.caName as string } : {}),
    relayUrl: v.relayUrl as string,
    relayOperator: v.relayOperator as string,
    channel: v.channel as string,
    chaincode: v.chaincode as string,
    electionId: v.electionId as string,
    issuerKeyHash: v.issuerKeyHash as string,
    curve: "FP256BN_AMCL",
    endorsers,
    ...(v.explorerUrl ? { explorerUrl: v.explorerUrl as string } : {}),
  };
}

/**
 * Reads every <election>.json in `dir`. A voter invite is for an election
 * with voter credentials, so the folder is refused without
 * WEFT_EXPERIMENTAL=1, and each invite must name one of the voter MSPs the
 * relay accepts idemix signers from: an invite for another MSP would send
 * voters to a relay that refuses their ballots.
 */
export function loadVoterInvites(
  dir: string | undefined,
  { experimental, idemixMspIds }: { experimental: boolean; idemixMspIds: string[] },
): Map<string, VoterInvite> {
  const invites = new Map<string, VoterInvite>();
  if (!dir) return invites;
  if (!experimental) {
    throw new Error(
      "WEFT_VOTER_INVITES is set, but the relay serves voter invites only when it's started with WEFT_EXPERIMENTAL=1. Set WEFT_EXPERIMENTAL=1, or remove WEFT_VOTER_INVITES.",
    );
  }
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  } catch (error) {
    throw new Error(`The relay couldn't read WEFT_VOTER_INVITES, ${dir}: ${(error as NodeJS.ErrnoException).code ?? String(error)}.`);
  }
  for (const file of files) {
    const path = join(dir, file);
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      throw new Error(`${path} isn't JSON: ${error instanceof Error ? error.message : String(error)}.`);
    }
    const invite = parseVoterInvite(json, path);
    if (`${invite.electionId}.json` !== file) {
      throw new Error(`${path} is the voter invite for ${invite.electionId}, so its file must be named ${invite.electionId}.json.`);
    }
    if (!idemixMspIds.includes(invite.mspId)) {
      throw new Error(
        `${path} names ${invite.mspId}, which isn't in WEFT_IDEMIX_MSP_IDS, so this relay would refuse its voters' ballots. Add ${invite.mspId} to WEFT_IDEMIX_MSP_IDS, or remove the invite.`,
      );
    }
    invites.set(invite.electionId, invite);
  }
  return invites;
}
