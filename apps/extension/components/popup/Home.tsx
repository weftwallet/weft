import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { ActivityRecord } from "../../lib/db";
import { ui, type IdentityView, type WalletState } from "../../lib/messages";
import { requestHostAccess } from "../../lib/permissions";
import { CopyButton, useFeedback } from "../feedback";
import { ActionError, Button, Empty, Icon, Logo, compactHex, healthView, shorten, timeAgo, toErrorInfo, useFocusOnArrival, type ErrorInfo } from "../ui";
import { FILTER_FROM, FilterInput, GroupHeading, focusTargetAfter, groupByNetwork, matches, namesSummary, useLeaving } from "./lists";
import { useAction, useActivityEvents, type Navigate } from "./state";

type Tab = "activity" | "identities" | "sites";
const TABS = ["activity", "identities", "sites"] as const;

/** What Home keeps while a deeper screen is open, so Back returns to the same place. */
export interface HomeMemory {
  tab: Tab;
  scrollTop: number;
  /** Identities added since the popup opened: they arrive as new rows (SYSTEM.md, Arriving). */
  fresh: string[];
}

export function Home({
  state,
  onState,
  navigate,
  memory,
}: {
  state: WalletState;
  onState: (s: WalletState) => void;
  navigate: Navigate;
  memory: HomeMemory;
}) {
  const { toast } = useFeedback();
  const active = state.identities.find((i) => i.id === state.settings.activeIdentityId) ?? state.identities[0]!;
  const channels = active.channels;
  const saved =
    state.settings.activeChannel && channels.includes(state.settings.activeChannel) ? state.settings.activeChannel : channels[0];
  // Shown straight away when changed, and put back if saving it fails.
  const [picked, setPicked] = useState<string | null>(null);
  const channel = picked ?? saved;
  const [tab, setTabState] = useState<Tab>(memory.tab);
  const tabsBar = useRef<HTMLDivElement>(null);
  const setTab = (t: Tab) => {
    memory.tab = t;
    setTabState(t);
    // With the tabs held at the top of a long list, the next section starts
    // at its beginning, under the tabs, not part way down.
    const el = page.current;
    const card = tabsBar.current?.previousElementSibling;
    if (!el || !card) return;
    // Where the bar sits when it isn't held: the card's bottom, plus the
    // page's 12px gap, less the bar's own 8px margin.
    const rest = card.getBoundingClientRect().bottom - el.getBoundingClientRect().top + el.scrollTop + 4;
    if (el.scrollTop > rest) el.scrollTop = rest;
  };

  const heading = useRef<HTMLHeadingElement>(null);
  useFocusOnArrival(heading);
  const page = useRef<HTMLElement>(null);
  // Back to where the page was scrolled, and remember it on the way out. The
  // copy of Home drawn while it leaves (App.tsx) is a fresh mount: it takes
  // the position but doesn't save it, or it would overwrite it with its own.
  useLayoutEffect(() => {
    const el = page.current;
    if (!el) return;
    el.scrollTop = memory.scrollTop;
    if (el.closest(".is-leaving")) return;
    return () => {
      memory.scrollTop = el.scrollTop;
    };
  }, []);

  const changeChannel = async (next: string) => {
    setPicked(next);
    try {
      onState(await ui("setChannel", { channel: next }));
      toast(`Using ${next}`);
    } catch (error) {
      toast(`Couldn't switch to ${next}. ${toErrorInfo(error).message}`, "error");
    } finally {
      setPicked(null);
    }
  };

  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const i = TABS.indexOf(e.currentTarget.id.replace("tab-", "") as Tab);
    const next =
      e.key === "ArrowRight" ? TABS[(i + 1) % TABS.length] : e.key === "ArrowLeft" ? TABS[(i + TABS.length - 1) % TABS.length] : e.key === "Home" ? TABS[0] : e.key === "End" ? TABS[TABS.length - 1] : null;
    if (!next) return;
    e.preventDefault();
    setTab(next);
    document.getElementById(`tab-${next}`)?.focus();
  };

  return (
    <>
      <header className="header">
        <h1 ref={heading} tabIndex={-1} className="visually-hidden">
          Weft
        </h1>
        <Logo size={28} />
        <div className={`channel-picker ${channels.length > 1 ? "channel-picker--choice" : ""}`}>
          <span className="channel-picker__msp mono" title={active.mspId}>
            {active.mspId}
          </span>
          <span className="subtle" aria-hidden="true">
            ·
          </span>
          {channels.length > 1 ? (
            <>
              <select aria-label="Channel" title={channel} value={channel ?? ""} onChange={(e) => void changeChannel(e.target.value)}>
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
          <button type="button" className="icon-btn" aria-label="Security" title="Security" onClick={() => navigate({ name: "security" })}>
            <Icon name="lock" />
          </button>
        </div>
      </header>

      <main ref={page} className="page">
        <IdentityCard
          key={active.id}
          identity={active}
          caUrl={state.networks.find((n) => n.id === active.networkId)?.caUrl ?? null}
          onState={onState}
          onAdd={() => navigate({ name: "add" })}
        />

        {/* Sticky, so the sections stay in reach down a long list. */}
        <div ref={tabsBar} className="tabs-bar">
          <div className="tabs" role="tablist" aria-label="Wallet sections">
            <span className="tabs__indicator" aria-hidden="true" style={{ transform: `translateX(calc(${TABS.indexOf(tab)} * (100% + 4px)))` }} />
            {TABS.map((t) => (
              <button
                key={t}
                id={`tab-${t}`}
                type="button"
                role="tab"
                aria-selected={tab === t}
                aria-controls="tab-panel"
                tabIndex={tab === t ? 0 : -1}
                onClick={() => setTab(t)}
                onKeyDown={onTabKey}
              >
                {t === "activity"
                  ? "Activity"
                  : t === "identities"
                    ? `Identities${state.identities.length > 1 ? ` · ${state.identities.length}` : ""}`
                    : `Sites${state.sites.length ? ` · ${state.sites.length}` : ""}`}
              </button>
            ))}
          </div>
        </div>

        <div key={tab} id="tab-panel" className="crossfade" role="tabpanel" aria-labelledby={`tab-${tab}`}>
          {tab === "activity" && <ActivityList navigate={navigate} />}
          {tab === "identities" && <IdentityList state={state} onState={onState} fresh={memory.fresh} onManage={() => navigate({ name: "identities" })} />}
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
  onAdd,
}: {
  identity: IdentityView;
  caUrl: string | null;
  onState: (s: WalletState) => void;
  onAdd: () => void;
}) {
  const health = healthView(identity);
  const { toast } = useFeedback();
  const renew = useAction(async () => {
    if (caUrl) await requestHostAccess([caUrl], "your organisation's CA");
    await ui("reenroll", { identityId: identity.id });
    onState(await ui("state"));
    toast("Certificate renewed");
  });
  const attributes = Object.entries(identity.attributes).filter(([k]) => !k.startsWith("hf."));
  const canRenew = Boolean(identity.enrollmentId && caUrl);
  const fingerprint = compactHex(identity.fingerprint);

  return (
    <section className="card crossfade" aria-label="Active identity">
      <div className="row-between">
        <span className="eyebrow">Active identity</span>
        {identity.role ? <span className="chip chip--solid">{identity.role}</span> : null}
      </div>
      <div className="identity-card__names">
        <div className="identity-name" title={identity.name}>
          {identity.name}
        </div>
        <div className="muted one-line" title={identity.organization}>
          {identity.organization}
        </div>
        <div className="mono subtle one-line type-xs" title={identity.networkName}>
          {identity.networkName}
        </div>
      </div>
      <div className="mono subtle type-xs inline">
        <span>SHA-256</span>
        <span className="text" title={fingerprint}>
          {shorten(fingerprint)}
        </span>
        <span className="push-right">
          <CopyButton text={fingerprint} label="Copy fingerprint" />
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
      <div className="stack identity-card__health">
        <div className="row-between">
          <span className="strong" style={{ color: health.color }}>{health.label}</span>
          <span className="subtle">{health.detail}</span>
        </div>
        <div className="bar" aria-hidden="true">
          <div style={{ transform: `scaleX(${health.width / 100})`, background: health.color }} />
        </div>
        {identity.legacyKey && health.state !== "expired" && (
          <div className="notice notice--amber">
            <Icon name="lock" size={18} color="var(--weft-warn-text)" />
            <span>
              This key was saved before Weft encrypted keys with your password, so it isn't encrypted on disk.
              {canRenew ? " Re-enrol to replace it with an encrypted one." : " Add this identity again to encrypt it."}
            </span>
          </div>
        )}
        {(health.state === "expiring" || health.state === "expired" || identity.legacyKey) && canRenew && (
          <Button
            className={`btn btn--wrap ${health.state === "expired" ? "btn--outline-signal" : "btn--outline-amber"}`}
            busy={renew.busy}
            onClick={() => void renew.run()}
          >
            Re-enrol as {identity.enrollmentId}
          </Button>
        )}
        {(health.state === "expiring" || health.state === "expired") && !canRenew && (
          <div className={`notice notice--column ${health.state === "expired" ? "notice--signal" : "notice--amber"}`}>
            <span>
              Weft can't renew this certificate itself, because it wasn't enrolled with a CA here. Ask your CA administrator
              for a new certificate, then add it with Import PEM.
            </span>
            <button type="button" className="link-btn link-btn--inline" onClick={onAdd}>
              Add an identity
            </button>
          </div>
        )}
        <ActionError error={renew.error} />
      </div>
    </section>
  );
}

const STATUS_STYLE = {
  committed: { icon: "check", bg: "var(--weft-accent-soft)", fg: "var(--weft-accent-text)", label: "Committed" },
  evaluated: { icon: "search", bg: "var(--weft-bg-overlay)", fg: "var(--weft-text-muted)", label: "Read" },
  failed: { icon: "alert", bg: "var(--weft-danger-soft)", fg: "var(--weft-danger-text)", label: "Failed" },
  rejected: { icon: "alert", bg: "var(--weft-bg-overlay)", fg: "var(--weft-text-subtle)", label: "Rejected" },
} as const;

/**
 * The list as last loaded while the popup is open. Coming back to Home (or
 * the copy of Home drawn while it leaves) shows it at once, so the page has
 * its height before the scroll position is put back, and then refreshes it.
 */
let lastActivity: ActivityRecord[] | null = null;

function ActivityList({ navigate }: { navigate: Navigate }) {
  const [items, setItems] = useState<ActivityRecord[] | null>(lastActivity);
  const [error, setError] = useState<ErrorInfo | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(() => new Set());
  const known = useRef<Set<string> | null>(lastActivity && new Set(lastActivity.map((i) => i.id)));
  const { announce } = useFeedback();

  const load = async () => {
    try {
      const loaded = await ui("activity");
      // What arrived since the list was first shown comes in as new (SYSTEM.md, Arriving).
      if (known.current) {
        const added = loaded.filter((i) => !known.current!.has(i.id));
        if (added.length) {
          setFresh((s) => new Set([...s, ...added.map((i) => i.id)]));
          const first = added[0]!;
          announce(`New activity: ${first.call.fn}, ${STATUS_STYLE[first.status].label.toLowerCase()}.`);
        }
      }
      known.current = new Set(loaded.map((i) => i.id));
      lastActivity = loaded;
      setItems(loaded);
      setError(null);
    } catch (e) {
      setError(toErrorInfo(e));
    }
  };
  useEffect(() => {
    void load();
  }, []);
  useActivityEvents(() => void load());

  if (error && !items) {
    return (
      <div className="empty">
        <ActionError error={{ ...error, message: "Weft couldn't load your activity." }}>
          <button type="button" className="link-btn link-btn--inline" onClick={() => void load()}>
            Try again
          </button>
        </ActionError>
      </div>
    );
  }
  // Reserved space while loading, so the tab doesn't jump when the list arrives.
  if (!items) return <div className="list-placeholder" aria-busy="true" />;
  if (items.length === 0) {
    return <Empty icon="activity">No transactions yet. Requests from apps you connect will show up here.</Empty>;
  }
  const days = groupByDay(items);
  return (
    <div className="stack stack--day">
      {days.map((day) => (
        <section key={day.label} aria-label={day.label}>
          <div className="eyebrow day-label">{day.label}</div>
          <div className="list stagger">
            {day.items.map((item) => (
              <ActivityRow key={item.id} item={item} isNew={fresh.has(item.id)} navigate={navigate} />
            ))}
          </div>
        </section>
      ))}
      {items.length >= 50 && (
        <p className="subtle type-xs centre list-note">Showing the 50 most recent.</p>
      )}
    </div>
  );
}

/** "Today", "Yesterday", or a date, newest first. */
function groupByDay(items: ActivityRecord[]): { label: string; items: ActivityRecord[] }[] {
  const startOfDay = (t: number) => new Date(t).setHours(0, 0, 0, 0);
  const today = startOfDay(Date.now());
  const yesterday = startOfDay(today - 12 * 3_600_000);
  const out: { label: string; items: ActivityRecord[] }[] = [];
  for (const item of items) {
    const day = startOfDay(item.at);
    const label =
      day === today
        ? "Today"
        : day === yesterday
          ? "Yesterday"
          : new Date(day).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
    const last = out[out.length - 1];
    if (last?.label === label) last.items.push(item);
    else out.push({ label, items: [item] });
  }
  return out;
}

function ActivityRow({ item, isNew, navigate }: { item: ActivityRecord; isNew: boolean; navigate: Navigate }) {
  const s = STATUS_STYLE[item.status];
  return (
    <button type="button" className={`list-item ${isNew ? "is-new" : ""}`} onClick={() => navigate({ name: "tx", activityId: item.id })}>
      <span className="list-item__icon" style={{ background: s.bg, color: s.fg }}>
        <Icon name={s.icon} size={16} />
      </span>
      <span className="list-item__body">
        <span className="list-item__title" title={item.call.fn}>
          {item.call.fn}
        </span>
        {item.status === "failed" ? (
          <span className="one-line type-xs danger-text">{item.title}</span>
        ) : (
          <span className="mono subtle one-line type-xs">
            {item.call.chaincode}
            {item.blockNumber ? ` · block ${Number(item.blockNumber).toLocaleString()}` : item.kind === "evaluate" ? " · query" : ""}
          </span>
        )}
      </span>
      <span className="list-item__end">
        <span className="status-label" style={{ color: s.fg }}>
          {s.label}
        </span>
        <span className="subtle type-xs">{timeAgo(item.at)}</span>
      </span>
    </button>
  );
}

function IdentityList({
  state,
  onState,
  fresh,
  onManage,
}: {
  state: WalletState;
  onState: (s: WalletState) => void;
  /** Identities that arrived since the popup opened, which come in as new rows. */
  fresh: string[];
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
  const select = useAction(async (identity: IdentityView) => {
    if (identity.id === activeId) return;
    try {
      onState(await ui("setActive", { identityId: identity.id }));
      toast(`Switched to ${identity.name}`);
    } catch (error) {
      toast(`Couldn't switch to ${identity.name}. ${toErrorInfo(error).message}`, "error");
    }
  });
  return (
    <div className="stack">
      {state.identities.length >= FILTER_FROM && <FilterInput value={query} onChange={setQuery} label="Filter identities" />}
      {groups.map((group) => (
        <div key={group.networkId} className="stagger stack">
          {grouped && <GroupHeading title={group.network?.name ?? "Unknown network"} detail={group.network?.mspId} />}
          {group.identities.map((identity) => (
            <IdentityOption
              key={identity.id}
              identity={identity}
              active={identity.id === activeId}
              showMsp={!grouped}
              isNew={fresh.includes(identity.id)}
              onSelect={() => void select.run(identity)}
            />
          ))}
        </div>
      ))}
      {groups.length === 0 && (
        <Empty icon="search" action={{ label: "Clear filter", onClick: () => setQuery("") }}>
          No identity matches “{query}”.
        </Empty>
      )}
      <button type="button" className="link-btn link-btn--inline" onClick={onManage}>
        Add or remove identities
      </button>
    </div>
  );
}

export function IdentityOption({
  identity,
  active,
  onSelect,
  showMsp = true,
  isNew = false,
}: {
  identity: IdentityView;
  active: boolean;
  onSelect: () => void;
  /** Off inside a network group, whose heading already names the MSP. */
  showMsp?: boolean;
  /** Arrived while the person was looking: comes in as a pick (motion.css .is-new). */
  isNew?: boolean;
}) {
  const health = healthView(identity);
  return (
    <button type="button" className={`identity-option${isNew ? " is-new" : ""}`} aria-pressed={active} onClick={onSelect}>
      <span className={`avatar ${active ? "avatar--active" : ""}`} aria-hidden="true">
        {identity.name.trim().charAt(0) || "?"}
      </span>
      <span className="list-item__body">
        <span className="list-item__title" title={identity.name}>
          {identity.name}
        </span>
        <span className="mono subtle one-line type-xs">
          {[showMsp ? identity.mspId : null, identity.role ?? "No role"].filter(Boolean).join(" · ")}
        </span>
      </span>
      <span className="type-xs" style={{ color: health.state === "valid" ? "var(--weft-text-subtle)" : health.color }}>
        {health.short}
      </span>
    </button>
  );
}

function SiteList({ state, onState }: { state: WalletState; onState: (s: WalletState) => void }) {
  const { confirm, toast } = useFeedback();
  const [query, setQuery] = useState("");
  const leaving = useLeaving();
  const list = useRef<HTMLDivElement>(null);
  if (state.sites.length === 0) {
    return <Empty icon="globe">No sites connected. Apps ask to connect the first time they need your identity.</Empty>;
  }
  const disconnect = async (origin: string, row: Element | null) => {
    const host = new URL(origin).host;
    const ok = await confirm({
      title: `Disconnect ${host}?`,
      body: "The site loses access to all your identities and must ask again before it can request anything. Any open tabs of it are told straight away.",
      confirmLabel: "Disconnect",
      icon: "unlink",
    });
    if (!ok) return;
    const refocus = focusTargetAfter(row, () => document.getElementById("tab-sites"));
    await leaving.leave(origin);
    try {
      onState(await ui("disconnectSite", { origin }));
      toast(`Disconnected ${host}`);
      refocus();
    } catch (error) {
      leaving.stay(origin);
      toast(`Couldn't disconnect ${host}. ${toErrorInfo(error).message}`, "error");
    }
  };
  const shown = state.sites.filter((site) => matches(query, new URL(site.origin).host));
  return (
    <div ref={list} className="stagger stack">
      {state.sites.length >= FILTER_FROM && <FilterInput value={query} onChange={setQuery} label="Filter sites" />}
      {shown.length === 0 && (
        <Empty icon="search" action={{ label: "Clear filter", onClick: () => setQuery("") }}>
          No site matches “{query}”.
        </Empty>
      )}
      {shown.map((site) => {
        const host = new URL(site.origin).host;
        const names = (site.identityIds ?? [])
          .map((id) => state.identities.find((i) => i.id === id)?.name)
          .filter((n): n is string => Boolean(n));
        return (
          <div key={site.origin} className={`site-row ${leaving.isLeaving(site.origin) ? "is-leaving" : ""}`}>
            <span className="site-row__icon" aria-hidden="true">
              <Icon name={site.origin.startsWith("https:") ? "lock" : "globe"} size={16} />
            </span>
            <span className="list-item__body">
              <span className="list-item__title" title={host}>
                {host}
              </span>
              <span className="subtle one-line type-xs" title={names.length ? `Connected as ${names.join(", ")}` : undefined}>
                {names.length ? `As ${namesSummary(names)} · ${timeAgo(site.connectedAt)}` : `Connected ${timeAgo(site.connectedAt)}`}
              </span>
            </span>
            <button
              type="button"
              className="small-btn"
              aria-label={`Disconnect ${host}`}
              onClick={(e) => void disconnect(site.origin, e.currentTarget.closest(".site-row"))}
            >
              Disconnect
            </button>
          </div>
        );
      })}
    </div>
  );
}
