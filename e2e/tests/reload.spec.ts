import { expect, stack, test } from "../support/fixtures.ts";

// Chrome only reloads an unpacked extension in a windowed browser, so this
// runs with `pnpm test:headed` (under xvfb on Linux).
test("a page is told when Weft is reloaded under it", { tag: "@headed" }, async ({ wallet }) => {
  const s = stack();
  const dapp = await wallet.dapp();
  await dapp.record();
  await wallet.join(dapp, "alice", s.users.alice!);
  await wallet.connect(dapp);
  await dapp.events();

  const extensions = await wallet.context.newPage();
  await extensions.goto("chrome://extensions/");
  await extensions.evaluate(() => new Promise((r) => (globalThis as any).chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }, r)));
  await extensions.evaluate((id) => new Promise((r) => (globalThis as any).chrome.developerPrivate.reload(id, { failQuietly: true }, r)), wallet.id);

  await expect
    .poll(async () => (await dapp.events(0)).filter((e) => e.event === "disconnect").map((e) => e.payload.reason), { timeout: 10_000 })
    .toEqual(["wallet-updated"]);
  expect((await dapp.request("weft_identity")).message).toContain("Reload this page");
});
