#!/usr/bin/env node
/**
 * Checks that the idemix module builds reproducibly: two builds, each in a
 * fresh temporary folder with an empty Go build cache, must give the same
 * SHA-256, and it must be the one committed in src/pinned.ts. It exits with
 * status 1 otherwise. It leaves dist/ alone.
 *
 *   node scripts/check.mjs
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUDGET, GO_TOOLCHAIN, build, readPinned } from "./build.mjs";

const pinned = readPinned();
const runs = [];
const scratch = mkdtempSync(join(tmpdir(), "weft-idemix-check-"));
try {
  for (const n of [1, 2]) {
    const started = Date.now();
    const out = build(join(scratch, `out${n}`), { gocache: join(scratch, `gocache${n}`) });
    runs.push(out);
    console.log(`Build ${n}, with an empty build cache, in ${((Date.now() - started) / 1000).toFixed(0)} s: ${out.wasm} (${out.bytes} bytes, ${out.gzip} gzipped)`);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

const problems = [];
if (runs[0].wasm !== runs[1].wasm) problems.push("The two builds differ, so the build isn't reproducible.");
if (runs[0].wasmExec !== runs[1].wasmExec) problems.push("The two builds copied different wasm_exec.js files.");
if (runs[0].wasm !== pinned.wasm) problems.push(`The module isn't the pinned one: src/pinned.ts has ${pinned.wasm}.`);
if (runs[0].wasmExec !== pinned.wasmExec) problems.push(`wasm_exec.js isn't the pinned one: src/pinned.ts has ${pinned.wasmExec}.`);
if (runs[0].bytes > BUDGET.raw || runs[0].gzip > BUDGET.gzip) problems.push(`The module is over its budget of ${BUDGET.raw} bytes, or ${BUDGET.gzip} gzipped.`);
if (problems.length) {
  process.stderr.write(problems.map((p) => `✗ ${p}\n`).join(""));
  process.exit(1);
}
console.log(`✓ Both builds with ${GO_TOOLCHAIN} give the pinned module, within its budget.`);
