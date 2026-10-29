/**
 * Field checks the way SYSTEM.md (Errors) describes them: a field is checked
 * when it loses focus, not while it's being typed; once its error shows, it's
 * checked on every change so the error clears as soon as it's fixed. On
 * submit everything is checked and focus moves to the first field in error.
 */

import { useCallback, useEffect, useId, useState } from "react";
import type { Check } from "../lib/validate";

export interface FieldState {
  id: string;
  error: string | null;
  onLeave: () => void;
}

export function useChecks<K extends string>(checks: Record<K, () => Check>) {
  const prefix = useId().replace(/[^a-zA-Z0-9]/g, "");
  const [shown, setShown] = useState<Set<K>>(() => new Set());
  // Checked every render: they read the form's current values.
  const current = {} as Record<K, Check>;
  for (const key of Object.keys(checks) as K[]) current[key] = checks[key]();

  // A fixed field stops being "shown", so it isn't flagged again mid-typing.
  const fixed = [...shown].filter((key) => !current[key]);
  useEffect(() => {
    if (fixed.length === 0) return;
    setShown((s) => {
      const next = new Set(s);
      for (const key of fixed) next.delete(key);
      return next;
    });
  }, [fixed.join(",")]);

  const id = useCallback((key: K) => `${prefix}-${key}`, [prefix]);

  const field = (key: K): FieldState => ({
    id: id(key),
    error: shown.has(key) ? current[key] : null,
    onLeave: () => {
      if (current[key]) setShown((s) => new Set(s).add(key));
    },
  });

  /** Checks every field. Returns true when they're all fine; otherwise focuses the first in error. */
  const submit = (): boolean => {
    const bad = (Object.keys(checks) as K[]).filter((key) => current[key]);
    setShown(new Set(bad));
    if (bad.length === 0) return true;
    // Fields render in the order the checks are listed.
    const first = document.getElementById(id(bad[0]!));
    first?.focus({ preventScroll: true });
    first?.scrollIntoView({ block: "center" });
    return false;
  };

  return { field, submit };
}
