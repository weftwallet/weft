import type { Page } from "@playwright/test";
import { expect, stack, test, type Wallet } from "../support/fixtures.ts";

/**
 * Members-only transactions the page's viewer gets back from the API, across
 * every page, since the elections tests add more than a page of votes.
 */
const membersOnly = (page: Page) =>
  page.evaluate(async () => {
    let count = 0;
    let before: number | undefined;
    for (;;) {
      const query = before === undefined ? "limit=100" : `limit=100&before=${before}`;
      const txs: { membersOnly?: boolean; blockNumber: string | number }[] = await (
        await fetch(`/api/v1/channels/mychannel/transactions?${query}`)
      ).json();
      count += txs.filter((t) => t.membersOnly).length;
      if (txs.length < 100) return count;
      before = Math.min(...txs.map((t) => Number(t.blockNumber)));
    }
  });

/** Clicks "Sign in with Weft" and approves the connect and sign-in windows. */
async function signIn(wallet: Wallet, page: Page) {
  const connectWindow = wallet.context.waitForEvent("page");
  await page.locator("header").getByRole("button", { name: "Sign in with Weft" }).click();
  const connect = await connectWindow;
  await connect.locator("footer").getByRole("button", { name: "Connect" }).click();
  const signInWindow = await wallet.context.waitForEvent("page");
  await expect(signInWindow.getByText("It doesn't sign a transaction")).toBeVisible();
  await signInWindow.getByRole("button", { name: "Sign in", exact: true }).click();
}

// Needs the playground's explorer, which publishes _lifecycle to members only.
test("signing in to the explorer with Weft shows what members see", { tag: "@fabric" }, async ({ wallet }) => {
  const s = stack();
  test.skip(!s.explorerUrl, "The playground explorer isn't running.");
  const dapp = await wallet.dapp();
  await wallet.join(dapp, "alice", s.users.alice!);

  const page = await wallet.context.newPage();
  await page.goto(s.explorerUrl!);
  await page.waitForFunction(() => (window as any).weft?.isWeft);
  expect(await membersOnly(page)).toBeGreaterThan(0);

  await signIn(wallet, page);
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  await expect(page.getByRole("link", { name: /alice/ })).toBeVisible();
  expect(await membersOnly(page)).toBe(0);

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.locator("header").getByRole("button", { name: "Sign in with Weft" })).toBeVisible();
});

// The playground runs explorers for Org1 and Org2, each from its own peer.
test("the playground's two explorers agree on mychannel", { tag: "@fabric" }, async ({ wallet }) => {
  const s = stack();
  test.skip(!s.explorerUrl, "The playground explorer isn't running.");
  const page = await wallet.context.newPage();
  await page.goto(s.explorerUrl!);
  await expect
    .poll(async () => page.evaluate(async () => (await (await fetch("/api/v1/channels/mychannel/organisations")).json())), { timeout: 40_000 })
    .toEqual([expect.objectContaining({ mspId: "Org2MSP", state: "agree" })]);
  // The first block is the channel's configuration, described in words.
  await page.goto(`${s.explorerUrl}/channels/mychannel/blocks/0`);
  await expect(page.getByRole("heading", { name: "How the channel started" })).toBeVisible();
  await expect(page.locator(".changes li").first()).toHaveText(/The channel starts with .*Org1MSP.*Org2MSP.* as members\./);
  await page.goto(`${s.explorerUrl}/channels/mychannel/blocks/1`);
  await expect(page.getByText("2 of 2 organisations report this block")).toBeVisible();
});
