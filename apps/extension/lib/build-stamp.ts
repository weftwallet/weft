/**
 * Which code is running. Every build carries the time it was made
 * (wxt.config.ts defines it), and the background answers the popup's
 * buildInfo request with its own. When the two differ, the background and the
 * window run different code: a browser can keep running an older background
 * after an update or, in a dev build, after a rebuild.
 */

declare global {
  interface ImportMetaEnv {
    /** Set by wxt.config.ts, as an ISO string. Undefined in unit tests. */
    readonly WEFT_BUILT_AT?: string;
  }
}

/** When the code of this page or worker was built. Null in unit tests. */
export const BUILT_AT: string | null = import.meta.env.WEFT_BUILT_AT ?? null;

/** How the background's code compares with the window's. */
export type BuildDifference = "background-older" | "window-older";

/**
 * Null when the window and the background run the same build, or when the
 * window has no stamp to compare. A background with no stamp was built before
 * Weft stamped its builds, so it counts as older. Two stamps that differ but
 * can't be read as times count as an older background too: reloading Weft
 * mends both cases.
 */
export function compareBuilds(windowBuiltAt: string | null, backgroundBuiltAt: string | null): BuildDifference | null {
  if (windowBuiltAt === null) return null;
  if (backgroundBuiltAt === null) return "background-older";
  if (windowBuiltAt === backgroundBuiltAt) return null;
  const w = Date.parse(windowBuiltAt);
  const b = Date.parse(backgroundBuiltAt);
  if (Number.isNaN(w) || Number.isNaN(b)) return "background-older";
  return b > w ? "window-older" : "background-older";
}

/** What the popup says about a difference. */
export const BUILD_DIFFERENCE_MESSAGE: Record<BuildDifference, string> = {
  "background-older": "Weft's background is older than this window, so they run different code. Reload Weft in your browser's extensions page.",
  "window-older": "This window is older than Weft's background, so they run different code. Close this window and open Weft again.",
};

/** "Built 9 Nov 2026, 14:03:12", or what is known when there's no stamp. */
export function builtLabel(builtAt: string | null): string {
  if (builtAt === null) return "Built before Weft recorded build times";
  const at = new Date(builtAt);
  if (Number.isNaN(at.getTime())) return `Built ${builtAt}`;
  const date = at.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  const time = at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return `Built ${date}, ${time}`;
}
