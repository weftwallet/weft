/**
 * The explorer's private election pages and full check (docs/adr/0007), on
 * a real network: both organisations' explorers, started with
 * WEFT_EXPERIMENTAL=1, show the same election, every ballot's proofs
 * verify, a tracking code from Weft's link lands on its ballot, and Check
 * every ballot passes in the browser's workers, then fails when one
 * published ballot is changed on its way to the page.
 *
 * Needs an election with ballots, as `pnpm playground:up --experimental`
 * seeds and the cast-ballot test votes in, ideally counted with
 * `pnpm playground:count`: WEFT_E2E_STACK=playground, WEFT_E2E_ELECTION to
 * choose it (budget-2027 by default), and WEFT_E2E_PRIVATE_EXPLORERS for
 * the explorers' addresses (the playground's two by default).
 */

import { expect, test } from "../support/fixtures.ts";

const ELECTION = process.env.WEFT_E2E_ELECTION ?? "budget-2027";
const CHANNEL = `privatevote-${ELECTION}`;
const EXPLORERS = (process.env.WEFT_E2E_PRIVATE_EXPLORERS ?? "http://localhost:8790,http://localhost:8791").split(",").map((u) => u.trim().replace(/\/+$/, ""));
const api = (base: string, path = "") => `${base}/api/v1/channels/${CHANNEL}/private-elections/${ELECTION}${path}`;

interface View {
  state: string;
  phase: string;
  fingerprint: string;
  submitters: string;
  ballots: { total: number; failed: number };
  tally: { counts: number[]; total: number } | null;
}
interface Ballots {
  total: number;
  ballots: { txId: string; block: number; tracking: string; voterTag: string; verified: boolean; ballot: { bitProofs: { z0: string; z1: string }[] } }[];
}

test.describe("the explorer's private election pages", () => {
  test("show the same election in both explorers, check every ballot in the browser, and catch a changed one", { tag: "@fabric" }, async ({ browser }) => {
    test.setTimeout(240_000);
    const views: View[] = [];
    for (const base of EXPLORERS) {
      const res = await fetch(api(base)).catch(() => null);
      test.skip(!res || res.status !== 200, `${base} doesn't show ${ELECTION}: start it with WEFT_EXPERIMENTAL=1 and privateElections for ${CHANNEL}.`);
      views.push((await res!.json()) as View);
    }
    const [first] = views;
    test.skip(first!.ballots.total === 0, `${ELECTION} has no ballots yet.`);
    // Every organisation's explorer reports the same election, the same ballots and the same count.
    for (const v of views) {
      expect(v).toMatchObject({ state: first!.state, fingerprint: first!.fingerprint, ballots: { total: first!.ballots.total, failed: 0 } });
      expect(v.tally).toEqual(first!.tally);
    }
    const ballots = (await (await fetch(api(EXPLORERS[0]!, "/ballots"))).json()) as Ballots;
    const other = (await (await fetch(api(EXPLORERS.at(-1)!, "/ballots"))).json()) as Ballots;
    expect(other.ballots.map((b) => [b.tracking, b.voterTag])).toEqual(ballots.ballots.map((b) => [b.tracking, b.voterTag]));
    const N = ballots.total;

    for (const [i, base] of EXPLORERS.entries()) {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      // Weft's link from a version 2 receipt.
      const mine = ballots.ballots[Math.floor(N / 2)]!;
      await page.goto(`${base}/channels/${CHANNEL}/elections/${ELECTION}?tracking=${mine.tracking}#receipt`);
      await expect(page.locator("#tracking-result .banner__title")).toHaveText(`Your ballot is in block #${mine.block} and its proofs verify.`);
      await expect(page.locator("tr.is-yours")).toHaveCount(1);
      await expect(page.locator("tr.is-yours a.row-link")).toHaveAttribute("href", `/channels/${CHANNEL}/transactions/${mine.txId}`);
      await expect(page.locator(".fp")).toHaveAttribute("data-copy", first!.fingerprint);
      await expect(page.locator("#main").getByText("Worked out here from the election's record. Weft shows the same before each vote.")).toBeVisible();
      await expect(page.locator("text=proofs fail")).toHaveCount(0);
      if (first!.phase === "counted") await expect(page.locator("#result")).toContainText(`The counts add up to the ${N} ballots, and both decryption shares verify.`);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

      await page.getByRole("button", { name: "Check every ballot" }).click();
      await expect(page.locator("#xcheck-result")).toContainText("Everything checks out.", { timeout: 120_000 });
      await expect(page.locator("#xcheck-result")).toContainText(`the ${N} ${N === 1 ? "ballot" : "ballots"}`);
      await expect(page.locator('[data-step="ballots"] [data-word]')).toHaveText(`${N} ${N === 1 ? "ballot" : "ballots"} check out`);

      // A ballot changed between this explorer and the page: one proof value of the last ballot.
      const changed = N - 1;
      await page.route(`**/private-elections/${ELECTION}/ballots*`, async (route) => {
        const body = (await (await route.fetch()).json()) as Ballots;
        for (const b of body.ballots) {
          if (b.txId === ballots.ballots[changed]!.txId) b.ballot.bitProofs[0]!.z0 = b.ballot.bitProofs[0]!.z1;
        }
        await route.fulfill({ json: body });
      });
      await page.getByRole("button", { name: "Check again" }).click();
      await expect(page.locator("#xcheck-result")).toContainText(`Ballot ${N} of ${N} doesn't check out.`, { timeout: 120_000 });
      await expect(page.locator("#xcheck-result")).toContainText("Ciphertext 0 is not a 0 or a 1.");
      await expect(page.locator(`#xcheck-result a[href="/channels/${CHANNEL}/transactions/${ballots.ballots[changed]!.txId}"]`)).toBeVisible();
      expect(errors, `page errors on explorer ${i + 1}`).toEqual([]);
      await page.close();
    }
  });
});
