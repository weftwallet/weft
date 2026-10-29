// Must load before @peculiar/x509 (via @weftwallet/core), whatever the import order.
import "reflect-metadata";
import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "../../assets/app.css";
import { qualifiedFunctionName } from "@weftwallet/core";
import type { OrgInvite } from "@weftwallet/protocol";
import { browser } from "wxt/browser";
import { InviteCard } from "../../components/InviteCard";
import { FeedbackProvider } from "../../components/feedback";
import { useChecks } from "../../components/form";
import { CreatePassword, Unlock } from "../../components/lock";
import { useAction } from "../../components/popup/state";
import {
  ActionError,
  Brand,
  Button,
  ErrorDetails,
  Field,
  Icon,
  SecretInput,
  Spinner,
  Splash,
  StatusScreen,
  WeaveMark,
  healthView,
  toErrorInfo,
  useFocusOnArrival,
  type ErrorInfo,
} from "../../components/ui";
import { ui, type ApprovalOutcome, type ApprovalView, type IdentityView } from "../../lib/messages";
import { requestHostAccess } from "../../lib/permissions";
import * as check from "../../lib/validate";
import type { VaultStatus } from "../../lib/vault";

const id = new URLSearchParams(location.search).get("id") ?? "";

function Approve() {
  const [view, setView] = useState<ApprovalView | null | undefined>(undefined);
  const [phase, setPhase] = useState<"review" | "working" | "done">("review");
  const [outcome, setOutcome] = useState<ApprovalOutcome | null>(null);
  const [deciding, setDeciding] = useState(false);
  const [vault, setVault] = useState<VaultStatus | null>(null);
  // A load that failed, as opposed to a request that's gone.
  const [loadError, setLoadError] = useState<ErrorInfo | null>(null);
  const [reloading, setReloading] = useState(false);

  const load = async () => {
    setLoadError(null);
    try {
      const [loaded, status] = await Promise.all([ui("approvalGet", { id }), ui("vaultStatus")]);
      setView(loaded);
      setVault(status);
    } catch (error) {
      setLoadError(toErrorInfo(error));
    }
  };

  useEffect(() => {
    void load();
    const loadVault = () => void ui("vaultStatus").then(setVault, (error: unknown) => setLoadError(toErrorInfo(error)));
    // Weft can lock while this window is open (auto-lock, or locked elsewhere).
    const onChange = (_changes: unknown, area: string) => area === "session" && loadVault();
    browser.storage.onChanged.addListener(onChange);
    // Chrome stops an idle extension worker after about 30 seconds, which
    // would drop this request while the user is still reading it. Any
    // message resets that timer.
    const timer = setInterval(() => void ui("keepAlive").catch(() => {}), 20_000);
    return () => {
      clearInterval(timer);
      browser.storage.onChanged.removeListener(onChange);
    };
  }, []);

  const decide = async (approved: boolean) => {
    if (deciding) return; // one decision per request, however fast the presses
    setDeciding(true);
    if (!approved) {
      await ui("approvalDecide", { id, approved: false }).catch(() => {});
      window.close();
      return;
    }
    setPhase("working");
    try {
      const result = await ui("approvalDecide", { id, approved: true });
      setOutcome(result);
      setPhase("done");
      if (result.status === "approved") setTimeout(() => window.close(), 1400);
    } catch (error) {
      setOutcome({
        status: "failed",
        activityId: null,
        title: "Weft stopped responding",
        detail: "Weft's background service stopped before it could say how the request went.",
        raw: toErrorInfo(error).message,
        // A submit may have gone out before the worker stopped.
        uncertain: view?.method === "weft_submit",
      });
      setPhase("done");
    }
  };

  // Escape rejects a request still being reviewed.
  useEffect(() => {
    if (phase !== "review" || !view) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) void decide(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (loadError) {
    return (
      <StatusScreen mark={<WeaveMark size={64} mode="still" />} title="Weft couldn't open this request" detail="Its background service didn't answer.">
        <div className="status-screen__actions">
          <Button
            className="btn btn--primary"
            busy={reloading}
            onClick={async () => {
              setReloading(true);
              await load();
              setReloading(false);
            }}
          >
            Try again
          </Button>
          <button type="button" className="btn" onClick={() => void decide(false)}>
            Reject
          </button>
          {loadError.detail || loadError.message ? <ErrorDetails>{[loadError.message, loadError.detail].filter(Boolean).join(" ")}</ErrorDetails> : null}
        </div>
      </StatusScreen>
    );
  }
  if (view === undefined || (view && !vault)) return <Splash label="Loading the request" />;
  if (view === null) {
    return (
      <StatusScreen
        mark={<WeaveMark size={64} mode="still" />}
        title="This request has ended"
        detail="The site cancelled it, or it was already answered. Nothing was signed from this window."
      >
        <div className="status-screen__actions">
          <button type="button" className="btn" onClick={() => window.close()}>
            Close
          </button>
        </div>
      </StatusScreen>
    );
  }

  const host = new URL(view.origin).host;
  let screen;
  const reloadVault = () => void ui("vaultStatus").then(setVault, (error: unknown) => setLoadError(toErrorInfo(error)));
  if (phase === "review" && vault?.state === "none") {
    screen = (
      <CreatePassword
        intro={
          view.method === "weft_addNetwork"
            ? "Weft encrypts the private key it creates for this network with your password, and asks for it again after it locks."
            : "Weft now encrypts private keys with a password and locks itself when you're not using it. Set one to continue."
        }
        onDone={reloadVault}
        onCancel={() => void decide(false)}
        cancelLabel="Reject"
      />
    );
  } else if (phase === "review" && vault?.state === "locked") {
    screen = (
      <Unlock
        status={vault}
        passkey="inline"
        subtitle={`${host} is waiting. Unlock to review the request.`}
        onUnlocked={reloadVault}
        onCancel={() => void decide(false)}
        cancelLabel="Reject request"
      />
    );
  } else if (phase !== "review") screen = <Progress view={view} phase={phase} outcome={outcome} />;
  else if (view.method === "weft_addNetwork") screen = <AddNetworkRequest view={view} onDecide={decide} deciding={deciding} />;
  else if (view.method === "weft_connect") screen = <ConnectRequest view={view} onDecide={decide} deciding={deciding} />;
  else if (view.method === "weft_signIn") screen = <SignInRequest view={view} onDecide={decide} deciding={deciding} />;
  else screen = <SignRequest view={view} onDecide={decide} deciding={deciding} />;
  return (
    // Working and done share one screen, so the mark settles in place rather than reloading.
    <div key={`${phase === "review" ? "review" : outcome?.status === "failed" ? "failed" : "progress"}-${vault?.state}`} className="screen fade-in">
      {screen}
    </div>
  );
}

/** The window's header: Weft's mark and name, what's being asked, and who's asking. */
function RequestHeader({ title, origin, subtitle }: { title: string; origin: string; subtitle: string }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useFocusOnArrival(heading, title);
  return (
    <header className="request-header">
      <Brand />
      <h1 ref={heading} tabIndex={-1} className="request-header__title">
        {title}
      </h1>
      <Origin origin={origin} subtitle={subtitle} />
    </header>
  );
}

function Origin({ origin, subtitle }: { origin: string; subtitle: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <span className="origin-icon" aria-hidden="true">
        <Icon name={origin.startsWith("https:") ? "lock" : "globe"} size={16} />
      </span>
      <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
        <span style={{ fontWeight: 500, overflowWrap: "anywhere" }}>{new URL(origin).host}</span>
        <span className="muted type-xs">{subtitle}</span>
      </div>
    </div>
  );
}

function Footer({
  onDecide,
  cta,
  ctaClass,
  deciding,
}: {
  onDecide: (approved: boolean) => void;
  cta: string;
  ctaClass: string;
  deciding: boolean;
}) {
  return (
    <footer className="footer">
      <Button aria-disabled={deciding || undefined} onClick={() => onDecide(false)}>
        Reject
      </Button>
      <Button className={`btn ${ctaClass}`} busy={deciding} onClick={() => onDecide(true)}>
        {cta}
      </Button>
    </footer>
  );
}

function IdentityLine({ identity }: { identity: IdentityView | null }) {
  if (!identity) return <span className="muted">No identity</span>;
  return (
    <>
      <span style={{ fontWeight: 500, display: "block" }}>{identity.name}</span>
      <span className="mono muted type-xs">{identity.mspId}</span>
    </>
  );
}

function ConnectRequest({
  view,
  onDecide,
  deciding,
}: {
  view: ApprovalView;
  onDecide: (approved: boolean) => void;
  deciding: boolean;
}) {
  const identity = view.identity;
  return (
    <>
      <RequestHeader title="Connect this site?" origin={view.origin} subtitle="wants to use your Weft identity" />
      <main className="page">
        <h2 className="eyebrow">The site will see</h2>
        <dl className="details">
          <dt>Identity</dt>
          <dd>
            <IdentityLine identity={identity} />
          </dd>
          <dt>Role</dt>
          <dd className={identity?.role ? "mono" : "muted"}>{identity?.role ?? "None"}</dd>
          {identity && Object.keys(identity.attributes).length > 0 && (
            <>
              <dt>Attributes</dt>
              <dd className="mono type-xs">
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
          <Icon name="shield" size={18} color="var(--weft-accent-text)" />
          <span>
            Connecting does not let the site sign anything. Every query and transaction will still ask for your approval.
          </span>
        </div>
      </main>
      <Footer onDecide={onDecide} cta="Connect" ctaClass="btn--primary" deciding={deciding} />
    </>
  );
}

/**
 * weft_signIn: proves who the user is to the site. It signs a message Weft
 * writes, never a transaction, and the window says so plainly.
 */
function SignInRequest({
  view,
  onDecide,
  deciding,
}: {
  view: ApprovalView;
  onDecide: (approved: boolean) => void;
  deciding: boolean;
}) {
  const host = new URL(view.origin).host;
  return (
    <>
      <RequestHeader title={`Sign in to ${host}?`} origin={view.origin} subtitle="wants to know it's you" />
      <main className="page">
        {view.statement && (
          <div className="card">
            <h2 className="eyebrow">The site says</h2>
            <div style={{ overflowWrap: "anywhere" }}>{view.statement}</div>
          </div>
        )}
        <dl className="details">
          <dt>Signing in as</dt>
          <dd>
            <IdentityLine identity={view.identity} />
          </dd>
          <dt>Valid for</dt>
          <dd>5 minutes, for {host} only</dd>
        </dl>
        <div className="notice notice--thread">
          <Icon name="shield" size={18} color="var(--weft-accent-text)" />
          <span>
            This proves to the site that you hold this identity. It doesn't sign a transaction or change anything on the
            ledger.
          </span>
        </div>
      </main>
      <Footer onDecide={onDecide} cta="Sign in" ctaClass="btn--primary" deciding={deciding} />
    </>
  );
}

function SignRequest({
  view,
  onDecide,
  deciding,
}: {
  view: ApprovalView;
  onDecide: (approved: boolean) => void;
  deciding: boolean;
}) {
  const call = view.call!;
  const submit = view.method === "weft_submit";
  const [showRaw, setShowRaw] = useState(false);
  const health = view.identity ? healthView(view.identity) : null;
  const args = call.args ?? [];
  const transient = Object.entries(call.transient ?? {});
  const transientKeys = transient.map(([key]) => key);
  // Private inputs are part of what the user signs, so they can always see
  // them, but they start hidden from anyone glancing at the screen.
  const [showPrivate, setShowPrivate] = useState(false);

  return (
    <>
      <RequestHeader
        title={submit ? "Sign this transaction?" : "Read from the ledger?"}
        origin={view.origin}
        subtitle={submit ? "wants you to sign a transaction" : "wants to read from the ledger"}
      />
      <main className="page">
        <div className={`notice ${submit ? "notice--amber" : "notice--thread"}`}>
          <span className="tag" style={{ background: submit ? "var(--weft-warn)" : "var(--weft-accent)" }}>
            {submit ? "Submit" : "Evaluate"}
          </span>
          <span>
            {submit
              ? "This changes the ledger. Once endorsed and committed it cannot be undone."
              : "Read only. Nothing is written to the ledger."}
          </span>
        </div>

        {view.identity && !view.identity.channels.includes(call.channel) && (
          <div className="notice notice--amber">
            <Icon name="alert" size={18} color="var(--weft-warn-text)" />
            <span>
              Your invite for {view.identity.networkName} doesn't list the channel <span className="mono">{call.channel}</span>.
              The network will likely reject this unless your organisation has joined it since.
            </span>
          </div>
        )}

        <dl className="details">
          <dt>Signing as</dt>
          <dd>
            <IdentityLine identity={view.identity} />
            {health && health.state !== "valid" && (
              <div className="type-xs" style={{ color: health.color }}>
                {health.label}
              </div>
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
          <dd className="mono" style={{ color: "var(--weft-accent-text)", fontWeight: 500 }}>
            {call.fn}
          </dd>
        </dl>

        <section className="args" aria-labelledby="args-heading">
          <h2 id="args-heading" className="eyebrow" style={{ padding: "10px 12px" }}>
            Arguments
          </h2>
          {args.length === 0 && (
            <div className="args__row">
              <span className="subtle">None</span>
            </div>
          )}
          {args.map((arg, i) => (
            <div key={i} className="args__row">
              <span className="subtle">{i}</span>
              <span className="args__value">{arg}</span>
            </div>
          ))}
          {transient.length > 0 && (
            <>
              <div className="args__row args__private">
                <span className="subtle">Private, never on the ledger</span>
                <button type="button" className="args__reveal" aria-pressed={showPrivate} onClick={() => setShowPrivate(!showPrivate)}>
                  <Icon name={showPrivate ? "eyeOff" : "eye"} size={16} />
                  {showPrivate ? "Hide" : "Show"}
                </button>
              </div>
              {transient.map(([key, value]) => (
                <div key={key} className="args__row">
                  <span className="subtle args__key">{key}</span>
                  {showPrivate ? (
                    <span className="args__value">{value}</span>
                  ) : (
                    <span className="subtle">
                      <span aria-hidden="true">••••••</span>
                      <span className="visually-hidden">Hidden</span>
                    </span>
                  )}
                </div>
              ))}
            </>
          )}
          <button type="button" className="link-btn" aria-expanded={showRaw} aria-controls="raw-request" onClick={() => setShowRaw(!showRaw)}>
            {showRaw ? "Hide raw request" : "View raw request"}
          </button>
          {showRaw && (
            <pre id="raw-request" className="raw panel">
              {JSON.stringify(
                {
                  ...call,
                  fn: qualifiedFunctionName(call),
                  transient: transient.length ? (showPrivate ? call.transient : transientKeys) : undefined,
                },
                null,
                2,
              )}
            </pre>
          )}
        </section>

        {submit &&
          (call.endorsingOrganizations?.length ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div className="subtle">Will be sent for approval to</div>
              <div className="chips">
                {call.endorsingOrganizations.map((msp) => (
                  <span key={msp} className="chip">
                    {msp}
                  </span>
                ))}
              </div>
            </div>
          ) : (
            <p className="subtle" style={{ margin: 0 }}>
              The network asks the organisations the contract's endorsement policy requires.
            </p>
          ))}
        <p className="subtle type-xs" style={{ margin: 0 }}>
          Weft checks that the network's request matches exactly what is shown here before signing.
        </p>
      </main>
      <Footer
        onDecide={onDecide}
        cta={submit ? "Sign and submit" : "Sign and query"}
        ctaClass={submit ? "btn--amber" : "btn--primary"}
        deciding={deciding}
      />
    </>
  );
}

/**
 * weft_addNetwork: a site asks the user to join a network from an invite.
 * The invite is fetched only after the user agrees, from the organisation's
 * own server, so the site can't put words in the invite.
 */
function AddNetworkRequest({ view, onDecide, deciding }: { view: ApprovalView; onDecide: (approved: boolean) => void; deciding: boolean }) {
  const inviteUrl = view.inviteUrl!;
  const [invite, setInvite] = useState<OrgInvite | null>(null);
  const [enrollmentId, setEnrollmentId] = useState("");
  const [secret, setSecret] = useState("");
  const checks = useChecks({
    enrollmentId: () => check.required(enrollmentId, "Enter your enrolment ID."),
    secret: () => check.required(secret, "Enter the enrolment secret from your registrar."),
  });

  const review = useAction(async () => {
    await requestHostAccess([inviteUrl], "the server the invite comes from");
    const loaded = await ui("fetchInvite", { link: inviteUrl });
    setInvite(loaded);
    setEnrollmentId(loaded.enrollmentId ?? "");
  });

  const enroll = useAction(async (inv: OrgInvite) => {
    await requestHostAccess([inv.caUrl, inv.relayUrl]);
    await ui("joinInvite", { invite: inv, enrollmentId: enrollmentId.trim(), secret, inviteUrl });
    onDecide(true);
  });
  const busy = review.busy || enroll.busy || deciding;

  return (
    <>
      <RequestHeader
        title={invite ? `Join ${invite.network}?` : "Add a network?"}
        origin={view.origin}
        subtitle="wants you to join a network"
      />
      {!invite ? (
        <>
          <main key="review" className="page">
            <dl className="details">
              <dt>Invite from</dt>
              <dd className="mono">{new URL(inviteUrl).host}</dd>
            </dl>
            <div className="notice notice--thread">
              <Icon name="shield" size={18} color="var(--weft-accent-text)" />
              <span>
                Weft loads the invite from that address, not from the site, and shows you what it contains before you
                enter anything.
              </span>
            </div>
            <ActionError error={review.error} />
          </main>
          <footer className="footer">
            <Button aria-disabled={busy || undefined} onClick={() => onDecide(false)}>
              Reject
            </Button>
            <Button className="btn btn--primary" busy={review.busy} onClick={() => void review.run()}>
              Review invite
            </Button>
          </footer>
        </>
      ) : (
        <form
          style={{ display: "contents" }}
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (checks.submit()) void enroll.run(invite);
          }}
        >
          <main key="enrol" className="page step" data-dir="forward">
            <InviteCard invite={invite} />
            <Field label="Enrolment ID" {...checks.field("enrollmentId")}>
              {(a) => <input {...a} className="mono" value={enrollmentId} onChange={(e) => setEnrollmentId(e.target.value)} />}
            </Field>
            <Field label="Enrolment secret" hint="From your registrar. Used once, never stored." {...checks.field("secret")}>
              {(a) => <SecretInput {...a} value={secret} onChange={(e) => setSecret(e.target.value)} />}
            </Field>
            <ActionError error={enroll.error} />
          </main>
          <footer className="footer">
            <Button aria-disabled={busy || undefined} onClick={() => onDecide(false)}>
              Reject
            </Button>
            <Button type="submit" className="btn btn--primary" busy={enroll.busy || deciding}>
              Enrol
            </Button>
          </footer>
        </form>
      )}
    </>
  );
}

const WORKING_TITLE: Record<ApprovalView["method"], string> = {
  weft_connect: "Connecting",
  weft_signIn: "Signing in",
  weft_addNetwork: "Finishing",
  weft_submit: "Signing and submitting",
  weft_evaluate: "Signing and querying",
};

const DONE_TITLE: Record<ApprovalView["method"], string> = {
  weft_connect: "Connected",
  weft_signIn: "Signed in",
  weft_addNetwork: "Network added",
  weft_submit: "Committed",
  weft_evaluate: "Done",
};

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
  const host = new URL(view.origin).host;
  // A commit can take a while; after ten seconds, say so.
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (phase !== "working") return;
    const t = setTimeout(() => setSlow(true), 10_000);
    return () => clearTimeout(t);
  }, [phase]);

  if (phase === "working") {
    return (
      <StatusScreen
        mark={<Spinner size={72} />}
        title={WORKING_TITLE[view.method]}
        detail={
          submit
            ? slow
              ? "Still waiting for the block. Weft stops waiting after a minute and tells you what happened."
              : "Waiting for organisations to approve and the block to commit."
            : "This only takes a moment."
        }
      />
    );
  }
  if (outcome?.status === "failed") {
    // What happened to the ledger, then what to do next.
    const ledger = outcome.uncertain
      ? null
      : submit || view.method === "weft_evaluate"
        ? "Nothing was written to the ledger."
        : "Nothing was signed.";
    const next = outcome.uncertain
      ? `Check ${host} or your organisation's explorer before sending it again.`
      : outcome.retryable
        ? `You can try again from ${host}.`
        : null;
    const technical = [outcome.code, outcome.raw].filter(Boolean).join(" ");
    return (
      <>
        <StatusScreen mark={<WeaveMark size={64} mode="still" />} title={outcome.title} detail={null}>
          <div className="status-screen__body" role="alert">
            <p style={{ margin: 0 }}>{outcome.detail}</p>
            {(ledger || next) && <p className="muted" style={{ margin: 0 }}>{[ledger, next].filter(Boolean).join(" ")}</p>}
            {outcome.activityId && <p className="muted" style={{ margin: 0 }}>The details are saved in your Weft activity.</p>}
            {technical && <ErrorDetails>{technical}</ErrorDetails>}
          </div>
        </StatusScreen>
        <footer className="footer footer--single">
          <button type="button" className="btn" onClick={() => window.close()}>
            Close
          </button>
        </footer>
      </>
    );
  }
  return <StatusScreen mark={<WeaveMark size={72} mode="settle" />} title={DONE_TITLE[view.method]} detail="This window closes on its own." />;
}

document.body.classList.add("window");
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <FeedbackProvider>
      <Approve />
    </FeedbackProvider>
  </StrictMode>,
);
