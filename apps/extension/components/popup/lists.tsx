/**
 * Helpers that keep lists usable when a wallet holds many identities,
 * networks and sites: grouping, filtering and short summaries.
 */

import type { NetworkRecord } from "../../lib/db";
import type { IdentityView } from "../../lib/messages";
import { Icon } from "../ui";

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
  detail?: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="group-head">
      <span className="group-head__title" title={title}>
        {title}
      </span>
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
