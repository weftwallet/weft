import { useEffect, useState } from "react";
import type { ActivityRecord } from "../../lib/db";
import { ui, type IdentityView, type WalletState } from "../../lib/messages";
import { requestHostAccess } from "../../lib/permissions";
import { CopyButton, useFeedback } from "../feedback";
import { Empty, Icon, Logo, Spinner, shorten, healthView, timeAgo } from "../ui";
import { FILTER_FROM, FilterInput, GroupHeading, groupByNetwork, matches, namesSummary } from "./lists";
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
  const tabs = ["activity", "identities", "sites"] as const;

  return (
    <>
      <header className="header">
        <Logo size={28} />
        <div className="channel-picker">
          <span className="dot" />
          <span className="channel-picker__msp mono" title={active.mspId}>
            {active.mspId}
          </span>
          <span className="subtle">·</span>
          {channels.length > 1 ? (
            <>
              <select
                aria-label="Channel"
                title={channel}
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
            </>
          ) : (
            <span className="channel-picker__channel" title={channel}>
              {channel}
            </span>
          )}
        </div>
        <div className="header__actions">
          <button
            type="button"
            className="icon-btn"
            aria-label="Manage identities"
            title="Manage identities"
            onClick={() => navigate({ name: "identities" })}
          >
            <Icon name="users" />
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label="Security"
            title="Security"
            onClick={() => navigate({ name: "security" })}
          >
            <Icon name="lock" />
          </button>
        </div>
      </header>

      <main className="page">
        <IdentityCard
          identity={active}
          caUrl={state.networks.find((n) => n.id === active.networkId)?.caUrl ?? null}
          onState={onState}
        />

        <nav className="tabs" role="tablist" aria-label="Wallet sections">
          <span
            className="tabs__indicator"
            aria-hidden="true"
            style={{ transform: `translateX(calc(${tabs.indexOf(tab)} * (100% + 4px)))` }}
          />
          {tabs.map((t) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
              {t === "activity"
                ? "Activity"
                : t === "identities"
                  ? `Identities${state.identities.length > 1 ? ` · ${state.identities.length}` : ""}`
                  : `Sites${state.sites.length ? ` · ${state.sites.length}` : ""}`}
            </button>
          ))}
        </nav>

        <div key={tab} className="fade-in" role="tabpanel">
          {tab === "activity" && <ActivityList navigate={navigate} />}
          {tab === "identities" && (
            <IdentityList state={state} onState={onState} onManage={() => navigate({ name: "identities" })} />
          )}
          {tab === "sites" && <SiteList state={state} onState={onState} />}
        </div>
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
        <div className="identity-name" title={identity.name}>
          {identity.name}
        </div>
        <div className="muted one-line" style={{ fontSize: 13 }} title={identity.organization}>
          {identity.organization}
        </div>
        <div className="mono subtle one-line" style={{ fontSize: 12 }} title={identity.networkName}>
          {identity.networkName}
        </div>
      </div>
      <div className="mono subtle" style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
        <span>SHA-256</span>
        <span style={{ color: "#c9d2da" }}>{shorten(identity.fingerprint, 11, 5)}</span>
        <span style={{ marginLeft: "auto" }}>
          <CopyButton text={identity.fingerprint} label="Copy fingerprint" />
        </span>
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
        {identity.legacyKey && health.state !== "expired" && (
          <div className="notice notice--amber" style={{ fontSize: 13 }}>
            <Icon name="lock" size={18} color="var(--weft-amber)" />
            <span>
              This key was saved before Weft encrypted keys with your password, so it isn't encrypted on disk.
              {identity.enrollmentId && caUrl ? " Re-enrol to replace it with an encrypted one." : " Add this identity again to encrypt it."}
            </span>
          </div>
        )}
        {(health.state === "expiring" || health.state === "expired" || identity.legacyKey) && identity.enrollmentId && caUrl && (
          <button
            type="button"
            className={`btn ${health.state === "expired" ? "btn--outline-signal" : "btn--outline-amber"}`}
            disabled={renew.busy}
            onClick={() => void renew.run()}
          >
            {renew.busy ? (
              <>
                <Spinner small tone={health.state === "expired" ? "thread" : "amber"} /> Renewing…
              </>
            ) : (
              `Re-enrol as ${identity.enrollmentId}`
            )}
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
    return <Empty icon="activity">No transactions yet. Requests from apps you connect will show up here.</Empty>;
  }
  const days = groupByDay(items);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {days.map((day) => (
        <section key={day.label} aria-label={day.label}>
          <div className="eyebrow" style={{ padding: "10px 4px 4px" }}>
            {day.label}
          </div>
          <div className="list">
            {day.items.map((item) => (
              <ActivityRow key={item.id} item={item} navigate={navigate} />
            ))}
          </div>
        </section>
      ))}
      {items.length >= 50 && (
        <p className="subtle" style={{ fontSize: 12, textAlign: "center", margin: "8px 0 0" }}>
          Showing the 50 most recent.
        </p>
      )}
    </div>
  );
}

/** "Today", "Yesterday", or a date, newest first. */
function groupByDay(items: ActivityRecord[]): { label: string; items: ActivityRecord[] }[] {
  const startOfDay = (t: number) => new Date(t).setHours(0, 0, 0, 0);
  const today = startOfDay(Date.now());
  const out: { label: string; items: ActivityRecord[] }[] = [];
  for (const item of items) {
    const day = startOfDay(item.at);
    const label =
      day === today
        ? "Today"
        : day === today - 86_400_000
          ? "Yesterday"
          : new Date(day).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
    const last = out[out.length - 1];
    if (last?.label === label) last.items.push(item);
    else out.push({ label, items: [item] });
  }
  return out;
}

function ActivityRow({ item, navigate }: { item: ActivityRecord; navigate: Navigate }) {
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
              <span className="list-item__title" title={item.call.fn}>
                {item.call.fn}
              </span>
              {item.status === "failed" ? (
                <span className="one-line" style={{ fontSize: 12, color: "var(--weft-signal)" }}>
                  {item.title}
                </span>
              ) : (
                <span className="mono subtle one-line" style={{ fontSize: 11 }}>
                  {item.call.chaincode}
                  {item.blockNumber ? ` · block ${Number(item.blockNumber).toLocaleString()}` : item.kind === "evaluate" ? " · query" : ""}
                </span>
              )}
            </span>
            <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2, flex: "none" }}>
              <span className="mono" style={{ fontSize: 11, color: s.fg }}>
                {s.label}
              </span>
              <span className="subtle" style={{ fontSize: 11 }}>
                {timeAgo(item.at)}
              </span>
            </span>
          </button>
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
  const { toast } = useFeedback();
  const [query, setQuery] = useState("");
  const activeId = state.settings.activeIdentityId;
  const groups = groupByNetwork(
    state.identities.filter((i) => matches(query, i.name, i.mspId, i.networkName, i.organization, i.role)),
    state.networks,
    activeId,
  );
  const grouped = new Set(state.identities.map((i) => i.networkId)).size > 1;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {state.identities.length >= FILTER_FROM && <FilterInput value={query} onChange={setQuery} label="Filter identities" />}
      {groups.map((group) => (
        <div key={group.networkId} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {grouped && <GroupHeading title={group.network?.name ?? "Unknown network"} detail={group.network?.mspId} />}
          {group.identities.map((identity) => (
            <IdentityOption
              key={identity.id}
              identity={identity}
              active={identity.id === activeId}
              showMsp={!grouped}
              onSelect={async () => {
                if (identity.id === activeId) return;
                onState(await ui("setActive", { identityId: identity.id }));
                toast(`Switched to ${identity.name}`);
              }}
            />
          ))}
        </div>
      ))}
      {groups.length === 0 && <Empty icon="search">No identity matches "{query}".</Empty>}
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
  showMsp = true,
}: {
  identity: IdentityView;
  active: boolean;
  onSelect: () => void;
  /** Off inside a network group, whose heading already names the MSP. */
  showMsp?: boolean;
}) {
  const health = healthView(identity);
  return (
    <button type="button" className="identity-option" aria-pressed={active} onClick={onSelect}>
      <span className={`avatar ${active ? "avatar--active" : ""}`}>{identity.name.charAt(0)}</span>
      <span className="list-item__body">
        <span className="list-item__title" title={identity.name}>
          {identity.name}
        </span>
        <span className="mono subtle one-line" style={{ fontSize: 11 }}>
          {[showMsp ? identity.mspId : null, identity.role ?? "no role"].filter(Boolean).join(" · ")}
        </span>
      </span>
      <span style={{ fontSize: 12, color: health.state === "valid" ? "var(--weft-text-subtle)" : health.color }}>
        {health.short}
      </span>
    </button>
  );
}

function SiteList({ state, onState }: { state: WalletState; onState: (s: WalletState) => void }) {
  const { confirm, toast } = useFeedback();
  const [query, setQuery] = useState("");
  if (state.sites.length === 0) {
    return <Empty icon="globe">No sites connected. Apps ask to connect the first time they need your identity.</Empty>;
  }
  const disconnect = async (origin: string) => {
    const host = new URL(origin).host;
    const ok = await confirm({
      title: `Disconnect ${host}?`,
      body: "The site loses access to all your identities and must ask again before it can request anything. Any open tabs of it are told straight away.",
      confirmLabel: "Disconnect",
      icon: "unlink",
    });
    if (!ok) return;
    onState(await ui("disconnectSite", { origin }));
    toast(`Disconnected ${host}`);
  };
  const shown = state.sites.filter((site) => matches(query, new URL(site.origin).host));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {state.sites.length >= FILTER_FROM && <FilterInput value={query} onChange={setQuery} label="Filter sites" />}
      {shown.length === 0 && <Empty icon="search">No site matches "{query}".</Empty>}
      {shown.map((site) => (
        <div key={site.origin} className="site-row">
          <span className="site-row__icon">
            <Icon name={site.origin.startsWith("https:") ? "lock" : "globe"} size={16} />
          </span>
          <span className="list-item__body">
            <span className="list-item__title" title={new URL(site.origin).host}>
              {new URL(site.origin).host}
            </span>
            {(() => {
              const names = (site.identityIds ?? [])
                .map((id) => state.identities.find((i) => i.id === id)?.name)
                .filter((n): n is string => Boolean(n));
              return (
                <span className="subtle one-line" style={{ fontSize: 11 }} title={names.length ? `Connected as ${names.join(", ")}` : undefined}>
                  {names.length ? `As ${namesSummary(names)} · ${timeAgo(site.connectedAt)}` : `Connected ${timeAgo(site.connectedAt)}`}
                </span>
              );
            })()}
          </span>
          <button type="button" className="small-btn" onClick={() => void disconnect(site.origin)}>
            Disconnect
          </button>
        </div>
      ))}
    </div>
  );
}
