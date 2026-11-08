/**
 * Times one slot's encryption and 0-or-1 proof for a 0 and for a 1, in a
 * shuffled order with new randomness each time, and prints the two
 * distributions and their difference. src/prove.test.ts checks that the
 * work is the same; this measures what that leaves.
 *
 *   pnpm --filter @weftwallet/tally timing [runs per value, default 4000]
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cpus } from "node:os";
import { VECTORS_DIR } from "./vectors.ts";
import { prepare, type Election } from "../src/election.ts";
import { drawBallotRandomness, proveSlot } from "../src/prove.ts";
import { seededRandom } from "../src/testing.ts";
import { voterTagX509 } from "../src/voter.ts";

const runs = Number(process.argv[2] ?? 4000);
const context = JSON.parse(readFileSync(join(VECTORS_DIR, "context.json"), "utf8"));
const election: Election = context.elections.find((e: { name: string }) => e.name === "budget-2027");
const { H, ctx } = prepare(election);
const tag = voterTagX509(election.channel, election.electionId, "Org1MSP", "timing");

// The order of 0s and 1s, shuffled with a fixed seed, and the randomness, drawn before timing.
const order: number[] = Array.from({ length: 2 * runs }, (_, i) => i % 2);
const shuffle = seededRandom("timing order");
for (let i = order.length - 1; i > 0; i--) {
  const b = shuffle.bytes(4);
  const k = ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0;
  const j = k % (i + 1);
  [order[i], order[j]] = [order[j]!, order[i]!];
}
const rnd = drawBallotRandomness(order.length, seededRandom("timing randomness"));

for (let i = 0; i < 200; i++) proveSlot(H, ctx, tag, 0, i % 2, rnd.r[i]!, rnd.bits[i]!.cs, rnd.bits[i]!.zs, rnd.bits[i]!.w);

const times: [number[], number[]] = [[], []];
for (let i = 0; i < order.length; i++) {
  const m = order[i]!;
  const t0 = process.hrtime.bigint();
  proveSlot(H, ctx, tag, 0, m, rnd.r[i]!, rnd.bits[i]!.cs, rnd.bits[i]!.zs, rnd.bits[i]!.w);
  times[m as 0 | 1].push(Number(process.hrtime.bigint() - t0) / 1e3);
}

const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b);
const quantile = (xs: number[], q: number) => sorted(xs)[Math.floor(q * (xs.length - 1))]!;
/** The mean and its standard error after dropping the slowest 1%, which are pauses for garbage collection. */
function trimmed(xs: number[]) {
  const s = sorted(xs).slice(0, Math.floor(xs.length * 0.99));
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  const variance = s.reduce((a, b) => a + (b - mean) ** 2, 0) / (s.length - 1);
  return { mean, se: Math.sqrt(variance / s.length) };
}

console.log(`Node ${process.version}, ${cpus()[0]?.model ?? "unknown CPU"}; ${runs} slots of each value, in shuffled order`);
for (const m of [0, 1] as const) {
  const t = trimmed(times[m]);
  console.log(`m = ${m}: median ${quantile(times[m], 0.5).toFixed(1)} µs, p10 ${quantile(times[m], 0.1).toFixed(1)}, p90 ${quantile(times[m], 0.9).toFixed(1)}, trimmed mean ${t.mean.toFixed(1)} ± ${t.se.toFixed(1)} µs`);
}
const a = trimmed(times[0]);
const b = trimmed(times[1]);
const diff = b.mean - a.mean;
const se = Math.sqrt(a.se ** 2 + b.se ** 2);
console.log(`m = 1 minus m = 0: ${diff.toFixed(1)} µs (${((100 * diff) / a.mean).toFixed(2)}% of a slot), 95% interval ${(diff - 1.96 * se).toFixed(1)} to ${(diff + 1.96 * se).toFixed(1)} µs; medians differ by ${(quantile(times[1], 0.5) - quantile(times[0], 0.5)).toFixed(1)} µs`);
