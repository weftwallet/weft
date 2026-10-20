import { useCallback, useEffect, useState } from "react";
import { ui, type WalletState } from "../../lib/messages";

export type Route =
  | { name: "home" }
  | { name: "identities" }
  | { name: "join" }
  | { name: "enroll" }
  | { name: "import" }
  | { name: "csr" }
  | { name: "complete-csr"; pendingId: string }
  | { name: "tx"; activityId: string }
  | { name: "network"; networkId: string };

export type Navigate = (route: Route) => void;

export function useWallet() {
  const [state, setState] = useState<WalletState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setState(await ui("state"));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { state, setState, error, refresh };
}

/** Wraps an async action with busy and error state for forms. */
export function useAction<A extends unknown[], R>(action: (...args: A) => Promise<R>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(
    async (...args: A): Promise<R | undefined> => {
      setBusy(true);
      setError(null);
      try {
        return await action(...args);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [action],
  );
  return { run, busy, error, setError };
}
