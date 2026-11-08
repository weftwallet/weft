/**
 * The voter-credentials project's setup: a fresh election with voter
 * credentials for this run, and two voters registered for it
 * (support/experimental.ts), which voter-credentials.spec.ts uses.
 */

import { stack, test } from "../support/fixtures.ts";
import { createCredentialsElection, missingCredentialsStack } from "../support/experimental.ts";

test("create a fresh election with voter credentials for this run", { tag: "@fabric" }, async () => {
  test.setTimeout(240_000);
  test.skip(stack().mode !== "playground", "Needs the playground stack (WEFT_E2E_STACK=playground).");
  const missing = await missingCredentialsStack();
  test.skip(missing !== null, missing ?? "");
  const e = await createCredentialsElection();
  test.info().annotations.push({ type: "election", description: `${e.electionId} on ${e.channel}, voters ${e.voters.map((v) => v.id).join(" and ")}: ${e.seeded.replace(/\n/g, "; ")}` });
});
