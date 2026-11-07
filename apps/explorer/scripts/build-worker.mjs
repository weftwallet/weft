// Bundles the private election full check's Web Worker (src/full-check-worker.ts),
// with @weftwallet/tally and noble read from their sources, into
// dist/worker/full-check.js. The explorer serves it as /assets/full-check.js
// when it runs with WEFT_EXPERIMENTAL=1 (docs/adr/0009).
import { build } from "rolldown";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
await build({
  input: join(root, "src/full-check-worker.ts"),
  platform: "browser",
  resolve: { conditionNames: ["weft-source", "import", "browser", "default"] },
  output: { file: join(root, "dist/worker/full-check.js"), format: "iife", minify: true },
  logLevel: "warn",
});
console.log("Built dist/worker/full-check.js");
