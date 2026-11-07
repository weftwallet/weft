/**
 * Ballot receipts in Weft's own pages (docs/adr/0006): saving one as a file
 * or as text, in the approval window when the browser refused to keep it,
 * and in a transaction's detail when it is kept.
 */
import { receiptFileName, receiptJson } from "@weftwallet/core";
import type { BallotReceipt, BallotReceiptV2 } from "@weftwallet/protocol";
import { useState, type ReactNode } from "react";
import { Button } from "./ui";

/** A version 1 receipt, or Weft Experimental's version 2 (docs/adr/0007). */
type AnyReceipt = BallotReceipt | BallotReceiptV2;

/** The receipt as the file and the copied text hold it. */
const receiptText = (receipt: AnyReceipt) => (receipt.version === 1 ? receiptJson(receipt) : JSON.stringify(receipt, null, 2));

/** Saves the receipt as the JSON file the explorer reads. Returns its name. */
export function downloadReceipt(receipt: AnyReceipt): string {
  const name = receiptFileName(receipt);
  const url = URL.createObjectURL(new Blob([receiptText(receipt)], { type: "application/json" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.hidden = true;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return name;
}

/** What the last Download or Copy did, for the status line under the buttons. */
export interface SavedLine {
  text: string;
  ok: boolean;
}

/**
 * Download receipt and Copy receipt, side by side, and the line that says
 * where the receipt went. `copied` is the line after a copy. No icons: at
 * 360 wide the two labels fit on one line only without them.
 */
export function SaveReceipt({
  receipt,
  copied,
  children,
}: {
  receipt: AnyReceipt;
  copied: string;
  /** More actions, under the pair (Check in the explorer). */
  children?: ReactNode;
}) {
  const [saved, setSaved] = useState<SavedLine | null>(null);
  return (
    <>
      <div className="receipt-actions">
        <div className="receipt-actions__pair">
          <Button className="btn btn--sm" onClick={() => setSaved({ text: `Downloaded as ${downloadReceipt(receipt)}.`, ok: true })}>
            Download receipt
          </Button>
          <Button
            className="btn btn--sm"
            onClick={() =>
              void navigator.clipboard.writeText(receiptText(receipt)).then(
                () => setSaved({ text: copied, ok: true }),
                () => setSaved({ text: "This browser didn't allow copying. Use Download receipt instead.", ok: false }),
              )
            }
          >
            Copy receipt
          </Button>
        </div>
        {children}
      </div>
      <p className={`field__status receipt-status ${saved ? (saved.ok ? "field-ok" : "field-error") : ""}`} role="status">
        {saved?.text}
      </p>
    </>
  );
}

/** A salt in groups of four, so it can be read aloud or compared by eye. */
export function GroupedHex({ value }: { value: string }) {
  return (
    <span className="args__value grouped">
      {(value.match(/.{1,4}/g) ?? []).map((g, i) => (
        <span key={i}>{g}</span>
      ))}
    </span>
  );
}
