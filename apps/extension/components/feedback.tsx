/**
 * Confirmation sheets and toasts for the popup and approval window.
 * Destructive actions go through confirm(): a bottom sheet that says what will
 * happen, with Cancel focused so Enter never deletes anything by accident.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Icon, type IconName } from "./ui";

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
  toast: (message: string) => void;
}

const FeedbackContext = createContext<Feedback>({
  confirm: async () => false,
  toast: () => {},
});

export const useFeedback = () => useContext(FeedbackContext);

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<(ConfirmOptions & { resolve: (ok: boolean) => void }) | null>(null);
  const [toastText, setToastText] = useState<{ text: string; key: number } | null>(null);

  const confirm = useCallback(
    (options: ConfirmOptions) => new Promise<boolean>((resolve) => setPending({ ...options, resolve })),
    [],
  );
  const toast = useCallback((text: string) => setToastText({ text, key: Date.now() }), []);

  useEffect(() => {
    if (!toastText) return;
    const t = setTimeout(() => setToastText(null), 1600);
    return () => clearTimeout(t);
  }, [toastText]);

  const [closing, setClosing] = useState(false);
  const close = (ok: boolean) => {
    if (closing) return;
    pending?.resolve(ok);
    // Let the sheet slide away before unmounting it.
    setClosing(true);
    setTimeout(
      () => {
        setPending(null);
        setClosing(false);
      },
      window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 160,
    );
  };

  return (
    <FeedbackContext.Provider value={{ confirm, toast }}>
      {children}
      {pending && <ConfirmSheet options={pending} onClose={close} closing={closing} />}
      {toastText && (
        <div key={toastText.key} className="toast" role="status">
          <Icon name="check" size={16} />
          {toastText.text}
        </div>
      )}
    </FeedbackContext.Provider>
  );
}

function ConfirmSheet({
  options,
  onClose,
  closing,
}: {
  options: ConfirmOptions;
  onClose: (ok: boolean) => void;
  closing: boolean;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  const sheet = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    // preventScroll: the sheet starts below the fold while it slides in, and a
    // plain focus() would scroll the whole popup to reach the button.
    cancel.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose(false);
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
      previous?.focus?.({ preventScroll: true });
    };
  }, [onClose]);

  return (
    <div className={`sheet-backdrop ${closing ? "is-closing" : ""}`} onMouseDown={(e) => e.target === e.currentTarget && onClose(false)}>
      <div ref={sheet} className="sheet" role="alertdialog" aria-modal="true" aria-labelledby="sheet-title" aria-describedby="sheet-body">
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

/** A copy button that confirms with a check and a toast. */
export function CopyButton({ text, label, size = 16 }: { text: string; label: string; size?: number }) {
  const { toast } = useFeedback();
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
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          toast("Copied");
        });
      }}
    >
      <Icon name={copied ? "check" : "copy"} size={size} color={copied ? "var(--weft-thread)" : "currentColor"} />
    </button>
  );
}

