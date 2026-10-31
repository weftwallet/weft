/**
 * A small window for passkey prompts. The popup closes when the browser's
 * passkey dialog takes focus, so the popup sends passkey work here.
 */
import "reflect-metadata";
import { StrictMode, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { browser } from "wxt/browser";
import "../../assets/app.css";
import { FeedbackProvider } from "../../components/feedback";
import { useAction } from "../../components/popup/state";
import { ActionError, Brand, Button, Field, Icon, StatusScreen, WeaveMark, tokenMs, useFocusOnArrival } from "../../components/ui";
import { addPasskey, unlockWithPasskey } from "../../lib/passkey";

const params = new URLSearchParams(location.search);
const action = params.get("action") === "add" ? "add" : "unlock";

function PasskeyWindow() {
  const [name, setName] = useState(params.get("name") ?? "");
  const [done, setDone] = useState(false);
  const title = useRef<HTMLHeadingElement>(null);
  useFocusOnArrival(title);

  const start = useAction(async () => {
    if (action === "add") await addPasskey(name.trim());
    else await unlockWithPasskey();
    setDone(true);
    setTimeout(async () => {
      // Back to the popup where the user started, where the browser allows it.
      await browser.action.openPopup?.().catch(() => {});
      window.close();
    }, tokenMs("--weft-hold-after-done", 1400));
  });

  if (done) {
    return (
      <StatusScreen
        mark={<WeaveMark size={64} mode="still" />}
        title={action === "add" ? "Passkey added" : "Unlocked"}
        detail="This window closes on its own."
      />
    );
  }

  return (
    <form
      className="contents"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void start.run();
      }}
    >
      <header className="request-header">
        <Brand />
      </header>
      <main className="page fade-in">
        <div className="page-title">
          <span className="lock-badge">
            <Icon name="key" size={18} />
          </span>
          <h1 ref={title} tabIndex={-1}>
            {action === "add" ? "Add a passkey" : "Unlock with a passkey"}
          </h1>
        </div>
        <p className="muted flat">
          {action === "add"
            ? "Your browser asks you to create a passkey for Weft, on this device, your phone or a security key. Your password keeps working too."
            : "Your browser asks for one of the passkeys you added to Weft."}
        </p>
        {action === "add" && (
          <Field label="Name" hint="So you can tell your passkeys apart, for example “Laptop” or “YubiKey”. Up to 40 characters.">
            {(a) => <input {...a} value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />}
          </Field>
        )}
        <ActionError error={start.error} />
      </main>
      <footer className="footer">
        <button type="button" className="btn" onClick={() => window.close()}>
          Cancel
        </button>
        <Button type="submit" className="btn btn--primary" busy={start.busy}>
          {action === "add" ? "Create passkey" : "Use passkey"}
        </Button>
      </footer>
    </form>
  );
}

document.body.classList.add("window");
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <FeedbackProvider>
      <PasskeyWindow />
    </FeedbackProvider>
  </StrictMode>,
);
