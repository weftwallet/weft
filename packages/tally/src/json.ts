/**
 * Strict parsing of the contract's JSON arguments into fixed fields. The
 * order of checks is part of the specification, because the first failure
 * decides the message: at each object, unknown fields first (in the byte
 * order of their UTF-8 names), then each field in the schema's order, depth
 * first; list items in order. The Go parser walks the same way.
 */
import { compareBytes, utf8 } from "./encoding.ts";
import { TallyError, messages, type Thing } from "./errors.ts";

export type Schema =
  | { kind: "string" }
  | { kind: "number" }
  | { kind: "list"; of: Schema }
  | { kind: "object"; fields: readonly (readonly [string, Schema])[] };

export const str: Schema = { kind: "string" };
export const num: Schema = { kind: "number" };
export const list = (of: Schema): Schema => ({ kind: "list", of });
export type ObjectSchema = Extract<Schema, { kind: "object" }>;
export const obj = (fields: readonly (readonly [string, Schema])[]): ObjectSchema => ({ kind: "object", fields });

const KIND_NAMES = { string: "a string", number: "a number", list: "a list", object: "an object" } as const;

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function matches(x: unknown, s: Schema): boolean {
  switch (s.kind) {
    case "string":
      return typeof x === "string";
    case "number":
      return typeof x === "number";
    case "list":
      return Array.isArray(x);
    case "object":
      return isObject(x);
  }
}

function join(path: string, field: string): string {
  return path === "" ? field : `${path}.${field}`;
}

function walk(thing: Thing, x: Record<string, unknown>, s: Extract<Schema, { kind: "object" }>, path: string): void {
  const known = new Set(s.fields.map(([name]) => name));
  const unknown = Object.keys(x)
    .filter((k) => !known.has(k))
    .sort((a, b) => compareBytes(utf8(a), utf8(b)));
  if (unknown.length) throw new TallyError(messages.unknownField(thing, join(path, unknown[0]!)));
  for (const [name, fs] of s.fields) {
    const p = join(path, name);
    if (!Object.prototype.hasOwnProperty.call(x, name)) throw new TallyError(messages.missing(thing, p));
    check(thing, x[name], fs, p);
  }
}

function check(thing: Thing, x: unknown, s: Schema, path: string): void {
  if (!matches(x, s)) throw new TallyError(messages.wrongType(thing, path, KIND_NAMES[s.kind]));
  if (s.kind === "object") walk(thing, x as Record<string, unknown>, s, path);
  if (s.kind === "list") (x as unknown[]).forEach((item, i) => check(thing, item, s.of, `${path}[${i}]`));
}

/** Parses `text` as `schema` or throws a TallyError with the contract's message. */
export function parseStrict<T>(thing: Thing, text: string, schema: Extract<Schema, { kind: "object" }>): T {
  let x: unknown;
  try {
    x = JSON.parse(text);
  } catch {
    throw new TallyError(messages.notJson(thing));
  }
  if (!isObject(x)) throw new TallyError(messages.notObject(thing));
  walk(thing, x, schema, "");
  return x as T;
}
