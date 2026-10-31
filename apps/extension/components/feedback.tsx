/**
 * Confirmation sheets, toasts and the page's live region, for the popup and
 * the extension's windows.
 * Destructive actions go through confirm(): a bottom sheet that says what will
 * happen, with Cancel focused so Enter never deletes anything by accident.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Icon, tokenMs, type IconName } from "./ui";

export interface ConfirmOptions {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  icon?: IconName;
  /** "danger" (default) for things that can't be undone; "caution" for changes worth a second look. */
  tone?: "danger" | "caution";
}

interface Feedback {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  /** A short note at the bottom of the screen, also read out. `tone: "error"` for something that didn't work. */
  toast: (message: string, tone?: "done" | "error") => void;
  /** Read out through the page's one polite live region, without showing anything. */
  announce: (message: string) => void;
}

const FeedbackContext = createContext<Feedback>({
  confirm: async () => false,
  toast: () => {},
  announce: () => {},
});

export const useFeedback = () => useContext(FeedbackContext);

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Long enough to read: about 60ms a character, between 2.4 and 6 seconds. */
const toastTime = (text: string) => Math.min(6000, Math.max(2400, text.length * 60));

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<(ConfirmOptions & { resolve: (ok: boolean) => void }) | null>(null);
  const [toastState, setToastState] = useState<{ text: string; tone: "done" | "error"; key: number; leaving: boolean } | null>(null);
  // A toast is a .reversible: its first frame comes from @starting-style, and
  // it is unmounted once its leave has ended.
  const [live, setLive] = useState("");

  const announce = useCallback((text: string) => {
    // Cleared first, so the same words twice are still read twice.
    setLive("");
    setTimeout(() => setLive(text), 60);
  }, []);

  const confirm = useCallback(
    (options: ConfirmOptions) => new Promise<boolean>((resolve) => setPending({ ...options, resolve })),
    [],
  );
  const toast = useCallback(
    (text: string, tone: "done" | "error" = "done") => {
      setToastState({ text, tone, key: Date.now(), leaving: false });
      announce(text);
    },
    [announce],
  );

  useEffect(() => {
    if (!toastState || toastState.leaving) return;
    const t = setTimeout(() => setToastState((s) => (s && s.key === toastState.key ? { ...s, leaving: true } : s)), toastTime(toastState.text));
    return () => clearTimeout(t);
  }, [toastState]);
  // Gone once the leave has had its time, whether or not a transition ran.
  useEffect(() => {
    if (!toastState?.leaving) return;
    const t = setTimeout(() => setToastState((s) => (s && s.key === toastState.key ? null : s)), tokenMs("--weft-duration-base-out", 154) + 50);
    return () => clearTimeout(t);
  }, [toastState]);

  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const close = useCallback((ok: boolean) => {
    if (closingRef.current) return;
    closingRef.current = true;
    pendingRef.current?.resolve(ok);
    setClosing(true);
  }, []);
  // The sheet leaves the way it came (a .reversible, so from wherever it is),
  // then unmounts.
  const closed = useCallback(() => {
    closingRef.current = false;
    setPending(null);
    setClosing(false);
  }, []);

  return (
    <FeedbackContext.Provider value={{ confirm, toast, announce }}>
      {children}
      {pending && <ConfirmSheet options={pending} onClose={close} closing={closing} onClosed={closed} />}
      {toastState && (
        <div
          key={toastState.key}
          className={`toast reversible ${toastState.tone === "error" ? "toast--error" : ""} ${toastState.leaving ? "" : "is-open"}`}
          aria-hidden="true"
        >
          <Icon name={toastState.tone === "error" ? "alert" : "check"} size={16} />
          {toastState.text}
        </div>
      )}
      <div className="visually-hidden" role="status" aria-live="polite">
        {live}
      </div>
    </FeedbackContext.Provider>
  );
}

function ConfirmSheet({
  options,
  onClose,
  closing,
  onClosed,
}: {
  options: ConfirmOptions;
  onClose: (ok: boolean) => void;
  closing: boolean;
  onClosed: () => void;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  const sheet = useRef<HTMLDivElement>(null);

  // onClose is stable, so this runs once: focus isn't moved again on later renders.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    // preventScroll: the sheet starts below the fold while it slides in, and a
    // plain focus() would scroll the whole popup to reach the button.
    cancel.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose(false);
      }
      // Keep Tab inside the sheet.
      if (e.key === "Tab" && sheet.current) {
        const buttons = Array.from(sheet.current.querySelectorAll<HTMLButtonElement>("button"));
        const first = buttons[0];
        const last = buttons[buttons.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      // Back to what opened it, if it's still there. A removed row's caller moves focus itself.
      if (previous?.isConnected && !document.activeElement?.closest(".screen")) previous.focus({ preventScroll: true });
    };
  }, [onClose]);

  // Unmounted once the leave has had its time (slow-out), or at once with reduced motion.
  useEffect(() => {
    if (!closing) return;
    const t = setTimeout(onClosed, reducedMotion() ? 0 : tokenMs("--weft-duration-slow-out", 252) + 50);
    return () => clearTimeout(t);
  }, [closing, onClosed]);

  const shown = !closing;
  return (
    <div className={`sheet-backdrop ${shown ? "is-open" : ""}`} onMouseDown={(e) => e.target === e.currentTarget && onClose(false)}>
      <div
        ref={sheet}
        className={`sheet reversible reversible--far ${shown ? "is-open" : ""}`}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="sheet-title"
        aria-describedby="sheet-body"
      >
        <span className={`sheet__icon ${options.tone === "caution" ? "sheet__icon--caution" : ""}`}>
          <Icon name={options.icon ?? "alert"} size={20} />
        </span>
        <h2 id="sheet-title" className="sheet__title">
          {options.title}
        </h2>
        <div id="sheet-body" className="sheet__body">
          {options.body}
        </div>
        <div className="sheet__actions">
          <button ref={cancel} type="button" className="btn" onClick={() => onClose(false)}>
            Cancel
          </button>
          <button
            type="button"
            className={`btn ${options.tone === "caution" ? "btn--amber" : "btn--danger"}`}
            onClick={() => onClose(true)}
          >
            {options.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Wraps "back" for forms: if the user typed something, ask before throwing
 * it away.
 */
export function useLeaveGuard(dirty: boolean, leave: () => void) {
  const { confirm } = useFeedback();
  return async () => {
    if (
      !dirty ||
      (await confirm({
        title: "Discard what you entered?",
        body: "You'll lose the details on this screen.",
        confirmLabel: "Discard",
        icon: "trash",
      }))
    ) {
      leave();
    }
  };
}

/** Copies text, confirming with a toast; says so if the browser refuses. */
export function useCopy() {
  const { toast } = useFeedback();
  return (text: string, done = "Copied") =>
    navigator.clipboard.writeText(text).then(
      () => {
        toast(done);
        return true;
      },
      () => {
        toast("Couldn't copy. Select the text and copy it instead.", "error");
        return false;
      },
    );
}

/** A copy button that confirms with a check and a toast. */
export function CopyButton({ text, label, size = 16 }: { text: string; label: string; size?: number }) {
  const copy = useCopy();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button
      type="button"
      className="icon-btn icon-btn--sm"
      aria-label={label}
      title={label}
      onClick={() => void copy(text).then((ok) => ok && setCopied(true))}
    >
      <span key={String(copied)} className="icon-swap">
        <Icon name={copied ? "check" : "copy"} size={size} color={copied ? "var(--weft-accent-text)" : "currentColor"} />
      </span>
    </button>
  );
}
