import { expect, stack, test } from "../support/fixtures.ts";

const disconnects = (events: { event: string; payload: any }[]) =>
  events.filter((e) => e.event === "disconnect").map((e) => e.payload.reason);

test("disconnect events reach every tab, whoever disconnects", async ({ wallet }) => {
  const tab1 = await wallet.dapp();
  const tab2 = await wallet.dapp();
  await tab1.record();
  await tab2.record();
  await wallet.join(tab1, "alice", stack().users.alice!);
  await wallet.connect(tab1);
  await tab1.events();
  await tab2.events();

  // The page disconnects itself.
  expect(await tab1.request("weft_disconnect")).toBeNull();
  expect(disconnects(await tab1.events())).toEqual(["site"]);
  expect(disconnects(await tab2.events())).toEqual(["site"]);
  expect(await tab1.request("weft_identity")).toBeNull();

  // The user disconnects it in Weft, from the Sites tab.
  await wallet.connect(tab1);
  await tab1.events();
  await tab2.events();
  const popup = await wallet.popup();
  await popup.getByRole("tab", { name: /Sites/ }).click();
  await popup.locator(".small-btn", { hasText: "Disconnect" }).click();
  await popup.locator(".sheet").getByRole("button", { name: "Disconnect" }).click();
  expect(disconnects(await tab1.events())).toEqual(["user"]);
  expect(disconnects(await tab2.events())).toEqual(["user"]);

  // Removing the last identity disconnects every site.
  await wallet.connect(tab1);
  await tab1.events();
  const state = await wallet.ui("state");
  await wallet.ui("removeIdentity", { identityId: state.identities[0].id });
  expect(disconnects(await tab1.events())).toEqual(["no-identity"]);
});

test("connections are per identity", async ({ wallet }) => {
  const s = stack();
  const dapp = await wallet.dapp();
  await dapp.record();
  await wallet.join(dapp, "alice", s.users.alice!);
  await wallet.join(dapp, "bob", s.users.bob!);
  const state = await wallet.ui("state");
  const alice = state.identities.find((i: any) => i.name === "alice");
  const bob = state.identities.find((i: any) => i.name === "bob");

  expect((await wallet.connect(dapp)).name).toBe("alice");
  await dapp.events();

  // Switching to an identity the site isn't approved for disconnects it.
  await wallet.ui("setActive", { identityId: bob.id });
  expect(disconnects(await dapp.events())).toEqual(["identity-changed"]);
  expect(await dapp.request("weft_identity")).toBeNull();

  // Approving bob too, then switching back to alice, keeps it connected.
  expect((await wallet.connect(dapp)).name).toBe("bob");
  await dapp.events();
  await wallet.ui("setActive", { identityId: alice.id });
  const events = await dapp.events();
  expect(events.find((e) => e.event === "identityChanged")?.payload.name).toBe("alice");
  expect(events.some((e) => e.event === "networkChanged")).toBe(true);
  expect(disconnects(events)).toEqual([]);
});
