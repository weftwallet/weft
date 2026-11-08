/**
 * Weft Experimental only (docs/adr/0008): Join from an invite reads either
 * kind of invite. A document with "weftVoterInvite" is a voter invite,
 * checked as the election's relay checks it; anything else is read as an
 * organisation's invite, as in Weft.
 */
import { InviteError, fetchInviteDocument, isVoterInviteDocument, parseInvite, parseVoterInvite } from "@weftwallet/core";
import type { OrgInvite, VoterInvite } from "@weftwallet/protocol";

export async function fetchAnyInvite(link: string, fetchImpl: typeof fetch = fetch): Promise<OrgInvite | VoterInvite> {
  const { json } = await fetchInviteDocument(link, fetchImpl);
  if (isVoterInviteDocument(json)) {
    try {
      return parseVoterInvite(json);
    } catch (error) {
      if (!(error instanceof InviteError)) throw error;
      throw new InviteError(
        "This voter invite has mistakes in it, so Weft Experimental can't use it. Ask the election's organisers for a new one.",
        error.detail ?? error.message,
      );
    }
  }
  try {
    return parseInvite(json);
  } catch (error) {
    if (!(error instanceof InviteError)) throw error;
    throw new InviteError("This invite has mistakes in it, so Weft can't use it. Ask your administrator for a new one.", error.message);
  }
}

export function isVoterInvite(invite: OrgInvite | VoterInvite): invite is VoterInvite {
  return "weftVoterInvite" in invite;
}
