import { clickToClose, expect, stack, test } from "../support/fixtures.ts";

test("the approval window keeps Reject and Sign on screen with many arguments", async ({ wallet }) => {
  const dapp = await wallet.dapp();
  await wallet.join(dapp, "alice", stack().users.alice!);
  await wallet.connect(dapp);
  const opened = wallet.context.waitForEvent("page");
  void dapp.request("weft_submit", {
    channel: "otherchannel", chaincode: "basic", fn: "CreateAsset",
    args: ["asset7", "teal", "5", "Ifeanyi", "300", "extra-1", "extra-2", "extra-3"],
  });
  const win = await opened;
  await win.setViewportSize({ width: 380, height: 640 });
  await win.waitForLoadState();
  const sign = win.getByRole("button", { name: "Sign and submit" });
  await expect(sign).toBeInViewport();
  await expect(win.getByRole("button", { name: "Reject" })).toBeInViewport();
  // Every argument is listed (the list scrolls, it doesn't squash).
  await expect(win.locator(".args__row")).toHaveCount(8);
  // The channel isn't in the invite, so the user is warned.
  await expect(win.getByText("doesn't list the channel")).toBeVisible();
  await clickToClose(win, win.getByRole("button", { name: "Reject" }));
});

test("opening a confirmation doesn't scroll the popup", async ({ wallet }) => {
  await wallet.enroll("alice", stack().users.alice!);
  const popup = await wallet.popup();
  await popup.getByRole("button", { name: "Manage identities" }).click();
  await popup.getByRole("button", { name: /^Remove / }).click();
  for (let i = 0; i < 6; i++) {
    const offsets = await popup.evaluate(() => [document.scrollingElement!.scrollTop, document.getElementById("root")!.scrollTop]);
    expect(offsets).toEqual([0, 0]);
    await popup.waitForTimeout(40);
  }
  await expect(popup.locator(".sheet")).toBeVisible();
  await popup.keyboard.press("Escape");
  await expect(popup.locator(".sheet")).toHaveCount(0);
});

test("a long MSP ID doesn't cover the identities button", async ({ wallet }) => {
  await wallet.enroll("bob", stack().users.bob!, {
    name: "Northwind Trade Finance Consortium (Production)",
    organization: "Northwind Freight Holdings International",
    mspId: "NorthwindFreightHoldingsInternationalMSP",
    channels: ["letters-of-credit", "invoices"],
  });
  const popup = await wallet.popup();
  await popup.getByRole("button", { name: "Manage identities" }).click({ timeout: 5000 });
  await expect(popup.getByRole("heading", { name: "Identities" })).toBeVisible();
});

test("many identities are grouped by network and can be filtered", async ({ wallet }) => {
  const s = stack();
  // Six identities (enough for the filter) across two networks. The CA lets a
  // user enrol more than once, so alice and bob are enough.
  for (let i = 0; i < 6; i++) {
    const user = i % 2 ? "bob" : "alice";
    const b = i >= 4;
    await wallet.enroll(user, s.users[user]!, { name: `Network ${b ? "B" : "A"}`, mspId: `Org${b ? 2 : 1}MSP`, relayUrl: `${s.relayUrl}/n${b ? 1 : 0}` });
  }

  const popup = await wallet.popup();
  await popup.getByRole("button", { name: "Manage identities" }).click();
  await expect(popup.locator(".group-head")).toHaveCount(2);
  await popup.getByLabel("Filter identities and networks").fill("Network B");
  await expect(popup.locator(".group-head")).toHaveCount(1);
  await expect(popup.locator(".group-head__title")).toHaveText("Network B");
});
