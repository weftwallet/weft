import { expect, stack, test } from "../support/fixtures.ts";

test("sites hear once when the certificate they use is close to expiring", async ({ wallet }) => {
  const s = stack();
  test.skip(!s.shortInviteUrl, "Needs the ten-day CA, which only the default stack starts.");
  const dapp = await wallet.dapp();
  await dapp.record();
  await wallet.join(dapp, "erin", s.shortUsers.erin!, s.shortInviteUrl!);
  const me = await wallet.connect(dapp);
  await dapp.events();

  // The worker checks hourly and when the active identity is set.
  await wallet.ui("setActive", { identityId: me.id });
  const first = (await dapp.events()).filter((e) => e.event === "certificateStatus");
  expect(first).toHaveLength(1);
  expect(first[0]!.payload).toMatchObject({ identityId: me.id, state: "expiring" });
  expect(first[0]!.payload.daysLeft).toBeLessThanOrEqual(10);

  await wallet.ui("setActive", { identityId: me.id });
  expect((await dapp.events()).filter((e) => e.event === "certificateStatus")).toHaveLength(0);
});
