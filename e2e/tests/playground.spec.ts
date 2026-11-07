import { expect, stack, test } from "../support/fixtures.ts";

test("the docs playground follows the wallet's connection", async ({ wallet }) => {
  const s = stack();
  test.skip(!s.sites.playground, "Build the playground first (pnpm --filter @weftwallet/playground build).");
  const page = await wallet.context.newPage();
  await page.goto(`${s.sites.playground}/?invite=${encodeURIComponent(s.inviteUrl)}`);
  await expect(page.locator("#pg-weft")).toHaveAttribute("data-state", "ok");
  await expect(page.locator("#pg-join")).toBeEnabled();

  await wallet.approve(
    () => page.locator("#pg-join").click(),
    async (win) => {
      await win.getByRole("button", { name: "Review invite" }).click();
      await win.locator("input.mono").fill("bob");
      await win.locator("input[type=password]").fill(s.users.bob!);
      await win.getByRole("button", { name: "Enrol", exact: true }).click();
      // The page's click returns at once; wait for the window to finish.
      await win.waitForEvent("close", { timeout: 20_000 });
    },
  );
  await wallet.approve(
    () => page.locator("#pg-connect").click(),
    (win) => win.locator("footer").getByRole("button", { name: "Connect" }).click(),
  );
  await expect(page.locator("#pg-conn")).toHaveText("Connected");

  await page.locator("#pg-disconnect").click();
  await expect(page.locator("#pg-conn")).toHaveText("Disconnected");

  await wallet.approve(
    () => page.locator("#pg-connect").click(),
    (win) => win.locator("footer").getByRole("button", { name: "Connect" }).click(),
  );
  const popup = await wallet.popup();
  await popup.getByRole("tab", { name: /Sites/ }).click();
  await popup.locator(".small-btn", { hasText: "Disconnect" }).click();
  await popup.locator(".sheet").getByRole("button", { name: "Disconnect" }).click();
  await expect(page.locator("#pg-conn")).toHaveText("Disconnected in Weft");
});

test("the playground's Private election section stays hidden without Weft", async ({ browser }) => {
  const s = stack();
  test.skip(!s.sites.playground, "Build the playground first (pnpm --filter @weftwallet/playground build).");
  const page = await browser.newPage();
  await page.goto(`${s.sites.playground}/?invite=${encodeURIComponent(s.inviteUrl)}`);
  // The page gives up looking for Weft after a moment, and says so.
  await expect(page.locator("#pg-weft")).toHaveAttribute("data-state", "missing");
  await expect(page.locator("#pg-private")).toBeHidden();
  await page.close();
});
