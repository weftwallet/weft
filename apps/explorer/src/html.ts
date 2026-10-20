/** A tiny HTML template helper: interpolations are escaped unless they're already HTML. */

export class Html {
  readonly value: string;
  constructor(value: string) {
    this.value = value;
  }
  toString(): string {
    return this.value;
  }
}

type Part = Html | string | number | boolean | null | undefined | Part[];

export function escape(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function render(part: Part): string {
  if (part === null || part === undefined || part === false || part === true) return "";
  if (part instanceof Html) return part.value;
  if (Array.isArray(part)) return part.map(render).join("");
  return escape(String(part));
}

export function html(strings: TemplateStringsArray, ...parts: Part[]): Html {
  let out = strings[0]!;
  parts.forEach((part, i) => (out += render(part) + strings[i + 1]!));
  return new Html(out);
}

export const raw = (value: string) => new Html(value);
