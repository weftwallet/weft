import { useEffect, useState } from "react";
import { browser } from "wxt/browser";
import { BUILD_DIFFERENCE_MESSAGE, BUILT_AT, builtLabel, compareBuilds, type BuildDifference } from "../../lib/build-stamp";
import { ui } from "../../lib/messages";
import { Icon } from "../ui";

/**
 * The background's build stamp, read once per page. A background that
 * doesn't answer buildInfo predates it, so its stamp is null.
 */
let background: Promise<string | null> | null = null;
const backgroundBuiltAt = () =>
  (background ??= ui("buildInfo").then(
    (info) => info.builtAt,
    () => null,
  ));

export interface BuildCheck {
  background: string | null;
  difference: BuildDifference | null;
}

/** This window's build compared with the background's: null until the background has answered. */
export function useBuildCheck(): BuildCheck | null {
  const [check, setCheck] = useState<BuildCheck | null>(null);
  useEffect(() => {
    let live = true;
    void backgroundBuiltAt().then((at) => live && setCheck({ background: at, difference: compareBuilds(BUILT_AT, at) }));
    return () => {
      live = false;
    };
  }, []);
  return check;
}

/** Says that the background and this window run different code, and nothing when they don't. */
export function BuildNotice({ check }: { check: BuildCheck | null }) {
  if (!check?.difference) return null;
  return (
    <div className="notice notice--amber" role="status">
      <Icon name="alert" size={18} color="var(--weft-warn-text)" />
      <span>{BUILD_DIFFERENCE_MESSAGE[check.difference]}</span>
    </div>
  );
}

/** The Security screen's build details: the version, and when this window's and the background's code were built. */
export function BuildDetails() {
  const check = useBuildCheck();
  return (
    <section className="stack" aria-labelledby="build-heading">
      <h2 id="build-heading" className="eyebrow">
        Build
      </h2>
      <dl className="details">
        <dt>Version</dt>
        <dd>{browser.runtime.getManifest().version}</dd>
        <dt>This window</dt>
        <dd>{builtLabel(BUILT_AT)}</dd>
        <dt>Background</dt>
        <dd>{check ? builtLabel(check.background) : "Asking the background"}</dd>
      </dl>
      <BuildNotice check={check} />
    </section>
  );
}
