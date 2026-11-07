/**
 * weft_castBallot end to end (docs/adr/0007): Weft Experimental casts a
 * private ballot from a site on a real network, and the site gets the
 * transaction and a version 2 receipt, never the choice.
 *
 * Runs in the experimental-stack project, against `pnpm playground:up
 * --experimental` (WEFT_E2E_STACK=playground), in the election that
 * experimental.setup.ts creates for the run (support/experimental.ts). The
 * voter is alice.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { CONTRACT, runElection } from "../support/experimental.ts";
import { BUILDS, expect, stack, test } from "../support/fixtures.ts";

test.describe("Weft Experimental casts a ballot", () => {
  test.skip(!existsSync(join(BUILDS.experimental, "manifest.json")), "Build Weft Experimental's test build first (pnpm --filter @weftwallet/extension build:e2e:experimental).");
  test.use({ build: "experimental" });

  test("from a site, which gets the receipt and never the choice", { tag: "@fabric" }, async ({ wallet }) => {
    test.setTimeout(180_000);
    const run = runElection();
    test.skip(!run, "No election for this run: the experimental-setup project makes one on pnpm playground:up --experimental.");
    const ELECTION = run!.electionId;
    const CHANNEL = run!.channel;
    // Enrolled here, so Weft keeps Org1's CA chain and checks its peer's signature on the election.
    await wallet.enroll("alice", stack().users.alice!, { channels: ["mychannel", CHANNEL], name: "Weft playground" });
    const dapp = await wallet.dapp();
    const params = { channel: CHANNEL, chaincode: CONTRACT, electionId: ELECTION };

    let fingerprint = "";
    const result = await wallet.approve(
      () => dapp.request("weft_castBallot", params),
      async (win) => {
        await expect(win.getByRole("heading", { name: /^Vote in / })).toBeVisible({ timeout: 40_000 });
        await expect(win.getByText(/^Weft read this election from the ledger through localhost:8787/)).toBeVisible();
        await expect(win.getByRole("button", { name: "Review your vote" })).toBeDisabled();
        await win.getByLabel("Plan B").check();
        await win.getByRole("button", { name: "Review your vote" }).click();
        await expect(win.getByRole("heading", { name: "Vote for Plan B?" })).toBeVisible();
        await expect(win.getByText("Org1MSP and Org2MSP each hold part of this election's key. Any 2 of them together could read your ballot.")).toBeVisible();
        await expect(win.getByText("Weft checked Org1MSP's peer signature on the election it read.")).toBeVisible();
        fingerprint = await win.locator(".fingerprint").innerText();
        await win.getByRole("switch", { name: "Keep the receipt in Weft" }).check();
        await win.getByRole("button", { name: "Sign and vote" }).click();
        await expect(win.getByText(/^Committed in block/)).toBeVisible({ timeout: 90_000 });
        await expect(win.getByText("Weft kept your receipt")).toBeVisible();
      },
    );

    expect(result).toMatchObject({
      status: "VALID",
      receipt: { kept: true, receipt: { type: "weft-ballot-receipt", version: 2, channel: CHANNEL, electionId: ELECTION, txId: result.transactionId } },
    });
    expect(result.blockNumber).toMatch(/^\d+$/);
    expect(result.receipt.receipt.blockNumber).toBe(Number(result.blockNumber));
    const tracking: string = result.receipt.receipt.tracking;
    expect(tracking).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(result)).not.toContain("Plan B");

    // The ballot is on the ledger under its tracking code, and the fingerprint
    // Weft showed is the one in the election's record.
    await wallet.connect(dapp);
    const read = (fn: string, args: string[]) =>
      wallet.approve(
        () => dapp.request("weft_evaluate", { ...params, chaincode: CONTRACT, fn, args }),
        (win) => win.getByRole("button", { name: "Sign and read" }).click(),
      );
    const ballot = JSON.parse((await read("GetBallot", [ELECTION, tracking])).text);
    expect(ballot).toMatchObject({ txId: result.transactionId, tracking });
    const election = JSON.parse((await read("GetElection", [ELECTION])).text);
    expect(fingerprint.replace(/\s+/g, "")).toBe(election.fingerprint);
    expect(election.state).toBe("open");

    // The contract refuses a second ballot, and the window says so.
    const again = await wallet.approve(
      () => dapp.request("weft_castBallot", params),
      async (win) => {
        await expect(win.getByText(/^Your Weft activity has a ballot from alice in this election/)).toBeVisible({ timeout: 40_000 });
        await win.getByLabel("Plan A").check();
        await win.getByRole("button", { name: "Review your vote" }).click();
        await win.getByRole("button", { name: "Sign and vote" }).click();
        await expect(win.getByRole("heading", { name: /^You've already voted in / })).toBeVisible({ timeout: 40_000 });
        await win.getByRole("button", { name: "Close" }).click();
      },
    );
    expect(again).toMatchObject({ code: 5001, message: "This identity has already voted in this election." });

    // The popup's activity has the ballot with its receipt, and the note opens only in Weft.
    const popup = await wallet.popup();
    await popup.getByRole("button", { name: /CastBallot.*receipt kept/ }).click();
    await expect(popup.getByText("Ballot receipt, version 2")).toBeVisible();
    await expect(popup.getByText("Plan B")).toHaveCount(0);
    await popup.getByRole("button", { name: "Show" }).click();
    await expect(popup.getByText("Plan B")).toBeVisible();
  });
});
