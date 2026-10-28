import type { Page } from "@playwright/test";
import { expect, stack, test } from "../support/fixtures.ts";

// Needs the playground: the ballot contract, and explorers named in the invite.
test("vote from the docs playground and check the receipt in the explorer", { tag: "@fabric" }, async ({ wallet }) => {
  const s = stack();
  test.skip(!s.docsUrl || !s.explorerUrl, "Needs the built docs and the playground's explorers.");
  const dapp = await wallet.dapp();
  await wallet.join(dapp, "alice", s.users.alice!);

  const page = await wallet.context.newPage();
  await page.goto(`${s.docsUrl}/playground/?invite=${encodeURIComponent(s.inviteUrl)}`);
  await wallet.approve(
    () => page.locator("#pg-connect").click(),
    (win) => win.locator("footer").getByRole("button", { name: "Connect" }).click(),
  );
  await expect(page.locator("#pg-conn")).toHaveText("Connected");

  // Both organisations' explorers are listed, found through the invite's one.
  await expect(page.locator(".pg-explorer")).toHaveCount(2);
  await expect(page.locator(".pg-explorer").filter({ hasText: "Org2's explorer" })).toContainText("submitters hidden");

  // A new election, so the test can vote however often it runs.
  const id = `e2e-${Date.now()}`;
  await page.getByText("Start your own election").click();
  await page.locator("#pg-new-id").fill(id);
  await page.locator("#pg-new-title").fill("Which colour?");
  await page.locator("#pg-new-options").fill("Teal, Amber");
  // Creating it, then the page reads it back: two approvals.
  let readBack: Promise<Page> | undefined;
  await wallet.approve(
    () => page.locator("#pg-new-create").click(),
    async (win) => {
      readBack = wallet.context.waitForEvent("page");
      await win.getByRole("button", { name: "Sign & submit" }).click();
    },
  );
  const query = await readBack!;
  await query.waitForLoadState();
  await query.getByRole("button", { name: "Sign & query" }).click();
  await expect(page.locator("#pg-el-state")).toHaveText("Open");

  await page.getByLabel("Amber").check();
  await wallet.approve(
    () => page.locator("#pg-el-vote").click(),
    async (win) => {
      // The choice is private data: listed, but its value isn't shown.
      await expect(win.getByText("private", { exact: true })).toBeVisible();
      await expect(win.getByText("Amber")).toHaveCount(0);
      await win.getByRole("button", { name: "Sign & submit" }).click();
    },
  );
  await expect(page.locator("#pg-receipt")).toBeVisible({ timeout: 30_000 });
  const receipt = JSON.parse((await page.locator("#pg-receipt-json").textContent())!);
  expect(receipt).toMatchObject({ electionId: id, option: "Amber" });

  // The link carries the choice and salt in the fragment, and the explorer's
  // page checks them in the browser.
  const href = (await page.locator("#pg-receipt-check").getAttribute("href"))!;
  expect(href.split("#")[0]).not.toContain(receipt.salt);
  const explorer = await wallet.context.newPage();
  // Until the explorer has indexed the block, it can't find the ballot.
  await expect
    .poll(async () => {
      await explorer.goto(href);
      return explorer.locator("#local").isVisible();
    }, { timeout: 20_000 })
    .toBe(true);
  await expect(explorer.locator("#local-result")).toHaveText("It matches: this commitment is a vote for Amber.");
  expect(explorer.url()).not.toContain(receipt.salt);

  // The seeded election is counted, and the count matches its ballots.
  await explorer.goto(`${s.explorerUrl}/channels/mychannel/elections/team-lunch`);
  await expect(explorer.getByText("The published total, 4, matches the 4 commitments on the ledger.")).toBeVisible();
});
