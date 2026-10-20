import { useEffect, useState } from "react";
import type { ActivityRecord } from "../../lib/db";
import { ui, type WalletState } from "../../lib/messages";
import { CopyButton, useFeedback } from "../feedback";
import { BackHeader, Icon, Spinner, shorten, timeAgo } from "../ui";
import type { Navigate } from "./state";

const HEADLINE = {
  committed: { color: "var(--weft-thread)", text: "Committed to the ledger" },
  evaluated: { color: "var(--weft-text-muted)", text: "Read only" },
  failed: { color: "var(--weft-signal)", text: "Not committed" },
  rejected: { color: "var(--weft-text-subtle)", text: "Rejected by you" },
} as const;

export function TxDetail({ state, activityId, navigate }: { state: WalletState; activityId: string; navigate: Navigate }) {
  const { toast } = useFeedback();
  const [item, setItem] = useState<ActivityRecord | null | undefined>(undefined);
  useEffect(() => {
    void ui("activityItem", { id: activityId }).then(setItem);
  }, [activityId]);

  const back = () => navigate({ name: "home" });
  if (item === undefined) {
    return (
      <>
        <BackHeader title="Transaction" onBack={back} />
        <div className="splash">
          <Spinner />
        </div>
      </>
    );
  }
  if (item === null) {
    return (
      <>
        <BackHeader title="Transaction" onBack={back} />
        <div className="empty">This transaction is no longer in your activity.</div>
      </>
    );
  }

  const identity = state.identities.find((i) => i.id === item.identityId);
  const head = HEADLINE[item.status];

  return (
    <>
      <BackHeader title="Transaction" onBack={back} />
      <main className="page" style={{ gap: 16 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="dot" style={{ width: 10, height: 10, borderRadius: 5, background: head.color }} />
            <span style={{ fontSize: 13, fontWeight: 500, color: head.color }}>{head.text}</span>
          </div>
          <div className="mono" style={{ fontSize: 24, fontWeight: 600, overflowWrap: "anywhere" }}>
            {item.call.fn}
          </div>
        </div>

        {item.status === "failed" && (
          <section className="notice notice--signal" style={{ flexDirection: "column" }}>
            <div style={{ fontSize: 15, fontWeight: 600 }}>{item.title}</div>
            <div style={{ color: "#e2d2d0" }}>{item.detail}</div>
            {item.endorsers && item.endorsers.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6, width: "100%" }}>
                {item.endorsers.map((e, i) => (
                  <div key={i} className="mono" style={{ fontSize: 12, display: "flex", gap: 8 }}>
                    <span style={{ color: "var(--weft-signal)" }}>✕</span>
                    <span>{e.mspId ?? e.address ?? "peer"}</span>
                    <span className="muted" style={{ marginLeft: "auto", textAlign: "right" }}>
                      {e.message}
                    </span>
                  </div>
                ))}
              </div>
            )}
            <div className="mono" style={{ fontSize: 11, color: "#c9a9a5" }}>
              {item.code}
            </div>
          </section>
        )}

        <dl className="details" style={{ gridTemplateColumns: "88px minmax(0,1fr)" }}>
          {item.transactionId && (
            <>
              <dt>Tx ID</dt>
              <dd className="mono" style={{ display: "flex", alignItems: "center", gap: 4, marginTop: -6, marginBottom: -6 }}>
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
              <dd className="mono">{(item.call.args ?? []).join(", ")}</dd>
            </>
          )}
          <dt>Signed by</dt>
          <dd>
            {identity?.name ?? "Removed identity"} <span className="mono muted">· {identity?.mspId}</span>
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
        <footer className="footer footer--single">
          <button
            type="button"
            className="btn"
            onClick={() => void navigator.clipboard.writeText(item.transactionId!).then(() => toast("Transaction ID copied"))}
          >
            <Icon name="copy" size={18} /> Copy transaction ID
          </button>
        </footer>
      )}
    </>
  );
}
