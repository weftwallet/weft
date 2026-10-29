import { expect, stack, test } from "../support/fixtures.ts";

// Needs real peers: run against `pnpm playground:up` with WEFT_E2E_STACK=playground.
test("evaluate and submit against the basic contract", { tag: "@fabric" }, async ({ wallet }) => {
  const s = stack();
  const dapp = await wallet.dapp();
  await wallet.join(dapp, "alice", s.users.alice!);
  await wallet.connect(dapp);
  const call = { channel: "mychannel", chaincode: "basic" };

  const init = await wallet.approve(
    () => dapp.request("weft_submit", { ...call, fn: "InitLedger" }),
    (win) => win.getByRole("button", { name: "Sign and submit" }).click(),
  );
  expect(init.status).toBe("VALID");
  expect(Number(init.blockNumber)).toBeGreaterThan(0);

  const all = await wallet.approve(
    () => dapp.request("weft_evaluate", { ...call, fn: "GetAllAssets" }),
    (win) => win.getByRole("button", { name: "Sign and query" }).click(),
  );
  expect(JSON.parse(all.text).length).toBeGreaterThan(0);

  const id = `e2e-${Date.now()}`;
  const created = await wallet.approve(
    () => dapp.request("weft_submit", { ...call, fn: "CreateAsset", args: [id, "teal", "5", "Weft", "300"] }),
    (win) => win.getByRole("button", { name: "Sign and submit" }).click(),
  );
  expect(created.status).toBe("VALID");

  const read = await wallet.approve(
    () => dapp.request("weft_evaluate", { ...call, fn: "ReadAsset", args: [id] }),
    (win) => win.getByRole("button", { name: "Sign and query" }).click(),
  );
  expect(JSON.parse(read.text).ID).toBe(id);

  const activity = await wallet.ui("activity");
  expect(activity.filter((a: any) => a.status === "committed")).toHaveLength(2);
});
