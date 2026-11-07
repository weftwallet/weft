import { useEffect, useState } from "react";
import { browser } from "wxt/browser";
import type { ActivityRecord } from "../../lib/db";
import { ui, type WalletState } from "../../lib/messages";
import type { ReceiptView } from "../../lib/receipts";
import { CopyButton, useCopy, useFeedback } from "../feedback";
import { GroupedHex, SaveReceipt } from "../receipt";
import { ActionError, BackHeader, Button, Empty, ErrorDetails, Icon, Splash, shorten, timeAgo, toErrorInfo, type ErrorInfo } from "../ui";
import { BallotReceiptCard } from "./BallotReceipt";
import type { Navigate } from "./state";

const HEADLINE = {
  committed: { color: "var(--weft-accent-text)", text: "Committed to the ledger" },
  evaluated: { color: "var(--weft-text-muted)", text: "Read only" },
  failed: { color: "var(--weft-danger-text)", text: "Failed, nothing written" },
  rejected: { color: "var(--weft-text-subtle)", text: "Rejected by you" },
} as const;

export function TxDetail({ state, activityId, navigate }: { state: WalletState; activityId: string; navigate: Navigate }) {
  const copy = useCopy();
  const [item, setItem] = useState<ActivityRecord | null | undefined>(undefined);
  const [error, setError] = useState<ErrorInfo | null>(null);
  const load = () => {
    setError(null);
    ui("activityItem", { id: activityId }).then(setItem, (e: unknown) => setError(toErrorInfo(e)));
  };
  useEffect(load, [activityId]);

  const back = () => navigate({ name: "home" });
  if (error) {
    return (
      <>
        <BackHeader title="Transaction" onBack={back} />
        <main className="page">
          <ActionError error={{ ...error, message: "Weft couldn't load this transaction." }}>
            <button type="button" className="link-btn link-btn--inline" onClick={load}>
              Try again
            </button>
          </ActionError>
        </main>
      </>
    );
  }
  if (item === undefined) {
    return (
      <>
        <BackHeader title="Transaction" onBack={back} />
        <Splash label="Loading the transaction" />
      </>
    );
  }
  if (item === null) {
    return (
      <>
        <BackHeader title="Transaction" onBack={back} />
        <main className="page">
          <Empty icon="activity" action={{ label: "Back to activity", onClick: back }}>
            This transaction is no longer in your activity.
          </Empty>
        </main>
      </>
    );
  }

  const identity = state.identities.find((i) => i.id === item.identityId);
  const head = HEADLINE[item.status];
  // Only transactions that reached a block are in the explorer.
  const explorer = state.networks.find((n) => n.id === identity?.networkId)?.explorerUrl;
  const explorerLink =
    explorer && item.transactionId && item.blockNumber
      ? `${explorer}/channels/${encodeURIComponent(item.call.channel)}/transactions/${encodeURIComponent(item.transactionId)}`
      : null;
  const technical = item.status === "failed" && (item.code || item.raw || (item.endorsers && item.endorsers.length > 0));

  return (
    <>
      <BackHeader title="Transaction" onBack={back} />
      <main className="page stack--loose">
        <div className="stack">
          <div className="inline">
            <span className="dot" style={{ background: head.color }} aria-hidden="true" />
            <span className="strong" style={{ color: head.color }}>
              {head.text}
            </span>
          </div>
          <div className="mono card__title wrap-anywhere">{item.call.fn}</div>
        </div>

        {item.receipt && <ReceiptCard key={item.id} item={item} state={state} onRemoved={load} />}

        {item.status === "failed" && (
          <section className="notice notice--signal notice--column">
            <div className="strong">{item.title}</div>
            <div className="text">{item.detail}</div>
            {technical && (
              <ErrorDetails>
                {item.code && <div>{item.code}</div>}
                {item.raw && <div>{item.raw}</div>}
                {item.endorsers?.map((e, i) => (
                  <div key={i}>
                    {e.mspId ?? e.address ?? "peer"}: {e.message}
                  </div>
                ))}
              </ErrorDetails>
            )}
          </section>
        )}

        <dl className="details">
          {item.transactionId && (
            <>
              <dt>Transaction ID</dt>
              <dd className="mono details__with-button">
                <span title={item.transactionId}>{shorten(item.transactionId)}</span>
                <CopyButton text={item.transactionId} label="Copy transaction ID" size={14} />
              </dd>
            </>
          )}
          <dt>Site</dt>
          <dd>{new URL(item.origin).host}</dd>
          <dt>Channel</dt>
          <dd className="mono">{item.call.channel}</dd>
          <dt>Contract</dt>
          <dd className="mono">
            {item.call.chaincode}
            {item.call.contract ? ` / ${item.call.contract}` : ""}
          </dd>
          {(item.call.args ?? []).length > 0 && (
            <>
              <dt>Arguments</dt>
              <dd className="mono tx-args">
                {(item.call.args ?? []).map((arg, i) => (
                  <div key={i} className="tx-arg">
                    <span className="subtle" aria-hidden="true">
                      {i}
                    </span>
                    <span className="tx-arg__value">{arg}</span>
                  </div>
                ))}
              </dd>
            </>
          )}
          {item.privateInputs && item.privateInputs.length > 0 && (
            <>
              <dt>Private</dt>
              <dd>
                <span className="mono">{item.privateInputs.join(", ")}</span>{" "}
                <span className="subtle">{item.receipt ? "(kept in the receipt)" : "(values not kept)"}</span>
              </dd>
            </>
          )}
          <dt>Signed by</dt>
          <dd>
            {identity ? (
              <>
                <span className="block">{identity.name}</span>
                <span className="mono muted type-xs">{identity.mspId}</span>
              </>
            ) : (
              <span className="muted">A removed identity</span>
            )}
          </dd>
          <dt>Block</dt>
          <dd className={item.blockNumber ? "mono" : "muted"}>{item.blockNumber ?? "None"}</dd>
          <dt>When</dt>
          <dd>
            {timeAgo(item.at)} <span className="subtle">· {new Date(item.at).toLocaleString()}</span>
          </dd>
        </dl>
      </main>
      {item.transactionId && (
        <footer className={explorerLink ? "footer" : "footer footer--single"}>
          <Button icon="copy" onClick={() => void copy(item.transactionId!, "Transaction ID copied")}>
            {explorerLink ? "Copy ID" : "Copy transaction ID"}
          </Button>
          {explorerLink && (
            <a className="btn btn--primary" href={explorerLink} target="_blank" rel="noreferrer">
              <Icon name="external" size={18} /> Explorer
            </a>
          )}
        </footer>
      )}
    </>
  );
}

/** "10:42 today", or the date for an earlier day. */
function keptSince(at: number): string {
  const d = new Date(at);
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? `${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })} today`
    : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/**
 * A vote's kept receipt (docs/adr/0006), first under the headline, since it
 * is why someone opens the transaction. The election and commitment are
 * public; the choice and salt are hidden until Show, as private inputs are
 * in the approval window, and hidden again whenever Weft locks.
 */
function ReceiptCard({ item, state, onRemoved }: { item: ActivityRecord; state: WalletState; onRemoved: () => void }) {
  const { confirm, toast } = useFeedback();
  const [view, setView] = useState<ReceiptView | null | undefined>(undefined);
  const [error, setError] = useState<ErrorInfo | null>(null);
  const [show, setShow] = useState(false);
  const unlocked = state.vault.state === "unlocked";

  const load = () => {
    setError(null);
    ui("receiptGet", { id: item.id }).then(setView, (e: unknown) => setError(toErrorInfo(e)));
  };
  // Opened while Weft is unlocked; dropped, and hidden again, when it locks.
  useEffect(() => {
    if (!unlocked) {
      setView(undefined);
      setShow(false);
      return;
    }
    load();
  }, [unlocked, item.id]);

  const remove = async () => {
    if (!view) return;
    const ok = await confirm({
      title: "Remove this receipt?",
      body: (
        <>
          <p className="sheet__para">
            Weft deletes your choice and salt for <span className="mono">{view.receipt.electionId}</span> from this browser. Your vote
            stays on the ledger.
          </p>
          <p className="flat muted">Without the receipt, or a copy you saved, you can't show that this commitment is your vote.</p>
        </>
      ),
      confirmLabel: "Remove",
      icon: "trash",
    });
    if (!ok) return;
    try {
      await ui("receiptRemove", { id: item.id });
      toast("Receipt removed");
      onRemoved();
      requestAnimationFrame(() => document.querySelector<HTMLElement>(".screen h1")?.focus({ preventScroll: true }));
    } catch (e) {
      toast(`Couldn't remove the receipt. ${toErrorInfo(e).message}`, "error");
    }
  };

  if (error) {
    return (
      <ActionError error={{ ...error, message: "Weft couldn't open this receipt." }}>
        <button type="button" className="link-btn link-btn--inline" onClick={load}>
          Try again
        </button>
      </ActionError>
    );
  }
  if (!view) return null;
  if (import.meta.env.WEFT_EXPERIMENTAL === true && "choice" in view) {
    return (
      <BallotReceiptCard
        id={item.id}
        receipt={view.receipt}
        choice={view.choice}
        {...(view.explorerUrl ? { explorerUrl: view.explorerUrl } : {})}
        keptSince={keptSince(view.keptAt)}
        onRemoved={onRemoved}
      />
    );
  }
  if ("choice" in view) return null;
  const r = view.receipt;
  const hidden = (
    <span className="subtle">
      <span aria-hidden="true">••••••</span>
      <span className="visually-hidden">Hidden</span>
    </span>
  );
  // A small window of Weft's opens the explorer and hands it the choice and
  // salt by message, so they never go in an address (entrypoints/receipt).
  // The popup would close before the explorer could ask, as for passkeys.
  const check = () =>
    void browser.windows.create({
      url: browser.runtime.getURL(`/receipt.html?id=${encodeURIComponent(item.id)}`),
      type: "popup",
      width: 380,
      height: 520,
      focused: true,
    });
  return (
    <div className="stack arrive">
      <section className="args" aria-labelledby="receipt-heading">
        <div className="args__heading row-between">
          <h2 id="receipt-heading" className="eyebrow">
            Receipt
          </h2>
          <span className="subtle type-xs">Ballot receipt, version 1</span>
        </div>
        <div className="args__row">
          <span className="subtle args__key">Election</span>
          <span className="args__value">{r.electionId}</span>
        </div>
        <div className="args__row">
          <span className="subtle args__key">Commitment</span>
          <span className="args__value" title={r.commitment}>
            {shorten(r.commitment)}
          </span>
        </div>
        <div className="args__row args__private">
          <span className="subtle">Private, only you can see these</span>
          <button type="button" className="args__reveal" aria-pressed={show} onClick={() => setShow(!show)}>
            <Icon name={show ? "eyeOff" : "eye"} size={16} />
            {show ? "Hide" : "Show"}
          </button>
        </div>
        <div className="args__row">
          <span className="subtle args__key">Choice</span>
          {show ? <span className="args__value">{r.option}</span> : hidden}
        </div>
        <div className="args__row">
          <span className="subtle args__key">Salt</span>
          {show ? <GroupedHex value={r.salt} /> : hidden}
        </div>
        <SaveReceipt receipt={r} copied="Copied. It includes your choice and salt.">
          {view.explorerUrl && (
            <Button className="btn btn--sm" icon="external" iconSize={16} onClick={check}>
              Check in the explorer
            </Button>
          )}
        </SaveReceipt>
      </section>
      <div className="row-between type-xs">
        <span className="subtle">Kept since {keptSince(view.keptAt)}.</span>
        <button type="button" className="link-btn link-btn--inline danger-text" onClick={() => void remove()}>
          Remove receipt
        </button>
      </div>
    </div>
  );
}
