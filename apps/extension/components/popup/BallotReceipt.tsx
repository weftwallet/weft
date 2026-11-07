/**
 * Weft Experimental (docs/adr/0007): a kept version 2 receipt in a ballot's
 * transaction detail. The tracking code is public and is the whole receipt;
 * the voter's note of the choice is hidden until Show, opens only while Weft
 * is unlocked, and proves nothing to anyone else. Reached only from code
 * behind EXPERIMENTAL.
 */
import type { BallotReceiptV2 } from "@weftwallet/protocol";
import { useState } from "react";
import { ui } from "../../lib/messages";
import { useFeedback } from "../feedback";
import { SaveReceipt } from "../receipt";
import { Button, Icon, shorten, toErrorInfo } from "../ui";

/** The explorer's election page, at the ballot with this tracking code. Nothing in it is secret. */
export function trackingUrl(explorerUrl: string, receipt: Pick<BallotReceiptV2, "channel" | "electionId" | "tracking">): string {
  const page = new URL(
    `${explorerUrl.replace(/\/+$/, "")}/channels/${encodeURIComponent(receipt.channel)}/elections/${encodeURIComponent(receipt.electionId)}`,
  );
  page.searchParams.set("tracking", receipt.tracking);
  page.hash = "receipt";
  return page.toString();
}

export function BallotReceiptCard({
  id,
  receipt,
  choice,
  explorerUrl,
  keptSince,
  onRemoved,
}: {
  id: string;
  receipt: BallotReceiptV2;
  choice: string;
  explorerUrl?: string;
  keptSince: string;
  onRemoved: () => void;
}) {
  const { confirm, toast } = useFeedback();
  const [show, setShow] = useState(false);

  const remove = async () => {
    const ok = await confirm({
      title: "Remove this receipt?",
      body: (
        <>
          <p className="sheet__para">
            Weft deletes the tracking code and your note of the choice for <span className="mono">{receipt.electionId}</span> from this browser.
            Your vote stays on the ledger, and in the totals.
          </p>
          <p className="flat muted">Without the receipt, or a copy you saved, you can't look up your ballot by its tracking code.</p>
        </>
      ),
      confirmLabel: "Remove",
      icon: "trash",
    });
    if (!ok) return;
    try {
      await ui("receiptRemove", { id });
      toast("Receipt removed");
      onRemoved();
      requestAnimationFrame(() => document.querySelector<HTMLElement>(".screen h1")?.focus({ preventScroll: true }));
    } catch (e) {
      toast(`Couldn't remove the receipt. ${toErrorInfo(e).message}`, "error");
    }
  };

  return (
    <div className="stack arrive">
      <section className="args" aria-labelledby="receipt-heading">
        <div className="args__heading row-between">
          <h2 id="receipt-heading" className="eyebrow">
            Receipt
          </h2>
          <span className="subtle type-xs">Ballot receipt, version 2</span>
        </div>
        <div className="args__row">
          <span className="subtle args__key">Election</span>
          <span className="args__value">{receipt.electionId}</span>
        </div>
        <div className="args__row">
          <span className="subtle args__key">Tracking code</span>
          <span className="args__value" title={receipt.tracking}>
            {shorten(receipt.tracking)}
          </span>
        </div>
        <div className="args__row args__private">
          <span className="subtle">Your note, only in Weft</span>
          <button type="button" className="args__reveal" aria-pressed={show} onClick={() => setShow(!show)}>
            <Icon name={show ? "eyeOff" : "eye"} size={16} />
            {show ? "Hide" : "Show"}
          </button>
        </div>
        <div className="args__row">
          <span className="subtle args__key">Your choice</span>
          {show ? (
            <span className="args__value">{choice}</span>
          ) : (
            <span className="subtle">
              <span aria-hidden="true">••••••</span>
              <span className="visually-hidden">Hidden</span>
            </span>
          )}
        </div>
        <SaveReceipt receipt={receipt} copied="Copied. It holds the tracking code, not your choice.">
          {explorerUrl && (
            <Button className="btn btn--sm" icon="external" iconSize={16} onClick={() => void window.open(trackingUrl(explorerUrl, receipt), "_blank", "noopener")}>
              Check in the explorer
            </Button>
          )}
        </SaveReceipt>
      </section>
      <p className="subtle type-xs flat">The receipt holds the tracking code, not your choice. The note is for you: it proves nothing to anyone else.</p>
      <div className="row-between type-xs">
        <span className="subtle">Kept since {keptSince}.</span>
        <button type="button" className="link-btn link-btn--inline danger-text" onClick={() => void remove()}>
          Remove receipt
        </button>
      </div>
    </div>
  );
}
