---
title: Quickstart
description: Connect a web app to Weft and call a Fabric contract in a few lines with @weftwallet/sdk.
---

`@weftwallet/sdk` is a small typed wrapper around the `window.weft` provider the extension injects.

## Install

```sh
pnpm add @weftwallet/sdk
```

:::note
The packages aren't on npm yet. Until they are, use the workspace: `"@weftwallet/sdk": "workspace:*"` inside this repository, or `pnpm link` from outside it.
:::

## Connect

```ts
import { getWeft, WeftNotInstalledError } from "@weftwallet/sdk";

try {
  const weft = await getWeft();          // waits up to 3s for the extension
  const me = await weft.connect();        // the user approves once per site
  console.log(`${me.name} from ${me.mspId}`, me.attributes);
} catch (error) {
  if (error instanceof WeftNotInstalledError) {
    // Point the user at the install page.
  }
}
```

`connect()` resolves with the active identity's public details: name, MSP ID, role, attributes, expiry, fingerprint and PEM certificate. Use them to tailor your UI, e.g. hide admin actions from `role: "client"`.

## Call a contract

Bind a channel and chaincode once, then call functions by name. Arguments are strings, as in Fabric.

```ts
const assets = weft.contract({ channel: "mychannel", chaincode: "basic" });

// Read-only. The user approves; nothing is written.
const asset = await assets.evaluateJson<{ ID: string; Owner: string }>("ReadAsset", "asset6");

// Write. Resolves once the transaction is committed as VALID.
const result = await assets.submit("TransferAsset", "asset6", "Christopher");
console.log(result.transactionId, result.blockNumber);
```

When a chaincode exposes several contracts, name the one you want: `weft.contract({ channel, chaincode, contract: "assets" })`.

### Private data and endorsers

```ts
await assets.submitWith("CreatePrivateAsset", ["asset9"], {
  transient: { price: "1200" },            // never written to the ledger; the user sees the key, not the value
  endorsingOrganizations: ["Org1MSP", "Org2MSP"],
});
```

## Handle errors

Every failure is a `WeftError` with a numeric `code`:

```ts
import { ErrorCode, WeftError } from "@weftwallet/sdk";

try {
  await assets.submit("TransferAsset", "asset6", "Christopher");
} catch (error) {
  if (!(error instanceof WeftError)) throw error;
  switch (error.code) {
    case ErrorCode.UserRejected:      // 4001: the user said no; don't retry automatically
      break;
    case ErrorCode.TransactionFailed: // 5001: error.data.status, e.g. "MVCC_READ_CONFLICT"
      break;
    case ErrorCode.CertificateExpired: // 4301: ask the user to renew in Weft
      break;
  }
}
```

The full list is in the [Provider API](/dapps/provider-api/#errors).

## Onboard users from your portal

If your app is also where users are given access, hand them straight to enrolment:

```ts
await weft.addNetwork("https://relay.org1.example.com/.well-known/weft-invite.json");
const me = await weft.connect();
```

## React to changes

```ts
const stop = weft.on("identityChanged", (identity) => {
  // The user switched identity in Weft (or removed it: identity is null).
});

weft.on("disconnect", ({ reason }) => {
  // The user disconnected your site in Weft, or you called weft.disconnect().
  // Show your "Connect" button again.
});

weft.on("networkChanged", ({ channel }) => {
  // The user picked another channel. Point your contract at it, or tell them.
});
```

Give users a way out too: `await weft.disconnect()` disconnects your site, and every open tab of it gets the `disconnect` event.

Next: [run everything locally against Fabric's test network](/dapps/test-network/).
