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

test("signing in on the network page shows the members-only channel", { tag: "@fabric" }, async ({ wallet }) => {
  const s = stack();
  test.skip(!s.docsUrl || !s.explorerUrl, "Needs the built docs and the playground's explorers.");
  const dapp = await wallet.dapp();
  await wallet.join(dapp, "alice", s.users.alice!);
  const page = await wallet.context.newPage();
  await page.goto(`${s.docsUrl}/operators/network/?explorer=${encodeURIComponent(s.explorerUrl!)}`);
  const members = page.locator(".nw-card", { has: page.locator("h2", { hasText: /^members/ }) });
  await expect(page.locator(".nw-card", { has: page.locator("h2", { hasText: "mychannel" }) })).toBeVisible();
  await expect(members).toHaveCount(0);

  // One sign-in, handed to both organisations' explorers.
  await wallet.approve(() => page.locator("#nw-signin-button").click(), (win) => win.locator("footer").getByRole("button", { name: "Connect" }).click());
  const signIn = await wallet.context.waitForEvent("page");
  await signIn.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator("#nw-signin-text")).toContainText("Signed in as alice (Org1MSP)", { timeout: 20_000 });
  await expect(members.locator("tbody tr")).toHaveCount(2);
  await expect(members.locator(".nw-tag")).toHaveText("members only");
  await expect(members.locator(".nw-verdict")).toContainText(/All 2 organisations agree/, { timeout: 40_000 });
  await members.getByText("Check a block in your browser").click();
  await expect(members.locator(".nw-hash--ok")).toHaveCount(2, { timeout: 20_000 });

  // Signing out forgets it.
  await page.locator("#nw-signin-button").click();
  await expect(members).toHaveCount(0);
});
