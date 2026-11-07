/**
 * Check in the explorer, for a receipt Weft keeps (docs/adr/0006). A small
 * window, as for passkeys: the popup closes as soon as another page takes
 * focus, and this page has to stay open to answer the explorer.
 *
 * It opens the network's explorer on the election with only the transaction
 * and the commitment in the address, both public. Once the explorer's page
 * has loaded it asks its opener for the choice and salt (RECEIPT_HANDOFF.ready);
 * this page answers that window only, at the explorer's exact origin, then
 * closes. The choice and salt never go in an address, so the browser's
 * history never records them.
 */
import "reflect-metadata";
import { RECEIPT_HANDOFF, type ReceiptHandoff } from "@weftwallet/protocol";
import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { browser } from "wxt/browser";
import "../../assets/app.css";
import { FeedbackProvider } from "../../components/feedback";
import { Unlock } from "../../components/lock";
import { SaveReceipt } from "../../components/receipt";
import { ActionError, Button, Splash, StatusScreen, WeaveMark, toErrorInfo, tokenMs, type ErrorInfo } from "../../components/ui";
import { ui } from "../../lib/messages";
import type { ReceiptView as AnyReceiptView } from "../../lib/receipts";

/** A version 1 receipt: the only kind whose choice and salt this window hands over. */
type ReceiptView = Extract<AnyReceiptView, { receipt: { version: 1 } }>;
import type { VaultStatus } from "../../lib/vault";

const id = new URLSearchParams(location.search).get("id") ?? "";

/** How long the explorer may take to ask before this page says what might be wrong. */
const SLOW_MS = 20_000;

type Stage = "opening" | "blocked" | "waiting" | "sent" | "closed";

/** The election page, with only public values in its address. */
function electionPage(view: ReceiptView): URL {
  const r = view.receipt;
  const url = new URL(`${view.explorerUrl}/channels/${encodeURIComponent(r.channel)}/elections/${encodeURIComponent(r.electionId)}`);
  url.search = new URLSearchParams({ tx: r.txId, commitment: r.commitment }).toString();
  url.hash = "receipt";
  return url;
}

function CheckReceipt() {
  const [vault, setVault] = useState<VaultStatus | null>(null);
  const [view, setView] = useState<ReceiptView | null | undefined>(undefined);
  const [error, setError] = useState<ErrorInfo | null>(null);
  const [stage, setStage] = useState<Stage>("opening");
  const [slow, setSlow] = useState(false);
  const [unlockHeld, setUnlockHeld] = useState(false);
  const target = useRef<Window | null>(null);
  // Opened once on arrival, however often React runs the effect.
  const started = useRef(false);

  const loadVault = () => void ui("vaultStatus").then(setVault, (e: unknown) => setError(toErrorInfo(e)));
  useEffect(() => {
    loadVault();
    // Weft can lock while this window is open.
    const onChange = (_c: unknown, area: string) => area === "session" && loadVault();
    browser.storage.onChanged.addListener(onChange);
    return () => browser.storage.onChanged.removeListener(onChange);
  }, []);

  // The receipt is opened only while Weft is unlocked, and dropped when it locks.
  const unlocked = vault?.state === "unlocked" && !unlockHeld;
  useEffect(() => {
    if (!unlocked) return setView(undefined);
    ui("receiptGet", { id }).then((v) => setView(v && v.receipt.version === 1 ? (v as ReceiptView) : null), (e: unknown) => setError(toErrorInfo(e)));
  }, [unlocked]);

  const page = view?.explorerUrl ? electionPage(view) : null;
  const open = () => {
    if (!page) return;
    setSlow(false);
    // Not noopener: the explorer's page asks this one for the choice and salt.
    const opened = window.open(page.toString(), "_blank");
    target.current = opened;
    setStage(opened ? "waiting" : "blocked");
  };
  useEffect(() => {
    if (!view || !page || started.current) return;
    started.current = true;
    open();
  }, [view]);

  // The answer goes to the window this page opened, at the explorer's origin,
  // and only once it has asked. The explorer sends nothing else back.
  useEffect(() => {
    if (!view || !page) return;
    const onMessage = (e: MessageEvent) => {
      if (stage !== "waiting" || !target.current || e.source !== target.current || e.origin !== page.origin) return;
      const data = e.data as { type?: unknown; version?: unknown } | null;
      if (data?.type !== RECEIPT_HANDOFF.ready || data.version !== 1) return;
      const r = view.receipt;
      const handoff: ReceiptHandoff = { type: RECEIPT_HANDOFF.receipt, version: 1, electionId: r.electionId, txId: r.txId, option: r.option, salt: r.salt };
      target.current.postMessage(handoff, page.origin);
      setStage("sent");
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [view, stage]);

  // While waiting: notice the explorer's page closing, and say so if it takes a while.
  useEffect(() => {
    if (stage !== "waiting") return;
    const slowTimer = setTimeout(() => setSlow(true), SLOW_MS);
    const watch = setInterval(() => target.current?.closed && setStage("closed"), 500);
    return () => {
      clearTimeout(slowTimer);
      clearInterval(watch);
    };
  }, [stage]);

  useEffect(() => {
    if (stage !== "sent") return;
    const t = setTimeout(() => window.close(), tokenMs("--weft-hold-after-done", 1400));
    return () => clearTimeout(t);
  }, [stage]);

  const mark = <WeaveMark size={64} mode="still" />;
  if (error) {
    return (
      <StatusScreen mark={mark} title="Weft couldn't open this receipt" detail="Nothing was sent to the explorer.">
        <div className="status-screen__actions">
          <ActionError error={{ message: error.message, ...(error.detail ? { detail: error.detail } : {}) }} />
          <button type="button" className="btn" onClick={() => window.close()}>
            Close
          </button>
        </div>
      </StatusScreen>
    );
  }
  if (!vault) return <Splash label="Opening your receipt" />;
  if (vault.state !== "unlocked" || unlockHeld) {
    return (
      <div className="screen fade-in">
        <Unlock
          status={vault}
          passkey="inline"
          subtitle="Unlock to check your receipt in the explorer."
          onUnlocked={loadVault}
          onHold={setUnlockHeld}
          onCancel={() => window.close()}
          cancelLabel="Close"
        />
      </div>
    );
  }
  if (view === undefined) return <Splash label="Opening your receipt" />;
  if (view === null || !page) {
    return (
      <StatusScreen
        mark={mark}
        title={view === null ? "This receipt is no longer in Weft" : "This network has no explorer"}
        detail={
          view === null
            ? "It was removed, with its identity or on its own. Nothing was sent."
            : "Its invite doesn't name an explorer, so there is nowhere to check the receipt from Weft. Download it and check it where the election is published."
        }
      >
        <div className="status-screen__actions">
          {view && <SaveReceipt receipt={view.receipt} copied="Copied. It includes your choice and salt." />}
          <button type="button" className="btn" onClick={() => window.close()}>
            Close
          </button>
        </div>
      </StatusScreen>
    );
  }

  const host = page.host;
  const titles: Record<Stage, string> = {
    opening: "Opening the explorer",
    blocked: "Open the explorer",
    waiting: "Waiting for the explorer",
    sent: "Sent to the explorer",
    closed: "The explorer's page closed",
  };
  const details: Record<Stage, string> = {
    opening: `Weft opens ${host} on ${view.receipt.electionId}.`,
    blocked: `The browser didn't let Weft open ${host}. Weft gives your choice and salt to that page, never to its address.`,
    waiting: slow
      ? `${host} hasn't asked for your choice and salt yet. It asks once it has found your transaction, so if it can't find it yet, reload that page after the next block.`
      : `Weft gives your choice and salt to ${host}'s election page when it asks, and to no other page.`,
    sent: `${host} checks your choice and salt in your browser. This window closes on its own.`,
    closed: "It closed before it asked for your choice and salt, so Weft sent nothing.",
  };
  return (
    <StatusScreen mark={mark} title={titles[stage]} detail={details[stage]}>
      {stage !== "sent" && stage !== "opening" && (
        <div className="status-screen__actions">
          {(stage === "blocked" || stage === "closed") && (
            <Button className="btn btn--primary" icon="external" onClick={open}>
              {stage === "closed" ? "Open the explorer again" : "Open the explorer"}
            </Button>
          )}
          {stage === "waiting" && slow && (
            <SaveReceipt receipt={view.receipt} copied="Copied. Paste it into the explorer's Check your receipt." />
          )}
          <button type="button" className="btn" onClick={() => window.close()}>
            {stage === "waiting" ? "Stop and close" : "Close"}
          </button>
        </div>
      )}
    </StatusScreen>
  );
}

document.body.classList.add("window");
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <FeedbackProvider>
      <CheckReceipt />
    </FeedbackProvider>
  </StrictMode>,
);
