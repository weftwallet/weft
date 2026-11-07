/**
 * Times encrypting and proving a ballot (Weft) and checking it (the explorer,
 * and the contract in Node terms) at 3 and 10 options, with the vectors'
 * elections. The Go figures come from the contract module:
 *
 *   go test -bench . -benchtime 3s ./internal/tally
 *
 *   pnpm --filter @weftwallet/tally bench
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cpus } from "node:os";
import { VECTORS_DIR } from "./vectors.ts";
import { encryptBallot } from "../src/client.ts";
import { checkBallot } from "../src/verify.ts";
import { voterTagX509, type Election } from "../src/index.ts";

const context = JSON.parse(readFileSync(join(VECTORS_DIR, "context.json"), "utf8"));
const byOptions: Record<number, Election> = {};
for (const e of context.elections) byOptions[e.options.length] = e;

function time(f: () => void, runs: number): number {
  for (let i = 0; i < 10; i++) f();
  const t0 = performance.now();
  for (let i = 0; i < runs; i++) f();
  return (performance.now() - t0) / runs;
}

console.log(`Node ${process.version}, ${cpus()[0]?.model ?? "unknown CPU"}, ${cpus().length} cores`);
for (const L of [3, 10]) {
  const e = byOptions[L]!;
  const tag = voterTagX509(e.channel, e.electionId, "Org1MSP", new TextEncoder().encode("bench"));
  const runs = L === 3 ? 100 : 40;
  const prove = time(() => encryptBallot(e, tag, 1), runs);
  const { json } = encryptBallot(e, tag, 1);
  const verify = time(() => checkBallot(e, tag, json), runs);
  console.log(`${L} options: encrypt and prove ${prove.toFixed(1)} ms, verify ${verify.toFixed(1)} ms, ${json.length} bytes of JSON`);
}
