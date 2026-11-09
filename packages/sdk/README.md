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

A voting app can send a ballot receipt with the vote. Weft checks it against the ballot, offers the voter to keep it, and returns it finished; with `"generate"` as the salt, Weft chooses the salt:

```ts
const salt = "generate";
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

With Weft and Weft Experimental both installed, `getWeft()` uses `window.weft`, the first to load. `detectProviders()` lists every Weft that announces itself (docs/adr/0010), and `getWeft({ rdns })` prefers one:

```ts
import {
  WEFT_EXPERIMENTAL_RDNS,
  detectProviders,
  getWeft,
} from "@weftwallet/sdk";

// One { info, provider } per wallet.
const wallets = await detectProviders();

const weft = await getWeft({ rdns: WEFT_EXPERIMENTAL_RDNS });
weft.info?.name; // "Weft Experimental"
```

`detectProviders({ waitMs })` listens for 500 ms by default and lists each wallet once, by `info.uuid`. With an `rdns` that no wallet announces within 500 ms of another Weft being found, `getWeft()` and `detectProvider()` use `window.weft`. `detectProvider(timeoutMs)` still takes the timeout as a number. `info` is what the announcer claims: any script on the page can announce a provider named "Weft", the same trust as `window.weft`.

Full guide: [Quickstart](../../apps/docs/src/content/docs/dapps/quickstart.md) and [Provider API](../../apps/docs/src/content/docs/dapps/provider-api.md).
