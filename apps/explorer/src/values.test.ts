import { describe, expect, it } from "vitest";
import { ExplorerDb } from "./db.ts";
import { decodeBlock } from "./decode.ts";
import { jsonText, VALUE_LINES } from "./pages.ts";
import { parsePolicy, publishBlock, publishedChannels } from "./policy.ts";
import { buildServer } from "./server.ts";
import { chain } from "./test/blocks.ts";

const long = { history: Array.from({ length: 10 }, (_, i) => ({ owner: `Owner${i}`, at: i })) };

function explorer() {
  const policy = parsePolicy({ organisation: "Org1", channels: { mychannel: { level: "public" } } });
  const db = new ExplorerDb(":memory:");
  const blocks = chain("mychannel", [
    { txs: [{ txId: "c0", chaincode: "", args: [], config: true }] },
    {
      txs: [
        {
          txId: "aa1100",
          chaincode: "basic",
          args: ["CreateAsset"],
          writes: [
            { key: "count", value: JSON.stringify({ n: 0 }) },
            { key: "nested", value: JSON.stringify({ a: { b: 1 } }) },
            { key: "long", value: JSON.stringify(long) },
          ],
        },
      ],
    },
  ]);
  for (const b of blocks) db.addBlock(publishBlock(policy, decodeBlock(b)));
  return buildServer({ name: "Org1", channels: publishedChannels(policy), policy, db, status: () => [] });
}

describe("JSON values", () => {
  it("keeps a short, flat value on one line", () => {
    expect(jsonText({ n: 0 })).toEqual({ text: '{"n":0}', oneLine: true });
    expect(jsonText([1, 2, 3])).toEqual({ text: "[1,2,3]", oneLine: true });
  });

  it("pretty-prints a nested or long value", () => {
    expect(jsonText({ a: { b: 1 } }).oneLine).toBe(false);
    expect(jsonText({ ID: "asset1", Color: "blue", Size: 5, Owner: "Tom", AppraisedValue: 300 }).oneLine).toBe(false);
  });

  it("shows them so on a transaction's page, with Show all past the cut", async () => {
    const page = (await explorer().inject("/channels/mychannel/transactions/aa1100")).body;
    expect(page).toContain('<span class="mono value">{&#34;n&#34;:0}</span>');
    expect(page).toMatch(/<pre class="value">\{\n {2}&#34;a&#34;/);
    const lines = JSON.stringify(long, null, 2).split("\n").length;
    expect(lines).toBeGreaterThan(VALUE_LINES);
    expect(page).toMatch(/<pre class="value" id="value-\d+" data-lines="\d+">/);
    expect(page).toMatch(/<button type="button" class="link-button value-cap__toggle" aria-expanded="false" aria-controls="value-\d+">Show all<\/button>/);
    // The script that runs it is on the page only when something is cut.
    expect(page).toContain("value-cap__toggle");
    expect(page.match(/<pre class="value" id=/g)).toHaveLength(1);
  });
});

describe("the overview", () => {
  it("leaves the hash out of its blocks table, and a block's page keeps it", async () => {
    const app = explorer();
    const home = (await app.inject("/")).body;
    expect(home).not.toContain("<th>Hash</th>");
    expect((await app.inject("/channels/mychannel")).body).toContain("<th>Hash</th>");
    expect((await app.inject("/channels/mychannel/blocks/1")).body).toContain("<dt>Hash</dt>");
  });
});
