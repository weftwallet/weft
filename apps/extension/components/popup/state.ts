import { useCallback, useEffect, useRef, useState } from "react";
import { browser } from "wxt/browser";
import { ui, type UiEvent, type WalletState } from "../../lib/messages";
import { toErrorInfo, type ErrorInfo } from "../ui";

/** Where an add-identity form goes back to: the screen it was opened from. */
export type AddFrom = "home" | "identities" | "add";

export type Route =
  | { name: "home" }
  | { name: "identities" }
  | { name: "add" }
  | { name: "join"; from?: AddFrom }
  | { name: "enroll"; from?: AddFrom }
  | { name: "import"; from?: AddFrom }
  | { name: "csr"; from?: AddFrom }
  | { name: "complete-csr"; pendingId: string }
  | { name: "tx"; activityId: string }
  | { name: "network"; networkId: string }
  | { name: "security" };

export type Navigate = (route: Route) => void;

export function useWallet() {
  const [state, setState] = useState<WalletState | null>(null);
  const [error, setError] = useState<ErrorInfo | null>(null);

  const refresh = useCallback(async () => {
    try {
      setState(await ui("state"));
      setError(null);
    } catch (e) {
      setError(toErrorInfo(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    // Locking (by the user in another window, or the auto-lock) changes session storage.
    const onChange = (_changes: unknown, area: string) => {
      if (area === "session") void refresh();
    };
    browser.storage.onChanged.addListener(onChange);
    return () => browser.storage.onChanged.removeListener(onChange);
  }, [refresh]);

  return { state, setState, error, refresh };
}

/**
 * Wraps an async action with busy and error state. A second run while one is
 * going is ignored, so nothing is done twice however fast the presses.
 */
export function useAction<A extends unknown[], R>(action: (...args: A) => Promise<R>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorInfo | null>(null);
  const running = useRef(false);
  const latest = useRef(action);
  latest.current = action;
  const run = useCallback(async (...args: A): Promise<R | undefined> => {
    if (running.current) return undefined;
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      return await latest.current(...args);
    } catch (e) {
      setError(toErrorInfo(e));
      return undefined;
    } finally {
      running.current = false;
      setBusy(false);
    }
  }, []);
  return { run, busy, error, setError };
}

/** Runs `onChange` when the worker says activity has changed. */
export function useActivityEvents(onChange: () => void) {
  const latest = useRef(onChange);
  latest.current = onChange;
  useEffect(() => {
    const listener = (message: unknown) => {
      if ((message as UiEvent | null)?.channel === "weft-ui-event") latest.current();
    };
    browser.runtime.onMessage.addListener(listener);
    return () => browser.runtime.onMessage.removeListener(listener);
  }, []);
}
