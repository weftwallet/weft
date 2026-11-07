import { defineConfig } from "vitest/config";
import { source } from "../../vite.source.ts";

export default defineConfig({ ...source, test: { testTimeout: 60_000 } });
