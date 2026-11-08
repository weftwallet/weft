import { defineConfig } from "vitest/config";
import { source } from "../../vite.source.ts";

// The global setup builds the module (if dist/wasm has none with the pinned
// hash) and the Go test tool, with Go; without Go, the module's tests skip.
export default defineConfig({ ...source, test: { testTimeout: 120_000, hookTimeout: 600_000, globalSetup: ["./src/test/setup.ts"] } });
