/**
 * Ballot receipts (docs/adr/0006) without a Fabric network: Weft's checks on
 * the receipt a site sends, the approval window's "Keep the receipt in
 * Weft", and a kept receipt in the popup, down to handing its choice and
 * salt to the explorer's page by message. A vote that really commits, and
 * the real explorer, are in elections.spec.ts (@fabric).
 */
import type { Page } from "@playwright/test";
import { expect, stack, test, type Wallet } from "../support/fixtures.ts";

const SALT = "7c1e94a0b3d25f86e0a4c9172bd35e6f";
const TX = "e41b22d89f3a1c07b25e6d0c4a7f38e19b5c2d74a6e0f18c3b9d5a2e7f04c61d";
const COMMITMENT = "348fb0f843ed08a3fd1a39e9b6c54e2b1392b421768c9a1ccf353540b1d4e333";
const vote = (option: string, salt: string) => ({
  channel: "mychannel",
  chaincode: "ballot",
  fn: "CastVote",
  args: ["board-2026"],
  transient: { ballot: JSON.stringify({ option, salt }) },
});
const asks = (salt: string) => ({ type: "weft-ballot-receipt", version: 1, channel: "mychannel", electionId: "board-2026", option: "Ada", salt });

test("a receipt that doesn't match the call fails with -32602 before any window opens", async ({ wallet }) => {
  const dapp = await wallet.dapp();
  await wallet.join(dapp, "alice", stack().users.alice!);
  await wallet.connect(dapp);
  const before = wallet.context.pages().length;
  const cases: [unknown, RegExp][] = [
    [{ ...asks(SALT), voter: "alice" }, /a field Weft doesn't keep: "voter"/],
    [{ ...asks(SALT), channel: "elections" }, /for the channel "elections", but the call is on "mychannel"/],
    [asks("0d5b8e21c4f97a36b1e0d2c58f4a7391"), /aren't the ones in any private input/],
    [asks("generate"), /no private input of this call is a JSON object with its option and "salt": "generate"/],
  ];
  for (const [receipt, message] of cases) {
    const result = await dapp.request("weft_submit", { ...vote("Ada", SALT), receipt });
    expect(result.code).toBe(-32602);
    expect(result.message).toMatch(message);
  }
  const read = await dapp.request("weft_evaluate", { ...vote("Ada", SALT), receipt: asks(SALT) });
  expect(read).toMatchObject({ code: -32602, message: 'Only weft_submit takes a "receipt": a read has nothing to record.' });
  expect(wallet.context.pages().length).toBe(before);
});

test("the approval window offers to keep the receipt, off until the user turns it on, with the salt Weft chose", async ({ wallet }) => {
  const dapp = await wallet.dapp();
  await wallet.join(dapp, "alice", stack().users.alice!);
  await wallet.connect(dapp);
  const opened = wallet.context.waitForEvent("page");
  const result = dapp.request("weft_submit", { ...vote("Ada", "generate"), receipt: asks("generate") });
  const win = await opened;
  await win.waitForLoadState();
  await win.setViewportSize({ width: 380, height: 640 });

  const keep = win.getByRole("switch", { name: "Keep the receipt in Weft" });
  await expect(keep).not.toBeChecked();
  await expect(win.getByText("localhost:5175 asks for this vote in board-2026.")).toBeVisible();
  await expect(win.getByText("Weft chose the salt at random.", { exact: false })).toBeVisible();
  await expect(win.locator(".in-receipt")).toHaveCount(0);
  await keep.check();
  await expect(win.locator(".args__key .in-receipt")).toHaveText("receipt");

  // The value shown, and signed, has the salt Weft chose, not the placeholder.
  await win.getByRole("button", { name: "Show" }).click();
  const value = (await win.locator(".args__row", { hasText: "ballot" }).locator(".args__value").textContent())!;
  const ballot = JSON.parse(value);
  expect(ballot).toEqual({ option: "Ada", salt: expect.stringMatching(/^[0-9a-f]{32}$/) });
  await win.getByRole("button", { name: "View raw request" }).click();
  const raw = JSON.parse((await win.locator("#raw-request").textContent())!);
  expect(raw.receipt).toEqual({ ...asks(ballot.salt) });
  await win.getByRole("button", { name: "Hide", exact: true }).click();
  expect(JSON.parse((await win.locator("#raw-request").textContent())!).receipt).toMatchObject({ option: "hidden", salt: "hidden" });
  await shoot(win, "approve-keep");

  await win.getByRole("button", { name: "Reject" }).click();
  expect((await result).code).toBe(4001);
});

/**
 * Puts a kept receipt in Weft as the worker would after a vote: the activity
 * record, flagged, and the receipt with its choice and salt sealed with the
 * key derived from the vault key, the record's ID as additional data. A
 * mismatch with lib/vault.ts would show as the receipt not opening.
 */
async function keepReceipt(wallet: Wallet, identityId: string, at = Date.now()) {
  const id = "receipt-activity-1";
  await wallet.worker.evaluate(
    async ({ id, identityId, at, SALT, TX, COMMITMENT }) => {
      const enc = new TextEncoder();
      const raw = new Uint8Array(((await chrome.storage.session.get("vaultKey")) as { vaultKey: number[] }).vaultKey);
      const material = await crypto.subtle.importKey("raw", raw, "HKDF", false, ["deriveKey"]);
      const key = await crypto.subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt: new ArrayBuffer(0), info: enc.encode("weft receipts v1") },
        material,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt"],
      );
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const data = new Uint8Array(
        await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(id) }, key, enc.encode(JSON.stringify({ option: "Ada", salt: SALT }))),
      );
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const r = indexedDB.open("weft");
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      const tx = db.transaction(["activity", "receipts"], "readwrite");
      const origin = "http://localhost:5175";
      tx.objectStore("activity").put({
        id, at, origin, identityId, kind: "submit", status: "committed",
        call: { channel: "mychannel", chaincode: "ballot", fn: "CastVote", args: ["board-2026"] },
        privateInputs: ["ballot"], transactionId: TX, blockNumber: "85", code: "VALID", receipt: true,
      });
      tx.objectStore("receipts").put({
        id, identityId, origin, type: "weft-ballot-receipt", version: 1, channel: "mychannel", electionId: "board-2026",
        txId: TX, blockNumber: 85, commitment: COMMITMENT, sealed: { iv, data }, keptAt: at,
      });
      await new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    },
    { id, identityId, at, SALT, TX, COMMITMENT },
  );
  return id;
}

/** Light and dark, for checking by eye (test-results). */
async function shoot(page: Page, name: string) {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(250);
    await page.screenshot({ path: test.info().outputPath(`${name}-${scheme}.png`), fullPage: true });
  }
  await page.emulateMedia({ colorScheme: null });
}

test("a kept receipt is with its vote in the popup, and goes to the explorer by message", async ({ wallet, site }) => {
  // A stand-in for the explorer's election page: it asks its opener, as the
  // real one does, and shows what it was given.
  const electionPath = "/channels/mychannel/elections/board-2026";
  site.page(
    electionPath,
    `<!doctype html><title>Election</title><body><script>
      window.addEventListener("message", function (e) {
        if (e.source !== window.opener) return;
        document.body.dataset.got = JSON.stringify({ origin: e.origin, data: e.data });
      });
      window.opener.postMessage({ type: "weft-receipt-check:ready", version: 1 }, "*");
    </script></body>`,
  );
  const identity = await wallet.enroll("alice", stack().users.alice!, { explorerUrl: site.origin });
  await keepReceipt(wallet, identity.id);

  const popup = await wallet.popup();
  const row = popup.getByRole("button", { name: /^CastVote\s*, receipt kept/ });
  await expect(row).toBeVisible();
  await expect(row.locator(".in-receipt")).toHaveText("receipt");
  await row.click();

  const card = popup.locator("section", { has: popup.getByRole("heading", { name: "Receipt" }) });
  await expect(card).toBeVisible();
  await expect(card.getByText("board-2026")).toBeVisible();
  await expect(card.getByText("Ada")).toHaveCount(0);
  await expect(popup.getByText("(kept in the receipt)")).toBeVisible();
  await card.getByRole("button", { name: "Show" }).click();
  await expect(card.getByText("Ada")).toBeVisible();
  await expect(card.locator(".grouped")).toHaveText(SALT.match(/.{4}/g)!.join(""));
  await shoot(popup, "popup-receipt");

  // Copy gives the same JSON the playground gives.
  // The clipboard, caught: an extension's page can't be granted it here.
  await popup.evaluate(() => {
    navigator.clipboard.writeText = async (text: string) => void ((window as any).__copied = text);
  });
  await card.getByRole("button", { name: "Copy receipt" }).click();
  await expect(popup.getByText("Copied. It includes your choice and salt.")).toBeVisible();
  const copied = JSON.parse(await popup.evaluate(() => (window as any).__copied));
  expect(copied).toEqual({ type: "weft-ballot-receipt", version: 1, channel: "mychannel", electionId: "board-2026", txId: TX, blockNumber: 85, commitment: COMMITMENT, option: "Ada", salt: SALT });

  // Check in the explorer: Weft's window opens the election page with only
  // public values in its address, and answers its ask at its exact origin.
  const checking = wallet.context.waitForEvent("page");
  const explorerOpens = wallet.context.waitForEvent("page", (p) => p.url().startsWith(site.origin + electionPath));
  await card.getByRole("button", { name: "Check in the explorer" }).click();
  const helper = await checking;
  expect(helper.url()).toContain("receipt.html?id=");
  let explorer: Page;
  try {
    explorer = await explorerOpens;
  } catch {
    throw new Error("Weft's window didn't open the explorer");
  }
  await expect.poll(() => explorer.evaluate(() => document.body.dataset.got ?? null)).not.toBeNull();
  const got = JSON.parse((await explorer.evaluate(() => document.body.dataset.got))!);
  expect(got.origin).toBe(wallet.url("").replace(/\/$/, ""));
  expect(got.data).toEqual({ type: "weft-receipt-check:receipt", version: 1, electionId: "board-2026", txId: TX, option: "Ada", salt: SALT });
  expect(explorer.url()).toBe(`${site.origin}${electionPath}?tx=${TX}&commitment=${COMMITMENT}#receipt`);
  expect(explorer.url()).not.toContain(SALT);
  // Its job done, Weft's window closes.
  await helper.waitForEvent("close", { timeout: 5000 });

  // Locking hides the choice and salt again.
  await wallet.lock();
  await expect(popup.getByRole("heading", { name: "Weft is locked" })).toBeVisible();
  await wallet.unlock();
  await expect(card.getByText("board-2026")).toBeVisible();
  await expect(card.getByText("Ada")).toHaveCount(0);

  // Removing it keeps the transaction, without its flag.
  await popup.getByRole("button", { name: "Remove receipt" }).click();
  await expect(popup.getByRole("alertdialog", { name: "Remove this receipt?" })).toContainText("Your vote stays on the ledger.");
  await popup.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click();
  await expect(popup.getByRole("heading", { name: "Receipt" })).toHaveCount(0);
  await expect(popup.getByText("(values not kept)")).toBeVisible();
  const activity = await wallet.ui("activity");
  expect(activity[0].receipt).toBeUndefined();
});

test("an old receipt stays in the list, and goes with its identity", async ({ wallet }) => {
  const identity = await wallet.enroll("alice", stack().users.alice!);
  // Older than the 50 most recent.
  await keepReceipt(wallet, identity.id, Date.now() - 30 * 86_400_000);
  await wallet.worker.evaluate(async (identityId) => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const r = indexedDB.open("weft");
      r.onsuccess = () => resolve(r.result);
    });
    const tx = db.transaction("activity", "readwrite");
    for (let i = 0; i < 55; i++) {
      tx.objectStore("activity").put({
        id: `read-${i}`, at: Date.now() - i * 1000, origin: "http://localhost:5175", identityId, kind: "evaluate", status: "evaluated",
        call: { channel: "mychannel", chaincode: "basic", fn: "ReadAsset", args: [`asset${i}`] },
      });
    }
    await new Promise((r) => (tx.oncomplete = r));
    db.close();
  }, identity.id);
  const activity = await wallet.ui("activity");
  expect(activity).toHaveLength(51);
  expect(activity[50]).toMatchObject({ id: "receipt-activity-1", receipt: true });

  const popup = await wallet.popup();
  await expect(popup.getByText("Showing the 50 most recent, and every transaction with a kept receipt.")).toBeAttached();
  await popup.getByRole("button", { name: "Manage identities" }).click();
  await popup.getByRole("button", { name: "Remove alice" }).click();
  const sheet = popup.getByRole("alertdialog", { name: "Remove alice?" });
  await expect(sheet).toContainText("Weft also deletes the 1 ballot receipt kept with alice's activity, for board-2026.");
  await sheet.getByRole("button", { name: "Remove" }).click();
  await expect(popup.locator(".toast", { hasText: "Removed alice" })).toBeVisible();
  expect(await wallet.ui("receiptsOf", { identityId: identity.id })).toEqual({ count: 0, elections: [] });
});
