import { certificateHealth } from "@weftwallet/core";
import type { IdentitySummary } from "@weftwallet/protocol";
import type { ReactNode } from "react";

/* Icons: 24px stroke icons, decorative unless labelled. ------------- */

const paths = {
  back: <path d="M15 18l-6-6 6-6" />,
  chevron: <path d="M6 9l6 6 6-6" />,
  more: (
    <>
      <circle cx="12" cy="5" r="1.2" />
      <circle cx="12" cy="12" r="1.2" />
      <circle cx="12" cy="19" r="1.2" />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V6a2 2 0 0 1 2-2h9" />
    </>
  ),
  check: <path d="M5 12l5 5L20 7" />,
  alert: (
    <>
      <path d="M12 8v5M12 16.5v.5" />
      <circle cx="12" cy="12" r="9" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="M20 20l-4.5-4.5" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </>
  ),
  shield: <path d="M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z" />,
  qr: <path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2M18 14h2v2M14 18v2h2M20 20h-2" />,
  key: (
    <>
      <circle cx="8" cy="12" r="4" />
      <path d="M12 12h9M18 12v3M21 12v2" />
    </>
  ),
  file: (
    <>
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
      <path d="M14 3v6h6M12 18v-6M9 15l3 3 3-3" />
    </>
  ),
  upload: <path d="M12 3v12M6 9l6-6 6 6M5 21h14" />,
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
    </>
  ),
} as const;

export type IconName = keyof typeof paths;

export function Icon({ name, size = 20, color = "currentColor" }: { name: IconName; size?: number; color?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      {paths[name]}
    </svg>
  );
}

/**
 * The Weft mark for 32px and below, drawn on a 16px pixel grid so threads and
 * gaps stay crisp. Use WovenMark for anything larger.
 */
export function Logo({ size = 24 }: { size?: number }) {
  const ink = "var(--weft-ink)";
  const thread = "var(--weft-thread)";
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" shapeRendering="crispEdges" role="img" aria-label="Weft">
      <rect width="16" height="16" rx="4" fill={thread} />
      <rect x="4" y="2" width="2" height="12" fill={ink} />
      <rect x="10" y="2" width="2" height="12" fill={ink} />
      <rect x="2" y="4" width="12" height="2" fill={ink} />
      <rect x="2" y="10" width="12" height="2" fill={ink} />
      <rect x="9" y="3" width="4" height="4" fill={thread} />
      <rect x="10" y="3" width="2" height="4" fill={ink} />
      <rect x="3" y="9" width="4" height="4" fill={thread} />
      <rect x="4" y="9" width="2" height="4" fill={ink} />
      <rect x="3" y="3" width="4" height="4" fill={thread} />
      <rect x="3" y="4" width="4" height="2" fill={ink} />
      <rect x="9" y="9" width="4" height="4" fill={thread} />
      <rect x="9" y="10" width="4" height="2" fill={ink} />
    </svg>
  );
}

/** The full woven mark, for larger sizes. */
export function WovenMark({ size = 72 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" role="img" aria-label="Weft">
      <rect x="2" y="2" width="44" height="44" rx="12" fill="var(--weft-thread)" />
      <g fill="none" strokeLinecap="round">
        <path d="M17 8V40M31 8V40" stroke="var(--weft-ink)" strokeWidth="3" />
        <path d="M10 14H38M10 24H38M10 34H38" stroke="var(--weft-ink)" strokeWidth="6" />
        <path d="M13 14H21M27 24H35M13 34H21" stroke="var(--weft-thread)" strokeWidth="10" strokeLinecap="butt" />
        <path d="M12 14H22M26 24H36M12 34H22" stroke="var(--weft-ink)" strokeWidth="6" strokeLinecap="butt" />
        <path d="M31 9V19M17 19V29M31 29V39" stroke="var(--weft-thread)" strokeWidth="7" strokeLinecap="butt" />
        <path d="M31 9V19M17 19V29M31 29V39" stroke="var(--weft-ink)" strokeWidth="3" strokeLinecap="butt" />
      </g>
    </svg>
  );
}

export function BackHeader({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <header className="header header--back">
      <button type="button" className="icon-btn" aria-label="Back" onClick={onBack}>
        <Icon name="back" />
      </button>
      <h1 className="header__title" style={{ margin: 0 }}>
        {title}
      </h1>
    </header>
  );
}

export function Field(props: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <label>
        <span style={{ display: "block", marginBottom: 6 }}>{props.label}</span>
        {props.children}
      </label>
      {props.hint ? <div className="field__hint">{props.hint}</div> : null}
    </div>
  );
}

const HEALTH_COLOR = {
  valid: "var(--weft-thread)",
  expiring: "var(--weft-amber)",
  expired: "var(--weft-signal)",
  "not-yet-valid": "var(--weft-amber)",
} as const;

export function healthView(identity: Pick<IdentitySummary, "notAfter">) {
  const health = certificateHealth(identity);
  const color = HEALTH_COLOR[health.state];
  switch (health.state) {
    case "valid":
      return { ...health, color, label: "Certificate valid", detail: `${health.daysLeft} days left`, short: `${health.daysLeft} days`, width: Math.min(100, Math.round((health.daysLeft / 365) * 100)) };
    case "expiring":
      return { ...health, color, label: `Expires in ${health.daysLeft} day${health.daysLeft === 1 ? "" : "s"}`, detail: "Renew soon", short: `${health.daysLeft} days`, width: Math.max(4, Math.round((health.daysLeft / 365) * 100)) };
    case "expired":
      return { ...health, color, label: "Certificate expired", detail: "Signing disabled", short: "Expired", width: 0 };
    default:
      return { ...health, color, label: "Not yet valid", detail: "", short: "Not valid", width: 0 };
  }
}

export function copy(text: string) {
  void navigator.clipboard.writeText(text);
}

/** Middle-truncates long identifiers: 7c1e09b4…a94f */
export function shorten(value: string, head = 8, tail = 4): string {
  return value.length <= head + tail + 1 ? value : `${value.slice(0, head)}…${value.slice(-tail)}`;
}

export function initial(name: string): string {
  return name.trim().charAt(0) || "?";
}
