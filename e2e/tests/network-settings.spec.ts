import { expect, stack, test } from "../support/fixtures.ts";

test("refreshing from the invite shows changes before applying them", async ({ wallet, site }) => {
  const s = stack();
  const invite = {
    weft: 1, network: "Changing network", organization: "Org1", mspId: "Org1MSP",
    caUrl: s.caUrl, caName: "ca-org1", relayUrl: s.relayUrl, channels: ["mychannel"],
  };
  const inviteUrl = site.serve("/invite.json", invite);
  const dapp = await wallet.dapp();
  await wallet.join(dapp, "alice", s.users.alice!, inviteUrl);

  // The organisation adds a channel.
  site.serve("/invite.json", { ...invite, channels: ["mychannel", "shipments"] });
  const popup = await wallet.popup();
  await popup.getByRole("button", { name: "Manage identities" }).click();
  await popup.getByRole("button", { name: /Network settings for Changing network/ }).click();
  await popup.getByRole("button", { name: "Refresh from invite" }).click();
  await expect(popup.getByText("The invite has changed")).toBeVisible();
  await expect(popup.getByText("shipments")).toBeVisible();
  await popup.getByRole("button", { name: "Apply changes" }).click();
  await expect.poll(async () => (await wallet.ui("state")).networks[0].channels).toEqual(["mychannel", "shipments"]);
});

test("a relay address that doesn't answer is flagged before saving", async ({ wallet }) => {
  await wallet.enroll("bob", stack().users.bob!);
  const popup = await wallet.popup();
  await popup.getByRole("button", { name: "Manage identities" }).click();
  await popup.getByRole("button", { name: /Network settings for/ }).click();
  await popup.locator("button.disclosure").click();
  await popup.getByLabel("Relay URL").fill("http://localhost:9");
  await popup.getByRole("button", { name: "Test and save" }).click();
  await expect(popup.getByText("Weft couldn't confirm these addresses")).toBeVisible();
  await expect(popup.getByText("The relay couldn't be reached.")).toBeVisible();

  await popup.getByRole("button", { name: "Save anyway" }).click();
  await popup.locator(".sheet").getByRole("button", { name: "Save" }).click();
  await expect.poll(async () => (await wallet.ui("state")).networks[0].relayUrl).toBe("http://localhost:9");
});

test("networks added without an invite can edit their channels", async ({ wallet }) => {
  await wallet.enroll("alice", stack().users.alice!);
  const popup = await wallet.popup();
  await popup.getByRole("button", { name: "Manage identities" }).click();
  await popup.getByRole("button", { name: /Network settings for/ }).click();
  await expect(popup.getByText("Added without an invite")).toBeVisible();
  await popup.locator("button.disclosure").click();
  await popup.getByLabel("Channels").fill("mychannel, shipments");
  await popup.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(async () => (await wallet.ui("state")).networks[0].channels).toEqual(["mychannel", "shipments"]);

  // With two channels, the header shows a picker.
  await popup.goto(wallet.url("popup.html"));
  await expect(popup.getByLabel("Channel")).toBeVisible();
});
