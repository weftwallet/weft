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

Full guide: [Quickstart](../../apps/docs/src/content/docs/dapps/quickstart.md) and [Provider API](../../apps/docs/src/content/docs/dapps/provider-api.md).
