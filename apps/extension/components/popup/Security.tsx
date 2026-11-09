import { useRef, useState } from "react";
import { ui, type WalletState } from "../../lib/messages";
import * as check from "../../lib/validate";
import { AUTO_LOCK_CHOICES } from "../../lib/vault";
import { useFeedback } from "../feedback";
import { useChecks } from "../form";
import { openPasskeyWindow } from "../lock";
import { ActionError, BackHeader, Button, Field, Icon, SecretInput, Select, timeAgo, toErrorInfo, tokenMs } from "../ui";
import { BuildDetails } from "./BuildInfo";
import { focusTargetAfter, useLeaving } from "./lists";
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
  const leaving = useLeaving();

  const lock = useAction(async () => {
    await ui("vaultLock");
    await refresh();
  });
  const autoLock = useAction(async (minutes: number) => {
    await ui("setAutoLock", { minutes });
    await refresh();
    toast(`Weft now locks ${lockLabel(minutes).toLowerCase()}`);
  });
  const addPasskey = useAction(() => openPasskeyWindow("add"));

  const removePasskey = async (id: string, name: string, row: Element | null) => {
    const ok = await confirm({
      title: `Remove ${name}?`,
      body: "Weft stops accepting this passkey. Your password and any other passkeys keep working. The passkey itself stays on your device until you delete it there.",
      confirmLabel: "Remove",
      icon: "key",
    });
    if (!ok) return;
    const refocus = focusTargetAfter(row, () => document.getElementById("passkeys-heading"));
    await leaving.leave(id);
    try {
      await ui("passkeyRemove", { credentialId: id });
      await refresh();
      toast(`Removed ${name}`);
      refocus();
    } catch (error) {
      leaving.stay(id);
      toast(`Couldn't remove ${name}. ${toErrorInfo(error).message}`, "error");
    }
  };

  return (
    <>
      <BackHeader title="Security" onBack={() => navigate({ name: "home" })} />
      <main className="page stack--loose">
        <section className="card">
          <div className="inline">
            <span className="lock-badge">
              <Icon name="lock" size={18} />
            </span>
            <div className="stack stack--tight">
              <span className="strong">Unlocked</span>
              <span className="muted">Signing needs your password or a passkey after Weft locks.</span>
            </div>
          </div>
          <Button icon="lock" iconSize={16} busy={lock.busy} onClick={() => void lock.run()}>
            Lock now
          </Button>
          <ActionError error={lock.error} />
        </section>

        <Field label="Lock automatically" hint="The time counts from when you last used Weft. Closing the browser always locks it.">
          {(a) => (
            <Select
              {...a}
              value={vault.autoLockMinutes}
              aria-busy={autoLock.busy || undefined}
              onChange={(e) => void autoLock.run(Number(e.target.value))}
            >
              {AUTO_LOCK_CHOICES.map((m) => (
                <option key={m} value={m}>
                  {lockLabel(m)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <ActionError error={autoLock.error} />

        <section className="stack" aria-labelledby="passkeys-heading">
          <div className="row-between">
            <h2 id="passkeys-heading" className="eyebrow" tabIndex={-1}>
              Passkeys
            </h2>
            <Button className="header-action" icon="plus" iconSize={16} busy={addPasskey.busy} onClick={() => void addPasskey.run()}>
              Add passkey
            </Button>
          </div>
          <ActionError error={addPasskey.error} />
          {vault.passkeys.length === 0 ? (
            <p className="subtle flat">
              Unlock with a fingerprint, face or security key instead of typing your password. The passkey needs to support
              the PRF extension. Weft checks when you add it.
            </p>
          ) : (
            <div className="list stagger">
              {vault.passkeys.map((p) => (
                <div key={p.id} className={`list-row ${leaving.isLeaving(p.id) ? "is-leaving" : ""}`}>
                  <Icon name="key" size={18} color="var(--weft-accent-text)" />
                  <span className="list-item__body">
                    <span className="list-item__title">{p.name}</span>
                    <span className="subtle type-xs">Added {timeAgo(p.createdAt)}</span>
                  </span>
                  <button
                    type="button"
                    className="icon-btn icon-btn--danger"
                    aria-label={`Remove ${p.name}`}
                    title={`Remove ${p.name}`}
                    onClick={(e) => void removePasskey(p.id, p.name, e.currentTarget.closest(".list-row"))}
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
          <div className="notice notice--amber">
            <Icon name="alert" size={18} color="var(--weft-warn-text)" />
            <span>
              {legacy === 1 ? "One identity was" : `${legacy} identities were`} saved before Weft encrypted keys, so{" "}
              {legacy === 1 ? "its key isn't" : "their keys aren't"} encrypted on disk. Re-enrol from the identity card to
              fix it.
            </span>
          </div>
        )}

        <BuildDetails />
      </main>
    </>
  );
}

function ChangePassword({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false);
  // Mounted from opening until its leave has ended.
  const [mounted, setMounted] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const opener = useRef<HTMLButtonElement>(null);
  const checks = useChecks({
    current: () => check.required(current, "Enter your current password."),
    next: () => check.newPassword(next),
    again: () => check.samePassword(again, next),
  });
  // The worker's answer about the current password belongs to that field.
  const [wrong, setWrong] = useState<{ current: string; message: string } | null>(null);

  // The panel is a .reversible (motion.css): it leaves from wherever it is.
  // Once it has gone, the fields are cleared and focus goes back to the button
  // that opened it.
  const close = () => {
    setOpen(false);
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    setTimeout(
      () => {
        setMounted(false);
        setCurrent("");
        setNext("");
        setAgain("");
        setWrong(null);
        change.setError(null);
        opener.current?.focus();
      },
      reduced ? 0 : tokenMs("--weft-duration-base-out", 154),
    );
  };
  const first = useRef<HTMLInputElement>(null);
  const openPanel = () => {
    setMounted(true);
    setOpen(true);
    requestAnimationFrame(() => first.current?.focus());
  };

  const change = useAction(async () => {
    try {
      await ui("changePassword", { current, next });
    } catch (error) {
      const info = toErrorInfo(error);
      if (/password/i.test(info.message) && /right|wrong/i.test(info.message)) {
        setWrong({ current, message: info.message });
        document.getElementById(checks.field("current").id)?.focus();
        return;
      }
      throw error;
    }
    onDone();
    close();
  });

  const currentField = checks.field("current");
  return (
    <>
      {!mounted && (
        <button ref={opener} type="button" className="btn" aria-expanded={false} aria-controls="change-password" onClick={openPanel}>
          Change password
        </button>
      )}
      {mounted && (
      <form
        id="change-password"
        className={`card panel reversible reversible--down ${open ? "is-open" : ""}`}
        noValidate
        aria-labelledby="change-password-heading"
        onSubmit={(e) => {
          e.preventDefault();
          if (checks.submit()) void change.run();
        }}
      >
      <h2 id="change-password-heading" className="eyebrow">
        Change password
      </h2>
      <Field
        label="Current password"
        {...currentField}
        error={currentField.error ?? (wrong && wrong.current === current ? wrong.message : null)}
      >
        {(a) => <SecretInput {...a} ref={first} value={current} onChange={(e) => setCurrent(e.target.value)} />}
      </Field>
      <Field label="New password" {...checks.field("next")}>
        {(a) => <SecretInput {...a} value={next} onChange={(e) => setNext(e.target.value)} />}
      </Field>
      <Field label="New password again" {...checks.field("again")}>
        {(a) => <SecretInput {...a} value={again} onChange={(e) => setAgain(e.target.value)} />}
      </Field>
      <ActionError error={change.error} />
      <div className="sheet__actions">
        <button type="button" className="btn" onClick={close}>
          Cancel
        </button>
        <Button type="submit" className="btn btn--primary" busy={change.busy}>
          Change password
        </Button>
      </div>
      </form>
      )}
    </>
  );
}
