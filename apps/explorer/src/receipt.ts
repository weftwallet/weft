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
 * (pages.ts), so it refers to nothing outside itself. Weft returns the same
 * receipt to a voting app, and keeps it when the voter asks (docs/adr/0006).
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

/**
 * A receipt's choice and salt handed to the election page by the page that
 * opened it (docs/adr/0006), instead of in the address, which the browser's
 * history would keep. The opener opens this page with only `tx` and
 * `commitment` in the address; this page posts a "ready", which carries
 * nothing, to window.opener; the opener answers with
 *
 *   { "type": "weft-receipt-check:receipt", "version": 1,
 *     "electionId": "board-2026", "txId": "…", "option": "Ada", "salt": "…" }
 *
 * posted to this explorer's exact origin. acceptHandoff says whether to use
 * an answer: the choice and salt from it, or null to ignore it.
 *
 * Who may answer: the origins in `trusted` (Weft Playground where the Weft
 * products are, and any the operator adds with WEFT_EXPLORER_RECEIPT_ORIGINS),
 * and any browser extension's page. An extension's origin can't be known in
 * advance: Firefox gives each installation of an add-on its own random
 * moz-extension:// address, and a build loaded by hand has its own Chrome ID.
 * Accepting any extension adds nothing an extension couldn't do already,
 * since one with access to this site can script the page itself. And what
 * an answer can do is small: it fills the local check's two fields, which
 * hash them in the browser and compare with the commitment the ledger holds,
 * so it can't make a wrong receipt check out, and nothing goes back. The
 * list keeps other web pages from opening this one with a choice and salt
 * of their own, to show a voter a result that doesn't match.
 *
 * Only data shaped as this receipt's answer is used: for this election and
 * this transaction, with a choice and a salt as the ballot contract takes
 * them, and nothing else. Like readReceipt, the election page inlines its
 * source (pages.ts), so it refers to nothing outside itself.
 */
export function acceptHandoff(
  message: { origin: string; data: unknown },
  page: { electionId: string; txId: string; trusted: string[] },
): { option: string; salt: string } | null {
  const extension = /^(chrome|moz)-extension:\/\/[a-z0-9-]+$/.test(message.origin);
  if (!extension && page.trusted.indexOf(message.origin) < 0) return null;
  const d: any = message.data;
  if (!d || typeof d !== "object" || Array.isArray(d)) return null;
  const keys = Object.keys(d).sort().join(",");
  if (keys !== "electionId,option,salt,txId,type,version") return null;
  if (d.type !== "weft-receipt-check:receipt" || d.version !== 1) return null;
  if (d.electionId !== page.electionId) return null;
  if (typeof d.txId !== "string" || d.txId.trim().toLowerCase() !== page.txId.trim().toLowerCase()) return null;
  if (typeof d.option !== "string" || d.option.length < 1 || d.option.length > 200) return null;
  if (typeof d.salt !== "string" || !/^[0-9a-f]{32,128}$/.test(d.salt)) return null;
  return { option: d.option, salt: d.salt };
}

/**
 * A version 2 receipt (docs/adr/0007, cast-ballot.md), for a private
 * election's Check your tracking code form, from a file, a drop or a paste:
 *
 *   { "type": "weft-ballot-receipt", "version": 2, "channel": "privatevote-budget-2027",
 *     "electionId": "budget-2027", "txId": "…", "blockNumber": 41, "tracking": "…" }
 *
 * It holds no choice and no randomness, so it fills only the tracking code.
 * Like readReceipt, the page inlines its source (private-pages.ts), so it
 * refers to nothing outside itself.
 */
export function readTrackingReceipt(text: string, electionId: string): { ok: true; tracking: string } | { ok: false; message: string } {
  let r: any;
  try {
    r = JSON.parse(text);
  } catch {
    return { ok: false, message: "Weft Explorer couldn't read that file. Choose the receipt Weft saved, a .json file." };
  }
  if (!r || typeof r !== "object" || Array.isArray(r)) return { ok: false, message: "That file isn't a ballot receipt. It has no tracking code." };
  if (r.type !== undefined && r.type !== "weft-ballot-receipt") return { ok: false, message: "That file isn't a ballot receipt. Choose the receipt Weft saved." };
  if (r.version === 1 || (r.version === undefined && r.commitment !== undefined)) {
    return { ok: false, message: "That's a version 1 receipt, for an election on the ballot contract. This election's receipts are version 2 and carry a tracking code." };
  }
  if (r.version !== 2) {
    return { ok: false, message: typeof r.version === "number" ? `That receipt is version ${r.version}. This explorer reads version 2 receipts for private elections.` : "That file isn't a ballot receipt. It has no tracking code." };
  }
  const election = typeof r.electionId === "string" ? r.electionId.trim() : "";
  if (election && election !== electionId) return { ok: false, message: `That receipt is for ${election}, not this election. Open ${election}'s page to check it.` };
  const tracking = typeof r.tracking === "string" ? r.tracking.trim().toLowerCase() : "";
  if (!tracking) return { ok: false, message: "That file isn't a ballot receipt. It has no tracking code." };
  if (!/^[0-9a-f]{64}$/.test(tracking)) return { ok: false, message: "That receipt's tracking code isn't 64 characters, 0 to 9 and a to f." };
  return { ok: true, tracking };
}
