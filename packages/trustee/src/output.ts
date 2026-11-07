/**
 * How weft-trustee writes: a line with ✓ for what it did, a line with ✗ for
 * what failed, plain lines for the rest, and an indented second line for
 * what to do next.
 */

/** A failure the command reports and exits with status 1. The first line follows ✗; the rest are indented under it. */
export class Failure extends Error {
  override name = "Failure";
  readonly lines: readonly string[];
  constructor(...lines: string[]) {
    super(lines[0]);
    this.lines = lines;
  }
}

export interface Output {
  /** A plain line on standard output. */
  line(text?: string): void;
  /** A line starting with ✓, for something done. */
  done(text: string): void;
  /** A line starting with ✗, on standard error, and indented hints under it. */
  failed(text: string, ...hints: string[]): void;
}

export const consoleOutput: Output = {
  line: (text = "") => process.stdout.write(`${text}\n`),
  done: (text) => process.stdout.write(`✓ ${text}\n`),
  failed: (text, ...hints) => process.stderr.write(`✗ ${text}\n${hints.map((h) => `  ${h}\n`).join("")}`),
};

/** "Org1MSP", "Org1MSP and Org2MSP", "Org1MSP, Org2MSP and Org3MSP". */
export function list(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** "1 ballot", "13 ballots". */
export function plural(n: number, word: string, many = `${word}s`): string {
  return `${n} ${n === 1 ? word : many}`;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "17:00 UTC on 31 January 2027". */
export function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm} UTC on ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** "3be0a91c…77d2e104". */
export function shortTx(txId: string): string {
  return txId.length > 20 ? `${txId.slice(0, 8)}…${txId.slice(-8)}` : txId;
}

/** A label column, as the status command lines them up. */
export function row(label: string, value: string): string {
  return `${label.padEnd(10)} ${value}`;
}
