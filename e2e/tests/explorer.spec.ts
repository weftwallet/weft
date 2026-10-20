import type { Page } from "@playwright/test";
import { expect, stack, test, type Wallet } from "../support/fixtures.ts";

/** Members-only transactions the page's viewer gets back from the API. */
const membersOnly = (page: Page) =>
  page.evaluate(async () => {
    const txs = await (await fetch("/api/v1/channels/mychannel/transactions?limit=100")).json();
    return txs.filter((t: { membersOnly?: boolean }) => t.membersOnly).length;
  });

/** Clicks "Sign in with Weft" and approves the connect and sign-in windows. */
async function signIn(wallet: Wallet, page: Page) {
  const connectWindow = wallet.context.waitForEvent("page");
  await page.getByRole("button", { name: "Sign in with Weft" }).click();
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
  await expect(page.getByRole("button", { name: "Sign in with Weft" })).toBeVisible();
});
