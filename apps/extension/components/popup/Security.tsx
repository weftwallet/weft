import { useState } from "react";
import { ui, type WalletState } from "../../lib/messages";
import { AUTO_LOCK_CHOICES } from "../../lib/vault";
import { useFeedback } from "../feedback";
import { openPasskeyWindow } from "../lock";
import { BackHeader, Field, Icon, SecretInput, Spinner, timeAgo } from "../ui";
import { useAction, type Navigate } from "./state";

function lockLabel(minutes: number): string {
  if (minutes === 0) return "Only when the browser closes";
  if (minutes < 60) return `After ${minutes} minutes`;
  return minutes === 60 ? "After 1 hour" : `After ${minutes / 60} hours`;
}

/** Lock now, auto-lock, passkeys and the password (docs/adr/0005). */
export function Security({
  state,
  onState,
  navigate,
}: {
  state: WalletState;
  onState: (s: WalletState) => void;
  navigate: Navigate;
}) {
  const { confirm, toast } = useFeedback();
  const vault = state.vault;
  const refresh = async () => onState(await ui("state"));
  const legacy = state.identities.filter((i) => i.legacyKey).length;

  const lock = useAction(async () => {
    await ui("vaultLock");
    await refresh();
  });
  const autoLock = useAction(async (minutes: number) => {
    await ui("setAutoLock", { minutes });
    await refresh();
    toast("Auto-lock updated");
  });

  const removePasskey = async (id: string, name: string) => {
    const ok = await confirm({
      title: `Remove ${name}?`,
      body: "Weft stops accepting this passkey. Your password and any other passkeys keep working. The passkey itself stays on your device until you delete it there.",
      confirmLabel: "Remove",
      icon: "key",
    });
    if (!ok) return;
    await ui("passkeyRemove", { credentialId: id });
    await refresh();
    toast(`Removed ${name}`);
  };

  return (
    <>
      <BackHeader title="Security" onBack={() => navigate({ name: "home" })} />
      <main className="page" style={{ gap: 20 }}>
        <section className="card" style={{ gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span className="lock-badge">
              <Icon name="lock" size={18} />
            </span>
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <span style={{ fontWeight: 500 }}>Unlocked</span>
              <span className="muted" style={{ fontSize: 13 }}>
                Signing needs your password or a passkey after Weft locks.
              </span>
            </div>
          </div>
          <button type="button" className="btn" disabled={lock.busy} onClick={() => void lock.run()}>
            Lock now
          </button>
        </section>

        <Field label="Lock automatically" hint="Counted from the last time you used Weft. Closing the browser always locks it.">
          <select
            value={vault.autoLockMinutes}
            disabled={autoLock.busy}
            onChange={(e) => void autoLock.run(Number(e.target.value))}
          >
            {AUTO_LOCK_CHOICES.map((m) => (
              <option key={m} value={m}>
                {lockLabel(m)}
              </option>
            ))}
          </select>
        </Field>
        {autoLock.error && <div className="error-text">{autoLock.error}</div>}

        <section style={{ display: "flex", flexDirection: "column", gap: 8 }} aria-label="Passkeys">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span className="eyebrow">Passkeys</span>
            <button type="button" className="header-action" onClick={() => void openPasskeyWindow("add")}>
              <Icon name="plus" size={16} /> Add
            </button>
          </div>
          {vault.passkeys.length === 0 ? (
            <p className="subtle" style={{ fontSize: 13, margin: 0 }}>
              Unlock with a fingerprint, face or security key instead of typing your password. The passkey needs to support
              the PRF extension. Weft checks when you add it.
            </p>
          ) : (
            <div className="list">
              {vault.passkeys.map((p) => (
                <div key={p.id} className="list-item">
                  <Icon name="key" size={18} color="var(--weft-thread)" />
                  <span className="list-item__body">
                    <span className="list-item__title">{p.name}</span>
                    <span className="subtle" style={{ fontSize: 12 }}>
                      Added {timeAgo(p.createdAt)}
                    </span>
                  </span>
                  <button
                    type="button"
                    className="icon-btn icon-btn--danger"
                    aria-label={`Remove ${p.name}`}
                    title={`Remove ${p.name}`}
                    onClick={() => void removePasskey(p.id, p.name)}
                  >
                    <Icon name="trash" size={18} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        <ChangePassword onDone={() => toast("Password changed")} />

        {legacy > 0 && (
          <div className="notice notice--amber" style={{ fontSize: 13 }}>
            <Icon name="alert" size={18} color="var(--weft-amber)" />
            <span>
              {legacy === 1 ? "One identity was" : `${legacy} identities were`} saved before Weft encrypted keys, so{" "}
              {legacy === 1 ? "its key isn't" : "their keys aren't"} encrypted on disk. Re-enrol from the identity card to
              fix it.
            </span>
          </div>
        )}
      </main>
    </>
  );
}

function ChangePassword({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const change = useAction(async () => {
    if (next !== again) throw new Error("The new passwords don't match.");
    await ui("changePassword", { current, next });
    setOpen(false);
    setCurrent("");
    setNext("");
    setAgain("");
    onDone();
  });

  if (!open) {
    return (
      <button type="button" className="btn" onClick={() => setOpen(true)}>
        Change password
      </button>
    );
  }
  return (
    <form
      className="card fade-in"
      style={{ gap: 12 }}
      onSubmit={(e) => {
        e.preventDefault();
        void change.run();
      }}
    >
      <span className="eyebrow">Change password</span>
      <Field label="Current password">
        <SecretInput required autoFocus value={current} onChange={(e) => setCurrent(e.target.value)} aria-label="Current password" />
      </Field>
      <Field label="New password">
        <SecretInput required value={next} onChange={(e) => setNext(e.target.value)} aria-label="New password" />
      </Field>
      <Field label="New password again">
        <SecretInput required value={again} onChange={(e) => setAgain(e.target.value)} aria-label="New password again" />
      </Field>
      {change.error && (
        <div className="error-text" role="alert">
          {change.error}
        </div>
      )}
      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" className="btn" style={{ flex: 1 }} onClick={() => setOpen(false)}>
          Cancel
        </button>
        <button type="submit" className="btn btn--primary" style={{ flex: 1 }} disabled={change.busy}>
          {change.busy ? <Spinner small /> : "Change"}
        </button>
      </div>
    </form>
  );
}
