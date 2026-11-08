/**
 * The enrolment ID of an X.509 voter, as the contract reads it from the
 * creator's id_bytes (private-tally-spec.md, The voter tag): the PEM decodes
 * as Go's encoding/pem Decode decodes it, to a CERTIFICATE block, and the
 * certificate's subject has exactly one commonName attribute, a non-empty
 * UTF8String or PrintableString, whose bytes are the enrolment ID.
 *
 * The contract parses the whole certificate with Go's crypto/x509. This
 * module reads the certificate's DER only as far as the subject, and checks
 * the subject's attribute values as Go does, so it gives the contract's
 * enrolment ID for every certificate the contract accepts. A certificate
 * whose other parts Go refuses gets an enrolment ID here and the contract's
 * refusal at the peer.
 */
import { TallyError, messages } from "./errors.ts";

const latin1 = (b: Uint8Array, from = 0, to = b.length) => {
  let s = "";
  for (let i = from; i < to; i++) s += String.fromCharCode(b[i]!);
  return s;
};

function indexOf(hay: Uint8Array, needle: Uint8Array, from = 0, to = hay.length): number {
  outer: for (let i = from; i + needle.length <= to; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

function lastIndexOf(hay: Uint8Array, needle: Uint8Array, to: number): number {
  outer: for (let i = to - needle.length; i >= 0; i--) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const PEM_START = ascii("\n-----BEGIN ");
const PEM_END = ascii("\n-----END ");
const PEM_EOL = ascii("-----");

/** Go's getLine: the line up to "\n" or "\r\n", without trailing spaces and tabs, and the offset after it. */
function getLine(b: Uint8Array, from: number, to: number): { line: [number, number]; next: number } {
  let i = -1;
  for (let k = from; k < to; k++) {
    if (b[k] === 0x0a) {
      i = k;
      break;
    }
  }
  let end: number;
  let next: number;
  if (i < 0) {
    end = to;
    next = to;
  } else {
    next = i + 1;
    end = i > from && b[i - 1] === 0x0d ? i - 1 : i;
  }
  while (end > from && (b[end - 1] === 0x20 || b[end - 1] === 0x09)) end--;
  return { line: [from, end], next };
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Go's base64.StdEncoding.Decode after encoding/pem's removeSpacesAndTabs: newlines skipped, padding required, nonzero trailing bits allowed. */
function base64Decode(b: Uint8Array, from: number, to: number): Uint8Array | null {
  const chars: number[] = [];
  for (let i = from; i < to; i++) {
    const c = b[i]!;
    if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) continue;
    chars.push(c);
  }
  if (chars.length % 4 !== 0) return null;
  const out: number[] = [];
  for (let q = 0; q < chars.length; q += 4) {
    const last = q + 4 === chars.length;
    const v: number[] = [];
    let pad = 0;
    for (let k = 0; k < 4; k++) {
      const c = chars[q + k]!;
      if (c === 0x3d) {
        if (!last || k < 2) return null;
        pad++;
        continue;
      }
      if (pad > 0) return null;
      const d = B64.indexOf(String.fromCharCode(c));
      if (d < 0) return null;
      v.push(d);
    }
    const n = (v[0]! << 18) | (v[1]! << 12) | ((v[2] ?? 0) << 6) | (v[3] ?? 0);
    out.push((n >> 16) & 255);
    if (pad < 2) out.push((n >> 8) & 255);
    if (pad < 1) out.push(n & 255);
  }
  return Uint8Array.from(out);
}

/** The first PEM block, as Go 1.26's encoding/pem Decode finds it: its type and decoded bytes, or null. */
export function decodePem(data: Uint8Array): { type: string; bytes: Uint8Array } | null {
  let base = 0;
  let endTrailerIndex = 0;
  for (;;) {
    if (endTrailerIndex < 0 || base + endTrailerIndex > data.length) return null;
    base += endTrailerIndex;
    let endIndex = indexOf(data, PEM_END, base);
    if (endIndex < 0) return null;
    endIndex -= base;
    endTrailerIndex = endIndex + PEM_END.length;
    const beginIndex = lastIndexOf(data.subarray(base), PEM_START.subarray(1), endIndex);
    if (beginIndex < 0 || (beginIndex > 0 && data[base + beginIndex - 1] !== 0x0a)) continue;
    const skip = beginIndex + PEM_START.length - 1;
    base += skip;
    endIndex -= skip;
    endTrailerIndex -= skip;

    const type = getLine(data, base, data.length);
    endIndex -= type.next - base;
    endTrailerIndex -= type.next - base;
    let rest = type.next;
    const [ts, te] = type.line;
    const typeLine = data.subarray(ts, te);
    if (typeLine.length < PEM_EOL.length || indexOf(typeLine, PEM_EOL, typeLine.length - PEM_EOL.length) < 0) {
      base = rest;
      continue;
    }
    const typeName = typeLine.subarray(0, typeLine.length - PEM_EOL.length);

    let headers = 0;
    let abandoned = false;
    for (;;) {
      if (rest >= data.length) return null;
      const h = getLine(data, rest, data.length);
      const colon = indexOf(data, ascii(":"), h.line[0], h.line[1]);
      if (colon < 0) break;
      headers++;
      endIndex -= h.next - rest;
      endTrailerIndex -= h.next - rest;
      rest = h.next;
    }
    if (headers > 0 && endIndex < 0) abandoned = true;

    if (!abandoned) {
      const trailer = rest + endTrailerIndex;
      const trailerLen = typeName.length + PEM_EOL.length;
      if (trailer + trailerLen > data.length) abandoned = true;
      else {
        const t = data.subarray(trailer, trailer + trailerLen);
        const sameType = typeName.every((x, k) => t[k] === x);
        const dashes = PEM_EOL.every((x, k) => t[typeName.length + k] === x);
        if (!sameType || !dashes) abandoned = true;
        else {
          const after = getLine(data, trailer + trailerLen, data.length);
          if (after.line[1] !== after.line[0]) abandoned = true;
        }
      }
    }
    if (!abandoned) {
      let bytes: Uint8Array | null = new Uint8Array(0);
      if (endIndex > 0) bytes = base64Decode(data, rest, rest + endIndex);
      if (bytes) return { type: latin1(typeName), bytes };
    }
    // Go continues from the offset it reached, with endTrailerIndex relative to it.
    base = rest;
  }
}

/* ---------- DER, as far as the subject ---------- */

interface Tlv {
  tag: number;
  /** The content's offsets. */
  start: number;
  end: number;
}

/** One DER TLV at `at`, with a one-byte tag and a minimal definite length, inside `limit`; or null. */
function tlv(b: Uint8Array, at: number, limit: number): Tlv | null {
  if (at + 2 > limit) return null;
  const tag = b[at]!;
  if ((tag & 0x1f) === 0x1f) return null;
  let len = b[at + 1]!;
  let start = at + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4 || start + n > limit || b[start] === 0) return null;
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + b[start + i]!;
    if (len < 0x80 || (n > 1 && len < 1 << (8 * (n - 1)))) return null;
    start += n;
  }
  if (start + len > limit) return null;
  return { tag, start, end: start + len };
}

const SEQUENCE = 0x30;
const SET = 0x31;
const OID = 0x06;
const INTEGER = 0x02;
const COMMON_NAME = Uint8Array.of(0x55, 0x04, 0x03);
const UTF8_STRING = 0x0c;
const PRINTABLE_STRING = 0x13;
/** The string types Go's crypto/x509 accepts in a Name: T61, Printable, UTF8, BMP, IA5 and Numeric. */
const NAME_STRINGS = new Set([0x14, PRINTABLE_STRING, UTF8_STRING, 0x1e, 0x16, 0x12]);

/** The certificate's subject Name TLV, or null if the outer structure doesn't hold one. */
function subjectOf(der: Uint8Array): Tlv | null {
  const cert = tlv(der, 0, der.length);
  if (!cert || cert.tag !== SEQUENCE || cert.end !== der.length) return null;
  const tbs = tlv(der, cert.start, cert.end);
  if (!tbs || tbs.tag !== SEQUENCE) return null;
  const sigAlg = tlv(der, tbs.end, cert.end);
  const sig = sigAlg && tlv(der, sigAlg.end, cert.end);
  if (!sigAlg || sigAlg.tag !== SEQUENCE || !sig || sig.tag !== 0x03 || sig.end !== cert.end) return null;
  let at = tbs.start;
  const first = tlv(der, at, tbs.end);
  if (first && first.tag === 0xa0) at = first.end;
  // serialNumber, signature, issuer, validity, then the subject.
  const want = [INTEGER, SEQUENCE, SEQUENCE, SEQUENCE];
  for (const tag of want) {
    const x = tlv(der, at, tbs.end);
    if (!x || x.tag !== tag) return null;
    at = x.end;
  }
  const subject = tlv(der, at, tbs.end);
  return subject && subject.tag === SEQUENCE ? subject : null;
}

function printable(b: Uint8Array): boolean {
  for (const c of b) {
    const ok =
      (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a) || (c >= 0x30 && c <= 0x39) || (c >= 0x27 && c <= 0x29) || (c >= 0x2b && c <= 0x2f) || c === 0x20 || c === 0x3a || c === 0x3d || c === 0x3f || c === 0x2a || c === 0x26;
    if (!ok) return false;
  }
  return true;
}

const fatalUtf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * The commonName values of a Name, each as its DER tag and content, or null
 * if the Name doesn't parse as Go parses one.
 */
function commonNames(der: Uint8Array, name: Tlv): { tag: number; value: Uint8Array }[] | null {
  const out: { tag: number; value: Uint8Array }[] = [];
  let at = name.start;
  while (at < name.end) {
    const set = tlv(der, at, name.end);
    if (!set || set.tag !== SET) return null;
    let a = set.start;
    while (a < set.end) {
      const atv = tlv(der, a, set.end);
      if (!atv || atv.tag !== SEQUENCE) return null;
      const oid = tlv(der, atv.start, atv.end);
      if (!oid || oid.tag !== OID || oid.end === oid.start) return null;
      const value = tlv(der, oid.end, atv.end);
      // Go reads the value and ignores anything after it in the attribute.
      if (!value || !NAME_STRINGS.has(value.tag)) return null;
      const content = der.subarray(value.start, value.end);
      if (value.tag === PRINTABLE_STRING && !printable(content)) return null;
      if (value.tag === UTF8_STRING) {
        try {
          fatalUtf8.decode(content);
        } catch {
          return null;
        }
      }
      const isCn = oid.end - oid.start === COMMON_NAME.length && COMMON_NAME.every((x, k) => der[oid.start + k] === x);
      if (isCn) out.push({ tag: value.tag, value: content });
      a = atv.end;
    }
    at = set.end;
  }
  return out;
}

/**
 * An X.509 creator's enrolment ID, from the id_bytes of its
 * SerializedIdentity, or the contract's refusal as a TallyError: the
 * id_bytes aren't a PEM certificate; the certificate doesn't parse; or its
 * subject doesn't have exactly one commonName that is a non-empty
 * UTF8String or PrintableString.
 */
export function enrolmentId(idBytes: Uint8Array): string {
  const block = decodePem(idBytes);
  if (!block || block.type !== "CERTIFICATE") throw new TallyError(messages.notX509Voter());
  const subject = subjectOf(block.bytes);
  const names = subject && commonNames(block.bytes, subject);
  if (!names) throw new TallyError(messages.certificate());
  const cn = names.length === 1 ? names[0]! : null;
  if (!cn || (cn.tag !== UTF8_STRING && cn.tag !== PRINTABLE_STRING) || cn.value.length === 0) throw new TallyError(messages.noEnrolmentId());
  return fatalUtf8.decode(cn.value);
}
