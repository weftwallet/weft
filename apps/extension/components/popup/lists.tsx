/**
 * Helpers that keep lists usable when a wallet holds many identities,
 * networks and sites: grouping, filtering, short summaries, and rows that
 * leave the way they came.
 */

import { useState } from "react";
import type { NetworkRecord } from "../../lib/db";
import type { IdentityView } from "../../lib/messages";
import { Icon, tokenMs } from "../ui";

/** Lists longer than this get a filter box. */
export const FILTER_FROM = 6;

export interface NetworkGroup {
  network: NetworkRecord | null;
  networkId: string;
  identities: IdentityView[];
}

/** Identities grouped by network, the active identity's network first, then by name. */
export function groupByNetwork(identities: IdentityView[], networks: NetworkRecord[], activeId: string | null): NetworkGroup[] {
  const groups = new Map<string, NetworkGroup>();
  for (const identity of identities) {
    const group = groups.get(identity.networkId) ?? {
      network: networks.find((n) => n.id === identity.networkId) ?? null,
      networkId: identity.networkId,
      identities: [],
    };
    group.identities.push(identity);
    groups.set(identity.networkId, group);
  }
  const activeNetwork = identities.find((i) => i.id === activeId)?.networkId;
  return [...groups.values()].sort((a, b) => {
    if (a.networkId === activeNetwork) return -1;
    if (b.networkId === activeNetwork) return 1;
    return (a.network?.name ?? "").localeCompare(b.network?.name ?? "");
  });
}

/** Case-insensitive match of a query against any of the given texts. */
export function matches(query: string, ...texts: (string | null | undefined)[]): boolean {
  const q = query.trim().toLowerCase();
  return !q || texts.some((t) => t?.toLowerCase().includes(q));
}

/** "alice", "alice and bob", "alice and 3 more". */
export function namesSummary(names: string[]): string {
  if (names.length <= 2) return names.join(" and ");
  return `${names[0]} and ${names.length - 1} more`;
}

export function FilterInput({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  return (
    <label className="filter">
      <Icon name="search" size={16} />
      <input type="search" placeholder={label} aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

export function GroupHeading({
  title,
  detail,
  action,
}: {
  title: string;
  detail?: string | undefined;
  action?: { label: string; onClick: () => void } | undefined;
}) {
  return (
    <div className="group-head">
      <h2 className="group-head__title" title={title} tabIndex={-1}>
        {title}
      </h2>
      {detail && (
        <span className="group-head__detail mono" title={detail}>
          {detail}
        </span>
      )}
      {action && (
        <button type="button" className="icon-btn icon-btn--sm" aria-label={action.label} title={action.label} onClick={action.onClick}>
          <Icon name="settings" size={16} />
        </button>
      )}
    </div>
  );
}

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Rows being removed: they leave (fade and shift, ease-in) before the list
 * closes up (SYSTEM.md, Navigation).
 */
export function useLeaving() {
  const [leaving, setLeaving] = useState<Set<string>>(() => new Set());
  const leave = (id: string) =>
    new Promise<void>((resolve) => {
      setLeaving((s) => new Set(s).add(id));
      setTimeout(resolve, reducedMotion() ? 0 : tokenMs("--weft-duration-base-out", 154));
    });
  const stay = (id: string) =>
    setLeaving((s) => {
      const next = new Set(s);
      next.delete(id);
      return next;
    });
  return { isLeaving: (id: string) => leaving.has(id), leave, stay };
}

/**
 * Where focus goes once a row is removed: the next row, else the one before,
 * else `fallback` (the list's heading).
 */
export function focusTargetAfter(row: Element | null, fallback: () => HTMLElement | null): () => void {
  const pick = (el: Element | null) => el?.querySelector<HTMLElement>("button, [href], input") ?? null;
  const next = pick(row?.nextElementSibling ?? null) ?? pick(row?.previousElementSibling ?? null);
  return () => (next?.isConnected ? next : fallback())?.focus({ preventScroll: false });
}
