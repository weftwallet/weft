/**
 * A ballot receipt file, as a voting app saves it (Weft Playground's
 * Download receipt) and the election page's Check your receipt form reads
 * it, from a file, a drop or a paste:
 *
 *   { "type": "weft-ballot-receipt", "version": 1, "channel": "mychannel",
 *     "electionId": "board-2026", "txId": "…", "blockNumber": 85,
 *     "commitment": "…", "option": "Ada", "salt": "…" }
 *
 * Receipts copied before type, version and channel were added are read too.
 * readReceipt runs in the browser: the election page inlines its source
 * (pages.ts), so it refers to nothing outside itself.
 */

export const RECEIPT_TYPE = "weft-ballot-receipt";

export type ReceiptRead =
  | { ok: true; txId: string; commitment: string; option: string | null; salt: string | null }
  | { ok: false; message: string };

/** Reads a receipt's text for the election `electionId`, or says plainly why it can't. */
export function readReceipt(text: string, electionId: string): ReceiptRead {
  const unreadable = "Weft Explorer couldn't read that file. Choose the receipt your voting app saved, a .json file.";
  let r: any;
  try {
    r = JSON.parse(text);
  } catch {
    return { ok: false, message: unreadable };
  }
  const noIds = "That file isn't a ballot receipt. It has no transaction ID or commitment.";
  if (!r || typeof r !== "object" || Array.isArray(r)) return { ok: false, message: noIds };
  if (r.type !== undefined && r.type !== "weft-ballot-receipt") {
    return { ok: false, message: "That file isn't a ballot receipt. Choose the receipt your voting app saved." };
  }
  if (r.version !== undefined && r.version !== 1) {
    return {
      ok: false,
      message:
        typeof r.version === "number"
          ? `That receipt is version ${r.version}. This explorer reads version 1 receipts only.`
          : "That file isn't a ballot receipt. Choose the receipt your voting app saved.",
    };
  }
  const given = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
  const txId = given(r.txId);
  const commitment = given(r.commitment);
  if (!txId || !commitment) return { ok: false, message: noIds };
  const election = given(r.electionId);
  if (election && election !== electionId) {
    return { ok: false, message: `That receipt is for ${election}, not this election. Open ${election}'s page to check it.` };
  }
  return { ok: true, txId, commitment, option: given(r.option), salt: given(r.salt) };
}
