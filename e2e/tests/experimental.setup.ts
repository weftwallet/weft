/**
 * The experimental-stack project's setup: a fresh private election for this
 * run (support/experimental.ts), which cast-ballot.spec.ts,
 * playground-private.spec.ts and private-explorer.spec.ts use.
 */

import { stack, test } from "../support/fixtures.ts";
import { createRunElection, missingStack } from "../support/experimental.ts";

test("create a fresh private election for this run", { tag: "@fabric" }, async () => {
  test.setTimeout(240_000);
  test.skip(stack().mode !== "playground", "Needs the playground stack (WEFT_E2E_STACK=playground).");
  const missing = missingStack();
  test.skip(missing !== null, missing ?? "");
  const e = await createRunElection();
  test.info().annotations.push({ type: "election", description: `${e.electionId} on ${e.channel}: ${e.seeded}` });
});
