import { expect, stack, test } from "../support/fixtures.ts";

// Needs the playground's two explorers and the built docs.
test("the network page finds every explorer and compares their blocks", { tag: "@fabric" }, async ({ wallet }) => {
  const s = stack();
  test.skip(!s.docsUrl || !s.explorerUrl, "Needs the built docs and the playground's explorers.");
  const page = await wallet.context.newPage();
  // One explorer is enough: the page finds Org2's through Org1's.
  await page.goto(`${s.docsUrl}/operators/network/?explorer=${encodeURIComponent(s.explorerUrl!)}`);
  const channel = page.locator(".nw-card", { has: page.locator("h2", { hasText: "mychannel" }) });
  await expect(channel.locator("tbody tr")).toHaveCount(2);
  await expect(channel.getByText("Org2MSP", { exact: true })).toBeVisible();
  await expect(channel.locator(".nw-verdict")).toContainText(/All 2 organisations agree on every block up to \d+\./, { timeout: 40_000 });

  await channel.getByText("Compare a block's hash across explorers").click();
  await expect(channel.locator(".nw-hash--ok")).toHaveCount(2);
  await expect(channel.getByText(/Every explorer has the same block \d+\./)).toBeVisible();
});
