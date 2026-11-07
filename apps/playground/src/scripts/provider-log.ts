/**
 * The provider log: every window.weft request and response, with timings,
 * newest first. Shared by Playground.astro's steps and the Private election
 * section (PrivateElection.astro), so one log holds the whole conversation
 * with Weft.
 */

const $ = (id: string) => document.getElementById(id) as HTMLElement;
let entries = 0;

export function log(direction: "→" | "←" | "•", title: string, body?: unknown, tone: "ok" | "err" | "info" = "info") {
  const li = document.createElement("li");
  li.dataset.tone = tone;
  li.className = "arrive";
  const head = document.createElement("div");
  head.className = "pg-log-head";
  head.textContent = `${new Date().toLocaleTimeString("en-GB")}  ${direction} ${title}`;
  li.append(head);
  let pre: HTMLPreElement | null = null;
  if (body !== undefined) {
    pre = document.createElement("pre");
    pre.id = `pg-log-${++entries}`;
    pre.textContent = typeof body === "string" ? body : JSON.stringify(body, null, 2);
    li.append(pre);
  }
  // Newest first; if someone has scrolled the log, keep what they're reading in place.
  const list = $("pg-log");
  const before = list.scrollHeight;
  list.prepend(li);
  // An entry taller than its cap (.pg-log pre) gets Show all, once it's in
  // the page and can be measured.
  if (pre && pre.scrollHeight > pre.clientHeight + 1) li.append(showAll(pre));
  if (list.scrollTop > 0) list.scrollTop += list.scrollHeight - before;
  $("pg-log-empty").hidden = true;
}

/**
 * Show all and Show less for a long log entry. Its height moves between the
 * cap and the whole as a transition, so a second press turns it back from
 * where it is (SYSTEM.md, Motion: reversible things).
 */
function showAll(pre: HTMLPreElement): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "btn btn--text pg-log-more";
  button.textContent = "Show all";
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-controls", pre.id);
  const settled = () => {
    if (button.getAttribute("aria-expanded") === "true") pre.style.maxHeight = "none";
  };
  button.addEventListener("click", () => {
    const open = button.getAttribute("aria-expanded") !== "true";
    // From the height it has now.
    pre.style.maxHeight = `${pre.getBoundingClientRect().height}px`;
    void pre.offsetHeight;
    button.setAttribute("aria-expanded", String(open));
    button.textContent = open ? "Show less" : "Show all";
    pre.classList.toggle("is-open", open);
    pre.style.maxHeight = open ? `${pre.scrollHeight}px` : "";
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) settled();
  });
  pre.addEventListener("transitionend", (e) => e.propertyName === "max-height" && settled());
  return button;
}

/** Sends one request to Weft, logging it and its answer or failure with how long it took. */
export async function logged<T = any>(provider: { request(args: { method: string; params?: unknown }): Promise<unknown> }, method: string, params?: unknown): Promise<T> {
  log("→", method, params);
  const started = performance.now();
  try {
    const result = await provider.request(params === undefined ? { method } : { method, params });
    log("←", `${method} · ${Math.round(performance.now() - started)} ms`, result, "ok");
    return result as T;
  } catch (error: any) {
    log("←", `${method} failed · ${Math.round(performance.now() - started)} ms`, { code: error?.code, message: error?.message, data: error?.data }, "err");
    throw error;
  }
}
