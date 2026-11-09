import { resolveInviteUrl } from "@weftwallet/core";
import type { OrgInvite, VoterInvite } from "@weftwallet/protocol";
import { Suspense, lazy, useEffect, useRef, useState, type ClipboardEvent, type FormEvent } from "react";
import { ui, type IdentityView, type NetworkInput, type PendingCsrView, type WalletState } from "../../lib/messages";
import { requestHostAccess, setTabLink } from "../../lib/permissions";
import { scanActiveTab, scanPastedImage } from "../../lib/qr";
import * as check from "../../lib/validate";
import { InviteCard } from "../InviteCard";
import { useCopy, useFeedback, useLeaveGuard } from "../feedback";
import { useChecks, type FieldState } from "../form";
import { ActionError, BackHeader, Button, Field, SecretInput, toErrorInfo, type ErrorInfo } from "../ui";
import { useAction, type AddFrom, type Navigate } from "./state";

/**
 * Weft Experimental's review of a voter invite and its enrolment (docs/adr/0008).
 * The test is on the build constant itself, so the normal build never emits it.
 */
const VoterJoin = import.meta.env.WEFT_EXPERIMENTAL === true ? lazy(() => import("./VoterCredential").then((m) => ({ default: m.VoterJoin }))) : null;

interface FormProps {
  state: WalletState;
  navigate: Navigate;
  /** Refreshes the wallet and goes home (or to `to`), with a note of what was added. */
  onDone: (added?: string, to?: "home" | "identities") => Promise<void>;
  /** The screen the form was opened from, which Back returns to. */
  from?: AddFrom | undefined;
}

/* Shared network fields ------------------------------------------- */

const EMPTY_NETWORK = {
  name: "",
  organization: "",
  mspId: "",
  caUrl: "",
  caName: "",
  relayUrl: "",
  channels: "",
};

type NetworkDraft = typeof EMPTY_NETWORK;

function toNetwork(d: NetworkDraft): NetworkInput {
  return {
    name: d.name.trim() || d.mspId.trim(),
    organization: d.organization.trim() || d.mspId.trim(),
    mspId: d.mspId.trim(),
    caUrl: d.caUrl.trim().replace(/\/+$/, ""),
    ...(d.caName.trim() ? { caName: d.caName.trim() } : {}),
    relayUrl: d.relayUrl.trim().replace(/\/+$/, ""),
    channels: d.channels
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean),
  };
}

/** The checks for the network fields, in the order they're shown. */
function networkChecks(d: NetworkDraft, needsCa: boolean) {
  return {
    mspId: () => check.required(d.mspId, "Enter your organisation's MSP ID, for example Org1MSP."),
    channels: () => check.channels(d.channels),
    relayUrl: () => check.url(d.relayUrl, "Enter your organisation's relay address."),
    caUrl: () => check.url(d.caUrl, needsCa ? "Enter your organisation's CA address." : undefined),
  };
}

type NetworkKey = keyof ReturnType<typeof networkChecks>;

function NetworkFields({
  draft,
  onChange,
  needsCa,
  field,
}: {
  draft: NetworkDraft;
  onChange: (d: NetworkDraft) => void;
  needsCa: boolean;
  field: (key: NetworkKey) => FieldState;
}) {
  const set = (key: keyof NetworkDraft) => (e: { target: { value: string } }) => onChange({ ...draft, [key]: e.target.value });
  return (
    <>
      <Field label="MSP ID" {...field("mspId")}>
        {(a) => <input {...a} className="mono" placeholder="Org1MSP" value={draft.mspId} onChange={set("mspId")} />}
      </Field>
      <Field label="Channels" hint="Separate several with commas." {...field("channels")}>
        {(a) => <input {...a} className="mono" placeholder="mychannel" value={draft.channels} onChange={set("channels")} />}
      </Field>
      <Field label="Relay URL" hint="Your organisation's relay picks which peers to use." {...field("relayUrl")}>
        {(a) => <input {...a} type="url" placeholder="https://relay.org1.example.com" value={draft.relayUrl} onChange={set("relayUrl")} />}
      </Field>
      <Field label={needsCa ? "CA URL" : "CA URL (for renewals)"} {...field("caUrl")}>
        {(a) => <input {...a} type="url" placeholder="https://ca.org1.example.com:7054" value={draft.caUrl} onChange={set("caUrl")} />}
      </Field>
      <Field label="CA name" hint="Fill this in only if your CA server hosts more than one CA.">
        {(a) => <input {...a} className="mono" placeholder="ca-org1" value={draft.caName} onChange={set("caName")} />}
      </Field>
      <Field label="Network name" hint="This name is shown in Weft only.">
        {(a) => <input {...a} placeholder="Acme Supply Network" value={draft.name} onChange={set("name")} />}
      </Field>
    </>
  );
}

const isDirty = (d: NetworkDraft) => Object.values(d).some((v) => v.trim() !== "");

/** The form's submit button, pinned to the bottom of the scrolling page, with the action's error above it. */
function Submit({ busy, label, error }: { busy: boolean; label: string; error: ErrorInfo | null }) {
  return (
    <div className="page__actions">
      <ActionError error={error} />
      <Button type="submit" className="btn btn--primary" busy={busy}>
        {label}
      </Button>
    </div>
  );
}

/* Join from invite ------------------------------------------------- */

export function JoinInvite({ state, navigate, onDone, from, initialLink }: FormProps & { initialLink?: string | undefined }) {
  const [link, setLink] = useState(initialLink ?? "");
  // Carried to a tab if the toolbar popup has to move this step there (lib/permissions.ts).
  useEffect(() => {
    setTabLink(link.trim());
    return () => setTabLink("");
  }, [link]);
  const [invite, setInvite] = useState<OrgInvite | VoterInvite | null>(null);
  const [enrollmentId, setEnrollmentId] = useState("");
  const [secret, setSecret] = useState("");
  // Which way the steps moved, for the slide.
  const direction = useRef<"forward" | "back">("forward");
  const { announce } = useFeedback();

  const linkChecks = useChecks({ link: () => check.inviteLink(link) });
  const enrolChecks = useChecks({
    enrollmentId: () => check.required(enrollmentId, "Enter your enrolment ID."),
    secret: () => check.required(secret, "Enter the enrolment secret from your administrator."),
  });

  const load = useAction(async (value: string) => {
    // Ask for the invite's own host (not the join page's) before fetching it.
    await requestHostAccess([resolveInviteUrl(value)], "the server your invite comes from");
    const loaded = await ui("fetchInvite", { link: value });
    direction.current = "forward";
    setInvite(loaded);
    setEnrollmentId("weftVoterInvite" in loaded ? "" : (loaded.enrollmentId ?? ""));
  });

  // Scanning hands over a link but can't open the permission prompt itself:
  // the browser only allows that from a click. So scanning fills the field and
  // the user presses Review invite.
  const scan = useAction(async () => {
    setLink(await scanActiveTab());
    announce("Found an invite link. Press Review invite.");
  });
  const [pasteError, setPasteError] = useState<ErrorInfo | null>(null);

  const onPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const clipboard = event.clipboardData;
    if (!Array.from(clipboard.files).some((f) => f.type.startsWith("image/"))) return;
    event.preventDefault();
    setPasteError(null);
    void scanPastedImage(clipboard)
      .then((text) => {
        if (!text) return;
        setLink(text);
        announce("Found an invite link. Press Review invite.");
      })
      .catch((error: unknown) => setPasteError(toErrorInfo(error)));
  };

  const join = useAction(async (inv: OrgInvite | VoterInvite) => {
    if ("weftVoterInvite" in inv) return;
    await requestHostAccess([inv.caUrl, inv.relayUrl]);
    const view = await ui("joinInvite", { invite: inv, enrollmentId: enrollmentId.trim(), secret, inviteUrl: resolveInviteUrl(link.trim()) });
    await onDone(`Added ${view.name}`);
  });

  const leave = useLeaveGuard(secret !== "", () => {
    direction.current = "back";
    setInvite(null);
    setSecret("");
    join.setError(null);
  });

  if (!invite) {
    const scanError = scan.error ?? pasteError;
    return (
      <>
        <BackHeader title="Join from an invite" onBack={() => navigate({ name: from ?? "add" })} />
        <form
          key="link"
          className="page step"
          data-dir={direction.current}
          noValidate
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (linkChecks.submit()) void load.run(link.trim());
          }}
        >
          <p className="muted flat">
            Your administrator shares a link that tells Weft where your organisation's CA and relay are.
          </p>
          <Field label="Invite link" hint="Paste the link, or paste a screenshot of the QR code." {...linkChecks.field("link")}>
            {(a) => (
              <input {...a} placeholder="https://… or weft://invite?u=…" value={link} onChange={(e) => setLink(e.target.value)} onPaste={onPaste} />
            )}
          </Field>
          <Button className="add-tile add-tile--row" icon="qr" busy={scan.busy} onClick={() => void scan.run()}>
            Scan QR code on this tab
          </Button>
          <ActionError error={scanError} />
          <Submit busy={load.busy} label="Review invite" error={load.error} />
        </form>
      </>
    );
  }

  if ("weftVoterInvite" in invite) {
    if (!VoterJoin) return null;
    return (
      <Suspense fallback={null}>
        <VoterJoin
          invite={invite}
          inviteUrl={resolveInviteUrl(link.trim())}
          state={state}
          dir={direction.current}
          onBack={() => {
            direction.current = "back";
            setInvite(null);
          }}
          onDone={onDone}
        />
      </Suspense>
    );
  }

  return (
    <>
      <BackHeader title="Join from an invite" onBack={() => void leave()} />
      <form
        key="enrol"
        className="page step"
        data-dir={direction.current}
        noValidate
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (enrolChecks.submit()) void join.run(invite);
        }}
      >
        <InviteCard invite={invite} />
        <Field label="Enrolment ID" {...enrolChecks.field("enrollmentId")}>
          {(a) => <input {...a} className="mono" value={enrollmentId} onChange={(e) => setEnrollmentId(e.target.value)} />}
        </Field>
        <Field label="Enrolment secret" hint="Your administrator gives you this. Weft uses it once and never stores it." {...enrolChecks.field("secret")}>
          {(a) => <SecretInput {...a} value={secret} onChange={(e) => setSecret(e.target.value)} />}
        </Field>
        <Submit busy={join.busy} label="Enrol" error={join.error} />
      </form>
    </>
  );
}

/* Enrol manually -------------------------------------------------- */

export function EnrollForm({ navigate, onDone, from }: FormProps) {
  const [draft, setDraft] = useState(EMPTY_NETWORK);
  const [enrollmentId, setEnrollmentId] = useState("");
  const [secret, setSecret] = useState("");
  const checks = useChecks({
    enrollmentId: () => check.required(enrollmentId, "Enter your enrolment ID."),
    secret: () => check.required(secret, "Enter the enrolment secret from your administrator."),
    ...networkChecks(draft, true),
  });
  const action = useAction(async () => {
    const network = toNetwork(draft);
    await requestHostAccess([network.caUrl, network.relayUrl]);
    const view = await ui("enroll", { network, enrollmentId: enrollmentId.trim(), secret });
    await onDone(`Added ${view.name}`);
  });
  const back = useLeaveGuard(isDirty(draft) || enrollmentId !== "" || secret !== "", () => navigate({ name: from ?? "add" }));

  return (
    <>
      <BackHeader title="Enrol with CA" onBack={() => void back()} />
      <form
        className="page"
        noValidate
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (checks.submit()) void action.run();
        }}
      >
        <Field label="Enrolment ID" {...checks.field("enrollmentId")}>
          {(a) => <input {...a} className="mono" value={enrollmentId} onChange={(e) => setEnrollmentId(e.target.value)} />}
        </Field>
        <Field label="Enrolment secret" hint="Weft uses it once and never stores it." {...checks.field("secret")}>
          {(a) => <SecretInput {...a} value={secret} onChange={(e) => setSecret(e.target.value)} />}
        </Field>
        <NetworkFields draft={draft} onChange={setDraft} needsCa field={checks.field} />
        <Submit busy={action.busy} label="Enrol" error={action.error} />
      </form>
    </>
  );
}

/* Import PEM -------------------------------------------------------- */

export function ImportForm({ navigate, onDone, from }: FormProps) {
  const [draft, setDraft] = useState(EMPTY_NETWORK);
  const [certificate, setCertificate] = useState("");
  const [privateKeyPem, setPrivateKeyPem] = useState("");
  const checks = useChecks({
    certificate: () => check.certificatePem(certificate),
    privateKey: () => check.privateKeyPem(privateKeyPem),
    ...networkChecks(draft, false),
  });
  const action = useAction(async () => {
    const network = toNetwork(draft);
    await requestHostAccess([network.relayUrl, network.caUrl]);
    const view = await ui("importIdentity", { network, certificate, privateKeyPem });
    await onDone(`Added ${view.name}`);
  });
  const back = useLeaveGuard(isDirty(draft) || certificate !== "" || privateKeyPem !== "", () => navigate({ name: from ?? "add" }));

  return (
    <>
      <BackHeader title="Import PEM" onBack={() => void back()} />
      <form
        className="page"
        noValidate
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (checks.submit()) void action.run();
        }}
      >
        <Field label="Certificate (PEM)" {...checks.field("certificate")}>
          {(a) => <textarea {...a} placeholder="-----BEGIN CERTIFICATE-----" value={certificate} onChange={(e) => setCertificate(e.target.value)} />}
        </Field>
        <Field label="Private key (PKCS#8 PEM)" hint="Weft imports it as a non-extractable key. Delete the file afterwards." {...checks.field("privateKey")}>
          {(a) => <textarea {...a} placeholder="-----BEGIN PRIVATE KEY-----" value={privateKeyPem} onChange={(e) => setPrivateKeyPem(e.target.value)} />}
        </Field>
        <NetworkFields draft={draft} onChange={setDraft} needsCa={false} field={checks.field} />
        <Submit busy={action.busy} label="Import" error={action.error} />
      </form>
    </>
  );
}

/* Generate CSR ------------------------------------------------------ */

export function CsrForm({ navigate, onDone, from }: FormProps) {
  const [draft, setDraft] = useState(EMPTY_NETWORK);
  const [commonName, setCommonName] = useState("");
  const [result, setResult] = useState<PendingCsrView | null>(null);
  const checks = useChecks({
    commonName: () => check.required(commonName, "Enter the name to request, usually your enrolment ID."),
    ...networkChecks(draft, false),
  });
  const action = useAction(async () => {
    const network = toNetwork(draft);
    await requestHostAccess([network.relayUrl, network.caUrl]);
    setResult(await ui("createCsr", { network, commonName: commonName.trim() }));
  });
  const copy = useCopy();
  const back = useLeaveGuard(isDirty(draft) || commonName !== "", () => navigate({ name: from ?? "add" }));

  if (result) {
    return (
      <>
        <BackHeader
          title="Certificate request"
          onBack={() => void onDone(undefined, "identities")}
        />
        <main className="page step" data-dir="forward">
          <p className="muted flat">
            Send this request to your administrator. When they send back a certificate, open Identities and paste it
            under “Waiting for a certificate”.
          </p>
          <div className="args">
            <pre className="raw raw--flush">
              {result.csr}
            </pre>
          </div>
          <div className="page__actions">
            <Button className="btn btn--primary" icon="copy" onClick={() => void copy(result.csr, "Request copied")}>
              Copy request
            </Button>
          </div>
        </main>
      </>
    );
  }

  return (
    <>
      <BackHeader title="Generate CSR" onBack={() => void back()} />
      <form
        className="page"
        noValidate
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (checks.submit()) void action.run();
        }}
      >
        <p className="muted flat">
          For CAs that issue certificates by hand. Weft creates the key here; only the request leaves the browser.
        </p>
        <Field label="Common name" hint="This is usually your enrolment ID." {...checks.field("commonName")}>
          {(a) => <input {...a} className="mono" value={commonName} onChange={(e) => setCommonName(e.target.value)} />}
        </Field>
        <NetworkFields draft={draft} onChange={setDraft} needsCa={false} field={checks.field} />
        <Submit busy={action.busy} label="Create request" error={action.error} />
      </form>
    </>
  );
}

export function CompleteCsr({ state, navigate, onDone, pendingId }: FormProps & { pendingId: string }) {
  const pending = state.pendingCsrs.find((p) => p.id === pendingId);
  const [certificate, setCertificate] = useState("");
  const checks = useChecks({ certificate: () => check.certificatePem(certificate) });
  const action = useAction(async (): Promise<IdentityView> => {
    const view = await ui("completeCsr", { pendingId, certificate });
    await onDone(`Added ${view.name}`);
    return view;
  });
  const back = useLeaveGuard(certificate !== "", () => navigate({ name: "identities" }));

  return (
    <>
      <BackHeader title="Add certificate" onBack={() => void back()} />
      <form
        className="page"
        noValidate
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (checks.submit()) void action.run();
        }}
      >
        {pending ? (
          <div className="row">
            <span className="wrap-anywhere">
              Request for <span className="mono">{pending.commonName}</span> on {pending.networkName}
            </span>
          </div>
        ) : (
          <p className="action-error__message flat" role="alert">
            This request no longer exists. Go back to Identities to see the ones still waiting.
          </p>
        )}
        <Field label="Issued certificate (PEM)" {...checks.field("certificate")}>
          {(a) => <textarea {...a} placeholder="-----BEGIN CERTIFICATE-----" value={certificate} onChange={(e) => setCertificate(e.target.value)} />}
        </Field>
        <Submit busy={action.busy} label="Add identity" error={action.error} />
      </form>
    </>
  );
}
