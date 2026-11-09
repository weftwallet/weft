/**
 * Weft Experimental only (docs/adr/0008): voter credentials in the popup.
 * Joining from a voter invite and getting the credential, the credentials'
 * own group in Identities, a credential's detail with Remove credential, and
 * the card Home shows when Weft holds nothing but voter credentials. Loaded
 * with a dynamic import behind the build constant, so the normal build has
 * none of it.
 */
import type { VoterInvite } from "@weftwallet/protocol";
import { useEffect, useRef, useState, type FormEvent } from "react";
import "./voter-credential.css";
import { newId } from "../../lib/db";
import { ui, type WalletState } from "../../lib/messages";
import { requestHostAccess } from "../../lib/permissions";
import { secretAgain, useCarriedFields } from "../../lib/tab-carry";
import { EnrolError, STEP_LINES, alreadyHeld, enrol, saveRecord, type EnrolStep } from "../../lib/voter/enrol";
import { measure, startVoterModule } from "../../lib/voter/module";
import { openEnrollmentId, sealCredential, voterKey } from "../../lib/voter/seal";
import type { VoterCredentialRecord, VoterCredentialView } from "../../lib/voter/types";
import { useFeedback, useLeaveGuard } from "../feedback";
import { useChecks } from "../form";
import { ActionError, BackHeader, Button, Field, Icon, SecretInput, shorten, toErrorInfo, type ErrorInfo } from "../ui";
import * as check from "../../lib/validate";
import { GroupHeading } from "./lists";
import type { Navigate } from "./state";

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/* ------------------------------------------------------------------ */
/* Joining                                                             */
/* ------------------------------------------------------------------ */

/**
 * What the voter joins, before any secret is typed, with the one sentence
 * about revocation (D13). It is named by the invite's title when it gives
 * one, with the election's ID under it.
 */
function VoterInviteCard({ invite }: { invite: VoterInvite }) {
  return (
    <>
      <section className="card" aria-label="Voter invite">
        <span className="eyebrow">You're joining an election as a voter</span>
        <div className="card__title wrap-anywhere">{invite.title ?? invite.electionId}</div>
        {invite.title && <div className="mono subtle type-xs wrap-anywhere">{invite.electionId}</div>}
        <dl className="details">
          <dt>Network</dt>
          <dd>{invite.network}</dd>
          <dt>Voters</dt>
          <dd>
            {invite.organization}
            <span className="mono muted type-xs block">{invite.mspId}</span>
          </dd>
          <dt>Channel</dt>
          <dd className="mono wrap-anywhere">{invite.channel}</dd>
          <dt>Voters' CA</dt>
          <dd className="mono">{hostOf(invite.caUrl)}</dd>
          <dt>Relay</dt>
          <dd>
            <span className="mono">{hostOf(invite.relayUrl)}</span>
            <span className="subtle type-xs block">Run by {invite.relayOperator}</span>
          </dd>
          <dt>Issuer key</dt>
          <dd>
            <span className="mono type-xs" title={invite.issuerKeyHash}>
              {shorten(invite.issuerKeyHash)}
            </span>
          </dd>
        </dl>
      </section>
      <div className="notice notice--thread">
        <Icon name="shield" size={18} color="var(--weft-accent-text)" />
        <span>
          A voter credential votes only in {invite.electionId}. Weft never shows it to a site, and a ballot signed with it shows {invite.mspId} and not who you
          are. It can't be revoked, so keep Weft locked when you're away.
        </span>
      </div>
    </>
  );
}

/**
 * The voter invite's review and Get a voter credential. Weft enrols in the
 * order lib/voter/enrol.ts gives, and the line above the button says which
 * step is running.
 */
export function VoterJoin({
  invite,
  inviteUrl,
  state,
  dir,
  onBack,
  onDone,
}: {
  invite: VoterInvite;
  inviteUrl: string;
  state: WalletState;
  dir: "forward" | "back";
  onBack: () => void;
  onDone: (added?: string, to?: "home" | "identities") => Promise<void>;
}) {
  // Carried to a tab if the toolbar popup has to move this step there, all but the secret (lib/tab-carry.ts).
  const carried = useCarriedFields("join-voter", () => ({ fields: { enrollmentId }, secrets: { secret: secret !== "" } }));
  const [enrollmentId, setEnrollmentId] = useState(carried.fields.enrollmentId ?? "");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState("");
  const [error, setError] = useState<ErrorInfo | null>(null);
  // A credential the CA issued and Weft sealed, but the browser refused to save.
  const [pending, setPending] = useState<VoterCredentialRecord | null>(null);
  const running = useRef(false);
  const checks = useChecks({
    enrollmentId: () => check.required(enrollmentId, "Enter your enrolment ID."),
    secret: () => check.required(secret, "Enter the enrolment secret the organisers gave you."),
  });
  const leave = useLeaveGuard(secret !== "" || pending !== null, onBack);

  const save = (record: VoterCredentialRecord) => ui("voterCredentialAdd", { record });

  const finish = async (view: VoterCredentialView) => {
    setPending(null);
    await onDone(`Added a voter credential for ${view.electionId}`, "identities");
  };

  const fail = (e: unknown) => {
    if (e instanceof EnrolError) {
      setError({ message: e.message, ...(e.detail ? { detail: e.detail } : {}) });
      if (e.pending) setPending(e.pending);
    } else setError(toErrorInfo(e));
    requestAnimationFrame(() => document.querySelector(".page__actions .action-error")?.scrollIntoView({ block: "nearest" }));
  };

  const run = async () => {
    if (running.current) return;
    // 1. Weft keeps one credential per election: checked before anything is asked of the browser or the CA.
    const held = state.voterCredentials?.find((c) => c.channel === invite.channel && c.chaincode === invite.chaincode && c.electionId === invite.electionId);
    if (held) {
      setError(null);
      return fail(alreadyHeld(invite.electionId, held.createdAt));
    }
    running.current = true;
    setBusy(true);
    setError(null);
    const started = performance.now();
    try {
      // 2. Host access, straight after the press, as the browser requires.
      await requestHostAccess([invite.caUrl, invite.relayUrl], "the voters' CA and the election's relay");
      const view = await enrol(invite, inviteUrl, enrollmentId.trim(), secret, {
        fetch: (input, init) => fetch(input, init),
        startModule: startVoterModule,
        voterKey,
        seal: sealCredential,
        save,
        newId,
        now: () => Date.now(),
        onStep: (step: EnrolStep) => setLine(STEP_LINES[step]),
      });
      measure("weft-voter-enrol", started);
      setSecret("");
      await finish(view);
    } catch (e) {
      fail(e);
    } finally {
      running.current = false;
      setBusy(false);
      setLine("");
    }
  };

  const saveAgain = async () => {
    if (!pending || running.current) return;
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      await finish(await saveRecord(pending, { save }));
    } catch (e) {
      fail(e);
    } finally {
      running.current = false;
      setBusy(false);
    }
  };

  return (
    <>
      <BackHeader title="Join from an invite" onBack={() => void leave()} />
      <form
        key="voter"
        className="page step"
        data-dir={dir}
        noValidate
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (pending) return void saveAgain();
          if (checks.submit()) void run();
        }}
      >
        <VoterInviteCard invite={invite} />
        <Field label="Enrolment ID" {...checks.field("enrollmentId")}>
          {(a) => <input {...a} className="mono" autoComplete="off" value={enrollmentId} disabled={pending !== null} onChange={(e) => setEnrollmentId(e.target.value)} />}
        </Field>
        <Field
          label="Enrolment secret"
          note={carried.leftOut.includes("secret") && secret === "" ? secretAgain("Enter the enrolment secret again.") : undefined}
          hint="The organisers give you this. The voters' CA accepts it once, and Weft never stores it."
          {...checks.field("secret")}
        >
          {(a) => <SecretInput {...a} autoComplete="off" value={secret} disabled={pending !== null} onChange={(e) => setSecret(e.target.value)} />}
        </Field>
        <div className="page__actions">
          <ActionError error={error} />
          <p className="subtle type-xs flat enrol-line" role="status">
            {line}
          </p>
          <Button type="submit" className="btn btn--primary" busy={busy}>
            {pending ? "Save the credential" : "Get a voter credential"}
          </Button>
        </div>
      </form>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* In Identities                                                       */
/* ------------------------------------------------------------------ */

/**
 * The voter credentials' own group, under the networks (D10). Each row is
 * named by its election, not the enrolment ID, and can't be pressed to make
 * it active: it opens the credential's detail.
 */
export function VoterCredentialGroup({ credentials, fresh, navigate }: { credentials: VoterCredentialView[]; fresh: string[]; navigate: Navigate }) {
  if (credentials.length === 0) return null;
  const msps = [...new Set(credentials.map((c) => c.mspId))];
  return (
    <section className="stack" aria-label="Voter credentials">
      <GroupHeading title="Voter credentials" detail={msps.length === 1 ? msps[0] : undefined} />
      {credentials.map((c) => (
        <div key={c.id} className="manage-row">
          <button type="button" className={`identity-option${fresh.includes(c.id) ? " is-new" : ""}`} onClick={() => navigate({ name: "voter-credential", id: c.id })}>
            <span className="avatar vc-avatar" aria-hidden="true">
              <Icon name="ballot" size={16} />
            </span>
            <span className="list-item__body">
              <span className="list-item__title" title={c.title}>
                {c.title}
              </span>
              <span className="mono subtle one-line type-xs">
                {c.title === c.electionId ? `${c.affiliation} · ${c.role}` : `${c.affiliation} · ${c.role} · ${c.electionId}`}
              </span>
            </span>
            <span className="type-xs subtle">{c.voted ? "Voted" : "Not voted"}</span>
          </button>
        </div>
      ))}
      <p className="subtle type-xs flat inset-x">Each votes in one election only. They are never connected to a site or made the active identity.</p>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* A credential's detail                                               */
/* ------------------------------------------------------------------ */

const added = (at: number) =>
  `${new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}, ${new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;

/** What Weft stores and shows for one credential, that it can't be revoked (D13), and Remove credential. */
export function VoterCredentialDetail({ state, id, navigate, onState }: { state: WalletState; id: string; navigate: Navigate; onState: (s: WalletState) => void }) {
  const { confirm, toast } = useFeedback();
  const credential = state.voterCredentials?.find((c) => c.id === id);
  const [enrollmentId, setEnrollmentId] = useState<string | null>(null);
  const unlocked = state.vault.state === "unlocked";

  // The enrolment ID is sealed: it is opened in this page, while Weft is unlocked, and only to show it here.
  useEffect(() => {
    if (!unlocked || !credential) return setEnrollmentId(null);
    let live = true;
    void (async () => {
      const record = await ui("voterCredential", { id });
      if (!record || !live) return;
      const opened = await openEnrollmentId(await voterKey(), record);
      if (live) setEnrollmentId(opened);
    })().catch(() => live && setEnrollmentId(null));
    return () => {
      live = false;
    };
  }, [id, unlocked, Boolean(credential)]);

  const back = () => navigate({ name: "identities" });
  if (!credential) {
    return (
      <>
        <BackHeader title="Voter credential" onBack={back} />
        <main className="page">
          <p className="muted flat">This voter credential is no longer in Weft.</p>
        </main>
      </>
    );
  }
  const c = credential;

  const remove = async () => {
    const ok = await confirm({
      title: `Remove the voter credential for ${c.electionId}?`,
      body: (
        <>
          <p className="sheet__para">
            Weft deletes its secret key from this browser, and it can't be recovered. The voters' CA issues one credential per voter, so you can't enrol for{" "}
            {c.electionId} again.
          </p>
          <p className="flat">{c.voted ? "Your ballot stays on the ledger and in the count." : `Without it you can't vote in ${c.electionId}.`}</p>
        </>
      ),
      confirmLabel: "Remove credential",
      icon: "trash",
    });
    if (!ok) return;
    try {
      onState(await ui("voterCredentialRemove", { id }));
      navigate({ name: "identities" });
      toast(`Removed the voter credential for ${c.electionId}`);
    } catch (e) {
      toast(`Couldn't remove the voter credential. ${toErrorInfo(e).message}`, "error");
    }
  };

  return (
    <>
      <BackHeader title="Voter credential" onBack={back} />
      <main className="page stack--loose">
        <div className="stack">
          <span className="eyebrow">For one election</span>
          <div className="card__title wrap-anywhere">
            {c.title}
          </div>
          <div className="mono subtle type-xs wrap-anywhere">
            {c.electionId} on {c.channel}
          </div>
        </div>
        <div className="notice notice--thread">
          <Icon name={c.voted ? "check" : "ballot"} size={18} color="var(--weft-accent-text)" />
          <span>
            {c.voted
              ? `You voted in ${c.electionId}${c.voted.blockNumber ? ` in block ${Number(c.voted.blockNumber).toLocaleString("en-GB")}` : ""}. The contract refuses a second ballot from this credential.`
              : `You haven't voted in ${c.electionId} with this credential.`}
          </span>
        </div>
        <dl className="details">
          <dt>Voter organisation</dt>
          <dd className="mono">{c.mspId}</dd>
          <dt>Shown on each ballot</dt>
          <dd>
            {c.mspId}, the affiliation <span className="mono">{c.affiliation}</span> and the role <span className="mono">{c.role}</span>. Every voter in{" "}
            {c.electionId} shares them.
          </dd>
          <dt>Enrolment ID</dt>
          <dd>
            <span className="mono">{enrollmentId ?? "Sealed"}</span>
            <span className="subtle type-xs block">Kept sealed on this device. Weft sent it to the voters' CA once, to enrol.</span>
          </dd>
          <dt>Issuer key</dt>
          <dd>
            <span className="mono type-xs" title={c.issuerKeyHash}>
              {shorten(c.issuerKeyHash)}
            </span>
            <span className="subtle type-xs block">
              SHA-256 of {c.caName ?? "the voters' CA"}'s key, which {c.electionId} pinned when it was created.
            </span>
          </dd>
          <dt>Curve</dt>
          <dd className="mono">{c.curve}</dd>
          <dt>Sites</dt>
          <dd>
            Never connected to a site. <span className="mono">weft_identity</span> and Sign in don't use it.
          </dd>
          <dt>Revocation</dt>
          <dd>
            None. Fabric can't revoke this credential and it has no expiry date. Anyone who copies it from this browser can vote once in {c.electionId} in your
            place. No other election accepts it.
          </dd>
          <dt>Added</dt>
          <dd>{added(c.createdAt)}</dd>
        </dl>
        <div className="row-between type-xs">
          <span className="subtle">The secret key is sealed under your vault key.</span>
          <button type="button" className="link-btn link-btn--inline danger-text" onClick={() => void remove()}>
            Remove credential
          </button>
        </div>
      </main>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Home, with only voter credentials                                   */
/* ------------------------------------------------------------------ */

/** In the active identity's place when Weft holds only voter credentials (D10). */
export function NoSiteIdentityCard({ credentials }: { credentials: VoterCredentialView[] }) {
  const one = credentials.length === 1 ? credentials[0]! : null;
  return (
    <section className="card crossfade" aria-label="No identity for sites">
      <span className="eyebrow">Active identity</span>
      <div className="identity-name">None for sites</div>
      <p className="muted flat">
        {one ? `Your voter credential for ${one.electionId} votes only in ${one.electionId}.` : "Your voter credentials each vote in their own election only."} A site
        that asks to connect gets "Weft has no identity yet" (4300).
      </p>
    </section>
  );
}
