/**
 * Weft Experimental only (docs/adr/0007): the approval window for
 * weft_castBallot. main.tsx loads it with a dynamic import behind
 * EXPERIMENTAL, so the normal build has none of it.
 *
 * Approve has already unlocked Weft. This reads the election through the
 * background worker, then shows two screens: choose an option, then confirm
 * the vote with who holds the key, the election fingerprint and what the
 * network sees. A failure before the vote replaces both with what happened.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import "./cast-ballot.css";
import { trackingUrl } from "../../components/popup/BallotReceipt";
import { SaveReceipt } from "../../components/receipt";
import {
  Brand,
  Button,
  ErrorDetails,
  Icon,
  Splash,
  StatusScreen,
  WeaveMark,
  clockTime,
  shorten,
  toErrorInfo,
  useFocusOnArrival,
  type ErrorInfo,
} from "../../components/ui";
import { ui, type ApprovalOutcome, type ApprovalView, type BallotElectionView, type BallotFailureView, type BallotReadView, type ReceiptOutcome } from "../../lib/messages";
import { requestHostAccess } from "../../lib/permissions";

interface Progress {
  phase: "review" | "working" | "done";
  outcome: ApprovalOutcome | null;
  slow: boolean;
}

interface Props {
  view: ApprovalView;
  onDecide: (approved: boolean, keepReceipt?: boolean, choice?: number) => void;
  deciding: boolean;
  progress: Progress;
}

const SUBTITLE = "asks you to vote in a private election";

/** "Org1MSP and Org2MSP", "Org1MSP, Org2MSP and Org3MSP". */
const listOf = (items: readonly string[]) => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "17:00 UTC on 31 January 2027". */
export function utcTime(iso: string): string {
  const d = new Date(iso);
  const hm = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  return `${hm} UTC on ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** "in 4 days", "in 3 hours", "in 20 minutes", or "4 days ago". */
export function fromNow(iso: string, now = Date.now()): string {
  const ms = Date.parse(iso) - now;
  const abs = Math.abs(ms);
  const [n, unit] =
    abs >= 2 * 86_400_000 ? [Math.round(abs / 86_400_000), "day"] : abs >= 2 * 3_600_000 ? [Math.round(abs / 3_600_000), "hour"] : [Math.max(1, Math.round(abs / 60_000)), "minute"];
  const span = `${n} ${unit}${n === 1 ? "" : "s"}`;
  return ms >= 0 ? `in ${span}` : `${span} ago`;
}

export default function CastBallotRequest({ view, onDecide, deciding, progress }: Props) {
  const ballot = view.ballot!;
  const [read, setRead] = useState<BallotReadView | null>(null);
  const [workerError, setWorkerError] = useState<ErrorInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [retryLine, setRetryLine] = useState<string | null>(null);
  const [step, setStep] = useState<"choose" | "confirm">("choose");
  const [dir, setDir] = useState<"forward" | "back">("forward");
  const [choice, setChoice] = useState<number | null>(null);
  // "Keep the receipt in Weft" starts off, and only the voter turns it on.
  const [keep, setKeep] = useState(false);

  useEffect(() => {
    void ui("ballotRead", { id: view.id }).then(setRead, (e: unknown) => setWorkerError(toErrorInfo(e)));
  }, [view.id]);

  /** Try again and Refresh from invite: the status screen stays, the pressed button shows the loader. */
  const again = async (refresh: boolean, inviteUrl?: string) => {
    if (busy) return;
    setBusy(true);
    setRetryLine(null);
    try {
      if (refresh && inviteUrl) await requestHostAccess([inviteUrl], "the server the invite comes from");
      const next = await ui(refresh ? "ballotRefreshInvite" : "ballotRead", { id: view.id });
      setRead(next);
      if (next.status === "failed" && next.failure.kind === "unreachable") {
        setRetryLine(`Tried again at ${clockTime()}. The relay still didn't answer. Check that it's running.`);
      }
    } catch (e) {
      const info = toErrorInfo(e);
      setRetryLine(refresh ? `Weft couldn't load the invite. ${info.message}` : `Tried again at ${clockTime()}. ${info.message}`);
    } finally {
      setBusy(false);
    }
  };

  if (workerError) {
    return (
      <StatusScreen mark={<WeaveMark size={64} mode="still" />} title="Weft couldn't read this election" detail="Its background worker didn't answer. No ballot was cast.">
        <div className="status-screen__actions">
          <button type="button" className="btn" onClick={() => onDecide(false)}>
            Close
          </button>
          <ErrorDetails>{workerError.message}</ErrorDetails>
        </div>
      </StatusScreen>
    );
  }
  if (!read || (read.status === "failed" && read.failure.kind === "locked")) {
    return <Splash label={`Reading ${ballot.electionId} from the ledger`} />;
  }
  if (read.status === "failed") {
    return <ReadFailed failure={read.failure} busy={busy} retryLine={retryLine} onAgain={again} onClose={() => onDecide(false)} />;
  }

  const election = read.election;
  if (step === "choose" && progress.phase === "review") {
    return (
      <ChooseScreen
        view={view}
        election={election}
        choice={choice}
        dir={dir}
        onChoose={setChoice}
        onReject={() => onDecide(false)}
        deciding={deciding}
        onReview={() => {
          if (choice === null) return;
          setDir("forward");
          setStep("confirm");
        }}
      />
    );
  }
  return (
    <ConfirmScreen
      view={view}
      election={election}
      choice={choice!}
      keep={keep}
      onKeep={setKeep}
      dir={dir}
      deciding={deciding}
      progress={progress}
      onChange={() => {
        setDir("back");
        setStep("choose");
      }}
      onDecide={onDecide}
    />
  );
}

/** The window's header: the mark and name, what's asked or what happened, and who asks. */
function Header({ title, origin, subtitle }: { title: string; origin: string; subtitle: string }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useFocusOnArrival(heading, title);
  return (
    <header className="request-header">
      <Brand />
      <h1 ref={heading} tabIndex={-1} className="request-header__title">
        {title}
      </h1>
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
    </header>
  );
}

/** A failure before the vote: what happened, and Try again, Refresh from invite or Close. */
function ReadFailed({
  failure,
  busy,
  retryLine,
  onAgain,
  onClose,
}: {
  failure: BallotFailureView;
  busy: boolean;
  retryLine: string | null;
  onAgain: (refresh: boolean, inviteUrl?: string) => void;
  onClose: () => void;
}) {
  const waiting = failure.kind === "unreachable" || failure.kind === "noChannel";
  return (
    <StatusScreen mark={<WeaveMark size={64} mode="still" />} title={failure.title} detail={failure.detail}>
      <div className="status-screen__actions">
        {failure.kind === "unreachable" && (
          <Button className="btn btn--primary" busy={busy} onClick={() => onAgain(false)}>
            Try again
          </Button>
        )}
        {failure.kind === "noChannel" && (
          <Button className="btn btn--primary" busy={busy} onClick={() => onAgain(true, failure.inviteUrl)}>
            Refresh from invite
          </Button>
        )}
        <Button aria-disabled={busy || undefined} onClick={onClose}>
          {waiting ? "Reject" : "Close"}
        </Button>
        {failure.technical && <ErrorDetails>{failure.technical}</ErrorDetails>}
      </div>
      <p className="status-screen__retry" role="status">
        {retryLine}
      </p>
    </StatusScreen>
  );
}

/** The election's public details, on the first screen. */
function ElectionDetails({ election }: { election: BallotElectionView }) {
  return (
    <dl className="details">
      <dt>Election</dt>
      <dd>
        <span className="strong block wrap-anywhere">{election.title}</span>
        <span className="mono muted type-xs">{election.electionId}</span>
      </dd>
      <dt>Channel</dt>
      <dd className="mono wrap-anywhere">{election.channel}</dd>
      <dt>Contract</dt>
      <dd className="mono">{election.chaincode}</dd>
      <dt>Planned closing</dt>
      <dd>
        {utcTime(election.closesAt)} <span className="subtle">· {fromNow(election.closesAt)}</span>
        {election.pastClosing && <span className="block type-xs warn-line">Past its planned closing time. The trustees haven't closed it yet.</span>}
      </dd>
    </dl>
  );
}

function ChooseScreen({
  view,
  election,
  choice,
  dir,
  deciding,
  onChoose,
  onReview,
  onReject,
}: {
  view: ApprovalView;
  election: BallotElectionView;
  choice: number | null;
  dir: "forward" | "back";
  deciding: boolean;
  onChoose: (i: number) => void;
  onReview: () => void;
  onReject: () => void;
}) {
  return (
    <form
      className="contents"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        onReview();
      }}
    >
      <Header title={`Vote in ${election.title}?`} origin={view.origin} subtitle={SUBTITLE} />
      <main className="page step" data-dir={dir}>
        {election.alreadyVoted && (
          <div className="notice notice--amber">
            <Icon name="alert" size={18} color="var(--weft-warn-text)" />
            <span>
              Your Weft activity has a ballot from {election.voter.name} in this election
              {election.alreadyVoted.blockNumber ? `, in block ${election.alreadyVoted.blockNumber}` : ""}. The contract refuses a second one.
            </span>
          </div>
        )}
        <div className="notice notice--thread">
          <span className="tag" style={{ background: "var(--weft-accent)" }}>
            Private
          </span>
          <span>Weft encrypts your choice in this window. The site, the relay and each organisation on its own see only an encrypted ballot.</span>
        </div>
        <fieldset className="ballot-options">
          <legend className="eyebrow">Your choice</legend>
          {election.options.map((option, i) => (
            <label key={i} className="ballot-option">
              <input type="radio" name="choice" value={i} checked={choice === i} onChange={() => onChoose(i)} />
              <span>{option}</span>
            </label>
          ))}
        </fieldset>
        <p className="subtle type-xs choose-hint">
          {choice === null ? "Choose one option to review your vote." : "Nothing is signed until you confirm your vote."}
        </p>
        <ElectionDetails election={election} />
        <p className="subtle type-xs flat">Weft read this election from the ledger through {election.relayHost}. The site gave only its ID.</p>
      </main>
      <footer className="footer">
        <Button aria-disabled={deciding || undefined} onClick={onReject}>
          Reject
        </Button>
        <Button type="submit" className="btn btn--primary" disabled={choice === null}>
          Review your vote
        </Button>
      </footer>
    </form>
  );
}

function ConfirmScreen({
  view,
  election,
  choice,
  keep,
  onKeep,
  dir,
  deciding,
  progress,
  onChange,
  onDecide,
}: {
  view: ApprovalView;
  election: BallotElectionView;
  choice: number;
  keep: boolean;
  onKeep: (keep: boolean) => void;
  dir: "forward" | "back";
  deciding: boolean;
  progress: Progress;
  onChange: () => void;
  onDecide: Props["onDecide"];
}) {
  const host = new URL(view.origin).host;
  const working = progress.phase === "working";
  const done = progress.phase === "done";
  const failed = done && progress.outcome?.status === "failed" ? progress.outcome : null;
  const approved = done && progress.outcome?.status === "approved" ? progress.outcome : null;
  const locked = progress.phase !== "review" || deciding;
  const option = election.options[choice]!;
  const title = working ? "Encrypting, signing and submitting" : failed ? failed.title : approved ? `Voted in ${election.title}` : `Vote for ${option}?`;
  const subtitle = working
    ? progress.slow
      ? "Still waiting for the block. Weft stops waiting after a minute and tells you what happened."
      : "Waiting for the network to answer."
    : SUBTITLE;

  return (
    <>
      <Header title={title} origin={view.origin} subtitle={subtitle} />
      <main className={`page step${working ? " page--dim" : ""}`} data-dir={dir} aria-busy={working || undefined}>
        {failed && <CastFailed outcome={failed} />}
        {approved && <ReceiptProblem receipt={approved.receipt} tracking={approved.tracking ?? ""} />}
        <section className="choice-card" aria-labelledby="choice-label">
          <div className="row-between">
            <span className="eyebrow" id="choice-label">
              Your vote
            </span>
            {!locked && (
              <button type="button" className="link-btn link-btn--inline" onClick={onChange}>
                Change choice
              </button>
            )}
          </div>
          <div className="choice-card__option">{option}</div>
        </section>
        <div className="notice notice--thread">
          <Icon name="shield" size={18} color="var(--weft-accent-text)" />
          <span>
            {listOf(election.trustees)} each hold part of this election's key. Any {election.threshold} of them together could read your ballot.
          </span>
        </div>
        <dl className="details">
          <dt>Election fingerprint</dt>
          <dd>
            <span className="fingerprint">
              {(election.fingerprint.match(/.{1,4}/g) ?? []).map((g, i) => (
                <span key={i}>{g}</span>
              ))}
            </span>
            <span className="subtle type-xs block">Weft worked this out from the election's record. Every explorer shows the same.</span>
          </dd>
          <dt>Voting as</dt>
          <dd>
            <span className="strong block">{election.voter.name}</span>
            <span className="mono muted type-xs">{election.voter.mspId}</span>
            <span className="subtle type-xs block">Every organisation can see that you voted.</span>
          </dd>
          <dt>Through</dt>
          <dd>
            <span className="mono">{election.relayHost}</span>
            <span className="subtle type-xs block">
              Weft read the election and sends your ballot through this relay. It sees your network address, not your choice.
            </span>
            <span className={`type-xs block ${election.peerChecked ? "subtle" : "warn-line"}`}>
              {election.peerChecked
                ? `Weft checked ${election.voter.mspId}'s peer signature on the election it read.`
                : `Weft didn't check a peer's signature on the election: it has no CA chain for this identity. Compare the fingerprint with an explorer's.`}
            </span>
          </dd>
        </dl>
        <section className={`keep${keep ? " keep--on" : ""}`} aria-labelledby="keep-title">
          <label className="keep__row">
            <span className="keep__text">
              <span className="strong" id="keep-title">
                Keep the receipt in Weft
              </span>
              <span className="subtle type-xs">{host} gets the tracking code either way.</span>
            </span>
            <input type="checkbox" role="switch" className="switch" checked={keep} disabled={locked} aria-describedby="keep-detail" onChange={(e) => onKeep(e.target.checked)} />
          </label>
          <p className="keep__detail type-xs" id="keep-detail">
            Weft keeps the tracking code with this transaction in your activity, and a note of your choice that only you can open in Weft. The receipt itself
            holds nothing about your choice.
          </p>
        </section>
        <p className="subtle type-xs flat">Before signing, Weft checks that the relay's proposal carries exactly the ballot it made.</p>
      </main>
      {failed ? (
        <footer className="footer footer--single">
          <button type="button" className="btn" onClick={() => window.close()}>
            Close
          </button>
        </footer>
      ) : approved ? (
        <DoneFooter election={election} host={host} outcome={approved} />
      ) : (
        <footer className="footer">
          <Button aria-disabled={deciding || undefined} onClick={() => onDecide(false)}>
            Reject
          </Button>
          <Button className="btn btn--amber" busy={deciding} onClick={() => onDecide(true, keep, choice)}>
            Sign and vote
          </Button>
        </footer>
      )}
    </>
  );
}

/** A failure after Sign and vote, at the top of the body: what happened, then the ledger and what to do. */
function CastFailed({ outcome }: { outcome: Extract<ApprovalOutcome, { status: "failed" }> }) {
  const box = useRef<HTMLDivElement>(null);
  // It is the body's first child: show it from its top, above where Sign and vote was pressed.
  useEffect(() => box.current?.closest("main")?.scrollTo({ top: 0 }), []);
  const technical = [outcome.code, outcome.raw].filter(Boolean).join(" ");
  return (
    <div ref={box} className="status-line status-line--failed request-outcome arrive" role="alert">
      <Icon name="alert" size={20} />
      <div className="status-line__text">
        <span>{outcome.detail}</span>
        {outcome.next && <span className="status-line__detail">{outcome.next}</span>}
        {outcome.activityId && <span className="status-line__detail">The details are saved in your Weft activity.</span>}
        {technical && <ErrorDetails>{technical}</ErrorDetails>}
      </div>
    </div>
  );
}

const trouble = (receipt: ReceiptOutcome | undefined) => receipt?.kept === false && (receipt.reason === "storage" || receipt.reason === "mismatch");

/** When Weft couldn't keep the receipt the voter asked for: the browser refused it, or the tracking codes differ. */
function ReceiptProblem({ receipt, tracking }: { receipt: ReceiptOutcome | undefined; tracking: string }) {
  const box = useRef<HTMLDivElement>(null);
  const shown = trouble(receipt);
  useEffect(() => {
    if (shown) box.current?.closest("main")?.scrollTo({ top: 0 });
  }, [shown]);
  if (!receipt || receipt.kept || !shown) return null;
  return (
    <div ref={box} className="notice notice--amber notice--column receipt-problem arrive" role="alert">
      <div className="inline strong receipt-problem__title">
        <Icon name="alert" size={18} />
        {receipt.reason === "storage" ? "Weft couldn't keep your receipt" : "Weft didn't keep the receipt"}
      </div>
      {receipt.reason === "storage" ? (
        <>
          <div>
            Your ballot is committed, but this browser refused to store the receipt and your note of the choice. Save the receipt now: Weft has a copy only
            while this window is open. It holds the tracking code, not your choice.
          </div>
          <SaveReceipt receipt={receipt.receipt} copied="Copied. It holds the tracking code, not your choice." />
          <ErrorDetails>{receipt.error}</ErrorDetails>
        </>
      ) : receipt.reason === "mismatch" ? (
        <>
          <div>
            Your ballot is committed, but the tracking code the contract returned isn't the one Weft worked out for the ballot it made. The explorer may not find
            your ballot by Weft's code, so Weft kept nothing. Tell the contract's developer.
          </div>
          <ErrorDetails>
            Weft worked out {shorten(tracking)} from the election context, your voter tag and the ballot.{" "}
            {receipt.returned ? `The contract returned ${shorten(receipt.returned)}.` : "The contract returned no tracking code."}
          </ErrorDetails>
        </>
      ) : null}
    </div>
  );
}

/** One status line once the ballot is committed: the block, the tracking code, the receipt, and the explorer's check. */
function DoneFooter({ election, host, outcome }: { election: BallotElectionView; host: string; outcome: Extract<ApprovalOutcome, { status: "approved" }> }) {
  const receipt = outcome.receipt;
  const stays = trouble(receipt);
  const tracking = outcome.tracking ?? "";
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
    ) : receipt?.kept === false && receipt.reason === "declined" ? (
      ` You left Keep the receipt in Weft off, so ${host} has the only copy of the tracking code.`
    ) : receipt?.kept === false && receipt.reason === "storage" ? (
      " Weft couldn't keep your receipt. Save it above before you close this window."
    ) : receipt?.kept === false && receipt.reason === "mismatch" ? (
      " Weft didn't keep your receipt. The reason is above."
    ) : null;
  const link = outcome.explorerUrl && !stays ? trackingUrl(outcome.explorerUrl, { channel: election.channel, electionId: election.electionId, tracking }) : null;
  return (
    <footer className="footer footer--status">
      <div className="status-line arrive" role="status">
        <Icon name="check" size={20} color="var(--weft-accent-text)" />
        <div className="status-line__text">
          <span>Committed in block {Number(outcome.blockNumber ?? 0).toLocaleString("en-GB")}.</span>
          <span className="status-line__detail">
            Tracking code <span className="mono">{shorten(tracking)}</span>.{said}
            {stays ? "" : " Closing."}
            {link && (
              <>
                {" "}
                <a href={link} target="_blank" rel="noreferrer">
                  Check it in the explorer
                </a>
              </>
            )}
          </span>
        </div>
      </div>
      {stays && (
        <button type="button" className="btn" onClick={() => window.close()}>
          Close
        </button>
      )}
    </footer>
  );
}
