import { certificateHealth } from "@weftwallet/core";
import type { IdentitySummary } from "@weftwallet/protocol";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type Ref,
  type RefObject,
  type SelectHTMLAttributes,
} from "react";
import LOADER from "@weftwallet/brand/logo/loaders/weft.svg?raw";
import LOADER_SMALL from "@weftwallet/brand/logo/loaders/weft-small.svg?raw";

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
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 7.5v.5" />
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
 * gaps stay crisp. Use WeaveMark for anything larger.
 */
export function Logo({ size = 24, label = "Weft" }: { size?: number; label?: string | null }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const ink = "var(--weft-ink)";
  const thread = "var(--weft-thread)";
  // Still: nothing in the mark moves once it is drawn (SYSTEM.md, Motion).
  return (
    <svg
      className="logo"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      shapeRendering="crispEdges"
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    >
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

/** The mark and the product's name, for the windows that have no other header. */
export function Brand() {
  return (
    <div className="brand">
      <Logo size={20} label={null} />
      <span>Weft</span>
    </div>
  );
}

/**
 * The mark. "draw" builds it from nothing, once per installation (the
 * welcome's first run; App.tsx keeps the flag); "still" is the finished mark,
 * which is what it is everywhere else. Working uses Spinner, Weft's loader.
 * prefers-reduced-motion shows the finished mark.
 */
export function WeaveMark({ size = 72, mode }: { size?: number; mode: "draw" | "still" }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
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
    <svg className={`weave weave--${mode}`} width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
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

/** Moves focus to a screen's h1 when it opens (SYSTEM.md, Navigation). */
export function useFocusOnArrival(ref: RefObject<HTMLElement | null>, key: unknown = null) {
  useEffect(() => {
    const el = ref.current;
    // A screen kept mounted under the lock, or one on its way out, isn't arriving.
    if (!el || el.closest("[hidden], .is-leaving")) return;
    el.focus({ preventScroll: true });
  }, [key]);
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
  useFocusOnArrival(heading, title);
  // Escape goes back, unless a sheet is open: it closes the sheet instead.
  const back = useRef(onBack);
  back.current = onBack;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || document.querySelector(".sheet-backdrop")) return;
      if (heading.current?.closest("[hidden], .is-leaving")) return;
      back.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <header className="header header--back">
      <button type="button" className="icon-btn" aria-label="Back" onClick={onBack}>
        <Icon name="back" />
      </button>
      <h1 ref={heading} tabIndex={-1} className="header__title">
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
export function SecretInput({ ref, ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & { ref?: Ref<HTMLInputElement> }) {
  const [shown, setShown] = useState(false);
  return (
    <div className="secret">
      <input {...props} ref={ref} type={shown ? "text" : "password"} autoComplete="off" spellCheck={false} />
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

/** A select with the chevron drawn in, so it follows the theme. */
export function Select({ children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className="select">
      <select {...props}>{children}</select>
      <Icon name="chevron" size={16} />
    </span>
  );
}

/**
 * Working: Weft's loader, the mark with its middle pick pulled through,
 * seated and drawn out (packages/brand/logo/loaders). It's decorative: the
 * words beside it say what's happening. It keeps turning with reduced motion.
 */
export function Spinner({ small = false, size }: { small?: boolean; size?: number }) {
  return (
    <span
      className={`loader ${small ? "loader--sm" : ""}`}
      style={size ? { width: size, height: size } : undefined}
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: LOADER }}
    />
  );
}

/**
 * A screen still loading: the loader and what it's waiting for. Like a busy
 * button, it shows nothing until wait-before-loader has passed (app.css
 * .splash__inner), so a quick answer never flashes a loader.
 */
export function Splash({ label }: { label: string }) {
  return (
    <div className="splash" role="status">
      <div className="splash__inner">
        <Spinner />
        <span className="muted">{label}</span>
      </div>
    </div>
  );
}

/** A motion token's value in milliseconds. A minifier may write 1400ms as 1.4s. */
export function tokenMs(name: string, fallback: number): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const v = parseFloat(raw);
  if (!Number.isFinite(v)) return fallback;
  return /ms$/.test(raw) ? v : v * 1000;
}

/**
 * Whether the loader should show for a wait: true only once wait-before-loader
 * has passed since `busy` became true, and false again the moment it ends, so
 * a quick answer never flashes a loader and a loader never finishes its pass.
 * The same semantics as ui.ts setBusy(), for React.
 */
export function useLoader(busy: boolean): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!busy) {
      setShown(false);
      return;
    }
    const t = setTimeout(() => setShown(true), tokenMs("--weft-wait-before-loader", 300));
    return () => clearTimeout(t);
  }, [busy]);
  return busy && shown;
}

/**
 * A button that can be busy, the way ui.ts setBusy() does it (SYSTEM.md,
 * Loading): aria-disabled at once, never disabled, so keyboard focus stays on
 * it and presses are ignored; the loader joins the label only after
 * wait-before-loader and is removed at once when the work ends; the label
 * stays and the width never changes (the loader takes the padding the button
 * gives up, or the place of the button's own icon).
 */
export function Button({
  busy = false,
  icon,
  iconSize = 18,
  className = "btn",
  type = "button",
  onClick,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean; icon?: IconName; iconSize?: number }) {
  const blocked = busy || rest["aria-disabled"] === true || rest["aria-disabled"] === "true";
  const loader = useLoader(busy);
  return (
    <button
      {...rest}
      type={type}
      className={`${className}${loader && !icon ? " is-working" : ""}`}
      aria-disabled={blocked || undefined}
      data-busy={busy || undefined}
      onClick={(e) => {
        if (blocked) {
          e.preventDefault();
          return;
        }
        onClick?.(e);
      }}
    >
      {loader ? (
        icon ? (
          // In the icon's place and the icon's size, so the label doesn't move.
          <span className="btn__icon-slot" style={{ width: iconSize, height: iconSize }}>
            <Spinner small />
          </span>
        ) : (
          <Spinner small />
        )
      ) : icon ? (
        <Icon name={icon} size={iconSize} />
      ) : null}
      {children}
    </button>
  );
}

export function Empty({ icon, children, action }: { icon: IconName; children: ReactNode; action?: { label: string; onClick: () => void } }) {
  return (
    <div className="empty arrive">
      <div className="empty__icon">
        <Icon name={icon} size={20} />
      </div>
      {children}
      {action && (
        <div>
          <button type="button" className="link-btn link-btn--inline" onClick={action.onClick}>
            {action.label}
          </button>
        </div>
      )}
    </div>
  );
}

/** "3 min ago", "2 hours ago", "yesterday", or a date. */
export function timeAgo(at: number, now = Date.now()): string {
  const s = Math.round((now - at) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return h === 1 ? "1 hour ago" : `${h} hours ago`;
  const d = Math.round(h / 24);
  if (d === 1) return "yesterday";
  if (d < 7) return `${d} days ago`;
  return new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short", year: d > 300 ? "numeric" : undefined });
}

/** What a field's input needs to be linked to its label, hint and error. */
export interface FieldInputProps {
  id: string;
  "aria-invalid"?: true;
  "aria-describedby"?: string;
}

/**
 * A labelled field. Its error line is always there, 20px tall, under the
 * input and its hint (.field__status, motion.css), so an error appearing never
 * moves the control below it; the message fades into the line and is linked
 * with aria-describedby after the hint (SYSTEM.md, Errors). `onLeave` runs
 * when focus leaves the field after the person has typed in it, which is when
 * it's checked. Submitting checks everything.
 */
export function Field({
  label,
  hint,
  error,
  id: given,
  onLeave,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  id?: string;
  onLeave?: () => void;
  children: (input: FieldInputProps) => ReactNode;
}) {
  const fallback = useId().replace(/[^a-zA-Z0-9]/g, "");
  const id = given ?? `f${fallback}`;
  const [edited, setEdited] = useState(false);
  const described = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(" ");
  return (
    <div
      className="field"
      onInput={() => setEdited(true)}
      onBlur={(e) => {
        if (onLeave && edited && !e.currentTarget.contains(e.relatedTarget as Node | null)) onLeave();
      }}
    >
      <label htmlFor={id}>{label}</label>
      {children({ id, ...(error ? { "aria-invalid": true as const } : {}), ...(described ? { "aria-describedby": described } : {}) })}
      {hint ? (
        <p className="field__hint" id={`${id}-hint`}>
          {hint}
        </p>
      ) : null}
      <FieldStatus id={`${id}-error`} error={error ?? null} />
    </div>
  );
}

/** The field's reserved error line: empty, or the icon and the sentence. */
export function FieldStatus({ id, error }: { id: string; error: string | null }) {
  return (
    <p className={`field__status${error ? " field-error" : ""}`} id={id}>
      {error && (
        <>
          <Icon name="alert" size={14} />
          <span>{error}</span>
        </>
      )}
    </p>
  );
}

/** A failed action: the plain message, and anything technical behind "Details". */
export interface ErrorInfo {
  message: string;
  detail?: string | undefined;
}

export function toErrorInfo(error: unknown): ErrorInfo {
  if (error instanceof Error) {
    const detail = (error as { detail?: unknown }).detail;
    return { message: error.message, ...(typeof detail === "string" && detail ? { detail } : {}) };
  }
  return { message: String(error) };
}

/**
 * Shown where the action was, until the person acts or tries again (SYSTEM.md,
 * Errors). If that place is scrolled out of view (a form longer than its
 * window), the page brings it into view, so a press never seems to do nothing.
 */
export function ActionError({ error, children }: { error: ErrorInfo | null; children?: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const message = error?.message;
  useEffect(() => {
    if (!message) return;
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    box.current?.scrollIntoView({ block: "nearest", behavior: still ? "auto" : "smooth" });
  }, [message]);
  if (!error) return null;
  return (
    <div ref={box} className="action-error arrive" role="alert">
      <p className="action-error__message">
        <Icon name="alert" size={16} />
        <span>{error.message}</span>
      </p>
      {children}
      {error.detail && <ErrorDetails>{error.detail}</ErrorDetails>}
    </div>
  );
}

export function ErrorDetails({ children }: { children: ReactNode }) {
  return (
    <details className="error-details">
      <summary>Details</summary>
      <div className="error-details__body">{children}</div>
    </details>
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

/**
 * Middle-truncates long identifiers, keeping 8 characters at each end
 * (SYSTEM.md, Type): 9f3a1c07…e41b22d8. Copying always copies the full value.
 */
export function shorten(value: string, head = 8, tail = 8): string {
  return value.length <= head + tail + 1 ? value : `${value.slice(0, head)}…${value.slice(-tail)}`;
}

/** A hex fingerprint as one run of lower-case hex, the form identifiers are shown and copied in. */
export function compactHex(value: string): string {
  return value.replace(/[^0-9a-fA-F]/g, "").toLowerCase();
}

export function initial(name: string): string {
  return name.trim().charAt(0) || "?";
}

/**
 * A centred mark with a title and a line or two of detail. The text area has a
 * fixed height, so the mark stays put when the text changes (working, then
 * done); the text fades in place. The title is the screen's h1, and focus
 * moves to it each time it changes, which is how the change is heard.
 */
export function StatusScreen({ mark, title, detail, children }: { mark: ReactNode; title: string; detail: ReactNode; children?: ReactNode }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useFocusOnArrival(heading, title);
  return (
    <main className={`status-screen ${detail === null ? "status-screen--report" : ""}`}>
      <div className="status-screen__mark">{mark}</div>
      <div className="status-screen__text">
        <h1 ref={heading} tabIndex={-1} key={title} className="status-screen__title arrive">
          {title}
        </h1>
        {detail !== null && (
          <div key={`${title}-detail`} className="status-screen__detail muted arrive">
            {detail}
          </div>
        )}
      </div>
      {children}
    </main>
  );
}
