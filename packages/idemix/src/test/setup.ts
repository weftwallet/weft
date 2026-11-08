/**
 * Vitest's global setup: builds the module if dist/wasm has none with the
 * pinned hash, the Go test tool, with the scratch issuer and IBM's MSP
 * verifier the tests sign against and the contract's pseudonym verifier,
 * and a test build of the module for the pseudonym vectors. Without Go on PATH, and with no module
 * built, the module's tests skip and say why.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));

export default function setup(): void {
  const hasGo = spawnSync("go", ["version"]).status === 0;
  if (!hasGo) {
    process.env.WEFT_IDEMIX_SKIP = "Go isn't on PATH, so the idemix module and its test tool can't be built.";
    return;
  }
  execFileSync(process.execPath, ["scripts/build.mjs", "--if-missing"], { cwd: root, stdio: "inherit" });
  mkdirSync(`${root}dist/test`, { recursive: true });
  execFileSync("go", ["build", "-o", "dist/test/testtool", "./internal/cmd/testtool"], { cwd: root, stdio: "inherit" });
  process.env.WEFT_IDEMIX_TESTTOOL = `${root}dist/test/testtool`;
  // A test build with pseudonymVector, which proves from a vector's fixed
  // inputs. It isn't the pinned module, which has no such function.
  execFileSync("go", ["build", "-tags", "weftvectors", "-o", "dist/test/weft-idemix-vectors.wasm", "./cmd/wasm"], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, GOOS: "js", GOARCH: "wasm", CGO_ENABLED: "0" },
  });
  process.env.WEFT_IDEMIX_VECTORS_WASM = `${root}dist/test/weft-idemix-vectors.wasm`;
}
