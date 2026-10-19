import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "../../assets/app.css";
import { qualifiedFunctionName } from "@weftwallet/core";
import { Icon, healthView } from "../../components/ui";
import { ui, type ApprovalOutcome, type ApprovalView, type IdentityView } from "../../lib/messages";

const id = new URLSearchParams(location.search).get("id") ?? "";

function Approve() {
  const [view, setView] = useState<ApprovalView | null | undefined>(undefined);
  const [phase, setPhase] = useState<"review" | "working" | "done">("review");
  const [outcome, setOutcome] = useState<ApprovalOutcome | null>(null);

  useEffect(() => {
    void ui("approvalGet", { id }).then(setView);
  }, []);

  const decide = async (approved: boolean) => {
    if (!approved) {
      await ui("approvalDecide", { id, approved: false });
      window.close();
      return;
    }
    setPhase("working");
    const result = await ui("approvalDecide", { id, approved: true });
    setOutcome(result);
    setPhase("done");
    if (result.status === "approved") setTimeout(() => window.close(), 1200);
  };

  if (view === undefined) return null;
  if (view === null) {
    return (
      <main className="page">
        <div className="empty">This request is no longer waiting for you.</div>
        <button type="button" className="btn" onClick={() => window.close()}>
          Close
        </button>
      </main>
    );
  }

  if (phase !== "review") return <Progress view={view} phase={phase} outcome={outcome} />;
  return view.method === "weft_connect" ? (
    <ConnectRequest view={view} onDecide={decide} />
  ) : (
    <SignRequest view={view} onDecide={decide} />
  );
}

function Origin({ origin, subtitle }: { origin: string; subtitle: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <span
        style={{
          width: 36,
          height: 36,
          borderRadius: 10,
          background: "var(--weft-slate)",
          border: "1px solid var(--weft-line-strong)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--weft-text-muted)",
          flex: "none",
        }}
      >
        <Icon name={origin.startsWith("https:") ? "lock" : "globe"} size={16} />
      </span>
      <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
        <span style={{ fontSize: 14, fontWeight: 500, overflowWrap: "anywhere" }}>{new URL(origin).host}</span>
        <span className="muted" style={{ fontSize: 12 }}>
          {subtitle}
        </span>
      </div>
    </div>
  );
}

function Footer({ onDecide, cta, ctaClass }: { onDecide: (approved: boolean) => void; cta: string; ctaClass: string }) {
  return (
    <footer className="footer">
      <button type="button" className="btn" onClick={() => onDecide(false)}>
        Reject
      </button>
      <button type="button" className={`btn ${ctaClass}`} onClick={() => onDecide(true)}>
        {cta}
      </button>
    </footer>
  );
}

function IdentityLine({ identity }: { identity: IdentityView | null }) {
  if (!identity) return <span className="muted">No identity</span>;
  return (
    <>
      <span style={{ fontWeight: 500 }}>{identity.name}</span> <span className="mono muted">· {identity.mspId}</span>
    </>
  );
}

function ConnectRequest({ view, onDecide }: { view: ApprovalView; onDecide: (approved: boolean) => void }) {
  const identity = view.identity;
  return (
    <>
      <header className="header" style={{ height: "auto", padding: "18px 16px 14px", flexDirection: "column", alignItems: "stretch", gap: 12 }}>
        <div style={{ fontSize: 18, fontWeight: 600 }}>Connect this site?</div>
        <Origin origin={view.origin} subtitle="wants to use your Weft identity" />
      </header>
      <main className="page">
        <div className="eyebrow">The site will see</div>
        <dl className="details">
          <dt>Identity</dt>
          <dd>
            <IdentityLine identity={identity} />
          </dd>
          <dt>Role</dt>
          <dd className="mono">{identity?.role ?? "none"}</dd>
          {identity && Object.keys(identity.attributes).length > 0 && (
            <>
              <dt>Attributes</dt>
              <dd className="mono" style={{ fontSize: 12 }}>
                {Object.entries(identity.attributes)
                  .map(([k, v]) => `${k}=${v}`)
                  .join(", ")}
              </dd>
            </>
          )}
          <dt>Certificate</dt>
          <dd className="muted">Public certificate only</dd>
        </dl>
        <div className="notice notice--thread">
          <Icon name="shield" size={18} color="var(--weft-thread)" />
          <span>
            Connecting does not let the site sign anything. Every query and transaction will still ask for your approval.
          </span>
        </div>
      </main>
      <Footer onDecide={onDecide} cta="Connect" ctaClass="btn--primary" />
    </>
  );
}

function SignRequest({ view, onDecide }: { view: ApprovalView; onDecide: (approved: boolean) => void }) {
  const call = view.call!;
  const submit = view.method === "weft_submit";
  const [showRaw, setShowRaw] = useState(false);
  const health = view.identity ? healthView(view.identity) : null;
  const args = call.args ?? [];
  const transientKeys = Object.keys(call.transient ?? {});

  return (
    <>
      <header className="header" style={{ height: "auto", padding: "18px 16px 14px", flexDirection: "column", alignItems: "stretch", gap: 12 }}>
        <div style={{ fontSize: 18, fontWeight: 600 }}>Signature request</div>
        <Origin origin={view.origin} subtitle={submit ? "wants you to sign a transaction" : "wants to read from the ledger"} />
      </header>
      <main className="page">
        <div className={`notice ${submit ? "notice--amber" : "notice--thread"}`}>
          <span className="tag" style={{ background: submit ? "var(--weft-amber)" : "var(--weft-thread)" }}>
            {submit ? "SUBMIT" : "EVALUATE"}
          </span>
          <span>
            {submit
              ? "This changes the ledger. Once endorsed and committed it cannot be undone."
              : "Read only. Nothing is written to the ledger."}
          </span>
        </div>

        <dl className="details">
          <dt>Signing as</dt>
          <dd>
            <IdentityLine identity={view.identity} />
            {health && health.state !== "valid" && (
              <div style={{ fontSize: 12, color: health.color }}>{health.label}</div>
            )}
          </dd>
          <dt>Channel</dt>
          <dd className="mono">{call.channel}</dd>
          <dt>Contract</dt>
          <dd className="mono">
            {call.chaincode}
            {call.contract ? ` / ${call.contract}` : ""}
          </dd>
          <dt>Function</dt>
          <dd className="mono" style={{ color: "var(--weft-thread)", fontWeight: 500 }}>
            {call.fn}
          </dd>
        </dl>

        <section className="args" aria-label="Arguments">
          <div className="eyebrow" style={{ padding: "10px 12px" }}>
            Arguments
          </div>
          {args.length === 0 && (
            <div className="args__row">
              <span className="subtle">none</span>
            </div>
          )}
          {args.map((arg, i) => (
            <div key={i} className="args__row">
              <span className="subtle">{i}</span>
              <span>{arg}</span>
            </div>
          ))}
          {transientKeys.length > 0 && (
            <div className="args__row">
              <span className="subtle">private</span>
              <span>{transientKeys.join(", ")}</span>
            </div>
          )}
          <button type="button" className="link-btn" onClick={() => setShowRaw(!showRaw)}>
            {showRaw ? "Hide raw request" : "View raw request"}
          </button>
          {showRaw && (
            <pre className="raw">
              {JSON.stringify(
                { ...call, fn: qualifiedFunctionName(call), transient: transientKeys.length ? transientKeys : undefined },
                null,
                2,
              )}
            </pre>
          )}
        </section>

        {submit &&
          (call.endorsingOrganizations?.length ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div className="subtle" style={{ fontSize: 13 }}>
                Will be sent for approval to
              </div>
              <div className="chips">
                {call.endorsingOrganizations.map((msp) => (
                  <span key={msp} className="chip" style={{ fontSize: 12 }}>
                    {msp}
                  </span>
                ))}
              </div>
            </div>
          ) : (
            <p className="subtle" style={{ fontSize: 13, margin: 0 }}>
              The network asks the organisations the contract's endorsement policy requires.
            </p>
          ))}
        <p className="subtle" style={{ fontSize: 12, margin: 0 }}>
          Weft checks that the network's request matches exactly what is shown here before signing.
        </p>
      </main>
      <Footer
        onDecide={onDecide}
        cta={submit ? "Sign & submit" : "Sign & query"}
        ctaClass={submit ? "btn--amber" : "btn--primary"}
      />
    </>
  );
}

function Progress({
  view,
  phase,
  outcome,
}: {
  view: ApprovalView;
  phase: "working" | "done";
  outcome: ApprovalOutcome | null;
}) {
  const submit = view.method === "weft_submit";
  if (phase === "working") {
    return (
      <main className="page" style={{ justifyContent: "center", alignItems: "center", textAlign: "center" }}>
        <div style={{ fontSize: 16, fontWeight: 600 }}>
          {view.method === "weft_connect" ? "Connecting…" : submit ? "Signing and submitting…" : "Signing and querying…"}
        </div>
        <div className="muted" style={{ fontSize: 13 }}>
          {submit ? "Waiting for organisations to approve and the block to commit." : "This only takes a moment."}
        </div>
      </main>
    );
  }
  if (outcome?.status === "failed") {
    return (
      <>
        <main className="page">
          <section className="notice notice--signal" style={{ flexDirection: "column" }}>
            <div style={{ fontSize: 15, fontWeight: 600 }}>{outcome.title}</div>
            <div style={{ color: "#e2d2d0" }}>{outcome.detail}</div>
          </section>
          <p className="muted" style={{ fontSize: 13, margin: 0 }}>
            Nothing was written to the ledger. The details are saved in your Weft activity.
          </p>
        </main>
        <footer className="footer footer--single">
          <button type="button" className="btn" onClick={() => window.close()}>
            Close
          </button>
        </footer>
      </>
    );
  }
  return (
    <main className="page" style={{ justifyContent: "center", alignItems: "center", textAlign: "center" }}>
      <span style={{ color: "var(--weft-thread)" }}>
        <Icon name="check" size={40} />
      </span>
      <div style={{ fontSize: 16, fontWeight: 600 }}>
        {view.method === "weft_connect" ? "Connected" : submit ? "Committed" : "Done"}
      </div>
    </main>
  );
}

document.body.classList.add("window");
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Approve />
  </StrictMode>,
);
