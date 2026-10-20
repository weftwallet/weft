import { useState, type ReactNode } from "react";
import { browser } from "wxt/browser";
import { ui } from "../lib/messages";
import { unlockWithPasskey } from "../lib/passkey";
import type { VaultStatus } from "../lib/vault";
import { Field, Icon, SecretInput, Spinner, WeaveMark } from "./ui";

const MIN = 8;

function useBusy() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (task: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await task();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, setError, run };
}

/**
 * Sets the wallet password. Shown before the first key is saved, and to
 * wallets from before the lock.
 */
export function CreatePassword({
  heading = "Set a password",
  intro,
  onDone,
  onCancel,
}: {
  heading?: string;
  intro: ReactNode;
  onDone: () => void;
  onCancel?: () => void;
}) {
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const { busy, error, setError, run } = useBusy();
  const short = password.length > 0 && password.length < MIN;
  const mismatch = again.length > 0 && again !== password;

  return (
    <form
      style={{ display: "contents" }}
      onSubmit={(e) => {
        e.preventDefault();
        if (password.length < MIN) return setError(`Use at least ${MIN} characters.`);
        if (password !== again) return setError("The passwords don't match.");
        void run(async () => {
          await ui("vaultSetup", { password });
          onDone();
        });
      }}
    >
      <main className="page">
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span className="lock-badge">
            <Icon name="lock" size={18} />
          </span>
          <h1 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>{heading}</h1>
        </div>
        <div className="muted" style={{ fontSize: 14 }}>
          {intro}
        </div>
        <Field label="Password" hint={short ? `At least ${MIN} characters.` : undefined}>
          <SecretInput required autoFocus value={password} onChange={(e) => setPassword(e.target.value)} aria-label="Password" />
        </Field>
        <Field label="Password again" hint={mismatch ? "Doesn't match yet." : undefined}>
          <SecretInput required value={again} onChange={(e) => setAgain(e.target.value)} aria-label="Password again" />
        </Field>
        <p className="subtle" style={{ fontSize: 13, margin: 0 }}>
          Weft can't reset this password. If you forget it, you enrol your identities again with your CA. You can add a
          passkey later to unlock without typing it.
        </p>
        {error && (
          <div className="error-text" role="alert">
            {error}
          </div>
        )}
      </main>
      <footer className={`footer ${onCancel ? "" : "footer--single"}`}>
        {onCancel && (
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button type="submit" className="btn btn--primary" disabled={busy}>
          {busy ? (
            <>
              <Spinner small /> Setting…
            </>
          ) : (
            "Set password"
          )}
        </button>
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
  onReset,
}: {
  status: VaultStatus;
  passkey: "inline" | "window";
  subtitle?: string;
  onUnlocked: () => void;
  onCancel?: () => void;
  /** Offers "Forgot your password?", which leads to resetting Weft. The popup passes it. */
  onReset?: () => void;
}) {
  const [password, setPassword] = useState("");
  const { busy, error, run } = useBusy();
  const [attempted, setAttempted] = useState(false);
  const [resetting, setResetting] = useState(false);
  const hasPasskey = status.passkeys.length > 0;
  // The mark weaves in once when the screen opens and loops while checking.
  // After a wrong password it stays still: weaving in again would look like success.
  const markMode = busy ? "loop" : attempted ? "still" : "settle";

  if (resetting && onReset) return <ResetWeft onCancel={() => setResetting(false)} onDone={onReset} />;

  const withPasskey = () =>
    run(async () => {
      if (passkey === "window") {
        await openPasskeyWindow("unlock");
        window.close();
        return;
      }
      await unlockWithPasskey();
      onUnlocked();
    });

  return (
    <form
      style={{ display: "contents" }}
      onSubmit={(e) => {
        e.preventDefault();
        setAttempted(true);
        void run(async () => {
          await ui("vaultUnlock", { password });
          onUnlocked();
        });
      }}
    >
      <main className="page lock-screen">
        <div className="lock-screen__mark">
          <WeaveMark size={56} mode={markMode} />
        </div>
        <div style={{ textAlign: "center" }}>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>Weft is locked</h1>
          <p className="muted" style={{ margin: "6px 0 0", fontSize: 14 }}>
            {subtitle}
          </p>
        </div>
        <Field label="Password">
          <SecretInput required autoFocus value={password} onChange={(e) => setPassword(e.target.value)} aria-label="Password" />
        </Field>
        {error && (
          <div className="error-text" role="alert">
            {error}
          </div>
        )}
        <button type="submit" className="btn btn--primary" disabled={busy || !password}>
          {busy && password ? (
            <>
              <Spinner small /> Unlocking…
            </>
          ) : (
            "Unlock"
          )}
        </button>
        {hasPasskey && (
          <button type="button" className="btn" disabled={busy} onClick={() => void withPasskey()}>
            <Icon name="key" size={16} /> Use a passkey
          </button>
        )}
        {onReset && (
          <button type="button" className="link-btn" style={{ alignSelf: "center" }} onClick={() => setResetting(true)}>
            Forgot your password?
          </button>
        )}
        {onCancel && (
          <button type="button" className="link-btn" style={{ alignSelf: "center" }} onClick={onCancel}>
            Cancel
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
  const { busy, error, run } = useBusy();
  const ready = typed.trim().toLowerCase() === RESET_PHRASE;
  return (
    <form
      style={{ display: "contents" }}
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready) return;
        void run(async () => {
          await ui("vaultReset");
          onDone();
        });
      }}
    >
      <main className="page">
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span className="lock-badge lock-badge--danger">
            <Icon name="alert" size={18} />
          </span>
          <h1 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>Reset Weft?</h1>
        </div>
        <p className="muted" style={{ margin: 0, fontSize: 14 }}>
          Weft can't recover a forgotten password, because it never stores it. Resetting deletes every identity and private
          key in this browser, your activity and your site connections.
        </p>
        <div className="notice notice--signal" style={{ fontSize: 13 }}>
          <Icon name="alert" size={18} color="var(--weft-signal)" />
          <span>
            This can't be undone. Your certificates stay valid on the network, and your networks are kept, so you can enrol
            again with your CA's enrollment ID and secret.
          </span>
        </div>
        <Field label={`Type “${RESET_PHRASE}” to confirm`}>
          <input
            autoFocus
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            aria-label="Confirmation"
          />
        </Field>
        {error && (
          <div className="error-text" role="alert">
            {error}
          </div>
        )}
      </main>
      <footer className="footer">
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn btn--danger" disabled={!ready || busy}>
          {busy ? <Spinner small /> : "Reset Weft"}
        </button>
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
