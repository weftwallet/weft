/**
 * Vitest's global setup: builds the module if dist/wasm has none with the
 * pinned hash, and the Go test tool, the scratch issuer and IBM's MSP
 * verifier the tests sign against. Without Go on PATH, and with no module
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
}
