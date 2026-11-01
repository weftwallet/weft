import type { Locator, Page } from "@playwright/test";
import { expect, stack, test } from "../support/fixtures.ts";

/** Pictures of `part` at 1440 and 360 wide, light and dark, for checking by eye (test-results). */
async function look(page: Page, part: Locator, name: string) {
  const size = page.viewportSize();
  for (const width of [1440, 360]) {
    await page.setViewportSize({ width, height: 900 });
    // No page is wider than its window.
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), `${name} at ${width}`).toBeLessThanOrEqual(0);
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await part.scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      await part.screenshot({ path: test.info().outputPath(`${name}-${width}-${scheme}.png`) });
    }
  }
  await page.emulateMedia({ colorScheme: null });
  if (size) await page.setViewportSize(size);
}

// Needs the playground: the ballot contract, and explorers named in the invite.
test("vote from the docs playground and check the receipt in the explorer", { tag: "@fabric" }, async ({ wallet }) => {
  const s = stack();
  test.skip(!s.sites.playground || !s.explorerUrl, "Needs the built playground and the playground's explorers.");
  const dapp = await wallet.dapp();
  await wallet.join(dapp, "alice", s.users.alice!);

  const page = await wallet.context.newPage();
  await page.goto(`${s.sites.playground}/?invite=${encodeURIComponent(s.inviteUrl)}`);
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
      await win.getByRole("button", { name: "Sign and submit" }).click();
    },
  );
  const query = await readBack!;
  await query.waitForLoadState();
  await query.getByRole("button", { name: "Sign and read" }).click();
  await expect(page.locator("#pg-el-state")).toHaveText("Open");

  await page.getByLabel("Amber").check();
  let windowSalt = "";
  await wallet.approve(
    () => page.locator("#pg-el-vote").click(),
    async (win) => {
      // The choice is a private input: hidden until the voter asks to see it.
      await expect(win.getByText("Private, never on the ledger")).toBeVisible();
      await expect(win.getByText("Amber")).toHaveCount(0);
      await win.getByRole("button", { name: "Show" }).click();
      await expect(win.getByText(/"option":"Amber"/)).toBeVisible();
      // Weft chose the salt: the window shows the value it signs.
      windowSalt = JSON.parse((await win.getByText(/"option":"Amber"/).textContent())!).salt;
      expect(windowSalt).toMatch(/^[0-9a-f]{32}$/);
      // Keeping the receipt is off until the voter turns it on.
      const keep = win.getByRole("switch", { name: "Keep the receipt in Weft" });
      await expect(keep).not.toBeChecked();
      await keep.check();
      await win.getByRole("button", { name: "Sign and submit" }).click();
      await expect(win.locator(".kept-line")).toHaveText("Weft kept your receipt", { timeout: 30_000 });
      // It closes after a moment; the picture is for checking by eye.
      await win.screenshot({ path: test.info().outputPath("approve-kept.png") }).catch(() => {});
    },
  );
  await expect(page.locator("#pg-receipt")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("#pg-receipt-saved")).toHaveText(/^Weft kept your receipt\./);
  const receipt = JSON.parse((await page.locator("#pg-receipt-json").textContent())!);
  expect(receipt).toMatchObject({ electionId: id, option: "Amber", salt: windowSalt });

  // Weft's activity keeps the input's name, not the vote; the vote is in its
  // receipt, sealed.
  const vote = (await wallet.ui("activity")).find((a: any) => a.call.fn === "CastVote");
  expect(vote.privateInputs).toEqual(["ballot"]);
  expect(vote.receipt).toBe(true);
  expect(JSON.stringify(vote)).not.toContain("Amber");
  expect((await wallet.ui("receiptGet", { id: vote.id })).receipt).toEqual(receipt);
  await look(page, page.locator("#pg-receipt"), "playground-kept");

  // The link carries only the transaction and the commitment. The explorer's
  // page asks this one for the choice and salt, and checks them in the browser.
  const check = page.locator("#pg-receipt-check");
  const href = (await check.getAttribute("href"))!;
  expect(href).not.toContain(receipt.salt);
  expect(href).not.toContain("Amber");
  const opened = wallet.context.waitForEvent("page");
  await check.click();
  const explorer = await opened;
  // Until the explorer has indexed the block, it can't find the ballot, and
  // doesn't ask. Reloading keeps its opener.
  await expect
    .poll(async () => {
      if (await explorer.locator("#local").isVisible()) return true;
      await explorer.reload();
      return false;
    }, { timeout: 30_000 })
    .toBe(true);
  await expect(explorer.locator("#local-result")).toHaveText("It matches: this commitment is a vote for Amber.");
  expect(explorer.url()).not.toContain(receipt.salt);
  await expect(page.locator("#pg-receipt-saved")).toHaveText(/^The explorer asked for your choice and salt/);
  await look(page, page.locator("#pg-receipt"), "playground-receipt");
  await look(explorer, explorer.locator("#receipt"), "explorer-receipt");

  // From Weft: the receipt is with the vote, and Check in the explorer hands
  // it over the same way, from Weft's own window.
  const popup = await wallet.popup();
  await popup.getByRole("button", { name: /^CastVote\s*, receipt kept/ }).first().click();
  const fromWeft = wallet.context.waitForEvent("page", (p) => p.url().startsWith(`${s.explorerUrl}/channels/mychannel/elections/`));
  await popup.getByRole("button", { name: "Check in the explorer" }).click();
  const weftExplorer = await fromWeft;
  await expect(weftExplorer.locator("#local-result")).toHaveText("It matches: this commitment is a vote for Amber.");
  expect(weftExplorer.url()).not.toContain(receipt.salt);

  // Org1's explorer publishes the ballot's private data hash, and the voter,
  // holding the value, can check it's the one recorded.
  await explorer.goto(`${s.explorerUrl}/channels/mychannel/transactions/${receipt.txId}`);
  await expect(explorer.getByRole("heading", { name: "Private data" })).toBeVisible();
  await explorer.locator("#pd-value").fill(JSON.stringify({ option: "Amber", salt: receipt.salt }));
  await explorer.locator("#pd-check").click();
  await expect(explorer.locator("#pd-result")).toHaveText("It matches a value this transaction wrote.");

  // The seeded election is counted, and the count matches its ballots.
  await explorer.goto(`${s.explorerUrl}/channels/mychannel/elections/team-lunch`);
  await expect(explorer.getByText("The published total, 4, matches the 4 commitments on the ledger.")).toBeVisible();
});
