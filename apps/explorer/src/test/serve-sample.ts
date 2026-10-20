// Serves sample blocks for looking at the pages: node src/test/serve-sample.ts
import { ExplorerDb } from "../db.ts";
import { decodeBlock } from "../decode.ts";
import { parsePolicy, publishBlock, publishedChannels } from "../policy.ts";
import { buildServer } from "../server.ts";
import { chain } from "./blocks.ts";

const policy = parsePolicy({ organisation: "Org1", channels: { mychannel: { level: "public", contracts: { ballot: "hidden" } } } });
const db = new ExplorerDb(":memory:");
const specs = [{ txs: [{ txId: "c0ffee00", chaincode: "", args: [], config: true }] }] as Parameters<typeof chain>[1];
for (let i = 1; i < 30; i++) {
  specs.push({
    txs: [
      { txId: `${(i * 7919).toString(16).padStart(8, "0")}a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8`, chaincode: "basic", args: ["CreateAsset", `asset${i}`, "blue", "5", "Tom", "300"], writes: [{ key: `asset${i}`, value: JSON.stringify({ ID: `asset${i}`, Color: "blue", Size: 5, Owner: "Tom", AppraisedValue: 300 }) }], event: i % 3 ? undefined : "AssetCreated" },
      ...(i % 4 === 0 ? [{ txId: `${(i * 104729).toString(16).padStart(8, "0")}ffeeddccbbaa99887766554433221100ffeeddccbbaa9988776655443322`, chaincode: "basic", args: ["TransferAsset", `asset${i}`, "Max"], writes: [{ key: `asset${i}`, value: "{}" }] }] : []),
      ...(i % 5 === 0 ? [{ txId: `${(i * 31).toString(16).padStart(8, "0")}00112233445566778899aabbccddeeff00112233445566778899aabbccdd`, chaincode: "ballot", args: ["Vote", "x"], writes: [] }] : []),
    ],
    codes: i % 4 === 0 ? [0, 11, 0].slice(0, 2 + (i % 5 === 0 ? 1 : 0)) : undefined,
  });
}
for (const b of chain("mychannel", specs)) db.addBlock(publishBlock(policy, decodeBlock(b)));
const app = buildServer({ name: "Org1", channels: publishedChannels(policy), db, status: () => [{ channel: "mychannel", state: "following", peerHeight: 30, lastError: null, lastBlockAt: Date.now() }] });
await app.listen({ port: 8799, host: "127.0.0.1" });
console.log("http://localhost:8799");
