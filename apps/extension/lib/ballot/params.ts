/**
 * Experimental (docs/adr/0007): the params of weft_castBallot, checked in
 * the background worker before any window opens. Pure, so it is tested
 * without a browser. Reached only from code behind EXPERIMENTAL.
 */

import { ErrorCode, WeftError, type CastBallotParams } from "@weftwallet/protocol";

const FIELDS = ["channel", "chaincode", "electionId"] as const;

/** As the contract's CreateElection requires. */
const ELECTION_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Fabric's rule for channel names: lowercase letters, digits, dots and dashes, starting with a letter, under 250 characters. */
const CHANNEL = /^[a-z][a-z0-9.-]{0,248}$/;

/** Fabric's rule for chaincode names. */
const CHAINCODE = /^[a-zA-Z0-9]+([-_][a-zA-Z0-9]+)*$/;

/**
 * The params as Weft uses them, or InvalidParams naming the field. The
 * request carries no choice, so a field such as "choice" or "ballot" is
 * refused rather than ignored: a site that sends one would otherwise think
 * it had chosen for the voter.
 */
export function checkCastBallotParams(params: unknown): CastBallotParams {
  const bad = (message: string): never => {
    throw new WeftError(ErrorCode.InvalidParams, message);
  };
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    bad('weft_castBallot takes an object with "channel", "chaincode" and "electionId".');
  }
  const p = params as Record<string, unknown>;
  const extra = Object.keys(p).filter((k) => !(FIELDS as readonly string[]).includes(k));
  if (extra.length > 0) {
    bad(`weft_castBallot takes only "channel", "chaincode" and "electionId", not "${extra.sort()[0]}". The voter chooses in Weft.`);
  }
  for (const field of FIELDS) {
    if (p[field] === undefined) bad(`The "${field}" parameter is required.`);
    if (typeof p[field] !== "string") bad(`The "${field}" parameter must be a string.`);
  }
  const { channel, chaincode, electionId } = p as Record<(typeof FIELDS)[number], string>;
  if (!CHANNEL.test(channel)) bad(`The "channel" parameter isn't a Fabric channel name: lowercase letters, digits, dots and dashes, starting with a letter.`);
  if (!CHAINCODE.test(chaincode)) bad(`The "chaincode" parameter isn't a Fabric contract name: letters and digits, joined by - or _.`);
  if (!ELECTION_ID.test(electionId)) bad(`The "electionId" parameter must be 1 to 64 letters, digits, - or _.`);
  return { channel, chaincode, electionId };
}
