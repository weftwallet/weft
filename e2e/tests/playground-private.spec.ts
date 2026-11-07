/**
 * The playground's Private election section end to end (docs/adr/0007):
 * bob votes from Weft Playground in Weft Experimental's window, the page
 * gets the receipt and never the choice, both explorers find the tracking
 * code, a second ballot is refused, `pnpm playground:count` closes and
 * counts the election, and the tally shows on the playground and on both
 * explorers.
 *
 * Runs in the experimental-stack project, after cast-ballot.spec.ts, in the
 * election experimental.setup.ts created for the run (support/experimental.ts).
 */

import type { Page } from "@playwright/test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { countRunElection, runElection, type RunElection } from "../support/experimental.ts";
import { BUILDS, expect, stack, test, type Wallet } from "../support/fixtures.ts";

const EXPLORERS = (process.env.WEFT_E2E_PRIVATE_EXPLORERS ?? "http://localhost:8790,http://localhost:8791").split(",").map((u) => u.trim().replace(/\/+$/, ""));
const api = (base: string, e: RunElection, path = "") => `${base}/api/v1/channels/${e.channel}/private-elections/${e.electionId}${path}`;

async function getJson(url: string): Promise<any> {
  const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}

/** Opens the playground on the stack's invite and chooses the run's election in the Private election section. */
async function openSection(wallet: Wallet, e: RunElection): Promise<Page> {
  const page = await wallet.context.newPage();
  await page.goto(`${stack().sites.playground}/?invite=${encodeURIComponent(stack().inviteUrl)}`);
  const section = page.locator("#pg-private");
  await expect(section).toBeVisible();
  await expect(section.locator("#pg-pe-status")).toContainText("private election");
  await section.getByRole("radio", { name: new RegExp(e.title) }).check();
  await expect(section.locator("#pg-pe-title")).toHaveText(e.title);
  return page;
}

test.describe("the playground's Private election section", () => {
  test.skip(!existsSync(join(BUILDS.experimental, "manifest.json")), "Build Weft Experimental's test build first (pnpm --filter @weftwallet/extension build:e2e:experimental).");
  test.use({ build: "experimental" });

  test("votes through Weft Experimental, never learns the choice, and shows the count", { tag: "@fabric" }, async ({ wallet }) => {
    test.setTimeout(300_000);
    const e = runElection();
    test.skip(!e, "No election for this run: the experimental-setup project makes one on pnpm playground:up --experimental.");
    test.skip(!stack().sites.playground, "Build the playground first (pnpm --filter @weftwallet/playground build).");
    const run = e!;
    await wallet.enroll("bob", stack().users.bob!, { channels: ["mychannel", run.channel], name: "Weft playground" });

    const page = await openSection(wallet, run);
    const section = page.locator("#pg-private");
    await expect(section.locator("#pg-pe-state")).toHaveText("Open");
    await expect(section.locator("#pg-pe-options")).toHaveText(run.options.join(", "));
    const vote = section.getByRole("button", { name: "Vote in Weft" });

    // bob chooses Plan A in Weft's window, and keeps the receipt.
    await wallet.approve(
      () => vote.click(),
      async (win) => {
        await expect(win.getByRole("heading", { name: `Vote in ${run.title}` })).toBeVisible({ timeout: 40_000 });
        await win.getByLabel("Plan A").check();
        await win.getByRole("button", { name: "Review your vote" }).click();
        await win.getByRole("switch", { name: "Keep the receipt in Weft" }).check();
        await win.getByRole("button", { name: "Sign and vote" }).click();
        await expect(win.getByText(/^Committed in block/)).toBeVisible({ timeout: 90_000 });
      },
    );
    await expect(section.locator("#pg-pe-message")).toContainText("Your ballot is in block", { timeout: 30_000 });
    await expect(section.locator("#pg-pe-state")).toHaveText("Voted");
    await expect(section.locator("#pg-pe-receipt-saved")).toHaveText(/^Weft kept your receipt\./);
    const receipt = JSON.parse(await section.locator("#pg-pe-receipt-json").innerText());
    expect(receipt).toMatchObject({ type: "weft-ballot-receipt", version: 2, channel: run.channel, electionId: run.electionId });
    expect(receipt.tracking).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(receipt).sort()).toEqual(["blockNumber", "channel", "electionId", "tracking", "txId", "type", "version"]);
    await expect(section.getByRole("link", { name: "Check it in the explorer" })).toHaveAttribute("href", new RegExp(`\\?tracking=${receipt.tracking}#receipt$`));
    // The page sent three strings and got back a transaction and a receipt: no option name in the conversation.
    const log = await page.locator("#pg-log").innerText();
    expect(log).toContain("weft_castBallot");
    expect(log).toContain(`"electionId": "${run.electionId}"`);
    expect(log).not.toMatch(/Plan [ABC]/);
    await expect(section.locator("#pg-pe-vote-wrap")).toBeHidden();

    // Both organisations' explorers find the tracking code.
    for (const base of EXPLORERS) {
      await expect.poll(async () => (await getJson(api(base, run, `/tracking/${receipt.tracking}`))).found, { timeout: 30_000, message: `${base} finds the tracking code` }).toBe(true);
    }

    // A second ballot from bob, from a fresh page: the contract refuses it, and the page says so.
    const again = await openSection(wallet, run);
    await wallet.approve(
      () => again.locator("#pg-private").getByRole("button", { name: "Vote in Weft" }).click(),
      async (win) => {
        await expect(win.getByText(/^Your Weft activity has a ballot from bob in this election/)).toBeVisible({ timeout: 40_000 });
        await win.getByLabel("Plan C").check();
        await win.getByRole("button", { name: "Review your vote" }).click();
        await win.getByRole("button", { name: "Sign and vote" }).click();
        await expect(win.getByRole("heading", { name: /^You've already voted in / })).toBeVisible({ timeout: 40_000 });
        await win.getByRole("button", { name: "Close" }).click();
      },
    );
    await expect(again.locator("#pg-pe-error")).toContainText("Your ballot wasn't committed: this identity has already voted in this election.");
    await expect(again.locator("#pg-pe-error summary")).toHaveText("Details");
    await again.close();

    // pnpm playground:count closes the election with both trustees and publishes the tally.
    const before = (await getJson(api(EXPLORERS[0]!, run))).ballots.total as number;
    expect(before).toBeGreaterThanOrEqual(1);
    expect(countRunElection(run)).toContain(`(${run.electionId}), counted`);

    // The playground shows the tally from the explorer, after Refresh or the 15-second update.
    await section.getByRole("button", { name: "Refresh" }).click();
    await expect(section.locator("#pg-pe-state")).toHaveText("Counted", { timeout: 30_000 });
    const tally = section.locator("#pg-pe-result .pg-tally");
    await expect(tally).toBeVisible();
    const shown = await tally.locator("dd").allInnerTexts();
    expect(shown.map(Number).reduce((a, b) => a + b, 0)).toBe(before);
    expect(Number(shown[0])).toBeGreaterThanOrEqual(1);
    await expect(section.locator("#pg-pe-result")).toContainText(`${before} ${before === 1 ? "ballot" : "ballots"}. Org1MSP and Org2MSP posted their decryption shares`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

    // Both explorers show the same count, on their API and their pages.
    for (const base of EXPLORERS) {
      await expect.poll(async () => (await getJson(api(base, run))).phase, { timeout: 30_000 }).toBe("counted");
      const v = await getJson(api(base, run));
      expect(v.tally).toEqual({ counts: shown.map(Number), total: before });
      const explorer = await wallet.context.newPage();
      await explorer.goto(`${base}/channels/${run.channel}/elections/${run.electionId}`);
      await expect(explorer.locator("#result")).toContainText(`The counts add up to the ${before} ${before === 1 ? "ballot" : "ballots"}, and both decryption shares verify.`);
      await explorer.close();
    }
  });
});
