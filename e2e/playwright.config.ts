import { defineConfig } from "@playwright/test";

/**
 * The tests that need the experimental stack (`pnpm playground:up
 * --experimental`): they vote in, count and check one private election that
 * experimental.setup.ts creates for the run (support/experimental.ts).
 */
const EXPERIMENTAL_STACK = /(cast-ballot|playground-private|private-explorer)\.spec\.ts$/;
/**
 * The tests of voter credentials (docs/adr/0008), on the same stack: two
 * voters enrol and vote in an election with voter credentials that
 * voter-credentials.setup.ts creates for the run.
 */
const VOTER_CREDENTIALS = /voter-credentials\.spec\.ts$/;

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
  projects: [
    { name: "weft", testIgnore: [EXPERIMENTAL_STACK, VOTER_CREDENTIALS] },
    { name: "experimental-setup", testMatch: /experimental\.setup\.ts$/ },
    // In file order: cast-ballot votes, playground-private votes from the playground and counts, private-explorer checks the count.
    { name: "experimental-stack", testMatch: EXPERIMENTAL_STACK, dependencies: ["experimental-setup"] },
    { name: "voter-credentials-setup", testMatch: /voter-credentials\.setup\.ts$/ },
    { name: "voter-credentials", testMatch: VOTER_CREDENTIALS, dependencies: ["voter-credentials-setup"] },
  ],
});
