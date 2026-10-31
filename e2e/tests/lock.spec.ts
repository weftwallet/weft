import { PASSWORD, expect, stack, test } from "../support/fixtures.ts";

/** What the worker stored for each identity's key. */
async function storedKeys(wallet: { worker: import("@playwright/test").Worker }) {
  return wallet.worker.evaluate(
    () =>
      new Promise<{ wrapped: boolean; legacy: boolean }[]>((resolve, reject) => {
        const open = indexedDB.open("weft");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const get = open.result.transaction("identities").objectStore("identities").getAll();
          get.onsuccess = () => resolve(get.result.map((r: any) => ({ wrapped: !!r.wrappedKey?.data, legacy: !!r.privateKey })));
          get.onerror = () => reject(get.error);
        };
      }),
  );
}

test.describe("a new wallet", () => {
  test.use({ walletPassword: null });

  test("asks for a password before saving the first key", async ({ wallet }) => {
    const dapp = await wallet.dapp();
    const added = await wallet.approve(
      () => dapp.request("weft_addNetwork", { url: stack().inviteUrl }),
      async (win) => {
        await expect(win.getByRole("heading", { name: "Set a password" })).toBeVisible();
        await win.getByLabel("Password", { exact: true }).fill("short");
        await win.getByLabel("Password again").fill("short");
        await win.getByRole("button", { name: "Set password" }).click();
        await expect(win.locator(".field-error")).toHaveText("Use at least 8 characters.");
        await win.getByLabel("Password", { exact: true }).fill(PASSWORD);
        await win.getByLabel("Password again").fill(PASSWORD);
        await win.getByRole("button", { name: "Set password" }).click();

        await win.getByRole("button", { name: "Review invite" }).click();
        await win.locator("input.mono").fill("alice");
        await win.locator("input[type=password]").fill(stack().users.alice!);
        await win.getByRole("button", { name: "Enrol", exact: true }).click();
      },
    );
    expect(added).toEqual({ added: true });
    expect((await wallet.ui("vaultStatus")).state).toBe("unlocked");
    expect(await storedKeys(wallet)).toEqual([{ wrapped: true, legacy: false }]);
  });

  test("the popup asks for a password when adding an identity", async ({ wallet }) => {
    const popup = await wallet.popup();
    // The expert paths sit behind a disclosure; the invite is the one tile.
    await popup.getByRole("button", { name: "More ways to add an identity" }).click();
    await popup.getByRole("button", { name: /Enrol with CA/ }).click();
    await expect(popup.getByRole("heading", { name: "Set a password" })).toBeVisible();
    await popup.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await popup.getByLabel("Password again").fill(`${PASSWORD}!`);
    await popup.getByRole("button", { name: "Set password" }).click();
    await expect(popup.locator(".field-error")).toHaveText("The passwords don't match.");
    await popup.getByLabel("Password again").fill(PASSWORD);
    await popup.getByRole("button", { name: "Set password" }).click();
    await expect(popup.getByText("Enrolment ID")).toBeVisible();
  });
});

test("keys are stored encrypted and can't be used while locked", async ({ wallet }) => {
  await wallet.enroll("alice", stack().users.alice!);
  expect(await storedKeys(wallet)).toEqual([{ wrapped: true, legacy: false }]);

  await wallet.lock();
  await expect(wallet.enroll("bob", stack().users.bob!)).rejects.toThrow("Weft is locked");
  await expect(wallet.ui("vaultUnlock", { password: "not the password" })).rejects.toThrow("That password isn't right.");
  await wallet.unlock();
  await wallet.enroll("bob", stack().users.bob!);
});

test("a locked wallet asks to unlock before showing a signature request", async ({ wallet }) => {
  const dapp = await wallet.dapp();
  await wallet.join(dapp, "alice", stack().users.alice!);
  await wallet.connect(dapp);
  await wallet.lock();

  // Public information stays readable while locked.
  expect((await dapp.request("weft_identity")).name).toBe("alice");

  const result = await wallet.approve(
    () => dapp.request("weft_evaluate", { channel: "mychannel", chaincode: "basic", fn: "GetAllAssets" }),
    async (win) => {
      await expect(win.getByRole("heading", { name: "Weft is locked" })).toBeVisible();
      await expect(win.getByText("is waiting. Unlock to review the request.")).toBeVisible();
      await win.getByLabel("Password").fill("not the password");
      await win.getByRole("button", { name: "Unlock" }).click();
      await expect(win.locator(".field-error")).toHaveText("That password isn't right.");
      await win.getByLabel("Password").fill(PASSWORD);
      await win.getByRole("button", { name: "Unlock" }).click();
      await expect(win.getByRole("heading", { name: "Read from the ledger?" })).toBeVisible();
      await win.getByRole("button", { name: "Sign and read" }).click();
    },
  );
  // It signed: without peers the relay reports a network failure, a later step than the lock.
  if (stack().mode === "ca") expect([5001, 5002]).toContain(result.code);
  else expect(result.text).toBeDefined();
});

test("cancelling the unlock rejects the request", async ({ wallet }) => {
  const dapp = await wallet.dapp();
  await wallet.join(dapp, "alice", stack().users.alice!);
  await wallet.connect(dapp);
  await wallet.lock();
  const result = await wallet.approve(
    () => dapp.request("weft_submit", { channel: "mychannel", chaincode: "basic", fn: "InitLedger" }),
    (win) => win.getByRole("button", { name: "Reject", exact: true }).click(),
  );
  expect(result.code).toBe(4001);
});

test("the popup locks from Security and unlocks with the password", async ({ wallet }) => {
  await wallet.enroll("alice", stack().users.alice!);
  const popup = await wallet.popup();
  await popup.getByRole("button", { name: "Security" }).click();
  await popup.getByRole("button", { name: "Lock now" }).click();
  await expect(popup.getByRole("heading", { name: "Weft is locked" })).toBeVisible();
  await popup.getByLabel("Password").fill(PASSWORD);
  await popup.getByRole("button", { name: "Unlock" }).click();
  // It comes back to the screen it was locked from.
  await expect(popup.getByRole("heading", { name: "Security" })).toBeVisible();
});

test("Escape closes the auto-lock list without leaving Security", async ({ wallet }) => {
  await wallet.enroll("alice", stack().users.alice!);
  const popup = await wallet.popup();
  await popup.getByRole("button", { name: "Security" }).click();
  const select = popup.getByLabel("Lock automatically");
  const before = await select.inputValue();
  await select.click();
  await popup.keyboard.press("Escape");
  await expect(popup.getByRole("heading", { name: "Security" })).toBeVisible();
  await popup.waitForTimeout(300);
  await expect(popup.getByRole("heading", { name: "Security" })).toBeVisible();
  // Chosen from the list, the setting changes as before.
  await select.selectOption({ index: 0 });
  await expect(select).not.toHaveValue(before);
});

test("an open popup locks when Weft locks elsewhere", async ({ wallet }) => {
  await wallet.enroll("alice", stack().users.alice!);
  const popup = await wallet.popup();
  await expect(popup.getByText("Active identity")).toBeVisible();
  await wallet.worker.evaluate(() => (globalThis as any).chrome.storage.session.remove(["vaultKey", "lockAt"]));
  await expect(popup.getByRole("heading", { name: "Weft is locked" })).toBeVisible();
});

test("auto-lock schedules an alarm, and changing the password keeps the keys", async ({ wallet }) => {
  await wallet.enroll("alice", stack().users.alice!);
  await wallet.ui("setAutoLock", { minutes: 5 });
  const alarm = await wallet.worker.evaluate(() => (globalThis as any).chrome.alarms.get("weft-auto-lock"));
  expect(alarm.scheduledTime - Date.now()).toBeGreaterThan(4 * 60_000);
  expect(alarm.scheduledTime - Date.now()).toBeLessThanOrEqual(5 * 60_000);
  await wallet.ui("setAutoLock", { minutes: 0 });
  expect(await wallet.worker.evaluate(() => (globalThis as any).chrome.alarms.get("weft-auto-lock"))).toBeUndefined();

  await expect(wallet.ui("changePassword", { current: "wrong password", next: "a new password" })).rejects.toThrow(
    "That password isn't right.",
  );
  await wallet.ui("changePassword", { current: PASSWORD, next: "a new password" });
  await wallet.lock();
  await expect(wallet.unlock()).rejects.toThrow("That password isn't right.");
  await wallet.ui("vaultUnlock", { password: "a new password" });
  await wallet.enroll("bob", stack().users.bob!);
});

test("a passkey with PRF unlocks Weft", async ({ wallet }) => {
  await wallet.enroll("alice", stack().users.alice!);
  const page = await wallet.context.newPage();
  // A virtual authenticator with PRF (hmac-secret), attached to this tab.
  const cdp = await wallet.context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      ctap2Version: "ctap2_1",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
      hasPrf: true,
    },
  });

  await page.goto(wallet.url("passkey.html?action=add"));
  // The window closes itself when done; keep it open so the same authenticator unlocks next.
  await page.evaluate(() => (window.close = () => {}));
  await page.getByLabel("Name").fill("Test key");
  await page.getByRole("button", { name: "Create passkey" }).click();
  await expect(page.getByText("Passkey added")).toBeVisible();
  const status = await wallet.ui("vaultStatus");
  expect(status.passkeys.map((p: any) => p.name)).toEqual(["Test key"]);

  await wallet.lock();
  await page.goto(wallet.url("passkey.html?action=unlock"));
  await page.evaluate(() => (window.close = () => {}));
  await page.getByRole("button", { name: "Use passkey" }).click();
  await expect(page.getByText("Unlocked")).toBeVisible();
  expect((await wallet.ui("vaultStatus")).state).toBe("unlocked");
});

test("a wallet from before the lock sets a password and re-enrols its old keys", async ({ wallet }) => {
  await wallet.enroll("alice", stack().users.alice!);
  // Turn the record into what older versions saved: a non-extractable key, no vault.
  await wallet.worker.evaluate(async () => {
    const chrome = (globalThis as any).chrome;
    const raw = new Uint8Array((await chrome.storage.session.get("vaultKey")).vaultKey);
    const vaultKey = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["unwrapKey"]);
    const db: IDBDatabase = await new Promise((resolve) => {
      const open = indexedDB.open("weft");
      open.onsuccess = () => resolve(open.result);
    });
    const done = (r: IDBRequest) => new Promise((resolve) => (r.onsuccess = () => resolve(r.result)));
    const [identity] = (await done(db.transaction("identities").objectStore("identities").getAll())) as any[];
    const w = identity.wrappedKey;
    identity.privateKey = await crypto.subtle.unwrapKey(
      "pkcs8", w.data, vaultKey, { name: "AES-GCM", iv: w.iv }, { name: "ECDSA", namedCurve: w.curve }, false, ["sign"],
    );
    delete identity.wrappedKey;
    await done(db.transaction("identities", "readwrite").objectStore("identities").put(identity));
    await done(db.transaction("settings", "readwrite").objectStore("settings").delete("vault"));
    await chrome.storage.session.remove(["vaultKey", "lockAt"]);
  });

  const popup = await wallet.popup();
  await expect(popup.getByRole("heading", { name: "Weft needs a password now" })).toBeVisible();
  await popup.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await popup.getByLabel("Password again").fill(PASSWORD);
  await popup.getByRole("button", { name: "Set password" }).click();

  await expect(popup.getByText("isn't encrypted on disk")).toBeVisible();
  await popup.getByRole("button", { name: "Re-enrol as alice" }).click();
  await expect(popup.getByText("isn't encrypted on disk")).toBeHidden();
  expect(await storedKeys(wallet)).toEqual([{ wrapped: true, legacy: false }]);
});

test("a forgotten password resets Weft after typing the phrase, keeping networks", async ({ wallet }) => {
  const dapp = await wallet.dapp();
  await wallet.join(dapp, "alice", stack().users.alice!);
  await wallet.connect(dapp);
  await dapp.record();
  await wallet.lock();

  const popup = await wallet.popup();
  await popup.getByLabel("Password").fill("not it");
  await popup.getByRole("button", { name: "Unlock" }).click();
  await expect(popup.locator(".field-error")).toHaveText("That password isn't right.");
  // After a wrong password the mark stays still rather than weaving in again.
  await expect(popup.locator(".lock-screen__mark svg")).toHaveClass(/weave--still/);

  await popup.getByRole("button", { name: "Forgot your password?" }).click();
  await expect(popup.getByRole("heading", { name: "Reset Weft?" })).toBeVisible();
  const reset = popup.getByRole("button", { name: "Reset Weft" });
  await expect(reset).toBeDisabled();
  await popup.getByLabel(/to confirm/).fill("reset");
  await expect(reset).toBeDisabled();
  await popup.getByLabel(/to confirm/).fill("reset weft");
  await reset.click();

  await expect(popup.getByText("An identity wallet for Hyperledger Fabric")).toBeVisible();
  const state = await wallet.ui("state");
  expect(state.identities).toHaveLength(0);
  expect(state.sites).toHaveLength(0);
  expect(state.vault.state).toBe("none");
  expect(state.networks).toHaveLength(1);
  expect((await dapp.events()).map((e) => e.event)).toContain("disconnect");
});
