import { useEffect, useState } from "react";
import type { ActivityRecord } from "../../lib/db";
import { ui, type WalletState } from "../../lib/messages";
import { CopyButton, useCopy } from "../feedback";
import { ActionError, BackHeader, Button, Empty, ErrorDetails, Icon, Splash, shorten, timeAgo, toErrorInfo, type ErrorInfo } from "../ui";
import type { Navigate } from "./state";

const HEADLINE = {
  committed: { color: "var(--weft-accent-text)", text: "Committed to the ledger" },
  evaluated: { color: "var(--weft-text-muted)", text: "Read only" },
  failed: { color: "var(--weft-danger-text)", text: "Not committed" },
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
              <dd className="mono">
                {(item.call.args ?? []).map((arg, i) => (
                  <div key={i}>{arg}</div>
                ))}
              </dd>
            </>
          )}
          {item.privateInputs && item.privateInputs.length > 0 && (
            <>
              <dt>Private</dt>
              <dd>
                <span className="mono">{item.privateInputs.join(", ")}</span> <span className="subtle">· values not kept</span>
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

