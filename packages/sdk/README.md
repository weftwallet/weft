# @weftwallet/sdk

Call [Weft](../../README.md) from a web app.

```ts
import { getWeft } from "@weftwallet/sdk";

const weft = await getWeft();
const me = await weft.connect();
const basic = weft.contract({ channel: "mychannel", chaincode: "basic" });

const assets = await basic.evaluateJson("GetAllAssets");
await basic.submit("TransferAsset", "asset6", "Christopher");
```

A voting app can send a ballot receipt with the vote. Weft checks it against the ballot, offers the voter to keep it, and returns it finished; with `"generate"` as the salt, Weft chooses the salt (Weft 0.2.0 and later, see `supportsReceipts()`):

```ts
const salt = weft.supportsReceipts() ? "generate" : mySalt();
const result = await weft.submit({
  channel: "elections", chaincode: "ballot", fn: "CastVote", args: ["board-2026"],
  transient: { ballot: JSON.stringify({ option: "Ada", salt }) },
  receipt: { type: "weft-ballot-receipt", version: 1, channel: "elections", electionId: "board-2026", option: "Ada", salt },
});
const { kept, receipt } = result.receipt!;

// From a click: opens the explorer's election page with only the transaction
// and commitment in its address, and hands it the choice and salt by message.
checkReceiptInExplorer(explorerUrl, receipt);
```

See [Run an election](../../apps/docs/src/content/docs/guides/elections.md).

Full guide: [Quickstart](../../apps/docs/src/content/docs/dapps/quickstart.md) and [Provider API](../../apps/docs/src/content/docs/dapps/provider-api.md).
