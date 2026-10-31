import type { OrgInvite } from "@weftwallet/protocol";
import { useState, type FormEvent } from "react";
import type { NetworkRecord } from "../../lib/db";
import { ui, type WalletState } from "../../lib/messages";
import { requestHostAccess } from "../../lib/permissions";
import * as check from "../../lib/validate";
import { useFeedback, useLeaveGuard } from "../feedback";
import { useChecks } from "../form";
import { ActionError, BackHeader, Button, Empty, Field, Icon } from "../ui";
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
  const [explorerUrl, setExplorerUrl] = useState(network.explorerUrl ?? "");
  // Channels are editable only for networks added without an invite; invite
  // networks take their channels from the invite.
  const editableChannels = !network.inviteUrl;
  const [channels, setChannels] = useState(network.channels.join(", "));
  const channelList = channels
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
  const [problems, setProblems] = useState<{ relay: string | null; ca: string | null } | null>(null);
  const [invite, setInvite] = useState<OrgInvite | null>(null);
  const identities = state.identities.filter((i) => i.networkId === network.id);

  const channelsChanged = editableChannels && channelList.join(",") !== network.channels.join(",");
  const endpointsChanged = relayUrl !== network.relayUrl || caUrl !== network.caUrl || caName !== (network.caName ?? "");
  const explorerChanged = explorerUrl.trim() !== (network.explorerUrl ?? "");
  const dirty = endpointsChanged || channelsChanged || explorerChanged;
  const leave = useLeaveGuard(dirty, onBack);
  const checks = useChecks({
    channels: () => (editableChannels ? check.channels(channels) : null),
    relayUrl: () => check.url(relayUrl, "Enter the relay's address."),
    caUrl: () => check.url(caUrl, "Enter the CA's address."),
    explorerUrl: () => check.url(explorerUrl),
  });


  const save = useAction(async (force: boolean) => {
    setProblems(null);
    // Only channels or the explorer changed: no endpoints to test or confirm.
    // Weft only opens the explorer as a link; it never sends anything to it.
    if (!endpointsChanged) {
      onState(
        await ui("updateNetwork", {
          networkId: network.id,
          patch: { ...(channelsChanged ? { channels: channelList } : {}), ...(explorerChanged ? { explorerUrl: explorerUrl.trim() } : {}) },
        }),
      );
      toast(explorerChanged && !channelsChanged ? "Explorer saved" : "Network saved");
      return;
    }
    await requestHostAccess([relayUrl.trim(), caUrl.trim()], "the relay and CA");
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
          <p className="sheet__para">
            Weft will send {network.name}'s transactions through this relay and renew certificates with this CA. Only use
            addresses your organisation gave you.
          </p>
          <p className="flat">
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
        patch: {
          relayUrl: relayUrl.trim(),
          caUrl: caUrl.trim(),
          caName: caName.trim(),
          explorerUrl: explorerUrl.trim(),
          ...(editableChannels ? { channels: channelList } : {}),
        },
      }),
    );
    setProblems(null);
    toast("Network saved");
  });

  const refresh = useAction(async () => {
    if (network.inviteUrl) await requestHostAccess([network.inviteUrl], "the server your invite comes from");
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
          explorerUrl: inv.explorerUrl ?? "",
          channels: inv.channels,
        },
      }),
    );
    setRelayUrl(inv.relayUrl);
    setCaUrl(inv.caUrl);
    setCaName(inv.caName ?? "");
    setExplorerUrl(inv.explorerUrl ?? "");
    setInvite(null);
    toast("Updated from invite");
  });

  return (
    <>
      <BackHeader title={network.name} onBack={() => void leave()} />
      <form
        className="page"
        noValidate
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (checks.submit()) void save.run(false);
        }}
      >
        <section className="card" aria-label="Network">
          <span className="eyebrow">{network.organization}</span>
          <div className="card__title">{network.name}</div>
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
            <Button icon="upload" busy={refresh.busy} onClick={() => void refresh.run()}>
              Refresh from invite
            </Button>
          )
        ) : (
          <p className="subtle type-xs flat">
            Added without an invite. Change its channels and addresses under Advanced.
          </p>
        )}
        <ActionError error={refresh.error ?? apply.error} />

        <button
          type="button"
          className="disclosure"
          aria-expanded={advanced}
          aria-controls="network-advanced"
          onClick={() => setAdvanced(!advanced)}
        >
          <span>Advanced</span>
          <span className="subtle type-xs push-right">
            {editableChannels ? "Channels and addresses" : "Addresses"}
          </span>
          <Icon name="chevron" size={16} />
        </button>

        {/* A .reversible (motion.css): it leaves from wherever it is when closed early. */}
        <div id="network-advanced" className={`panel reversible reversible--down ${advanced ? "is-open" : ""}`} hidden={!advanced}>
            {editableChannels && (
              <Field
                label="Channels"
                hint="Separate several with commas. Listing a channel doesn't give access: your organisation must be a member of it."
                {...checks.field("channels")}
              >
                {(a) => <input {...a} className="mono" value={channels} onChange={(e) => setChannels(e.target.value)} />}
              </Field>
            )}
            <Field label="Relay URL" hint="Your organisation's Weft relay. It picks which peers to use." {...checks.field("relayUrl")}>
              {(a) => <input {...a} type="url" value={relayUrl} onChange={(e) => setRelayUrl(e.target.value)} />}
            </Field>
            <Field label="CA URL" hint="Used to enrol and renew certificates." {...checks.field("caUrl")}>
              {(a) => <input {...a} type="url" value={caUrl} onChange={(e) => setCaUrl(e.target.value)} />}
            </Field>
            <Field label="CA name" hint="Only if your CA server hosts more than one CA">
              {(a) => <input {...a} className="mono" value={caName} onChange={(e) => setCaName(e.target.value)} />}
            </Field>
            <Field label="Explorer URL" hint="Optional. Your organisation's explorer, linked from each transaction." {...checks.field("explorerUrl")}>
              {(a) => <input {...a} type="url" value={explorerUrl} onChange={(e) => setExplorerUrl(e.target.value)} />}
            </Field>
            <div className="page__actions">
              {problems && (
                <div className="notice notice--amber notice--column arrive" role="alert">
                  <div className="strong">Weft couldn't confirm these addresses</div>
                  {problems.relay && <div>The relay {problems.relay}.</div>}
                  {problems.ca && <div>The CA {problems.ca}.</div>}
                  <button type="button" className="link-btn link-btn--inline" onClick={() => void save.run(true)}>
                    Save anyway
                  </button>
                </div>
              )}
              <ActionError error={save.error} />
              {dirty ? (
                <Button type="submit" className="btn btn--primary" busy={save.busy}>
                  {endpointsChanged ? "Test and save" : "Save"}
                </Button>
              ) : (
                <p className="subtle type-xs flat centre">Change an address or channel to save it.</p>
              )}
            </div>
          </div>
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
  if ((invite.explorerUrl ?? "") !== (network.explorerUrl ?? "")) {
    changes.push({ label: "Explorer", from: network.explorerUrl ?? "none", to: invite.explorerUrl ?? "none" });
  }
  if (invite.network !== network.name) changes.push({ label: "Name", from: network.name, to: invite.network });
  const nothing = added.length === 0 && removed.length === 0 && changes.length === 0;

  if (nothing) {
    return (
      <div className="notice notice--thread arrive">
        <Icon name="check" size={18} color="var(--weft-accent-text)" />
        <span className="grow">Up to date with your organisation's invite.</span>
        <button type="button" className="link-btn link-btn--inline" onClick={onCancel}>
          OK
        </button>
      </div>
    );
  }
  return (
    <section className="card arrive" aria-label="Changes from the invite">
      <span className="eyebrow">The invite has changed</span>
      <dl className="details">
        {added.length > 0 && (
          <>
            <dt>New channels</dt>
            <dd className="mono accent-text">
              {added.join(", ")}
            </dd>
          </>
        )}
        {removed.length > 0 && (
          <>
            <dt>Removed</dt>
            <dd className="mono warn-text">
              {removed.join(", ")}
            </dd>
          </>
        )}
        {changes.map((c) => (
          <div key={c.label} className="contents">
            <dt>{c.label}</dt>
            <dd className="mono type-xs">
              <span className="subtle struck">
                <span className="visually-hidden">Was </span>
                {c.from}
              </span>
              <br />
              <span className="visually-hidden">Now </span>
              {c.to}
            </dd>
          </div>
        ))}
      </dl>
      <div className="sheet__actions sheet__actions--flush">
        <button type="button" className="btn" onClick={onCancel}>
          Not now
        </button>
        <Button className="btn btn--primary" busy={busy} onClick={onApply}>
          Update
        </Button>
      </div>
    </section>
  );
}
