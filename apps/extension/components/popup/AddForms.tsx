import { resolveInviteUrl } from "@weftwallet/core";
import type { OrgInvite } from "@weftwallet/protocol";
import { useState, type ClipboardEvent, type FormEvent } from "react";
import { ui, type IdentityView, type NetworkInput, type PendingCsrView, type WalletState } from "../../lib/messages";
import { requestHostAccess } from "../../lib/permissions";
import { scanActiveTab, scanPastedImage } from "../../lib/qr";
import { InviteCard } from "../InviteCard";
import { BackHeader, Field, Icon, copy } from "../ui";
import { useAction, type Navigate } from "./state";

interface FormProps {
  state: WalletState;
  navigate: Navigate;
  onDone: () => Promise<void>;
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

function NetworkFields({
  draft,
  onChange,
  needsCa,
}: {
  draft: NetworkDraft;
  onChange: (d: NetworkDraft) => void;
  needsCa: boolean;
}) {
  const set = (key: keyof NetworkDraft) => (e: { target: { value: string } }) => onChange({ ...draft, [key]: e.target.value });
  return (
    <>
      <Field label="MSP ID">
        <input required className="mono" placeholder="Org1MSP" value={draft.mspId} onChange={set("mspId")} />
      </Field>
      <Field label="Channels" hint="Comma-separated">
        <input required className="mono" placeholder="mychannel" value={draft.channels} onChange={set("channels")} />
      </Field>
      <Field label="Relay URL" hint="Your organisation's Weft relay">
        <input required type="url" placeholder="https://relay.org1.example.com" value={draft.relayUrl} onChange={set("relayUrl")} />
      </Field>
      <Field label={needsCa ? "CA URL" : "CA URL (for renewals)"}>
        <input
          required={needsCa}
          type="url"
          placeholder="https://ca.org1.example.com:7054"
          value={draft.caUrl}
          onChange={set("caUrl")}
        />
      </Field>
      <Field label="CA name" hint="Only if your CA server hosts more than one CA">
        <input className="mono" placeholder="ca-org1" value={draft.caName} onChange={set("caName")} />
      </Field>
      <Field label="Network name" hint="Shown in Weft only">
        <input placeholder="Acme Supply Network" value={draft.name} onChange={set("name")} />
      </Field>
    </>
  );
}

function Submit({ busy, label, error }: { busy: boolean; label: string; error: string | null }) {
  return (
    <footer className="footer footer--single" style={{ padding: 0, border: 0, gap: 8 }}>
      {error && <div className="error-text" role="alert">{error}</div>}
      <button type="submit" className="btn btn--primary" disabled={busy}>
        {busy ? "Working…" : label}
      </button>
    </footer>
  );
}

/* Join from invite ------------------------------------------------- */

export function JoinInvite({ navigate, onDone }: FormProps) {
  const [link, setLink] = useState("");
  const [invite, setInvite] = useState<OrgInvite | null>(null);
  const [enrollmentId, setEnrollmentId] = useState("");
  const [secret, setSecret] = useState("");

  const load = useAction(async (value: string) => {
    // Ask for the invite's own host (not the join page's) before fetching it.
    await requestHostAccess([resolveInviteUrl(value)]);
    const loaded = await ui("fetchInvite", { link: value });
    setInvite(loaded);
    setEnrollmentId(loaded.enrollmentId ?? "");
  });

  // Scanning hands over a link but can't open the permission prompt itself:
  // the browser only allows that from a click. So scanning fills the field and
  // the user presses Continue.
  const scan = useAction(async () => {
    setLink(await scanActiveTab());
  });

  const onPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const clipboard = event.clipboardData;
    if (!Array.from(clipboard.files).some((f) => f.type.startsWith("image/"))) return;
    event.preventDefault();
    scan.setError(null);
    void scanPastedImage(clipboard)
      .then((text) => text && setLink(text))
      .catch((error: unknown) => scan.setError(error instanceof Error ? error.message : String(error)));
  };

  const join = useAction(async (inv: OrgInvite) => {
    await requestHostAccess([inv.caUrl, inv.relayUrl]);
    await ui("joinInvite", { invite: inv, enrollmentId: enrollmentId.trim(), secret });
    await onDone();
  });

  if (!invite) {
    return (
      <>
        <BackHeader title="Join from invite" onBack={() => navigate({ name: "identities" })} />
        <form
          className="page"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void load.run(link.trim());
          }}
        >
          <p className="muted" style={{ margin: 0 }}>
            Your network administrator shares a link that tells Weft where your organisation's CA and relay are.
          </p>
          <Field label="Invite link" hint="Paste the link, or paste a screenshot of the QR code.">
            <input
              required
              placeholder="https://… or weft://invite?u=…"
              value={link}
              onChange={(e) => setLink(e.target.value)}
              onPaste={onPaste}
            />
          </Field>
          <button type="button" className="add-tile" style={{ minHeight: 48, flexDirection: "row" }} onClick={() => void scan.run()}>
            <Icon name="qr" size={18} />
            {scan.busy ? "Looking for a QR code…" : "Scan QR code on this tab"}
          </button>
          {scan.error && <div className="error-text">{scan.error}</div>}
          <Submit busy={load.busy} label="Continue" error={load.error} />
        </form>
      </>
    );
  }

  return (
    <>
      <BackHeader title="Join from invite" onBack={() => setInvite(null)} />
      <form
        className="page"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void join.run(invite);
        }}
      >
        <InviteCard invite={invite} />
        <Field label="Enrollment ID">
          <input required className="mono" value={enrollmentId} onChange={(e) => setEnrollmentId(e.target.value)} />
        </Field>
        <Field label="Enrollment secret" hint="From your registrar. Used once, never stored.">
          <input required type="password" value={secret} onChange={(e) => setSecret(e.target.value)} />
        </Field>
        <Submit busy={join.busy} label="Enroll" error={join.error} />
      </form>
    </>
  );
}

/* Enroll manually -------------------------------------------------- */

export function EnrollForm({ navigate, onDone }: FormProps) {
  const [draft, setDraft] = useState(EMPTY_NETWORK);
  const [enrollmentId, setEnrollmentId] = useState("");
  const [secret, setSecret] = useState("");
  const action = useAction(async () => {
    const network = toNetwork(draft);
    await requestHostAccess([network.caUrl, network.relayUrl]);
    await ui("enroll", { network, enrollmentId: enrollmentId.trim(), secret });
    await onDone();
  });

  return (
    <>
      <BackHeader title="Enroll with CA" onBack={() => navigate({ name: "identities" })} />
      <form
        className="page"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void action.run();
        }}
      >
        <Field label="Enrollment ID">
          <input required className="mono" value={enrollmentId} onChange={(e) => setEnrollmentId(e.target.value)} />
        </Field>
        <Field label="Enrollment secret" hint="Used once, never stored.">
          <input required type="password" value={secret} onChange={(e) => setSecret(e.target.value)} />
        </Field>
        <NetworkFields draft={draft} onChange={setDraft} needsCa />
        <Submit busy={action.busy} label="Enroll" error={action.error} />
      </form>
    </>
  );
}

/* Import PEM -------------------------------------------------------- */

export function ImportForm({ navigate, onDone }: FormProps) {
  const [draft, setDraft] = useState(EMPTY_NETWORK);
  const [certificate, setCertificate] = useState("");
  const [privateKeyPem, setPrivateKeyPem] = useState("");
  const action = useAction(async () => {
    const network = toNetwork(draft);
    await requestHostAccess([network.relayUrl, network.caUrl]);
    await ui("importIdentity", { network, certificate, privateKeyPem });
    await onDone();
  });

  return (
    <>
      <BackHeader title="Import PEM" onBack={() => navigate({ name: "identities" })} />
      <form
        className="page"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void action.run();
        }}
      >
        <Field label="Certificate (PEM)">
          <textarea required placeholder="-----BEGIN CERTIFICATE-----" value={certificate} onChange={(e) => setCertificate(e.target.value)} />
        </Field>
        <Field label="Private key (PKCS#8 PEM)" hint="Imported as a non-exportable key. Delete the file afterwards.">
          <textarea required placeholder="-----BEGIN PRIVATE KEY-----" value={privateKeyPem} onChange={(e) => setPrivateKeyPem(e.target.value)} />
        </Field>
        <NetworkFields draft={draft} onChange={setDraft} needsCa={false} />
        <Submit busy={action.busy} label="Import" error={action.error} />
      </form>
    </>
  );
}

/* Generate CSR ------------------------------------------------------ */

export function CsrForm({ navigate, onDone }: FormProps) {
  const [draft, setDraft] = useState(EMPTY_NETWORK);
  const [commonName, setCommonName] = useState("");
  const [result, setResult] = useState<PendingCsrView | null>(null);
  const action = useAction(async () => {
    const network = toNetwork(draft);
    await requestHostAccess([network.relayUrl, network.caUrl]);
    setResult(await ui("createCsr", { network, commonName: commonName.trim() }));
  });

  if (result) {
    return (
      <>
        <BackHeader title="Certificate request" onBack={() => void onDone()} />
        <main className="page">
          <p className="muted" style={{ margin: 0 }}>
            Send this request to your CA administrator. When they send back a certificate, open Identities and paste it
            under "Waiting for a certificate".
          </p>
          <div className="args">
            <pre className="raw" style={{ borderTop: 0 }}>
              {result.csr}
            </pre>
          </div>
          <button type="button" className="btn btn--primary" onClick={() => copy(result.csr)}>
            Copy request
          </button>
        </main>
      </>
    );
  }

  return (
    <>
      <BackHeader title="Generate CSR" onBack={() => navigate({ name: "identities" })} />
      <form
        className="page"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void action.run();
        }}
      >
        <p className="muted" style={{ margin: 0 }}>
          For CAs that issue certificates by hand. Weft creates the key here; only the request leaves the browser.
        </p>
        <Field label="Common name" hint="Usually your enrollment ID">
          <input required className="mono" value={commonName} onChange={(e) => setCommonName(e.target.value)} />
        </Field>
        <NetworkFields draft={draft} onChange={setDraft} needsCa={false} />
        <Submit busy={action.busy} label="Create request" error={action.error} />
      </form>
    </>
  );
}

export function CompleteCsr({ state, navigate, onDone, pendingId }: FormProps & { pendingId: string }) {
  const pending = state.pendingCsrs.find((p) => p.id === pendingId);
  const [certificate, setCertificate] = useState("");
  const action = useAction(async (): Promise<IdentityView> => {
    const view = await ui("completeCsr", { pendingId, certificate });
    await onDone();
    return view;
  });

  return (
    <>
      <BackHeader title="Add certificate" onBack={() => navigate({ name: "identities" })} />
      <form
        className="page"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void action.run();
        }}
      >
        {pending && (
          <div className="row">
            <Icon name="key" size={18} />
            Request for <span className="mono">{pending.commonName}</span> on {pending.networkName}
          </div>
        )}
        <Field label="Issued certificate (PEM)">
          <textarea required placeholder="-----BEGIN CERTIFICATE-----" value={certificate} onChange={(e) => setCertificate(e.target.value)} />
        </Field>
        <Submit busy={action.busy} label="Add identity" error={action.error} />
      </form>
    </>
  );
}
