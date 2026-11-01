---
title: Provider API
description: The window.weft provider, its methods, events and error codes.
---

The extension injects `window.weft` into HTTPS pages and `localhost`. The types live in `@weftwallet/protocol`.

```ts
interface WeftProvider {
  readonly isWeft: true;
  readonly version: string;
  readonly features: readonly string[];  // for example ["receipts"]
  request(args: { method: string; params?: unknown }): Promise<unknown>;
  on(event: string, listener: (payload: unknown) => void): void;
  off(event: string, listener: (payload: unknown) => void): void;
}
```

The provider may be injected after your script runs. Wait for the `weft#initialized` event on `window`, or use `detectProvider()` from `@weftwallet/sdk`, which does this for you.

## Methods

| Method | Params | Result | Asks the user |
|---|---|---|---|
| `weft_connect` | None | `IdentitySummary` | Yes, once per site and identity |
| `weft_identity` | None | `IdentitySummary \| null` | No |
| `weft_networks` | None | `NetworkSummary[]` | No |
| `weft_evaluate` | `ContractCall` | `EvaluateResult` | Every time |
| `weft_submit` | `SubmitParams` | `SubmitResult` | Every time |
| `weft_addNetwork` | `{ url }` | `{ added: true }` | Every time |
| `weft_disconnect` | None | `null` | No |
| `weft_signIn` | `{ nonce, statement? }` | `SignInResult` | Every time |

`weft_addNetwork` asks the user to join a network from an [invite](/operators/invites/). `url` is the invite's HTTPS URL, a `weft://` link or a join link. Weft fetches the invite itself from that address, shows it, and the user enrols. It doesn't need the site to be connected, which suits an admin portal's "Set up Weft" button.

A connection is to one identity. If the user switches to an identity that isn't connected to your site, your site gets `disconnect` with reason `"identity-changed"` and has to call `weft_connect` again; switching back to a connected identity sends `identityChanged` instead. Your site never sees identities the user didn't connect to it.

`weft_identity` returns `null` for sites that aren't connected. `weft_networks`, `weft_evaluate` and `weft_submit` fail with `4100` until the site is connected.

`weft_signIn` proves to your site that the user holds the active identity, for signing in. It needs a connected site. See [Sign in with Weft](#sign-in-with-weft).

`weft_submit` takes an optional `receipt`, for a vote whose receipt Weft makes and offers to keep. See [Ballot receipts](#ballot-receipts).

`weft_networks` lists the networks of the identities connected to your site, the active one first (`active: true`). The user's other networks stay private: they would reveal organisations your site wasn't shown.

### Types

```ts
interface IdentitySummary {
  id: string;
  name: string;                         // certificate common name
  mspId: string;                        // for example "Org1MSP"
  role: string | null;                  // NodeOU: "client", "admin", "peer", "orderer"
  attributes: Record<string, string>;   // Fabric CA attributes, including hf.*
  issuer: string;
  notAfter: string;                     // ISO 8601
  fingerprint: string;                  // SHA-256, colon-separated hex
  certificate: string;                  // PEM
}

interface NetworkSummary {
  id: string;
  name: string;
  mspId: string;
  channels: string[];
  active: boolean;                      // the network of the identity in use now
}

interface ContractCall {
  channel: string;
  chaincode: string;
  contract?: string;                    // contract name inside the chaincode
  fn: string;
  args?: string[];
  transient?: Record<string, string>;   // private data inputs
  endorsingOrganizations?: string[];
}

interface EvaluateResult {
  text: string | null;                  // UTF-8 result, or null if the bytes aren't text
  base64: string;
}

interface SignInParams {
  nonce: string;                        // 16 to 128 of A-Z a-z 0-9 - _, from your server, used once
  statement?: string;                   // one line shown to the user, at most 200 characters
}

interface SignInResult {
  message: string;                      // the exact text signed, starting "weft-sign-in:v1"
  signature: string;                    // base64 DER ECDSA over the message's UTF-8 bytes
  certificate: string;                  // PEM
  mspId: string;
}

interface SubmitParams extends ContractCall {
  receipt?: BallotReceiptRequest;       // see Ballot receipts
}

interface SubmitResult extends EvaluateResult {
  transactionId: string;
  blockNumber: string;                  // a string, because Fabric block numbers are 64-bit
  status: string;                       // "VALID"
  receipt?: ReceiptResult;              // when the request had a receipt
}
```

## Ballot receipts

A voting web app can have Weft make the voter's ballot receipt and offer to keep it with the transaction. Add `receipt` to the `weft_submit` params. The approval window shows **Keep the receipt in Weft**, off until the user turns it on; your site can't turn it on, and Weft remembers nothing between requests. Weft adds `txId`, `blockNumber` and `commitment` itself once the transaction commits, and returns the finished receipt whether or not it kept it. No method reads a kept receipt back. See [Run an election](/guides/elections/) for the contract and the explorer.

```ts
interface BallotReceiptRequest {
  type: "weft-ballot-receipt";
  version: 1;
  channel: string;                      // the call's channel
  electionId: string;                   // one of the call's args
  option: string;                       // 1 to 200 characters, as in the ballot you send in transient
  salt: string;                         // 32 to 128 lowercase hex characters as in the ballot, or "generate"
}

interface BallotReceipt {
  type: "weft-ballot-receipt";
  version: 1;
  channel: string;
  electionId: string;
  txId: string;
  blockNumber: number;
  commitment: string;                   // SHA-256 of electionId, option and salt, joined by "\n", as hex
  option: string;
  salt: string;
}

type ReceiptResult =
  | { kept: true; receipt: BallotReceipt }
  | { kept: false; reason: "declined" | "storage" | "mismatch"; receipt: BallotReceipt };
```

```ts
const weft = await getWeft();
const salt = "generate";               // Weft chooses it
const result = await weft.submit({
  channel: "mychannel",
  chaincode: "ballot",
  fn: "CastVote",
  args: ["board-2026"],
  transient: { ballot: JSON.stringify({ option: "Ada", salt }) },
  receipt: { type: "weft-ballot-receipt", version: 1, channel: "mychannel", electionId: "board-2026", option: "Ada", salt },
});
// Offer Download and Copy either way. Only your notice changes.
const { kept, receipt } = result.receipt!;
showReceipt(receipt, { keptInWeft: kept });
```

### Letting Weft choose the salt

Send `"generate"` as the salt in two places: the receipt, and the JSON of exactly one private input, with the receipt's `option` beside it. Weft draws 16 random bytes with `crypto.getRandomValues`, as 32 lowercase hex characters, and puts them in both before the approval window opens. That private input is written again with `JSON.stringify`, its keys in their order, so the contract reads the same object with the salt filled in. The user approves, and Weft signs, that value, and Weft checks the relay's proposal against it as it checks any private input. The salt comes back in `result.receipt.receipt.salt`.

### What Weft checks

Before any window opens, in this order. The first that fails ends the request with `-32602` InvalidParams, and the message names the field.

1. The method is `weft_submit`. On `weft_evaluate` a receipt has nothing to record.
2. `type` is `"weft-ballot-receipt"` and `version` is `1`, the format the explorer's receipt check reads.
3. The six fields, and no others, so a site can't store data of its own in Weft.
4. `channel` is the call's channel.
5. `electionId` is one of the call's arguments.
6. `salt` is 32 to 128 lowercase hex characters, as the ballot contract requires, or `"generate"`; `option` is 1 to 200 characters.
7. One private input of the call, read as JSON, has exactly this `option` and `salt`. With `"generate"`: exactly one private input has `"salt": "generate"`, and its `option` is the receipt's. A private input with `"salt": "generate"` while the receipt has a salt of its own fails too.

After the commit, Weft computes the commitment itself, as the contract's `commitmentFor` does, and compares it with the `commitment` the contract returned in its result. If they differ, the vote stands, the receipt carries Weft's commitment, and Weft keeps nothing: `reason: "mismatch"`.

| `reason` | Meaning |
|---|---|
| `"declined"` | The user left **Keep the receipt in Weft** off. |
| `"storage"` | The browser refused to store it. The approval window stays open with **Download receipt** and **Copy receipt**. |
| `"mismatch"` | The contract's commitment isn't SHA-256 of the election ID, option and salt. Tell your contract's developer. |

### Checking a receipt in the explorer

The organisation's explorer checks a receipt on its election page. Don't put the choice or salt in the page's address: the browser's history records the whole address, fragment included. Open the page with only the transaction ID and the commitment, and hand it the choice and salt by message once it asks:

```ts
import { checkReceiptInExplorer } from "@weftwallet/sdk";

button.addEventListener("click", () => checkReceiptInExplorer(explorerUrl, receipt));
```

Without the SDK:

1. `window.open(page, "_blank")`, from a click and without `noopener`, where `page` is `<explorer>/channels/<channel>/elections/<electionId>?tx=<txId>&commitment=<commitment>#receipt`.
2. Once the explorer has found the ballot, its page posts `{ type: "weft-receipt-check:ready", version: 1 }` to `window.opener`. It carries nothing.
3. If the message's `source` is the window you opened and its `origin` is the explorer's, answer with `win.postMessage({ type: "weft-receipt-check:receipt", version: 1, electionId, txId, option, salt }, explorerOrigin)`. Always name the explorer's exact origin, never `"*"`.

The explorer uses an answer only from origins its operator lists in [`WEFT_EXPLORER_RECEIPT_ORIGINS`](/operators/explorer/#configuration), from Weft Playground, and from Weft itself, and only shaped as that page's receipt. It sends nothing back. From any other site, the voter chooses, drops or pastes the receipt on the page.

## Sign in with Weft

`weft_signIn` lets your server know who is using your site, with the certificate their organisation's CA issued. The wallet writes the message itself, so your site can't get anything else signed:

```text
weft-sign-in:v1
origin: https://explorer.org1.example
msp: Org1MSP
nonce: 3kQ9xPbD7wFh2LmN8aZ1
issued: 2026-10-20T05:00:00.000Z
expires: 2026-10-20T05:05:00.000Z
statement: Sign in to Org1's explorer
```

The origin is the one the browser reports for your page, never a value your page passes. The message is text, so its signature can't be passed off as a Fabric transaction signature, which signs protobuf bytes.

```ts
const weft = await getWeft();
await weft.connect();
const { nonce } = await (await fetch("/auth/nonce")).json();
const signed = await weft.signIn(nonce, "Sign in to Org1's explorer");
await fetch("/auth/verify", { method: "POST", body: JSON.stringify(signed) });
```

On your server, with `@weftwallet/core`:

1. `parseSignInMessage(message)`, and check the origin is yours, the nonce is one you issued and haven't seen, and the time is between `issued` and `expires`.
2. `verifySignIn(message, signature, certificate)` checks the signature against the certificate's key.
3. Check the certificate chains to a root you trust for that MSP ID, for example the MSP's root certificates from your channel's configuration block. Without this step, anyone could sign in with a certificate they made themselves.

The [explorer](/operators/explorer/) does all three; its `src/auth.ts` is a complete example.

## Events

| Event | Payload | When |
|---|---|---|
| `identityChanged` | `IdentitySummary \| null` | The user switched, renewed or removed the active identity. |
| `networkChanged` | `{ networkId, channel }` | The user picked a different channel, or switched to an identity on another network. |
| `disconnect` | `{ reason }` | The site is no longer connected. See the reasons below. |
| `certificateStatus` | `{ identityId, state, notAfter, daysLeft }` | The certificate your site uses is close to expiring (`state: "expiring"`, within 30 days) or has expired (`"expired"`). Sent once per state, at most an hour late. Prompt the user to renew in Weft; the renewed certificate arrives as `identityChanged`. |

`identityChanged`, `networkChanged` and `certificateStatus` reach sites connected to the identity in use. `disconnect` reaches the site being disconnected, in every open tab. After it, show your "Connect" state again: calls fail with `4100` until the user reconnects.

| `disconnect` reason | Meaning | What to do |
|---|---|---|
| `"user"` | The user disconnected your site in Weft. | Show "Connect". |
| `"site"` | Your page called `weft_disconnect`, in this tab or another. | Show "Connect". |
| `"identity-changed"` | The user switched to an identity that isn't connected to your site. | Show "Connect"; connecting asks for the new identity. |
| `"no-identity"` | The user removed their last identity. | Show "Connect"; Weft will ask them to add one. |
| `"wallet-updated"` | Weft was updated or reloaded while your page was open. | Ask the user to reload the page. |

## Errors

Rejected promises carry `{ code, message, data? }` (a `WeftError` when you use the SDK).

| Code | Name | Meaning |
|---|---|---|
| `4001` | UserRejected | The user rejected the request or closed the window. |
| `4100` | Unauthorized | The site isn't connected. Call `weft_connect`. |
| `4200` | UnsupportedMethod | Weft does not support the method. |
| `4300` | NoIdentity | Weft has no identity yet. |
| `4301` | CertificateExpired | The active certificate has expired. |
| `-32002` | RequestPending | This site already has a request waiting in Weft. Weft brings that window to the front. Wait until the user approves or rejects it before sending another. |
| `5001` | TransactionFailed | The network rejected the transaction. `data` has the Fabric code and, for endorsement failures, per-peer details. |
| `5002` | NetworkUnavailable | The relay couldn't be reached. |
| `-32602` | InvalidParams | Malformed params, including a ballot receipt that doesn't fit its call. The message names the field. |
| `-32603` | Internal | Anything else, including Weft refusing to sign mismatched bytes. |

## Without the SDK

```js
window.addEventListener("weft#initialized", async () => {
  const me = await window.weft.request({ method: "weft_connect" });
  const result = await window.weft.request({
    method: "weft_evaluate",
    params: { channel: "mychannel", chaincode: "basic", fn: "GetAllAssets" },
  });
  console.log(me.name, JSON.parse(result.text));
});
```
