import type { OrgInvite } from "@weftwallet/protocol";
import { useState, type FormEvent } from "react";
import type { NetworkRecord } from "../../lib/db";
import { ui, type WalletState } from "../../lib/messages";
import { requestHostAccess } from "../../lib/permissions";
import { useFeedback, useLeaveGuard } from "../feedback";
import { BackHeader, Empty, Field, Icon, Spinner } from "../ui";
import { useAction, type Navigate } from "./state";

/**
 * Where Weft reaches one network. Like a custom RPC URL in MetaMask, but for
 * the two things a Fabric wallet talks to: the organisation's relay and CA.
 * Peers are not here on purpose: the relay chooses them.
 */
export function NetworkSettings({
  state,
  onState,
  networkId,
  navigate,
}: {
  state: WalletState;
  onState: (s: WalletState) => void;
  networkId: string;
  navigate: Navigate;
}) {
  const network = state.networks.find((n) => n.id === networkId);
  const back = () => navigate({ name: "identities" });
  if (!network) {
    return (
      <>
        <BackHeader title="Network" onBack={back} />
        <Empty icon="globe">This network no longer exists.</Empty>
      </>
    );
  }
  return <Settings key={network.id} network={network} state={state} onState={onState} onBack={back} />;
}

function Settings({
  network,
  state,
  onState,
  onBack,
}: {
  network: NetworkRecord;
  state: WalletState;
  onState: (s: WalletState) => void;
  onBack: () => void;
}) {
  const { confirm, toast } = useFeedback();
  const [advanced, setAdvanced] = useState(false);
  const [relayUrl, setRelayUrl] = useState(network.relayUrl);
  const [caUrl, setCaUrl] = useState(network.caUrl);
  const [caName, setCaName] = useState(network.caName ?? "");
  const [problems, setProblems] = useState<{ relay: string | null; ca: string | null } | null>(null);
  const [invite, setInvite] = useState<OrgInvite | null>(null);
  const identities = state.identities.filter((i) => i.networkId === network.id);

  const dirty = relayUrl !== network.relayUrl || caUrl !== network.caUrl || caName !== (network.caName ?? "");
  const leave = useLeaveGuard(dirty, onBack);

  const save = useAction(async (force: boolean) => {
    setProblems(null);
    await requestHostAccess([relayUrl.trim(), caUrl.trim()]);
    if (!force) {
      const found = await ui("checkEndpoints", { relayUrl: relayUrl.trim(), caUrl: caUrl.trim(), caName: caName.trim() || undefined });
      if (found.relay || found.ca) {
        setProblems(found);
        return;
      }
    }
    const ok = await confirm({
      title: "Change where Weft connects?",
      body: (
        <>
          <p style={{ margin: "0 0 8px" }}>
            Weft will send {network.name}'s transactions through this relay and renew certificates with this CA. Only use
            addresses your organisation gave you.
          </p>
          <p style={{ margin: 0 }}>
            Your keys stay in this browser either way, and Weft still checks every transaction before signing it.
          </p>
        </>
      ),
      confirmLabel: "Save",
      icon: "globe",
      tone: "caution",
    });
    if (!ok) return;
    onState(
      await ui("updateNetwork", {
        networkId: network.id,
        patch: { relayUrl: relayUrl.trim(), caUrl: caUrl.trim(), caName: caName.trim() },
      }),
    );
    setProblems(null);
    toast("Network saved");
  });

  const refresh = useAction(async () => {
    if (network.inviteUrl) await requestHostAccess([network.inviteUrl]);
    const loaded = await ui("refreshInvite", { networkId: network.id });
    if (loaded.mspId !== network.mspId) {
      throw new Error(
        `The invite is now for ${loaded.mspId}, but your identities belong to ${network.mspId}. Ask your administrator.`,
      );
    }
    setInvite(loaded);
  });

  const apply = useAction(async (inv: OrgInvite) => {
    await requestHostAccess([inv.relayUrl, inv.caUrl]);
    onState(
      await ui("updateNetwork", {
        networkId: network.id,
        patch: {
          name: inv.network,
          organization: inv.organization,
          relayUrl: inv.relayUrl,
          caUrl: inv.caUrl,
          caName: inv.caName ?? "",
          channels: inv.channels,
        },
      }),
    );
    setRelayUrl(inv.relayUrl);
    setCaUrl(inv.caUrl);
    setCaName(inv.caName ?? "");
    setInvite(null);
    toast("Updated from invite");
  });

  return (
    <>
      <BackHeader title="Network" onBack={() => void leave()} />
      <form
        className="page"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void save.run(false);
        }}
      >
        <section className="card" aria-label="Network">
          <span className="eyebrow">{network.organization}</span>
          <div style={{ fontSize: 20, fontWeight: 600 }}>{network.name}</div>
          <dl className="details">
            <dt>MSP ID</dt>
            <dd className="mono">{network.mspId}</dd>
            <dt>Channels</dt>
            <dd className="mono">{network.channels.join(", ")}</dd>
            <dt>Identities</dt>
            <dd>{identities.map((i) => i.name).join(", ") || "None"}</dd>
            {network.inviteUrl && (
              <>
                <dt>Invite</dt>
                <dd className="mono">{new URL(network.inviteUrl).host}</dd>
              </>
            )}
          </dl>
        </section>

        {network.inviteUrl ? (
          invite ? (
            <InviteChanges network={network} invite={invite} busy={apply.busy} onApply={() => void apply.run(invite)} onCancel={() => setInvite(null)} />
          ) : (
            <button type="button" className="btn" disabled={refresh.busy} onClick={() => void refresh.run()}>
              {refresh.busy ? (
                <>
                  <Spinner small /> Checking the invite…
                </>
              ) : (
                <>
                  <Icon name="upload" size={18} /> Refresh from invite
                </>
              )}
            </button>
          )
        ) : (
          <p className="subtle" style={{ fontSize: 12, margin: 0 }}>
            Added without an invite, so channels and addresses only change here.
          </p>
        )}
        {(refresh.error || apply.error) && <div className="error-text">{refresh.error ?? apply.error}</div>}

        <button
          type="button"
          className="disclosure"
          aria-expanded={advanced}
          onClick={() => setAdvanced(!advanced)}
        >
          <span>Advanced</span>
          <span className="subtle" style={{ fontSize: 12, marginLeft: "auto" }}>
            Relay and CA addresses
          </span>
          <Icon name="chevron" size={16} />
        </button>

        {advanced && (
          <div className="fade-in" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <Field label="Relay URL" hint="Your organisation's Weft relay. It picks which peers to use.">
              <input required type="url" value={relayUrl} onChange={(e) => setRelayUrl(e.target.value)} />
            </Field>
            <Field label="CA URL" hint="Used to enrol and renew certificates.">
              <input required type="url" value={caUrl} onChange={(e) => setCaUrl(e.target.value)} />
            </Field>
            <Field label="CA name" hint="Only if your CA server hosts more than one CA">
              <input className="mono" value={caName} onChange={(e) => setCaName(e.target.value)} />
            </Field>
            {dirty && (
              <div className="page__actions">
                {problems && (
                  <div className="notice notice--amber fade-in" style={{ flexDirection: "column", gap: 4 }} role="alert">
                    <div style={{ fontWeight: 600 }}>Weft couldn't confirm these addresses</div>
                    {problems.relay && <div>The relay {problems.relay}.</div>}
                    {problems.ca && <div>The CA {problems.ca}.</div>}
                    <button type="button" className="link-btn" style={{ padding: "4px 0 0" }} onClick={() => void save.run(true)}>
                      Save anyway
                    </button>
                  </div>
                )}
                {save.error && <div className="error-text">{save.error}</div>}
                <button type="submit" className="btn btn--primary" disabled={save.busy}>
                  {save.busy ? (
                    <>
                      <Spinner small /> Checking…
                    </>
                  ) : (
                    "Test and save"
                  )}
                </button>
              </div>
            )}
          </div>
        )}
      </form>
    </>
  );
}

/** What refreshing would change, shown before anything is saved. */
function InviteChanges({
  network,
  invite,
  busy,
  onApply,
  onCancel,
}: {
  network: NetworkRecord;
  invite: OrgInvite;
  busy: boolean;
  onApply: () => void;
  onCancel: () => void;
}) {
  const added = invite.channels.filter((c) => !network.channels.includes(c));
  const removed = network.channels.filter((c) => !invite.channels.includes(c));
  const changes: { label: string; from: string; to: string }[] = [];
  if (invite.relayUrl.replace(/\/+$/, "") !== network.relayUrl) changes.push({ label: "Relay", from: network.relayUrl, to: invite.relayUrl });
  if (invite.caUrl.replace(/\/+$/, "") !== network.caUrl) changes.push({ label: "CA", from: network.caUrl, to: invite.caUrl });
  if ((invite.caName ?? "") !== (network.caName ?? "")) changes.push({ label: "CA name", from: network.caName ?? "none", to: invite.caName ?? "none" });
  if (invite.network !== network.name) changes.push({ label: "Name", from: network.name, to: invite.network });
  const nothing = added.length === 0 && removed.length === 0 && changes.length === 0;

  if (nothing) {
    return (
      <div className="notice notice--thread fade-in">
        <Icon name="check" size={18} color="var(--weft-thread)" />
        <span style={{ flex: 1 }}>Up to date with your organisation's invite.</span>
        <button type="button" className="link-btn" style={{ width: "auto", padding: 0 }} onClick={onCancel}>
          OK
        </button>
      </div>
    );
  }
  return (
    <section className="card fade-in" aria-label="Changes from the invite">
      <span className="eyebrow">The invite has changed</span>
      <dl className="details">
        {added.length > 0 && (
          <>
            <dt>New channels</dt>
            <dd className="mono" style={{ color: "var(--weft-thread)" }}>
              {added.join(", ")}
            </dd>
          </>
        )}
        {removed.length > 0 && (
          <>
            <dt>Removed</dt>
            <dd className="mono" style={{ color: "var(--weft-amber)" }}>
              {removed.join(", ")}
            </dd>
          </>
        )}
        {changes.map((c) => (
          <div key={c.label} style={{ display: "contents" }}>
            <dt>{c.label}</dt>
            <dd className="mono" style={{ fontSize: 12 }}>
              <span className="subtle" style={{ textDecoration: "line-through" }}>
                {c.from}
              </span>
              <br />
              {c.to}
            </dd>
          </div>
        ))}
      </dl>
      <div className="sheet__actions" style={{ paddingTop: 0 }}>
        <button type="button" className="btn" onClick={onCancel}>
          Not now
        </button>
        <button type="button" className="btn btn--primary" disabled={busy} onClick={onApply}>
          {busy ? <Spinner small /> : "Update"}
        </button>
      </div>
    </section>
  );
}
