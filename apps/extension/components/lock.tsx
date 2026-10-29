import { useEffect, useRef, useState, type ReactNode } from "react";
import { browser } from "wxt/browser";
import { ui } from "../lib/messages";
import { unlockWithPasskey } from "../lib/passkey";
import * as check from "../lib/validate";
import type { VaultStatus } from "../lib/vault";
import { useChecks } from "./form";
import { useAction } from "./popup/state";
import { ActionError, Button, Field, Icon, SecretInput, Spinner, WeaveMark, useFocusOnArrival } from "./ui";

/**
 * Sets the wallet password. Shown before the first key is saved, and to
 * wallets from before the lock.
 */
export function CreatePassword({
  heading = "Set a password",
  intro,
  onDone,
  onCancel,
  cancelLabel = "Cancel",
}: {
  heading?: string;
  intro: ReactNode;
  onDone: () => void;
  onCancel?: () => void;
  cancelLabel?: string;
}) {
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const checks = useChecks({
    password: () => check.newPassword(password),
    again: () => check.samePassword(again, password),
  });
  const setup = useAction(async () => {
    await ui("vaultSetup", { password });
    onDone();
  });
  const title = useRef<HTMLHeadingElement>(null);
  useFocusOnArrival(title);

  return (
    <form
      style={{ display: "contents" }}
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (checks.submit()) void setup.run();
      }}
    >
      <main className="page">
        <div className="page-title">
          <span className="lock-badge">
            <Icon name="lock" size={18} />
          </span>
          <h1 ref={title} tabIndex={-1}>
            {heading}
          </h1>
        </div>
        <div className="muted">{intro}</div>
        <Field label="Password" {...checks.field("password")}>
          {(a) => <SecretInput {...a} value={password} onChange={(e) => setPassword(e.target.value)} />}
        </Field>
        <Field label="Password again" {...checks.field("again")}>
          {(a) => <SecretInput {...a} value={again} onChange={(e) => setAgain(e.target.value)} />}
        </Field>
        <p className="subtle" style={{ margin: 0 }}>
          Weft can't reset this password. If you forget it, you enrol your identities again with your CA. You can add a
          passkey later to unlock without typing it.
        </p>
        <ActionError error={setup.error} />
      </main>
      <footer className={`footer ${onCancel ? "" : "footer--single"}`}>
        {onCancel && (
          <button type="button" className="btn" onClick={onCancel}>
            {cancelLabel}
          </button>
        )}
        <Button type="submit" className="btn btn--primary" busy={setup.busy}>
          Set password
        </Button>
      </footer>
    </form>
  );
}

/**
 * The lock screen. `passkey` decides how the passkey button works: "inline"
 * runs WebAuthn here (windows), "window" opens the passkey window (the popup,
 * which would close when the passkey dialog takes focus).
 */
export function Unlock({
  status,
  passkey,
  subtitle = "Unlock to continue.",
  onUnlocked,
  onCancel,
  cancelLabel = "Cancel",
  onReset,
}: {
  status: VaultStatus;
  passkey: "inline" | "window";
  subtitle?: string;
  onUnlocked: () => void;
  onCancel?: () => void;
  cancelLabel?: string;
  /** Offers "Forgot your password?", which leads to resetting Weft. The popup passes it. */
  onReset?: () => void;
}) {
  const [password, setPassword] = useState("");
  // A wrong password is the password field's error; it clears once it's changed.
  const [wrong, setWrong] = useState<{ password: string; message: string } | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [resetting, setResetting] = useState(false);
  const checks = useChecks({ password: () => check.required(password, "Enter your password.") });
  const passwordId = checks.field("password").id;
  const unlock = useAction(async () => {
    try {
      await ui("vaultUnlock", { password });
    } catch (error) {
      setWrong({ password, message: error instanceof Error ? error.message : String(error) });
      const input = document.getElementById(passwordId) as HTMLInputElement | null;
      input?.focus();
      input?.select();
      return;
    }
    onUnlocked();
  });
  const withPasskey = useAction(async () => {
    if (passkey === "window") {
      await openPasskeyWindow("unlock");
      window.close();
      return;
    }
    await unlockWithPasskey();
    onUnlocked();
  });
  const hasPasskey = status.passkeys.length > 0;
  const busy = unlock.busy || withPasskey.busy;
  // The one thing to do here is type the password, so focus goes straight to
  // it rather than to the heading (SYSTEM.md, Navigation).
  useEffect(() => {
    if (resetting) return;
    const input = document.getElementById(passwordId);
    if (input && !input.closest("[hidden]")) input.focus({ preventScroll: true });
  }, [resetting, passwordId]);

  if (resetting && onReset) return <ResetWeft onCancel={() => setResetting(false)} onDone={onReset} />;

  const field = checks.field("password");
  const fieldError = field.error ?? (wrong && wrong.password === password ? wrong.message : null);

  return (
    <form
      style={{ display: "contents" }}
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (!checks.submit()) return;
        setAttempted(true);
        void unlock.run();
      }}
    >
      <main className="page lock-screen">
        <div className="lock-screen__mark">
          {/* The mark weaves in once when the screen opens; the loader turns while checking.
              After a wrong password it stays still: weaving in again would look like success. */}
          {busy ? <Spinner size={56} /> : <WeaveMark size={56} mode={attempted ? "still" : "settle"} />}
        </div>
        <div style={{ textAlign: "center" }}>
          <h1 className="lock-screen__title">
            Weft is locked
          </h1>
          <p className="muted" style={{ margin: "6px 0 0" }}>
            {subtitle}
          </p>
        </div>
        <Field label="Password" {...field} error={fieldError}>
          {(a) => (
            <SecretInput {...a} value={password} onChange={(e) => setPassword(e.target.value)} />
          )}
        </Field>
        <Button type="submit" className="btn btn--primary" busy={unlock.busy} aria-disabled={withPasskey.busy || undefined}>
          Unlock
        </Button>
        {hasPasskey && (
          <>
            <Button icon="key" iconSize={16} busy={withPasskey.busy} aria-disabled={unlock.busy || undefined} onClick={() => void withPasskey.run()}>
              Use a passkey
            </Button>
            <ActionError error={withPasskey.error} />
          </>
        )}
        {onReset && (
          <button type="button" className="link-btn link-btn--inline" style={{ alignSelf: "center" }} onClick={() => setResetting(true)}>
            Forgot your password?
          </button>
        )}
        {onCancel && (
          <button type="button" className="link-btn link-btn--inline" style={{ alignSelf: "center" }} onClick={onCancel}>
            {cancelLabel}
          </button>
        )}
      </main>
    </form>
  );
}

const RESET_PHRASE = "reset weft";

/**
 * The way out of a forgotten password. Weft can't recover it, so this deletes
 * every key and starts again. Typing the phrase makes sure it's meant.
 */
function ResetWeft({ onCancel, onDone }: { onCancel: () => void; onDone: () => void }) {
  const [typed, setTyped] = useState("");
  const reset = useAction(async () => {
    await ui("vaultReset");
    onDone();
  });
  const ready = typed.trim().toLowerCase() === RESET_PHRASE;
  const title = useRef<HTMLHeadingElement>(null);
  useFocusOnArrival(title);
  return (
    <form
      style={{ display: "contents" }}
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) void reset.run();
      }}
    >
      <main className="page">
        <div className="page-title">
          <span className="lock-badge lock-badge--danger">
            <Icon name="alert" size={18} />
          </span>
          <h1 ref={title} tabIndex={-1}>
            Reset Weft?
          </h1>
        </div>
        <p className="muted" style={{ margin: 0 }}>
          Weft can't recover a forgotten password, because it never stores it. Resetting deletes every identity and private
          key in this browser, your activity and your site connections.
        </p>
        <div className="notice notice--signal">
          <Icon name="alert" size={18} color="var(--weft-danger-text)" />
          <span>
            This can't be undone. Your certificates stay valid on the network, and your networks are kept, so you can enrol
            again with your CA's enrolment ID and secret.
          </span>
        </div>
        <Field label={`Type “${RESET_PHRASE}” to confirm`} hint="Reset Weft stays off until the phrase matches.">
          {(a) => <input {...a} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />}
        </Field>
        <ActionError error={reset.error} />
      </main>
      <footer className="footer">
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <Button type="submit" className="btn btn--danger" busy={reset.busy} disabled={!ready}>
          Reset Weft
        </Button>
      </footer>
    </form>
  );
}

/** Opens passkey.html, where WebAuthn can show its dialog without closing anything. */
export async function openPasskeyWindow(action: "unlock" | "add", name?: string): Promise<void> {
  const query = new URLSearchParams({ action, ...(name ? { name } : {}) });
  await browser.windows.create({
    url: browser.runtime.getURL(`/passkey.html?${query}`),
    type: "popup",
    width: 380,
    height: 520,
    focused: true,
  });
}
