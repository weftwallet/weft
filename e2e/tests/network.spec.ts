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

  // Checked in the browser: each organisation's signed checkpoint, then the
  // hashes back from it to the block.
  await channel.getByText("Check a block in your browser").click();
  await expect(channel.locator(".nw-hash--ok")).toHaveCount(2, { timeout: 20_000 });
  await expect(channel.getByText(/All 2 organisations signed a ledger with the same block \d+\. Checked in this browser\./)).toBeVisible();
  await expect(channel.getByText(/Org2MSP signed block \d+/)).toBeVisible();

  // The explorer's block page checks its own hash, and links here.
  const block = await wallet.context.newPage();
  await block.goto(`${s.explorerUrl}/channels/mychannel/blocks/3`);
  await expect(block.getByText("Your browser computed the same hash from this header.")).toBeVisible();
  await expect(block.getByRole("link", { name: "network page" })).toHaveAttribute("href", /operators\/network\/\?explorer=/);
});
