/**
 * A small window for passkey prompts. The popup closes when the browser's
 * passkey dialog takes focus, so the popup sends passkey work here.
 */
import "reflect-metadata";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { browser } from "wxt/browser";
import "../../assets/app.css";
import { Field, Icon, Spinner, WeaveMark } from "../../components/ui";
import { addPasskey, unlockWithPasskey } from "../../lib/passkey";

const params = new URLSearchParams(location.search);
const action = params.get("action") === "add" ? "add" : "unlock";

function PasskeyWindow() {
  const [name, setName] = useState(params.get("name") ?? "");
  const [phase, setPhase] = useState<"ready" | "working" | "done">("ready");
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setPhase("working");
    setError(null);
    try {
      if (action === "add") await addPasskey(name.trim());
      else await unlockWithPasskey();
      setPhase("done");
      setTimeout(async () => {
        // Back to the popup where the user started, where the browser allows it.
        await browser.action.openPopup?.().catch(() => {});
        window.close();
      }, 900);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("ready");
    }
  };

  if (phase === "done") {
    return (
      <main className="status-screen fade-in" aria-live="polite">
        <WeaveMark size={64} mode="settle" />
        <div style={{ fontSize: 16, fontWeight: 600 }}>{action === "add" ? "Passkey added" : "Unlocked"}</div>
        <div className="muted" style={{ fontSize: 13 }}>
          This window closes on its own.
        </div>
      </main>
    );
  }

  return (
    <form
      style={{ display: "contents" }}
      onSubmit={(e) => {
        e.preventDefault();
        void start();
      }}
    >
      <main className="page fade-in">
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span className="lock-badge">
            <Icon name="key" size={18} />
          </span>
          <h1 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>
            {action === "add" ? "Add a passkey" : "Unlock with a passkey"}
          </h1>
        </div>
        <p className="muted" style={{ margin: 0, fontSize: 14 }}>
          {action === "add"
            ? "Your browser asks you to create a passkey for Weft, on this device, your phone or a security key. Your password keeps working too."
            : "Your browser asks for one of the passkeys you added to Weft."}
        </p>
        {action === "add" && (
          <Field label="Name" hint="So you can tell your passkeys apart, e.g. “Laptop” or “YubiKey”.">
            <input autoFocus value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
          </Field>
        )}
        {error && (
          <div className="error-text" role="alert">
            {error}
          </div>
        )}
      </main>
      <footer className="footer">
        <button type="button" className="btn" onClick={() => window.close()}>
          Cancel
        </button>
        <button type="submit" className="btn btn--primary" disabled={phase === "working"}>
          {phase === "working" ? (
            <>
              <Spinner small /> Waiting…
            </>
          ) : action === "add" ? (
            "Create passkey"
          ) : (
            "Use passkey"
          )}
        </button>
      </footer>
    </form>
  );
}

document.body.classList.add("window");
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PasskeyWindow />
  </StrictMode>,
);
