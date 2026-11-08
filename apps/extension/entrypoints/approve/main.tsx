// Must load before @peculiar/x509 (via @weftwallet/core), whatever the import order.
import "reflect-metadata";
import { StrictMode, Suspense, lazy, useEffect, useRef, useState, type ReactNode } from "react";
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
import { SaveReceipt } from "../../components/receipt";
import {
  ActionError,
  Brand,
  Button,
  ErrorDetails,
  Field,
  Icon,
  SecretInput,
  Splash,
  StatusScreen,
  WeaveMark,
  clockTime,
  fromWorker,
  healthView,
  shorten,
  toErrorInfo,
  tokenMs,
  useFocusOnArrival,
  type ErrorInfo,
} from "../../components/ui";
import { EXPERIMENTAL } from "../../lib/experimental";
import { UiError, ui, type ApprovalOutcome, type ApprovalView, type IdentityView, type ReceiptOutcome } from "../../lib/messages";
import { requestHostAccess } from "../../lib/permissions";
import * as check from "../../lib/validate";
import type { VaultStatus } from "../../lib/vault";

const id = new URLSearchParams(location.search).get("id") ?? "";

/**
 * Weft Experimental's weft_castBallot window (docs/adr/0007). The test is on
 * the build constant itself, which wxt.config.ts replaces with false in the
 * normal build, so the bundler never emits the window's chunk there.
 */
const CastBallotRequest = import.meta.env.WEFT_EXPERIMENTAL === true ? lazy(() => import("./cast-ballot")) : null;

type Phase = "review" | "working" | "done";

/** Where a request is: being reviewed, running, or finished, with how it went. */
interface Progress {
  phase: Phase;
  outcome: ApprovalOutcome | null;
  /** A commit has taken more than ten seconds. */
  slow: boolean;
}

const REVIEWING: Progress = { phase: "review", outcome: null, slow: false };

function Approve() {
  const [view, setView] = useState<ApprovalView | null | undefined>(undefined);
  const [phase, setPhase] = useState<Phase>("review");
  const [outcome, setOutcome] = useState<ApprovalOutcome | null>(null);
  const [deciding, setDeciding] = useState(false);
  const [vault, setVault] = useState<VaultStatus | null>(null);
  // A load that failed, as opposed to a request that's gone.
  const [loadError, setLoadError] = useState<ErrorInfo | null>(null);
  const [reloading, setReloading] = useState(false);
  // When Try again last ran without the request opening, for the line under it.
  const [triedAt, setTriedAt] = useState<string | null>(null);
  // The lock screen stays up while it holds (its loader seating after the
  // unlock), even once the vault reads as unlocked.
  const [unlockHeld, setUnlockHeld] = useState(false);

  /**
   * Reads the request and the vault; says whether it could. Gives up after
   * WORKER_TIMEOUT_MS, so the splash never waits for ever. The error screen
   * stays up while it tries again, so Try again keeps focus.
   */
  const load = async (): Promise<boolean> => {
    try {
      const [loaded, status] = await fromWorker(Promise.all([ui("approvalGet", { id }), ui("vaultStatus")]));
      setView(loaded);
      setVault(status);
      setLoadError(null);
      return true;
    } catch (error) {
      setLoadError(toErrorInfo(error));
      return false;
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

  /** keepReceipt: "Keep the receipt in Weft", as the user left it. Nothing else sets it. choice: weft_castBallot's option. */
  const decide = async (approved: boolean, keepReceipt = false, choice?: number) => {
    if (deciding) return; // one decision per request, however fast the presses
    setDeciding(true);
    if (!approved) {
      await ui("approvalDecide", { id, approved: false }).catch(() => {});
      window.close();
      return;
    }
    setPhase("working");
    try {
      const result = await ui("approvalDecide", { id, approved: true, keepReceipt, ...(choice !== undefined ? { choice } : {}) });
      setOutcome(result);
      setPhase("done");
    } catch (error) {
      setOutcome({
        status: "failed",
        activityId: null,
        title: "Weft stopped responding",
        detail: "Weft's background worker stopped before it could say how the request went.",
        raw: toErrorInfo(error).message,
        // A submit, or a ballot, may have gone out before the worker stopped.
        uncertain: view?.method === "weft_submit" || (EXPERIMENTAL && view?.method === "weft_castBallot"),
      });
      setPhase("done");
    }
  };

  // A success state stays hold-after-done, then the window closes (SYSTEM.md,
  // Errors). Not when Weft couldn't keep a receipt the user asked it to, or
  // (weft_castBallot) couldn't save the vote at all: the window says why, and
  // for a refused write it holds the only copy.
  useEffect(() => {
    if (phase !== "done" || outcome?.status !== "approved" || receiptTrouble(outcome.receipt) || outcome.unsaved) return;
    const t = setTimeout(() => window.close(), tokenMs("--weft-hold-after-done", 1400));
    return () => clearTimeout(t);
  }, [phase, outcome]);

  // A commit can take a while; after ten seconds, say so.
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (phase !== "working") return;
    const t = setTimeout(() => setSlow(true), 10_000);
    return () => clearTimeout(t);
  }, [phase]);

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
      <StatusScreen mark={<WeaveMark size={64} mode="still" />} title="Weft couldn't open this request" detail="Its background worker didn't answer. Nothing has been signed.">
        <div className="status-screen__actions">
          <Button
            className="btn btn--primary"
            busy={reloading}
            onClick={async () => {
              setReloading(true);
              setTriedAt(null);
              const opened = await load();
              setReloading(false);
              if (!opened) setTriedAt(clockTime());
            }}
          >
            Try again
          </Button>
          <button type="button" className="btn" onClick={() => void decide(false)}>
            Reject
          </button>
          {loadError.detail || loadError.message ? <ErrorDetails>{[loadError.message, loadError.detail].filter(Boolean).join(" ")}</ErrorDetails> : null}
        </div>
        <p className="status-screen__retry" role="status">
          {triedAt && `Tried again at ${triedAt}. The background worker still didn't answer.`}
        </p>
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
  const progress: Progress = { phase, outcome, slow };
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
  } else if (phase === "review" && (vault?.state === "locked" || (unlockHeld && vault?.state === "unlocked"))) {
    screen = (
      <Unlock
        status={vault}
        passkey="inline"
        subtitle={`${host} is waiting. Unlock to review the request.`}
        onUnlocked={reloadVault}
        onHold={setUnlockHeld}
        onCancel={() => void decide(false)}
        cancelLabel="Reject"
      />
    );
  } else if (EXPERIMENTAL && CastBallotRequest && view.method === "weft_castBallot") {
    screen = (
      <Suspense fallback={<Splash label="Loading the request" />}>
        <CastBallotRequest view={view} onDecide={decide} deciding={deciding} progress={progress} />
      </Suspense>
    );
  } else if (view.method === "weft_addNetwork") screen = <AddNetworkRequest view={view} onDecide={decide} deciding={deciding} progress={progress} />;
  else if (view.method === "weft_connect") screen = <ConnectRequest view={view} onDecide={decide} deciding={deciding} progress={progress} />;
  else if (view.method === "weft_signIn") screen = <SignInRequest view={view} onDecide={decide} deciding={deciding} progress={progress} />;
  else screen = <SignRequest view={view} onDecide={decide} deciding={deciding} progress={progress} />;
  return (
    // The request stays on screen from review to done: working and finished
    // are changes to its title and footer, not screens of their own.
    <div key={phase === "review" && (vault?.state !== "unlocked" || unlockHeld) ? (unlockHeld ? "locked" : vault?.state) : "request"} className="screen fade-in">
      {screen}
    </div>
  );
}

/**
 * The window's header: Weft's mark and name, what's being asked, and who's
 * asking. While the request runs the title says so ("Signing and submitting")
 * and the origin's line says what is being waited for; when it has finished
 * the title says what happened. Focus moves to the title each time it changes,
 * which is how the change is heard.
 */
function RequestHeader({
  title,
  origin,
  subtitle,
  progress,
  working,
  done,
}: {
  title: string;
  origin: string;
  subtitle: string;
  progress: Progress;
  /** The title while the request runs. */
  working: string;
  /** The title once it has succeeded. */
  done: string;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const shown =
    progress.phase === "working"
      ? working
      : progress.phase === "done"
        ? progress.outcome?.status === "failed"
          ? progress.outcome.title
          : done
        : title;
  useFocusOnArrival(heading, shown);
  return (
    <header className="request-header">
      <Brand />
      <h1 ref={heading} tabIndex={-1} className="request-header__title">
        {shown}
      </h1>
      <Origin origin={origin} subtitle={progress.phase === "working" ? waitingFor(progress) : subtitle} />
    </header>
  );
}

function waitingFor(progress: Progress): string {
  return progress.slow ? "Still waiting for the block. Weft stops waiting after a minute and tells you what happened." : "Waiting for the network to answer.";
}

function Origin({ origin, subtitle }: { origin: string; subtitle: string }) {
  return (
    <div className="origin">
      <span className="origin-icon" aria-hidden="true">
        <Icon name={origin.startsWith("https:") ? "lock" : "globe"} size={16} />
      </span>
      <div className="origin__text">
        <span className="origin__host">{new URL(origin).host}</span>
        <span key={subtitle} className="muted type-xs arrive">
          {subtitle}
        </span>
      </div>
    </div>
  );
}

/** What was done, for the status line once a request has succeeded. */
interface Done {
  headline: string;
  detail: ReactNode;
  link?: { href: string; label: string };
  /** The window stays open with Close: something above needs reading first. */
  stays?: boolean;
}

/** A receipt the user asked Weft to keep, and it couldn't. */
const receiptTrouble = (receipt: ReceiptOutcome | undefined) =>
  receipt?.kept === false && (receipt.reason === "storage" || receipt.reason === "mismatch");

/**
 * The footer: Reject and the action while the request is reviewed, the
 * action busy where it is while the request runs, and one status line in
 * their place once it has finished: what was done, where and as whom, with a
 * link to the explorer where the network has one. A failure keeps only Close
 * here; what happened goes at the top of the body (FailureOutcome), where it
 * has room for its Details.
 */
function Footer({
  onDecide,
  cta,
  ctaClass,
  deciding,
  progress,
  done,
}: {
  onDecide: (approved: boolean) => void;
  cta: string;
  ctaClass: string;
  deciding: boolean;
  progress: Progress;
  done: Done;
}) {
  if (failed(progress)) return <CloseFooter />;
  if (progress.phase === "done") {
    return (
      <footer className="footer footer--status">
        <div className="status-line arrive" role="status">
          <Icon name="check" size={20} color="var(--weft-accent-text)" />
          <div className="status-line__text">
            <span>{done.headline}</span>
            <span className="status-line__detail">
              {done.detail}
              {done.link && (
                <>
                  {" "}
                  <a href={done.link.href} target="_blank" rel="noreferrer">
                    {done.link.label}
                  </a>
                </>
              )}
            </span>
          </div>
        </div>
        {done.stays && (
          <button type="button" className="btn" onClick={() => window.close()}>
            Close
          </button>
        )}
      </footer>
    );
  }
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

const failed = (progress: Progress) => progress.phase === "done" && progress.outcome?.status === "failed";

/** A finished request's footer when it failed: only Close. */
function CloseFooter() {
  return (
    <footer className="footer footer--single">
      <button type="button" className="btn" onClick={() => window.close()}>
        Close
      </button>
    </footer>
  );
}

/**
 * How a failed request went, at the top of the request's body: the sentence
 * first, what happened to the ledger and what to do next, then anything
 * technical behind Details. The body scrolls to it, so it is the first thing
 * seen under the title that names the failure.
 */
function FailureOutcome({ progress, view }: { progress: Progress; view: ApprovalView }) {
  const box = useRef<HTMLDivElement>(null);
  const outcome = progress.outcome?.status === "failed" && progress.phase === "done" ? progress.outcome : null;
  useEffect(() => {
    if (!outcome) return;
    box.current?.scrollIntoView({ block: "nearest" });
  }, [outcome]);
  if (!outcome) return null;
  const host = new URL(view.origin).host;
  const submit = view.method === "weft_submit";
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
    <div ref={box} className="status-line status-line--failed request-outcome arrive" role="alert">
      <Icon name="alert" size={20} />
      <div className="status-line__text">
        <span>{outcome.detail}</span>
        {(ledger || next) && <span className="status-line__detail">{[ledger, next].filter(Boolean).join(" ")}</span>}
        {outcome.activityId && <span className="status-line__detail">The details are saved in your Weft activity.</span>}
        {technical && <ErrorDetails>{technical}</ErrorDetails>}
      </div>
    </div>
  );
}

/** The call as one line: TransferAsset(asset7, Org2MSP). */
function callLine(view: ApprovalView): string {
  const call = view.call!;
  return `${call.fn}(${(call.args ?? []).join(", ")})`;
}

/** The body dims to 55% while the request runs, but stays readable. */
const bodyClass = (progress: Progress) => `page${progress.phase === "working" ? " page--dim" : ""}`;

function IdentityLine({ identity }: { identity: IdentityView | null }) {
  if (!identity) return <span className="muted">No identity</span>;
  return (
    <>
      <span className="strong block">{identity.name}</span>
      <span className="mono muted type-xs">{identity.mspId}</span>
    </>
  );
}

interface RequestProps {
  view: ApprovalView;
  onDecide: (approved: boolean, keepReceipt?: boolean) => void;
  deciding: boolean;
  progress: Progress;
}

function ConnectRequest({ view, onDecide, deciding, progress }: RequestProps) {
  const identity = view.identity;
  const host = new URL(view.origin).host;
  return (
    <>
      <RequestHeader
        title="Connect this site?"
        origin={view.origin}
        subtitle="wants to use your Weft identity"
        progress={progress}
        working="Connecting"
        done="Connected"
      />
      <main className={bodyClass(progress)} aria-busy={progress.phase === "working" || undefined}>
        <FailureOutcome progress={progress} view={view} />
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
            Connecting does not let the site sign anything. Every read and transaction will still ask for your approval.
          </span>
        </div>
      </main>
      <Footer
        onDecide={onDecide}
        cta="Connect"
        ctaClass="btn--primary"
        deciding={deciding}
        progress={progress}
        done={{ headline: `Connected to ${host}.`, detail: identity ? `It sees ${identity.name} in ${identity.mspId}. Closing.` : "Closing." }}
      />
    </>
  );
}

/**
 * weft_signIn: proves who the user is to the site. It signs a message Weft
 * writes, never a transaction, and the window says so plainly.
 */
function SignInRequest({ view, onDecide, deciding, progress }: RequestProps) {
  const host = new URL(view.origin).host;
  return (
    <>
      <RequestHeader
        title={`Sign in to ${host}?`}
        origin={view.origin}
        subtitle="wants to know it's you"
        progress={progress}
        working="Signing in"
        done="Signed in"
      />
      <main className={bodyClass(progress)} aria-busy={progress.phase === "working" || undefined}>
        <FailureOutcome progress={progress} view={view} />
        {view.statement && (
          <div className="card">
            <h2 className="eyebrow">The site says</h2>
            <div className="wrap-anywhere">{view.statement}</div>
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
      <Footer
        onDecide={onDecide}
        cta="Sign in"
        ctaClass="btn--primary"
        deciding={deciding}
        progress={progress}
        done={{ headline: `Signed in to ${host}.`, detail: view.identity ? `As ${view.identity.name} in ${view.identity.mspId}. Closing.` : "Closing." }}
      />
    </>
  );
}

function SignRequest({ view, onDecide, deciding, progress }: RequestProps) {
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
  // "Keep the receipt in Weft" starts off on every request, and only this
  // switch turns it on: the request can't, and Weft remembers nothing.
  const [keep, setKeep] = useState(false);
  const receipt = submit ? view.receipt : undefined;
  const hidden = (value: string) => (showPrivate ? value : "hidden");

  return (
    <>
      <RequestHeader
        title={submit ? "Sign this transaction?" : "Read from the ledger?"}
        origin={view.origin}
        subtitle={submit ? "wants you to sign a transaction" : "wants to read from the ledger"}
        progress={progress}
        working={submit ? "Signing and submitting" : "Signing and reading"}
        done={submit ? "Committed" : "Read from the ledger"}
      />
      <main className={bodyClass(progress)} aria-busy={progress.phase === "working" || undefined}>
        <FailureOutcome progress={progress} view={view} />
        <ReceiptProblem progress={progress} electionId={view.receipt?.request.electionId ?? ""} />
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
              The network rejects this unless your organisation has joined the channel since the invite was published.
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
          <dd className="mono accent-text strong">{call.fn}</dd>
        </dl>

        <section className="args" aria-labelledby="args-heading">
          <h2 id="args-heading" className="eyebrow args__heading">
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
                  <span className="subtle args__key">
                    {key}
                    {keep && receipt?.input === key && (
                      <>
                        {" "}
                        <span className="in-receipt arrive">receipt</span>
                      </>
                    )}
                  </span>
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
          {/* A .reversible (motion.css): hidden early, it turns back from where it is. */}
          <pre id="raw-request" className={`raw reversible reversible--down${showRaw ? " is-open" : ""}`} hidden={!showRaw}>
            {JSON.stringify(
              {
                ...call,
                fn: qualifiedFunctionName(call),
                transient: transient.length ? (showPrivate ? call.transient : transientKeys) : undefined,
                ...(receipt ? { receipt: { ...receipt.request, option: hidden(receipt.request.option), salt: hidden(receipt.request.salt) } } : {}),
              },
              null,
              2,
            )}
          </pre>
        </section>

        {receipt && (
          <KeepReceipt
            host={new URL(view.origin).host}
            receipt={receipt}
            keep={keep}
            onKeep={setKeep}
            locked={progress.phase !== "review" || deciding}
          />
        )}

        {submit &&
          (call.endorsingOrganizations?.length ? (
            <div className="stack">
              <div className="subtle">Sent for endorsement to</div>
              <div className="chips">
                {call.endorsingOrganizations.map((msp) => (
                  <span key={msp} className="chip">
                    {msp}
                  </span>
                ))}
              </div>
            </div>
          ) : (
            <p className="subtle flat">The network asks the organisations the contract's endorsement policy requires.</p>
          ))}
        <p className="subtle type-xs flat">Before signing, Weft checks that the relay's messages match what is shown here.</p>
      </main>
      <Footer
        onDecide={(approved) => onDecide(approved, approved && keep)}
        cta={submit ? "Sign and submit" : "Sign and read"}
        ctaClass={submit ? "btn--amber" : "btn--primary"}
        deciding={deciding}
        progress={progress}
        done={signDone(view, progress.outcome)}
      />
    </>
  );
}

/**
 * weft_addNetwork: a site asks the user to join a network from an invite.
 * The invite is fetched only after the user agrees, from the organisation's
 * own server, so the site can't put words in the invite.
 */
/**
 * The status line for a signed call: the block it reached (for a submit), the
 * call, who signed, and the explorer where the network names one.
 */
function signDone(view: ApprovalView, outcome: ApprovalOutcome | null): Done {
  const approved = outcome?.status === "approved" ? outcome : null;
  const signer = view.identity ? `, signed as ${view.identity.name}` : "";
  const detail = `${callLine(view)}${signer}.`;
  if (view.method !== "weft_submit") return { headline: "Read from the ledger.", detail: `${detail} Closing.` };
  const block = approved?.blockNumber ? ` in block ${Number(approved.blockNumber).toLocaleString()}` : "";
  const receipt = approved?.receipt;
  const trouble = receiptTrouble(receipt);
  const link =
    approved?.explorerUrl && approved.transactionId && !trouble
      ? {
          href: `${approved.explorerUrl}/channels/${encodeURIComponent(view.call!.channel)}/transactions/${encodeURIComponent(approved.transactionId)}`,
          label: "View in the explorer",
        }
      : undefined;
  // What became of the receipt, after the call, in the same line.
  const said: ReactNode =
    receipt?.kept === true ? (
      receipt.locked ? (
        <>
          {" "}
          <span className="kept-line">Weft kept your receipt.</span> It locked while it waited, so unlock Weft to see it.
        </>
      ) : (
        <>
          {" "}
          <span className="kept-line">Weft kept your receipt</span> with it in your activity.
        </>
      )
    ) : receipt?.kept === false && receipt.reason === "storage" ? (
      " Weft couldn't keep your receipt. Save it above before you close this window."
    ) : receipt?.kept === false && receipt.reason === "mismatch" ? (
      " Weft didn't keep your receipt. The reason is above."
    ) : null;
  return {
    headline: `Committed${block}.`,
    detail: (
      <>
        {detail}
        {said}
      </>
    ),
    ...(link ? { link } : {}),
    ...(trouble ? { stays: true } : {}),
  };
}

/**
 * "Keep the receipt in Weft", under the arguments: who asks, and what Weft
 * keeps. Off until the user turns it on; it can't change once signing starts.
 */
function KeepReceipt({
  host,
  receipt,
  keep,
  onKeep,
  locked,
}: {
  host: string;
  receipt: NonNullable<ApprovalView["receipt"]>;
  keep: boolean;
  onKeep: (keep: boolean) => void;
  locked: boolean;
}) {
  return (
    <section className={`keep${keep ? " keep--on" : ""}`} aria-labelledby="keep-title">
      <label className="keep__row">
        <span className="keep__text">
          <span className="strong" id="keep-title">
            Keep the receipt in Weft
          </span>
          <span className="subtle type-xs">
            {host} asks for this vote in <span className="mono">{receipt.request.electionId}</span>.
          </span>
        </span>
        <input
          type="checkbox"
          role="switch"
          className="switch"
          checked={keep}
          disabled={locked}
          aria-describedby="keep-detail"
          onChange={(e) => onKeep(e.target.checked)}
        />
      </label>
      <p className="keep__detail type-xs" id="keep-detail">
        {receipt.generated && "Weft chose the salt at random. The site gets the receipt whether or not Weft keeps it. "}
        Weft keeps your choice and salt from <span className="mono">{receipt.input}</span>, encrypted with your password, and adds the
        transaction ID, block and commitment once it commits. You'll find it under this transaction in your activity.
      </p>
    </section>
  );
}

/**
 * At the top of a committed vote's body, when Weft couldn't keep the receipt
 * the user asked it to: the browser refused the write, so this window offers
 * the only copy Weft has, or the contract's commitment wasn't the one for the
 * choice and salt, so a receipt with it wouldn't check out.
 */
function ReceiptProblem({ progress, electionId }: { progress: Progress; electionId: string }) {
  const box = useRef<HTMLDivElement>(null);
  const outcome = progress.phase === "done" && progress.outcome?.status === "approved" ? progress.outcome.receipt : undefined;
  const trouble = receiptTrouble(outcome);
  useEffect(() => {
    if (trouble) box.current?.scrollIntoView({ block: "nearest" });
  }, [trouble]);
  if (!outcome || outcome.kept || !trouble) return null;
  return (
    <div ref={box} className="notice notice--amber notice--column receipt-problem arrive" role="alert">
      <div className="inline strong receipt-problem__title">
        <Icon name="alert" size={18} />
        {outcome.reason === "storage" ? "Weft couldn't keep your receipt" : "Weft didn't keep the receipt"}
      </div>
      {outcome.reason === "storage" ? (
        <>
          <div>Your vote is committed, but this browser refused to store the receipt. Save it now: Weft has a copy only while this window is open.</div>
          <SaveReceipt receipt={outcome.receipt} copied="Copied. Paste it somewhere you'll keep it." />
          <ErrorDetails>{outcome.error}</ErrorDetails>
        </>
      ) : outcome.reason === "mismatch" ? (
        <>
          <div>
            Your vote is committed, but the commitment the contract returned isn't the one for your choice and salt. A receipt with it
            wouldn't check out in the explorer, so Weft kept nothing. Tell the site's owner.
          </div>
          <ErrorDetails>
            Expected {shorten(outcome.expected)}, SHA-256 of {electionId}, the choice and the salt.{" "}
            {outcome.returned ? `The contract returned ${shorten(outcome.returned)}.` : "The contract returned no commitment."}
          </ErrorDetails>
        </>
      ) : null}
    </div>
  );
}

function AddNetworkRequest({ view, onDecide, deciding, progress }: RequestProps) {
  const inviteUrl = view.inviteUrl!;
  const [invite, setInvite] = useState<OrgInvite | null>(null);
  const [enrollmentId, setEnrollmentId] = useState("");
  const [secret, setSecret] = useState("");
  const checks = useChecks({
    enrollmentId: () => check.required(enrollmentId, "Enter your enrolment ID."),
    secret: () => check.required(secret, "Enter the enrolment secret from your administrator."),
  });

  const review = useAction(async () => {
    await requestHostAccess([inviteUrl], "the server the invite comes from");
    const loaded = await ui("fetchInvite", { link: inviteUrl });
    // Weft Experimental reads voter invites too (docs/adr/0008), but a site can't hand one over: the voter opens it in the popup.
    if (import.meta.env.WEFT_EXPERIMENTAL === true && "weftVoterInvite" in loaded) {
      throw new UiError(
        "This is a voter invite for an election. A site can't add it for you: open Weft Experimental from the toolbar, choose Join from an invite and paste the link.",
        `${inviteUrl} has "weftVoterInvite": 1.`,
      );
    }
    if ("weftVoterInvite" in loaded) return;
    setInvite(loaded);
    setEnrollmentId(loaded.enrollmentId ?? "");
  });

  const enroll = useAction(async (inv: OrgInvite) => {
    await requestHostAccess([inv.caUrl, inv.relayUrl]);
    await ui("joinInvite", { invite: inv, enrollmentId: enrollmentId.trim(), secret, inviteUrl });
    onDecide(true);
  });
  const busy = review.busy || enroll.busy || deciding;
  // Enrolling is the work here; the decision that follows it is a formality.
  const shown: Progress = enroll.busy ? { ...progress, phase: "working" } : progress;
  const done = progress.phase === "done" && progress.outcome?.status === "approved";

  return (
    <>
      <RequestHeader
        title={invite ? `Join ${invite.network}?` : "Add a network?"}
        origin={view.origin}
        subtitle="wants you to join a network"
        progress={shown}
        working={invite ? `Joining ${invite.network}` : "Joining"}
        done={invite ? `Joined ${invite.network}` : "Network added"}
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
          className="contents"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (checks.submit()) void enroll.run(invite);
          }}
        >
          <main key="enrol" className={`${bodyClass(shown)} step`} data-dir="forward" aria-busy={shown.phase === "working" || undefined}>
            <FailureOutcome progress={progress} view={view} />
            <InviteCard invite={invite} />
            <Field label="Enrolment ID" {...checks.field("enrollmentId")}>
              {(a) => <input {...a} className="mono" value={enrollmentId} onChange={(e) => setEnrollmentId(e.target.value)} />}
            </Field>
            <Field label="Enrolment secret" hint="Your administrator gives you this. Weft uses it once and never stores it." {...checks.field("secret")}>
              {(a) => <SecretInput {...a} value={secret} onChange={(e) => setSecret(e.target.value)} />}
            </Field>
            <ActionError error={enroll.error} />
          </main>
          {failed(progress) ? (
            <CloseFooter />
          ) : done ? (
            <footer className="footer footer--status">
              <div className="status-line arrive" role="status">
                <Icon name="check" size={20} color="var(--weft-accent-text)" />
                <div className="status-line__text">
                  <span>Joined {invite.network}.</span>
                  <span className="status-line__detail">
                    Enrolled as {enrollmentId.trim()} in {invite.mspId}. Closing.
                  </span>
                </div>
              </div>
            </footer>
          ) : (
            <footer className="footer">
              <Button aria-disabled={busy || undefined} onClick={() => onDecide(false)}>
                Reject
              </Button>
              <Button type="submit" className="btn btn--primary" busy={enroll.busy || deciding}>
                Enrol
              </Button>
            </footer>
          )}
        </form>
      )}
    </>
  );
}

document.body.classList.add("window");
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <FeedbackProvider>
      <Approve />
    </FeedbackProvider>
  </StrictMode>,
);
