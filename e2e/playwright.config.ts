import { defineConfig } from "@playwright/test";

// One worker: the tests share one CA, relay and set of demo users.
export default defineConfig({
  testDir: "./tests",
  globalSetup: "./support/global-setup.ts",
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  // @headed tests reload the extension, which only works in a windowed
  // browser (run them with `pnpm test:headed`). @fabric tests need peers
  // (WEFT_E2E_STACK=playground).
  grepInvert: process.env.WEFT_E2E_GREP ? undefined : process.env.WEFT_E2E_STACK === "playground" ? /@headed/ : /@headed|@fabric/,
  use: { trace: "retain-on-failure" },
});
