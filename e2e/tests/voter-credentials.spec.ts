/**
 * Voter credentials end to end (docs/adr/0008): two voters, each in a
 * browser profile of their own with Weft Experimental, vote anonymously in
 * an election with voter credentials from Weft Playground's Private election
 * section. Each copies the voter invite from the section, enrols at the
 * election's voters' CA in Weft Experimental's popup, and votes in Weft's
 * window. A vote before enrolling, and a second ballot from one credential,
 * are refused with the section's messages. `pnpm playground:count` closes
 * and counts the election, and the tally shows on the playground and on
 * both explorers, whose full check in the browser checks each ballot's
 * one-off identity and pseudonym proof with the idemix module.
 *
 * Runs in the voter-credentials project, in the election
 * voter-credentials.setup.ts created for the run (support/experimental.ts).
 */

import type { Page } from "@playwright/test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { countRunElection, credentialsElection, type CredentialsElection } from "../support/experimental.ts";
import { BUILDS, clickToClose, expect, launchWallet, stack, test, type Wallet } from "../support/fixtures.ts";

const EXPLORERS = (process.env.WEFT_E2E_PRIVATE_EXPLORERS ?? "http://localhost:8790,http://localhost:8791").split(",").map((u) => u.trim().replace(/\/+$/, ""));
const api = (base: string, e: CredentialsElection, path = "") => `${base}/api/v1/channels/${e.channel}/private-elections/${e.electionId}${path}`;

async function getJson(url: string): Promise<any> {
  const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}

/** Opens the playground on the stack's invite and chooses the run's election in the Private election section. */
async function openSection(wallet: Wallet, e: CredentialsElection): Promise<Page> {
  const page = await wallet.context.newPage();
  await page.goto(`${stack().sites.playground}/?invite=${encodeURIComponent(stack().inviteUrl)}`);
  const section = page.locator("#pg-private");
  await expect(section).toBeVisible();
  await expect(section.locator("#pg-pe-status")).toContainText("private election");
  await section.getByRole("radio", { name: new RegExp(e.title) }).check();
  await expect(section.locator("#pg-pe-title")).toHaveText(e.title);
  return page;
}

/** Copies the voter invite from the section, as a voter does, and returns what was copied. */
async function copyInvite(page: Page, e: CredentialsElection): Promise<string> {
  const section = page.locator("#pg-private");
  await expect(section.getByRole("heading", { name: "Get a voter credential" })).toBeVisible();
  await expect(section.locator("#pg-pe-invite-url")).toHaveText(e.inviteUrl);
  await section.getByRole("button", { name: "Copy voter invite" }).click();
  await expect(section.locator("#pg-pe-invite-status")).toHaveText("Copied. Paste it into Weft Experimental's Join from an invite.");
  return page.evaluate(() => navigator.clipboard.readText());
}

/** Joins from the voter invite in Weft Experimental's popup and gets a voter credential. */
async function enrol(wallet: Wallet, invite: string, voter: { id: string; secret: string }, e: CredentialsElection) {
  const p = await wallet.popup();
  await p.getByRole("button", { name: "Join from an invite" }).first().click();
  await p.getByLabel("Invite link").fill(invite);
  await p.getByRole("button", { name: "Review invite" }).click();
  await expect(p.getByText(e.voterMsp).first()).toBeVisible({ timeout: 20_000 });
  await p.getByLabel("Enrolment ID").fill(voter.id);
  await p.getByLabel("Enrolment secret", { exact: true }).fill(voter.secret);
  await p.getByRole("button", { name: "Get a voter credential" }).click();
  await expect(p.getByRole("heading", { name: "Identities" })).toBeVisible({ timeout: 60_000 });
  await expect(p.getByRole("region", { name: "Voter credentials" })).toContainText(e.electionId);
  await p.close();
}

/** Votes from the section in Weft's window, keeping the receipt, and returns it. */
async function vote(wallet: Wallet, page: Page, e: CredentialsElection, option: string) {
  const section = page.locator("#pg-private");
  await wallet.approve(
    () => section.getByRole("button", { name: "Vote in Weft" }).click(),
    async (win) => {
      await expect(win.getByRole("heading", { name: `Vote in ${e.title}` })).toBeVisible({ timeout: 60_000 });
      await win.getByLabel(option).check();
      await win.getByRole("button", { name: "Review your vote" }).click();
      await win.getByRole("switch", { name: "Keep the receipt in Weft" }).check();
      await win.getByRole("button", { name: "Sign and vote" }).click();
      await expect(win.getByText(/^Committed in block/)).toBeVisible({ timeout: 90_000 });
    },
  );
  await expect(section.locator("#pg-pe-message")).toContainText("Your ballot is in block", { timeout: 30_000 });
  await expect(section.locator("#pg-pe-message")).toContainText(`This page doesn't know your choice or which voter you are: Weft signed it as an anonymous member of ${e.voterMsp}.`);
  await expect(section.locator("#pg-pe-state")).toHaveText("Voted");
  const receipt = JSON.parse(await section.locator("#pg-pe-receipt-json").innerText());
  expect(receipt).toMatchObject({ type: "weft-ballot-receipt", version: 2, channel: e.channel, electionId: e.electionId });
  return receipt as { tracking: string; txId: string };
}

test.describe("voter credentials in Weft Playground", () => {
  test.skip(!existsSync(join(BUILDS.experimental, "manifest.json")), "Build Weft Experimental's test build first (pnpm --filter @weftwallet/extension build:e2e:experimental).");
  test.use({ build: "experimental" });

  test("two voters enrol and vote anonymously, and both explorers count and check them", { tag: "@fabric" }, async ({ wallet, site }, testInfo) => {
    test.setTimeout(480_000);
    const e = credentialsElection();
    test.skip(!e, "No election for this run: the voter-credentials-setup project makes one on pnpm playground:up --experimental.");
    test.skip(!stack().sites.playground, "Build the playground first (pnpm --filter @weftwallet/playground build).");
    const run = e!;
    const [a, b] = run.voters as [{ id: string; secret: string }, { id: string; secret: string }];
    const playground = new URL(stack().sites.playground!).origin;

    // The first voter, in the fixture's profile.
    await wallet.context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: playground });
    const page = await openSection(wallet, run);
    const section = page.locator("#pg-private");
    await expect(section.locator("#pg-pe-state")).toHaveText("Open");
    await expect(section.locator("#pg-pe-voters")).toHaveText(`Anonymous, with voter credentials from ${run.voterMsp}. Each credential votes once.`);

    // Before enrolling: Weft holds no credential for it, and no ballot is cast.
    await wallet.approve(
      () => section.getByRole("button", { name: "Vote in Weft" }).click(),
      async (win) => {
        await expect(win.getByRole("button", { name: "Close" })).toBeVisible({ timeout: 40_000 });
        await clickToClose(win, win.getByRole("button", { name: "Close" }));
      },
    );
    await expect(section.locator("#pg-pe-error")).toContainText(`Weft has no voter credential for ${run.electionId}, so no ballot was cast.`);
    await expect(section.locator("#pg-pe-error")).toContainText("Code 4300");

    const invite = await copyInvite(page, run);
    expect(invite).toBe(run.inviteUrl);
    await enrol(wallet, invite, a, run);
    const first = await vote(wallet, page, run, "Ada Obi");
    // The page sent three strings and got back a transaction and a receipt: no option, and no voter.
    const log = await page.locator("#pg-log").innerText();
    expect(log).toContain("weft_castBallot");
    expect(log).not.toMatch(/Ada Obi|Ben Carter|Chioma Ude/);
    expect(log).not.toContain(a.id);
    await expect(section.locator("#pg-pe-invite")).toBeHidden();

    // A second ballot from the same credential, from a fresh page: the contract refuses it by its pseudonym.
    const again = await openSection(wallet, run);
    await wallet.approve(
      () => again.locator("#pg-private").getByRole("button", { name: "Vote in Weft" }).click(),
      async (win) => {
        await expect(win.getByRole("heading", { name: `Vote in ${run.title}` })).toBeVisible({ timeout: 60_000 });
        await win.getByLabel("Chioma Ude").check();
        await win.getByRole("button", { name: "Review your vote" }).click();
        await win.getByRole("button", { name: "Sign and vote" }).click();
        await expect(win.getByRole("heading", { name: /^You've already voted in / })).toBeVisible({ timeout: 60_000 });
        await clickToClose(win, win.getByRole("button", { name: "Close" }));
      },
    );
    await expect(again.locator("#pg-pe-error")).toContainText(`Your ballot wasn't committed: this voter credential has already voted in ${run.electionId}.`);
    await again.close();

    // The second voter, in a browser profile of their own.
    const other = await launchWallet(site, "experimental", testInfo.outputPath("profile-b"));
    try {
      await other.context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: playground });
      const pageB = await openSection(other, run);
      await enrol(other, await copyInvite(pageB, run), b, run);
      const second = await vote(other, pageB, run, "Ben Carter");
      expect(second.tracking).not.toBe(first.tracking);
      await pageB.close();
    } finally {
      await other.context.close();
    }

    // Both explorers have the two ballots, with two different pseudonyms, and name neither voter.
    for (const base of EXPLORERS) {
      await expect.poll(async () => (await getJson(api(base, run))).ballots.total, { timeout: 30_000, message: `${base} has both ballots` }).toBe(2);
      const { ballots } = await getJson(api(base, run, "/ballots"));
      expect(ballots.map((x: any) => x.verified)).toEqual([true, true]);
      expect(new Set(ballots.map((x: any) => x.voterTag)).size).toBe(2);
      for (const x of ballots) expect(x.anonymousCreator).toMatchObject({ mspId: run.voterMsp, ou: "voters", role: "member" });
      expect(JSON.stringify(ballots)).not.toContain(a.id);
      expect((await getJson(api(base, run, `/tracking/${first.tracking}`))).found).toBe(true);
    }

    // pnpm playground:count closes the election with both trustees and publishes the tally.
    expect(countRunElection(run)).toContain(`(${run.electionId}), counted`);
    await section.getByRole("button", { name: "Refresh" }).click();
    await expect(section.locator("#pg-pe-state")).toHaveText("Counted", { timeout: 30_000 });
    await expect(section.locator("#pg-pe-result .pg-tally dd")).toHaveText(["1", "1", "0"]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

    // Both explorers show the count, and their full check in the browser checks every pseudonym.
    for (const base of EXPLORERS) {
      await expect.poll(async () => (await getJson(api(base, run))).phase, { timeout: 30_000 }).toBe("counted");
      expect((await getJson(api(base, run))).tally).toEqual({ counts: [1, 1, 0], total: 2 });
      const explorer = await wallet.context.newPage();
      await explorer.goto(`${base}/channels/${run.channel}/elections/${run.electionId}`);
      await expect(explorer.locator(".private-banner")).toContainText(`signed by an anonymous member of ${run.voterMsp}`);
      await expect(explorer.locator("#ballots th").nth(base === EXPLORERS[0] ? 2 : 1)).toHaveText("Pseudonym");
      await explorer.getByRole("button", { name: "Check every ballot" }).click();
      const result = explorer.locator("#xcheck-result .banner");
      await expect(result).toContainText("Everything checks out.", { timeout: 120_000 });
      await expect(result).toContainText("the 2 ballots, their 2 different pseudonyms, the totals and both decryption shares give Ada Obi 1, Ben Carter 1 and Chioma Ude 0.");
      await expect(explorer.locator('[data-step="pseudonyms"] [data-word]')).toHaveText("2 ballots check out");
      expect(await explorer.content()).not.toContain(a.id);
      await explorer.close();
    }
  });
});
