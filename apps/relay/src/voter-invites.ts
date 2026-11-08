/**
 * Experimental (docs/adr/0008, D8 of step 5): the voter invites the
 * election's relay serves, one per election, from the folder
 * WEFT_VOTER_INVITES. Each file is <election>.json and holds a VoterInvite.
 * They are read and checked at startup, as the organisation's invite is,
 * with @weftwallet/core's parseVoterInvite, the check Weft Experimental makes
 * when a voter opens one. A file added to the folder later, for an election
 * created after the relay started, is read and checked the same way when it
 * is first asked for (lateVoterInvite).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseVoterInvite } from "@weftwallet/core";
import type { VoterInvite } from "@weftwallet/protocol";

/** The route the relay serves voter invites on; the file name is <election>.json. */
export const VOTER_INVITE_ROUTE = "/.well-known/weft-voter-invite/:file";

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
  for (const file of files) invites.set(file.replace(/\.json$/, ""), readVoterInvite(dir, file, idemixMspIds));
  return invites;
}

/** Reads and checks one <election>.json in `dir`, with the same rules as at startup. */
export function readVoterInvite(dir: string, file: string, idemixMspIds: string[]): VoterInvite {
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
  return invite;
}

/**
 * A voter invite that wasn't in the folder at startup: read and checked now,
 * and kept, if the folder has it. Returns null when it doesn't, and throws
 * with the reason when the file fails a check, so the relay can log it.
 */
export function lateVoterInvite(dir: string | undefined, id: string, invites: Map<string, VoterInvite>, idemixMspIds: string[]): VoterInvite | null {
  if (!dir || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) || !existsSync(join(dir, `${id}.json`))) return null;
  const invite = readVoterInvite(dir, `${id}.json`, idemixMspIds);
  invites.set(id, invite);
  return invite;
}
