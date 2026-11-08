#!/usr/bin/env node
/**
 * Builds the idemix WebAssembly module from Go source, reproducibly, and
 * refuses a module whose SHA-256 isn't the one committed in src/pinned.ts
 * (docs/adr/0008).
 *
 *   node scripts/build.mjs               build into dist/wasm and check the hashes
 *   node scripts/build.mjs --if-missing  only if dist/wasm has no module with the pinned hash
 *   node scripts/build.mjs --update      build and write the new hashes into src/pinned.ts
 *   node scripts/build.mjs --out <dir>   build into another folder (scripts/check.mjs)
 *
 * The build is pinned: the Go toolchain (GOTOOLCHAIN, which Go downloads if
 * the go on PATH is another version), the modules in go.sum, the flags
 * below and the environment, which is cleared of everything else that
 * changes Go's output. It builds a copy of the module in a temporary folder
 * with its dependencies vendored, puts _overlay/mathlib-v0.3.2/math.go in place of
 * IBM mathlib's math.go after checking that file's SHA-256, and builds with
 * -trimpath, so neither the repository's path nor the module cache's shows
 * in the module.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";

export const GO_TOOLCHAIN = "go1.26.10";
/** SHA-256 of IBM mathlib v0.3.2's math.go, which _overlay/mathlib-v0.3.2/math.go replaces. */
export const MATHLIB_MATH_GO_SHA256 = "fecf5007d48724357e6abc1d49f6654d193a4e52bfbd1fe53b01de48f5e02ca3";
export const BUILD_FLAGS = ["-trimpath", "-buildvcs=false", "-ldflags=-s -w -buildid="];
/** The budget: 13.5 MB raw and 3.2 MB gzipped, in bytes. */
export const BUDGET = { raw: 13_500_000, gzip: 3_200_000 };

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pinnedFile = join(root, "src", "pinned.ts");

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function fail(message, hint) {
  process.stderr.write(`✗ ${message}\n${hint ? `  ${hint}\n` : ""}`);
  process.exit(1);
}

export function readPinned() {
  const text = readFileSync(pinnedFile, "utf8");
  const field = (name) => {
    const m = text.match(new RegExp(`${name}:\\s*"([0-9a-f]{64})"`));
    if (!m) fail(`src/pinned.ts has no ${name}.`);
    return m[1];
  };
  return { wasm: field("wasmSha256"), wasmExec: field("wasmExecSha256") };
}

function writePinned(wasm, wasmExec, bytes) {
  let text = readFileSync(pinnedFile, "utf8");
  text = text.replace(/wasmSha256:\s*"[0-9a-f]{64}"/, `wasmSha256: "${wasm}"`);
  text = text.replace(/wasmExecSha256:\s*"[0-9a-f]{64}"/, `wasmExecSha256: "${wasmExec}"`);
  text = text.replace(/wasmBytes:\s*[0-9_]+/, `wasmBytes: ${bytes.toLocaleString("en").replaceAll(",", "_")}`);
  writeFileSync(pinnedFile, text);
}

/**
 * The environment for every go command: the caller's PATH, HOME and module
 * settings, and nothing else that changes what Go builds.
 */
export function goEnv(extra = {}) {
  const keep = ["PATH", "HOME", "GOPATH", "GOMODCACHE", "GOPROXY", "GONOSUMDB", "GONOSUMCHECK", "GOPRIVATE", "GOSUMDB", "GOINSECURE", "GOCACHE", "TMPDIR", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR"];
  const env = {};
  for (const key of keep) if (process.env[key] !== undefined) env[key] = process.env[key];
  // GOTOOLCHAIN: the pinned toolchain, downloaded by the go on PATH if it
  // is another version. GOFLAGS: only what the build sets.
  return { ...env, GOTOOLCHAIN: GO_TOOLCHAIN, GOFLAGS: "-mod=vendor -modcacherw", CGO_ENABLED: "0", GOOS: "js", GOARCH: "wasm", GOWASM: "", GOEXPERIMENT: "", GO111MODULE: "on", ...extra };
}

function go(args, options) {
  try {
    return execFileSync("go", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
  } catch (error) {
    if (error.code === "ENOENT") fail("Go isn't on your PATH, and the idemix module is built from Go source.", "Install Go (macOS: brew install go; others: https://go.dev/dl/). Any Go from 1.21 downloads the pinned toolchain itself.");
    fail(`go ${args[0]} failed.`, `${(error.stderr || error.stdout || error.message).trim().split("\n").slice(-6).join("\n  ")}`);
  }
}

/** Copies the module's sources, without tests, into dir. */
function copySources(dir) {
  cpSync(join(root, "go.mod"), join(dir, "go.mod"));
  cpSync(join(root, "go.sum"), join(dir, "go.sum"));
  for (const pkg of ["signer", "cmd/wasm"]) {
    mkdirSync(join(dir, pkg), { recursive: true });
    for (const file of readdirSync(join(root, pkg))) {
      if (file.endsWith(".go") && !file.endsWith("_test.go")) cpSync(join(root, pkg, file), join(dir, pkg, file));
    }
  }
}

/** Builds the module into outDir and returns its files' hashes and sizes. */
export function build(outDir, { gocache } = {}) {
  const work = mkdtempSync(join(tmpdir(), "weft-idemix-"));
  try {
    const env = goEnv(gocache ? { GOCACHE: gocache } : {});
    const version = go(["env", "GOVERSION"], { cwd: root, env: { ...env, GOFLAGS: "-mod=mod" } }).trim();
    if (version !== GO_TOOLCHAIN) fail(`Go reports ${version}, not the pinned ${GO_TOOLCHAIN}.`, "Go couldn't switch to the pinned toolchain. Check that go on your PATH is Go 1.21 or later and can reach its module proxy.");
    copySources(work);
    go(["mod", "vendor"], { cwd: work, env: { ...env, GOFLAGS: "-modcacherw" } });
    const mathGo = join(work, "vendor", "github.com", "IBM", "mathlib", "math.go");
    if (sha256(readFileSync(mathGo)) !== MATHLIB_MATH_GO_SHA256) {
      fail("IBM mathlib's math.go isn't the file _overlay/mathlib-v0.3.2/math.go was made from.", "A new mathlib version needs a new overlay: see packages/idemix/README.md.");
    }
    cpSync(join(root, "_overlay", "mathlib-v0.3.2", "math.go"), mathGo);
    mkdirSync(outDir, { recursive: true });
    const wasmPath = join(outDir, "weft-idemix.wasm");
    go(["build", ...BUILD_FLAGS, "-o", wasmPath, "./cmd/wasm"], { cwd: work, env });
    const goroot = go(["env", "GOROOT"], { cwd: work, env }).trim();
    cpSync(join(goroot, "lib", "wasm", "wasm_exec.js"), join(outDir, "wasm_exec.js"));
    const wasm = readFileSync(wasmPath);
    const wasmExec = readFileSync(join(outDir, "wasm_exec.js"));
    return { wasm: sha256(wasm), wasmExec: sha256(wasmExec), bytes: wasm.length, gzip: gzipSync(wasm, { level: 9 }).length, path: wasmPath };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const mb = (n) => `${(n / 1_000_000).toFixed(2)} MB`;

function main() {
  const { values } = parseArgs({ options: { "if-missing": { type: "boolean" }, update: { type: "boolean" }, out: { type: "string" } } });
  const outDir = values.out ?? join(root, "dist", "wasm");
  const pinned = readPinned();
  if (values["if-missing"]) {
    const wasm = join(outDir, "weft-idemix.wasm");
    const exec = join(outDir, "wasm_exec.js");
    if (existsSync(wasm) && existsSync(exec) && sha256(readFileSync(wasm)) === pinned.wasm && sha256(readFileSync(exec)) === pinned.wasmExec) {
      console.log(`The idemix module in ${relative(process.cwd(), outDir) || "."} is the pinned one.`);
      return;
    }
  }
  const started = Date.now();
  const out = build(outDir);
  const where = relative(process.cwd(), out.path);
  console.log(`Built ${where} with ${GO_TOOLCHAIN} in ${((Date.now() - started) / 1000).toFixed(1)} s: ${mb(out.bytes)}, ${mb(out.gzip)} gzipped.`);
  console.log(`  weft-idemix.wasm  ${out.wasm}`);
  console.log(`  wasm_exec.js      ${out.wasmExec}`);
  if (out.bytes > BUDGET.raw || out.gzip > BUDGET.gzip) {
    fail(`The module is over its budget of ${mb(BUDGET.raw)}, or ${mb(BUDGET.gzip)} gzipped.`, "Find what grew before raising the budget (packages/idemix/README.md).");
  }
  if (values.update) {
    writePinned(out.wasm, out.wasmExec, out.bytes);
    console.log("Wrote the new hashes into src/pinned.ts. Commit them with the change that caused them.");
    return;
  }
  if (out.wasm !== pinned.wasm || out.wasmExec !== pinned.wasmExec) {
    rmSync(out.path, { force: true });
    fail(
      `The module built here isn't the pinned one${out.wasm === pinned.wasm ? ": wasm_exec.js differs" : ""}, so it was deleted.`,
      `src/pinned.ts has ${pinned.wasm}. If you changed the Go code, go.mod or the toolchain, run node scripts/build.mjs --update and commit the new hash.`,
    );
  }
  console.log("✓ The module and wasm_exec.js have the pinned SHA-256.");
}

if (process.argv[1] && statSync(process.argv[1]).isFile() && fileURLToPath(import.meta.url) === process.argv[1]) main();
