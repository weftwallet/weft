import { useEffect, useState } from "react";
import type { ActivityRecord } from "../../lib/db";
import { ui, type IdentityView, type WalletState } from "../../lib/messages";
import { requestHostAccess } from "../../lib/permissions";
import { Icon, Logo, copy, shorten, healthView } from "../ui";
import { useAction, type Navigate } from "./state";

type Tab = "activity" | "identities" | "sites";

export function Home({
  state,
  onState,
  navigate,
}: {
  state: WalletState;
  onState: (s: WalletState) => void;
  navigate: Navigate;
}) {
  const active = state.identities.find((i) => i.id === state.settings.activeIdentityId) ?? state.identities[0]!;
  const channels = active.channels;
  const channel =
    state.settings.activeChannel && channels.includes(state.settings.activeChannel) ? state.settings.activeChannel : channels[0];
  const [tab, setTab] = useState<Tab>("activity");

  return (
    <>
      <header className="header">
        <Logo size={28} />
        <div className="channel-picker">
          <span className="dot" />
          <span className="mono" style={{ fontWeight: 500 }}>
            {active.mspId}
          </span>
          <span className="subtle">·</span>
          <select
            aria-label="Channel"
            value={channel ?? ""}
            onChange={async (e) => onState(await ui("setChannel", { channel: e.target.value }))}
          >
            {channels.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <Icon name="chevron" size={14} color="var(--weft-text-subtle)" />
        </div>
        <button type="button" className="icon-btn" aria-label="Identities" onClick={() => navigate({ name: "identities" })}>
          <Icon name="more" />
        </button>
      </header>

      <main className="page">
        <IdentityCard
          identity={active}
          caUrl={state.networks.find((n) => n.id === active.networkId)?.caUrl ?? null}
          onState={onState}
        />

        <nav className="tabs" role="tablist" aria-label="Wallet sections">
          {(["activity", "identities", "sites"] as const).map((t) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
              {t === "activity" ? "Activity" : t === "identities" ? "Identities" : "Sites"}
            </button>
          ))}
        </nav>

        {tab === "activity" && <ActivityList navigate={navigate} />}
        {tab === "identities" && (
          <IdentityList state={state} onState={onState} onManage={() => navigate({ name: "identities" })} />
        )}
        {tab === "sites" && <SiteList state={state} onState={onState} />}
      </main>
    </>
  );
}

function IdentityCard({
  identity,
  caUrl,
  onState,
}: {
  identity: IdentityView;
  caUrl: string | null;
  onState: (s: WalletState) => void;
}) {
  const health = healthView(identity);
  const renew = useAction(async () => {
    if (caUrl) await requestHostAccess([caUrl]);
    await ui("reenroll", { identityId: identity.id });
    onState(await ui("state"));
  });
  const attributes = Object.entries(identity.attributes).filter(([k]) => !k.startsWith("hf."));

  return (
    <section className="card" aria-label="Active identity">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span className="eyebrow">Active identity</span>
        {identity.role ? <span className="chip chip--solid">{identity.role}</span> : null}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <div style={{ fontSize: 24, fontWeight: 600, letterSpacing: "-0.01em" }}>{identity.name}</div>
        <div className="muted" style={{ fontSize: 13 }}>
          {identity.organization} · <span className="mono">{identity.networkName}</span>
        </div>
      </div>
      <div className="mono subtle" style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
        <span>SHA-256</span>
        <span style={{ color: "#c9d2da" }}>{shorten(identity.fingerprint, 11, 5)}</span>
        <button
          type="button"
          className="icon-btn"
          style={{ marginLeft: "auto", width: 32, height: 32 }}
          aria-label="Copy fingerprint"
          onClick={() => copy(identity.fingerprint)}
        >
          <Icon name="copy" size={16} />
        </button>
      </div>
      {attributes.length > 0 && (
        <div className="chips">
          {attributes.map(([k, v]) => (
            <span key={k} className="chip">
              {k}={v}
            </span>
          ))}
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingTop: 4 }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
          <span style={{ color: health.color, fontWeight: 500 }}>{health.label}</span>
          <span className="subtle">{health.detail}</span>
        </div>
        <div className="bar">
          <div style={{ width: `${health.width}%`, background: health.color }} />
        </div>
        {(health.state === "expiring" || health.state === "expired") && identity.enrollmentId && caUrl && (
          <button
            type="button"
            className={`btn ${health.state === "expired" ? "btn--outline-signal" : "btn--outline-amber"}`}
            disabled={renew.busy}
            onClick={() => void renew.run()}
          >
            {renew.busy ? "Renewing…" : `Re-enroll as ${identity.enrollmentId}`}
          </button>
        )}
        {renew.error && <div className="error-text">{renew.error}</div>}
      </div>
    </section>
  );
}

const STATUS_STYLE = {
  committed: { icon: "check", bg: "#12302d", fg: "var(--weft-thread)", label: "VALID" },
  evaluated: { icon: "search", bg: "#1c2733", fg: "var(--weft-text-muted)", label: "READ" },
  failed: { icon: "alert", bg: "#3a1d1b", fg: "var(--weft-signal)", label: "FAILED" },
  rejected: { icon: "alert", bg: "#1c2733", fg: "var(--weft-text-subtle)", label: "REJECTED" },
} as const;

function ActivityList({ navigate }: { navigate: Navigate }) {
  const [items, setItems] = useState<ActivityRecord[] | null>(null);
  useEffect(() => {
    void ui("activity").then(setItems);
  }, []);

  if (!items) return null;
  if (items.length === 0) {
    return <div className="empty">No transactions yet. Requests from apps you connect will show up here.</div>;
  }
  return (
    <div className="list">
      {items.map((item) => {
        const s = STATUS_STYLE[item.status];
        return (
          <button
            key={item.id}
            type="button"
            className="list-item"
            onClick={() => navigate({ name: "tx", activityId: item.id })}
          >
            <span className="list-item__icon" style={{ background: s.bg, color: s.fg }}>
              <Icon name={s.icon} size={16} />
            </span>
            <span className="list-item__body">
              <span className="list-item__title">{item.call.fn}</span>
              {item.status === "failed" ? (
                <span style={{ fontSize: 12, color: "var(--weft-signal)" }}>{item.title}</span>
              ) : (
                <span className="mono subtle" style={{ fontSize: 11 }}>
                  {item.call.chaincode}
                  {item.blockNumber ? ` · block ${Number(item.blockNumber).toLocaleString()}` : item.kind === "evaluate" ? " · query, not recorded" : ""}
                </span>
              )}
            </span>
            <span className="mono" style={{ fontSize: 11, color: s.fg }}>
              {s.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function IdentityList({
  state,
  onState,
  onManage,
}: {
  state: WalletState;
  onState: (s: WalletState) => void;
  onManage: () => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {state.identities.map((identity) => (
        <IdentityOption
          key={identity.id}
          identity={identity}
          active={identity.id === state.settings.activeIdentityId}
          onSelect={async () => onState(await ui("setActive", { identityId: identity.id }))}
        />
      ))}
      <button type="button" className="link-btn" onClick={onManage}>
        Add or manage identities
      </button>
    </div>
  );
}

export function IdentityOption({
  identity,
  active,
  onSelect,
}: {
  identity: IdentityView;
  active: boolean;
  onSelect: () => void;
}) {
  const health = healthView(identity);
  return (
    <button type="button" className="identity-option" aria-pressed={active} onClick={onSelect}>
      <span className={`avatar ${active ? "avatar--active" : ""}`}>{identity.name.charAt(0)}</span>
      <span className="list-item__body">
        <span className="list-item__title">{identity.name}</span>
        <span className="mono subtle" style={{ fontSize: 11 }}>
          {identity.mspId}
          {identity.role ? ` · ${identity.role}` : ""}
        </span>
      </span>
      <span style={{ fontSize: 12, color: health.state === "valid" ? "var(--weft-text-subtle)" : health.color }}>
        {health.short}
      </span>
    </button>
  );
}

function SiteList({ state, onState }: { state: WalletState; onState: (s: WalletState) => void }) {
  if (state.sites.length === 0) {
    return <div className="empty">No sites connected. Apps ask to connect the first time they need your identity.</div>;
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {state.sites.map((site) => (
        <div key={site.origin} className="row">
          <span className="dot" />
          <span style={{ flex: 1, overflowWrap: "anywhere" }}>{new URL(site.origin).host}</span>
          <button
            type="button"
            className="link-btn"
            style={{ width: "auto", padding: "4px 0" }}
            onClick={async () => onState(await ui("disconnectSite", { origin: site.origin }))}
          >
            Disconnect
          </button>
        </div>
      ))}
    </div>
  );
}
