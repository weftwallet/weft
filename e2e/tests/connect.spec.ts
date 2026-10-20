import { expect, stack, test } from "../support/fixtures.ts";

test("a site joins a network from an invite and connects", async ({ wallet }) => {
  const dapp = await wallet.dapp();
  expect(await wallet.join(dapp, "alice", stack().users.alice!)).toEqual({ added: true });
  expect(await dapp.request("weft_identity")).toBeNull();

  const me = await wallet.connect(dapp);
  expect(me.name).toBe("alice");
  expect(me.mspId).toBe("Org1MSP");
  expect((await dapp.request("weft_identity")).name).toBe("alice");

  const networks = await dapp.request("weft_networks");
  expect(networks).toHaveLength(1);
  expect(networks[0].active).toBe(true);
});

test("a site can't stack approval windows (-32002)", async ({ wallet }) => {
  const dapp = await wallet.dapp();
  const opened = wallet.context.waitForEvent("page");
  const first = dapp.request("weft_addNetwork", { url: stack().inviteUrl });
  const win = await opened;
  await win.waitForLoadState();

  const second = await dapp.request("weft_addNetwork", { url: stack().inviteUrl });
  expect(second.code).toBe(-32002);
  const approvalWindows = wallet.context.pages().filter((p) => p.url().includes("approve.html"));
  expect(approvalWindows).toHaveLength(1);

  await win.getByRole("button", { name: "Cancel" }).click();
  expect((await first).code).toBe(4001);
});

test("calls before connecting fail with 4100", async ({ wallet }) => {
  const dapp = await wallet.dapp();
  const result = await dapp.request("weft_evaluate", { channel: "mychannel", chaincode: "basic", fn: "GetAllAssets" });
  expect(result.code).toBe(4100);
});
