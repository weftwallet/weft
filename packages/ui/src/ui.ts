/**
 * The behaviour every Weft site shares, to go with base.css and motion.css:
 * field errors, failed actions, busy buttons, the page's live region, and
 * things arriving and leaving. See packages/brand/SYSTEM.md (States,
 * Errors, Navigation).
 */

const still = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ---------------- the live region ---------------- */

/**
 * Says something in the page's one polite live region (the shell's
 * #weft-status). Call it only when something changed for the person, never
 * on a timer.
 */
export function announce(text: string) {
  const region = document.getElementById("weft-status");
  if (!region) return;
  // Cleared first, so the same words said twice are heard twice.
  region.textContent = "";
  requestAnimationFrame(() => (region.textContent = text));
}

/* ---------------- busy buttons ---------------- */

/**
 * A motion token's value in milliseconds, with a fallback for a page without
 * tokens. A minifier may have written 1400ms as 1.4s, so the unit is read.
 */
export function tokenMs(name: string, fallback: number): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const v = parseFloat(raw);
  if (!Number.isFinite(v)) return fallback;
  return /ms$/.test(raw) ? v : v * 1000;
}

const loaderTimers = new WeakMap<HTMLElement, number>();

/**
 * Marks a control as working, the one way every product does it (SYSTEM.md,
 * "Loading"): aria-disabled at once, so it keeps keyboard focus and presses
 * are ignored (check isBusy in the handler); the product's loader joins the
 * label (.is-working) only after wait-before-loader, so a quick answer never
 * flashes one; and when the work ends the loader is removed at once rather
 * than finishing its pass. The label stays and the width never changes
 * (base.css .btn.is-working).
 */
export function setBusy(button: HTMLElement, busy: boolean) {
  const pending = loaderTimers.get(button);
  if (pending) {
    clearTimeout(pending);
    loaderTimers.delete(button);
  }
  if (busy) {
    button.setAttribute("aria-disabled", "true");
    const wait = tokenMs("--weft-wait-before-loader", 300);
    loaderTimers.set(
      button,
      window.setTimeout(() => {
        loaderTimers.delete(button);
        if (isBusy(button)) button.classList.add("is-working");
      }, wait),
    );
  } else {
    button.removeAttribute("aria-disabled");
    button.classList.remove("is-working");
  }
}

export const isBusy = (button: HTMLElement) => button.getAttribute("aria-disabled") === "true";

/* ---------------- field errors ---------------- */

type Field = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

function describedBy(field: Field, id: string, on: boolean) {
  const ids = (field.getAttribute("aria-describedby") ?? "").split(/\s+/).filter((x) => x && x !== id);
  if (on) ids.push(id);
  if (ids.length) field.setAttribute("aria-describedby", ids.join(" "));
  else field.removeAttribute("aria-describedby");
}

/**
 * Shows or clears a field's error in the field's reserved line: the
 * p.field__status right below the field (or below `after`, when the field
 * sits in a row with a button). The line is always there, 20px tall, so
 * nothing below the field moves; the message fades into it (motion.css).
 * Sets aria-invalid, and the line's id in aria-describedby after any hint's.
 * A field with no .field__status in its markup gets one the first time,
 * which reserves the line from then on; put it in the markup to reserve it
 * from the start.
 */
export function setFieldError(field: Field, message: string | null, after: Element = field) {
  const id = `${field.id}-error`;
  const status = statusLine(field, id, after, !!message);
  if (!message) {
    field.removeAttribute("aria-invalid");
    describedBy(field, id, false);
    if (status) {
      status.textContent = "";
      status.classList.remove("field-error");
    }
    return;
  }
  status!.textContent = message;
  status!.classList.add("field-error");
  field.setAttribute("aria-invalid", "true");
  describedBy(field, id, true);
}

/** The field's reserved error line: by id, then by markup, then made. */
function statusLine(field: Field, id: string, after: Element, make: boolean): HTMLElement | null {
  const byId = document.getElementById(id);
  if (byId) return byId;
  const next = after.nextElementSibling;
  const inMarkup = next?.classList.contains("field__status") ? next : after.closest(".field")?.querySelector<HTMLElement>(".field__status");
  if (inMarkup) {
    if (!inMarkup.id) inMarkup.id = id;
    return inMarkup as HTMLElement;
  }
  if (!make) return null;
  const p = Object.assign(document.createElement("p"), { id, className: "field__status" });
  after.after(p);
  return p;
}

export interface FieldCheck {
  field: Field;
  /** The error for the field's current value, or null when it's fine. */
  check: () => string | null;
  /** Where the error goes below, when not right below the field. */
  after?: Element;
}

/**
 * Checks fields the way SYSTEM.md says: when one loses focus after it's been
 * changed, then on every change once its error shows. checkAll() checks
 * everything, moves focus to the first field with an error, and says
 * whether all of them are fine.
 */
export function watchFields(checks: FieldCheck[]) {
  const run = ({ field, check, after }: FieldCheck) => {
    const message = check();
    setFieldError(field, message, after);
    return !message;
  };
  for (const c of checks) {
    let changed = false;
    c.field.addEventListener("input", () => {
      changed = true;
      if (c.field.getAttribute("aria-invalid") === "true") run(c);
    });
    c.field.addEventListener("change", () => (changed = true));
    c.field.addEventListener("blur", () => changed && run(c));
  }
  return {
    checkAll(): boolean {
      const bad = checks.filter((c) => !run(c));
      bad[0]?.field.focus();
      return bad.length === 0;
    },
    clear() {
      checks.forEach((c) => setFieldError(c.field, null));
    },
  };
}

/** Whether a value is an http or https address. */
export function isWebUrl(value: string): boolean {
  try {
    return /^https?:$/.test(new URL(value).protocol);
  } catch {
    return false;
  }
}

/* ---------------- failed actions ---------------- */

/**
 * Shows a failed action in its box (a div.action-error with role="alert",
 * where the action was): the sentence first, then anything technical
 * behind Details. Stays until clearError, when the person acts or retries.
 */
export function showError(box: HTMLElement, sentence: string, details?: string | null) {
  const p = Object.assign(document.createElement("p"), { textContent: sentence });
  const parts: Node[] = [p];
  if (details) {
    const more = Object.assign(document.createElement("details"), { className: "error-details" });
    more.append(Object.assign(document.createElement("summary"), { textContent: "Details" }), Object.assign(document.createElement("pre"), { textContent: details }));
    parts.push(more);
  }
  box.replaceChildren(...parts);
  reveal(box);
}

export function clearError(box: HTMLElement) {
  box.replaceChildren();
  box.hidden = true;
}

/** The technical side of an error, for Details: its code and message. */
export function technical(error: any): string {
  if (error == null) return "";
  const lines: string[] = [];
  if (error.code !== undefined) lines.push(`Code ${error.code}`);
  lines.push(String(error.message ?? error));
  if (error.data?.status) lines.push(`Status ${error.data.status}`);
  for (const d of error.data?.details ?? []) if (d?.message) lines.push(d.message);
  return lines.join("\n");
}

/**
 * What a failed fetch means, in words: the address didn't answer, it
 * answered with an error, or it took too long.
 */
export function fetchProblem(error: any, what: string): string {
  const message = String(error?.message ?? error);
  if (error?.name === "TimeoutError" || /timed out|timeout/i.test(message)) return `${what} didn't answer in time. Check that it's running and try again.`;
  const status = message.match(/^HTTP (\d+)/)?.[1];
  if (status === "404") return `${what} answered, but there's nothing at that address. Check the address.`;
  if (status) return `${what} answered with an error (HTTP ${status}). Try again, or check its logs.`;
  return `Couldn't reach ${what.charAt(0).toLowerCase()}${what.slice(1)}. Check the address, that it's running, and that it allows other sites to read it.`;
}

/* ---------------- arriving and leaving ---------------- */

const leaving = new WeakMap<HTMLElement, () => void>();

/** Shows a hidden element, fading in from shift-md below its place. */
export function reveal(el: HTMLElement) {
  leaving.get(el)?.();
  if (!el.hidden) return;
  el.hidden = false;
  el.classList.remove("is-leaving");
  el.classList.add("arrive");
  el.addEventListener("animationend", () => el.classList.remove("arrive"), { once: true });
}

/** Hides an element the way it arrived, in reverse, then sets hidden. */
export function conceal(el: HTMLElement) {
  if (el.hidden || leaving.has(el)) return;
  if (still() || !el.isConnected || !el.getClientRects().length) {
    el.hidden = true;
    return;
  }
  el.classList.remove("arrive");
  el.classList.add("is-leaving");
  let timer = 0;
  // Stops the leaving, without hiding: for reveal() during it.
  function done() {
    clearTimeout(timer);
    el.removeEventListener("animationend", finish);
    el.classList.remove("is-leaving");
    leaving.delete(el);
  }
  function finish() {
    done();
    el.hidden = true;
  }
  leaving.set(el, done);
  el.addEventListener("animationend", finish);
  // In case the animation never runs.
  timer = window.setTimeout(finish, 400);
}

/** Sets an element shown or hidden, arriving or leaving as it changes. */
export function showIf(el: HTMLElement, show: boolean) {
  if (show) reveal(el);
  else conceal(el);
}

/**
 * Makes a <details> close the way it opened, in reverse: the summary's
 * click holds it open while its content leaves (motion.css,
 * details.disclosure). Only for the native details element, which would hide
 * its content at once; a menu or panel is a .reversible instead (motion.css)
 * and needs no script beyond toggling .is-open. Returns close(), for Escape
 * and clicks outside.
 */
export function closesInReverse(details: HTMLDetailsElement, onClosed?: () => void) {
  const summary = details.querySelector("summary");
  let timer = 0;
  const close = () => {
    if (!details.open || details.classList.contains("is-closing")) return;
    if (still()) {
      details.open = false;
      onClosed?.();
      return;
    }
    details.classList.add("is-closing");
    const finish = () => {
      clearTimeout(timer);
      details.classList.remove("is-closing");
      details.open = false;
      onClosed?.();
    };
    const content = [...details.children].find((c) => c !== summary);
    if (content) content.addEventListener("animationend", finish, { once: true });
    timer = window.setTimeout(finish, 300);
  };
  summary?.addEventListener("click", (e) => {
    if (details.open) {
      e.preventDefault();
      close();
    }
  });
  return close;
}

/* ---------------- identifiers ---------------- */

/** A full identifier, grouped in fours so two can be compared block by block. */
export const grouped = (id: string) => id.replace(/(.{4})(?=.)/g, "$1 ");

/** A shortened identifier, cut in the middle, 8 characters kept at each end. */
export const shortened = (id: string) => (id.length > 20 ? `${id.slice(0, 8)}…${id.slice(-8)}` : id);
