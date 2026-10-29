import { certificateHealth } from "@weftwallet/core";
import type { IdentitySummary } from "@weftwallet/protocol";
import { useEffect, useId, useRef, useState, type InputHTMLAttributes, type ReactNode } from "react";

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
  external: <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />,
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
  trash: <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />,
  users: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.6a3.5 3.5 0 0 1 0 6.8M18.5 14.2A6.5 6.5 0 0 1 21.5 20" />
    </>
  ),
  eye: (
    <>
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  eyeOff: <path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6C3.9 8.4 2 12 2 12s3.6 7 10 7c1.9 0 3.5-.6 4.9-1.4M9.9 9.9a3 3 0 0 0 4.2 4.2" />,
  unlink: <path d="M9 15l-2 2a3.5 3.5 0 0 1-5-5l3-3a3.5 3.5 0 0 1 5 0M15 9l2-2a3.5 3.5 0 0 1 5 5l-3 3a3.5 3.5 0 0 1-5 0M4 4l16 16" />,
  activity: <path d="M3 12h4l3-8 4 16 3-8h4" />,
  plus: <path d="M12 5v14M5 12h14" />,
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </>
  ),
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
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const ink = "var(--weft-ink)";
  const thread = "var(--weft-thread)";
  // The warps stay put; on hover the two weft rows pass through again.
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 16 16" shapeRendering="crispEdges" role="img" aria-label="Weft">
      <defs>
        <clipPath id={`${id}a`}>
          <rect className="logo__reveal logo__reveal--1" x="2" y="2" width="12" height="6" />
        </clipPath>
        <clipPath id={`${id}b`}>
          <rect className="logo__reveal logo__reveal--2" x="2" y="8" width="12" height="6" />
        </clipPath>
      </defs>
      <rect width="16" height="16" rx="4" fill={thread} />
      <rect x="4" y="2" width="2" height="12" fill={ink} />
      <rect x="10" y="2" width="2" height="12" fill={ink} />
      <g clipPath={`url(#${id}a)`}>
        <rect x="2" y="4" width="12" height="2" fill={ink} />
        <rect x="9" y="3" width="4" height="4" fill={thread} />
        <rect x="10" y="3" width="2" height="4" fill={ink} />
        <rect x="3" y="3" width="4" height="4" fill={thread} />
        <rect x="3" y="4" width="4" height="2" fill={ink} />
      </g>
      <g clipPath={`url(#${id}b)`}>
        <rect x="2" y="10" width="12" height="2" fill={ink} />
        <rect x="3" y="9" width="4" height="4" fill={thread} />
        <rect x="4" y="9" width="2" height="4" fill={ink} />
        <rect x="9" y="9" width="4" height="4" fill={thread} />
        <rect x="9" y="10" width="4" height="2" fill={ink} />
      </g>
    </svg>
  );
}

/**
 * The full mark with its weft threads drawn in, for motion:
 * - "loop": the threads weave in row by row and fade, while Weft waits on the network.
 * - "settle": they weave in once and the mark gives a small pulse, on success.
 * - "draw": the square, then the warps, then the wefts, once (first-run welcome).
 * prefers-reduced-motion shows the finished mark.
 */
/**
 * The mark, weaving. "draw" builds it from nothing (first run), "settle" weaves
 * the weft in once and pulses (done), "loop" weaves while working, "still" is
 * the finished mark with no motion (after work that didn't succeed).
 */
export function WeaveMark({ size = 72, mode }: { size?: number; mode: "loop" | "settle" | "draw" | "still" }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  // Hovering a resting mark weaves its weft in again. A new key restarts the animation.
  const [hovers, setHovers] = useState(0);
  const shown = hovers > 0 && mode !== "loop" ? "weave" : mode;
  const ink = "var(--weft-ink)";
  const thread = "var(--weft-thread)";
  // Each row: [y, x of the warp it passes over, x of the warp it passes under].
  const rows: [number, number, number][] = [
    [14, 17, 31],
    [24, 31, 17],
    [34, 17, 31],
  ];
  const bands: [number, number][] = [
    [6, 13.25],
    [19.25, 10],
    [29.25, 12.75],
  ];
  return (
    <svg
      key={hovers}
      className={`weave weave--${shown}`}
      width={size}
      height={size}
      viewBox="0 0 48 48"
      role="img"
      aria-label="Weft"
      onMouseEnter={() => mode !== "loop" && setHovers((n) => n + 1)}
    >
      <defs>
        {bands.map(([y, h], i) => (
          <clipPath key={i} id={`${id}r${i}`}>
            <rect className={`weave__reveal weave__reveal--${i + 1}`} x="6" y={y} width="36" height={h} />
          </clipPath>
        ))}
      </defs>
      <rect className="weave__ground" x="2" y="2" width="44" height="44" rx="12" fill={thread} />
      <path className="weave__warps" d="M17 8V40M31 8V40" stroke={ink} strokeWidth="3" strokeLinecap="round" fill="none" />
      <g className="weave__rows" fill="none">
        {rows.map(([y, over, under], i) => (
          <g key={i} clipPath={`url(#${id}r${i})`}>
            <path d={`M${over - 4} ${y}H${over + 4}`} stroke={thread} strokeWidth="9" />
            <path d={`M10 ${y}H38`} stroke={ink} strokeWidth="6" strokeLinecap="round" />
            <path d={`M${under} ${y - 4.5}V${y + 4.5}`} stroke={thread} strokeWidth="7" />
            <path d={`M${under} ${y - 4.5}V${y + 4.5}`} stroke={ink} strokeWidth="3" />
          </g>
        ))}
      </g>
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

export function BackHeader({
  title,
  onBack,
  action,
}: {
  title: string;
  onBack: () => void;
  /** A text button on the right, e.g. "Add". */
  action?: { label: string; onClick: () => void; icon?: IconName };
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  // Move focus to the new screen's title so keyboard and screen reader users
  // land at the top of what just opened.
  useEffect(() => heading.current?.focus({ preventScroll: true }), [title]);
  return (
    <header className="header header--back">
      <button type="button" className="icon-btn" aria-label="Back" onClick={onBack}>
        <Icon name="back" />
      </button>
      <h1 ref={heading} tabIndex={-1} className="header__title" style={{ margin: 0, outline: "none" }}>
        {title}
      </h1>
      {action && (
        <button type="button" className="header-action" onClick={action.onClick}>
          {action.icon && <Icon name={action.icon} size={16} />}
          {action.label}
        </button>
      )}
    </header>
  );
}

/** Password field with a show/hide toggle. */
export function SecretInput(props: Omit<InputHTMLAttributes<HTMLInputElement>, "type">) {
  const [shown, setShown] = useState(false);
  return (
    <div className="secret">
      <input {...props} type={shown ? "text" : "password"} autoComplete="off" spellCheck={false} />
      <button
        type="button"
        className="icon-btn"
        aria-label={shown ? "Hide secret" : "Show secret"}
        aria-pressed={shown}
        onClick={() => setShown(!shown)}
      >
        <Icon name={shown ? "eyeOff" : "eye"} size={18} />
      </button>
    </div>
  );
}

export function Spinner({ tone = "thread", small = false }: { tone?: "thread" | "amber"; small?: boolean }) {
  return (
    <span
      className={`spinner ${tone === "amber" ? "spinner--amber" : ""} ${small ? "spinner--sm" : ""}`}
      role="status"
      aria-label="Working"
    />
  );
}

export function SuccessMark() {
  return (
    <span className="success-mark">
      <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M5 12l5 5L20 7" />
      </svg>
    </span>
  );
}

export function Empty({ icon, children }: { icon: IconName; children: ReactNode }) {
  return (
    <div className="empty fade-in">
      <div className="empty__icon">
        <Icon name={icon} size={20} />
      </div>
      {children}
    </div>
  );
}

/** "3 min ago", "yesterday", or a date. */
export function timeAgo(at: number, now = Date.now()): string {
  const s = Math.round((now - at) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d === 1) return "yesterday";
  if (d < 7) return `${d} days ago`;
  return new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short", year: d > 300 ? "numeric" : undefined });
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
  valid: "var(--weft-accent-text)",
  expiring: "var(--weft-warn-text)",
  expired: "var(--weft-danger-text)",
  "not-yet-valid": "var(--weft-warn-text)",
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

/**
 * A centred mark with a title and a line or two of detail. The text area has a
 * fixed height, so the mark stays put when the text changes (working, then
 * done); the text fades in place instead.
 */
export function StatusScreen({ mark, title, detail }: { mark: ReactNode; title: string; detail: ReactNode }) {
  return (
    <main className="status-screen" aria-live="polite">
      <div className="status-screen__mark">{mark}</div>
      <div className="status-screen__text">
        <div key={title} className="status-screen__title fade-in">
          {title}
        </div>
        <div key={`${title}-detail`} className="status-screen__detail muted fade-in">
          {detail}
        </div>
      </div>
    </main>
  );
}
