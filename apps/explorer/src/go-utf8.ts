/**
 * Bytes to text as the private-ballot contract reads them (docs/adr/0007).
 * The contract is Go: encoding/json replaces each byte that doesn't start a
 * valid UTF-8 sequence with U+FFFD, one replacement per byte, because
 * utf8.DecodeRune reports every invalid sequence as 1 byte long. A browser's
 * TextDecoder, and Node's Buffer, follow the WHATWG decoder instead, which
 * replaces a truncated sequence as a whole: E2 82 41 is "��A" in
 * Go and "�A" in JavaScript. The election pages decode every argument
 * and written value of the contract with goString, so a title or an option
 * reads here as it read on the endorsing peers.
 */

const strict = new TextDecoder("utf-8", { fatal: true });

/** The length of the valid UTF-8 sequence at b[i], or 0 if none starts there (Go's acceptance ranges). */
function sequence(b: Uint8Array, i: number): number {
  const x = b[i]!;
  if (x < 0x80) return 1;
  const cont = (j: number, lo = 0x80, hi = 0xbf) => i + j < b.length && b[i + j]! >= lo && b[i + j]! <= hi;
  if (x >= 0xc2 && x <= 0xdf) return cont(1) ? 2 : 0;
  if (x === 0xe0) return cont(1, 0xa0) && cont(2) ? 3 : 0;
  if ((x >= 0xe1 && x <= 0xec) || x === 0xee || x === 0xef) return cont(1) && cont(2) ? 3 : 0;
  if (x === 0xed) return cont(1, 0x80, 0x9f) && cont(2) ? 3 : 0;
  if (x === 0xf0) return cont(1, 0x90) && cont(2) && cont(3) ? 4 : 0;
  if (x >= 0xf1 && x <= 0xf3) return cont(1) && cont(2) && cont(3) ? 4 : 0;
  if (x === 0xf4) return cont(1, 0x80, 0x8f) && cont(2) && cont(3) ? 4 : 0;
  return 0;
}

/** Decodes UTF-8 as Go's encoding/json does: each byte of an invalid sequence becomes one U+FFFD. */
export function goString(bytes: Uint8Array): string {
  try {
    return strict.decode(bytes);
  } catch {
    /* not valid UTF-8: decode it byte by byte below */
  }
  const parts: string[] = [];
  let start = 0;
  let i = 0;
  while (i < bytes.length) {
    const n = sequence(bytes, i);
    if (n > 0) {
      i += n;
      continue;
    }
    if (i > start) parts.push(strict.decode(bytes.subarray(start, i)));
    parts.push("�");
    i += 1;
    start = i;
  }
  if (start < bytes.length) parts.push(strict.decode(bytes.subarray(start)));
  return parts.join("");
}

/**
 * JSON.parse, with each lone surrogate in a string value or name replaced
 * by U+FFFD, as Go's encoding/json does with "\ud800".
 */
export function goJsonParse(text: string): unknown {
  const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
  const well = (s: string) => s.replace(LONE, "�");
  const fix = (v: unknown): unknown => {
    if (typeof v === "string") return well(v);
    if (Array.isArray(v)) return v.map(fix);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [well(k), fix(x)]));
    return v;
  };
  return fix(JSON.parse(text));
}
