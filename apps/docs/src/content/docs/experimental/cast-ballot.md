---
title: Casting a ballot
description: The planned weft_castBallot method, its request and result, the approval window, receipt version 2 and feature detection.
---

:::caution[Experimental]
This page describes Weft Experimental, a separate build that is not part of the main product, and nothing on it applies to Weft as you install it. No one outside the project has reviewed its cryptography. None of it is built yet, and the page describes the planned design.
:::

`weft_castBallot` asks Weft to cast a ballot in a private election on the [private-ballot contract](/experimental/contract-api/). The voter chooses in Weft's approval window, Weft encrypts and proves the ballot, and the web app gets the transaction and a receipt, never the choice. Only Weft Experimental offers it, and normal Weft answers `4200` UnsupportedMethod. ([ADR 0007](/reference/decisions/))

## Detecting support

Check `window.weft.features`. Both builds report `version` 0.1.0.

| Entry | Means |
|---|---|
| `"receipts"` | `receipt` on `weft_submit`, for the main product's ballot contract. Both builds. |
| `"castBallot"` | `weft_castBallot`, for elections with X.509 voters. Weft Experimental only. |
| `"voterCredentials"` | Weft can hold voter credentials and cast anonymous ballots with `weft_castBallot`. Weft Experimental only. |

```ts
import { detectProvider } from "@weftwallet/sdk";

const weft = await detectProvider();
const privateBallots = weft?.features.includes("castBallot") ?? false;
const anonymousBallots = weft?.features.includes("voterCredentials") ?? false;
// Show the private election only when privateBallots is true. For an election
// with voter credentials, also require anonymousBallots.
```

Weft Playground shows its "Private election" section only when `castBallot` is present.

## Request

```ts
interface CastBallotParams {
  channel: string;     // the election's channel, for example "privatevote-budget-2027"
  chaincode: string;   // the private-ballot contract, for example "private-ballot"
  electionId: string;  // 1 to 64 letters, digits, - or _
}
```

```ts
const result = await window.weft.request({
  method: "weft_castBallot",
  params: { channel: "privatevote-budget-2027", chaincode: "private-ballot", electionId: "budget-2027" },
});
```

Each election has its own channel, `privatevote-budget-2027` for `budget-2027` and `privatevote-chair-2027` for `chair-2027`. An election with X.509 voters gets its own channel too, for the same reason as one with voter credentials: other elections' voters aren't members of its channel and can't read its ballots, and closing it changes no other channel.

The request carries no choice, no key and no ballot. The web app can't preselect an option. A helper in `@weftwallet/sdk` is planned.

`weft_castBallot` doesn't need `weft_connect`, as `weft_addNetwork` doesn't. A voter credential is never connected to a site, and the web app has no reason to learn the voter's identity before the vote. Weft asks every time.

## What Weft does

Before any window opens:

1. It checks the params. A missing or malformed field fails with `-32602`.
2. It finds a network of the voter's with that channel. With none, it fails with `4300`.
3. It reads the election with `GetElection`, through that network's relay, and checks the record: a private-ballot record of version 1, `open`, with `closesAt` in the future. It computes the election context and the key fingerprint itself from the record's fields, and refuses a record whose `context` or `fingerprint` differs. Otherwise it fails with `4400`.
4. It picks the identity that votes. For X.509 voters, the active identity, if its MSP is one of the election's voter organisations. For voter credentials, the credential Weft holds for the election's voter MSP whose issuer key is the one the election pinned. With neither, it fails with `4300`.

The election key comes from the ledger, never from the web app. A key the web app chose could be one whose secret it holds, and a finished ballot from the web app couldn't be checked to hold the option the voter saw. The read goes through the relay, and Weft doesn't yet check the peer's signature on the answer, so the fingerprint in the window, which explorers show too, is how a voter can check the key.

Then the approval window opens. When the voter presses Sign and vote, Weft's background worker:

1. encrypts the choice under the election key and makes the proofs, bound to the election and to the voter tag, about 20 ms for three options;
2. for a voter credential, makes a new idemix identity for the transaction and the per-election pseudonym proof, bound to the ballot's tracking code;
3. discards the encryption randomness;
4. asks the relay to build the proposal for `CastBallot` or `CastAnonymousBallot`, and checks the proposal's arguments are exactly the ballot it made (ADR 0001's check, with the creator compared byte for byte for a voter credential);
5. signs, endorses, submits and waits for the commit, as `weft_submit` does;
6. computes the tracking code itself and compares it with the one the contract returned.

## The approval window

The window shows:

- the site's origin, as the browser reports it;
- the election's title, channel, contract and closing time;
- the options, from the election record, none selected. Sign and vote stays disabled until the voter picks one;
- who holds the key: "Org1MSP and Org2MSP each hold part of this election's key. Any 2 of them together could read your ballot.";
- the key fingerprint, to compare with the explorer's;
- who signs, and what the network sees. For an X.509 voter: the identity's name and MSP, and "Every organisation can see that you voted." For a voter credential: "An anonymous member of ChairVoters2027MSP", what the network sees (the voter organisation, the shared affiliation, the role), that a second vote from the credential will be refused, and that the vote can't be linked to the voter's other ballots;
- that the ballot goes through the relay at the relay's host, which sees the voter's network address but not the choice;
- Keep the receipt in Weft, off.

The choice stays in the window and the worker. It leaves them only encrypted. Closing the window, or Reject, fails the request with `4001`.

## Result

```ts
interface CastBallotResult {
  transactionId: string;
  blockNumber: string;   // a string, because Fabric block numbers are 64-bit
  status: "VALID";
  receipt: BallotReceiptResultV2;
}

type BallotReceiptResultV2 =
  | { kept: true; receipt: BallotReceiptV2 }
  | { kept: false; reason: "declined" | "storage" | "mismatch"; receipt: BallotReceiptV2 };
```

| `reason` | Meaning |
|---|---|
| `"declined"` | The voter left Keep the receipt in Weft off. |
| `"storage"` | The browser refused to store it. The window stays open with Download receipt and Copy receipt. |
| `"mismatch"` | The contract's tracking code isn't the one Weft computed. The vote stands, the receipt carries Weft's tracking code, and Weft keeps nothing. Tell the contract's developer. |

The web app learns the transaction, the block, the tracking code and whether Weft kept the receipt. It never learns the choice. For an election with X.509 voters, a web app that can read the ledger can see who submitted the transaction, as anyone with ledger access can.

## Receipt version 2

```ts
interface BallotReceiptV2 {
  type: "weft-ballot-receipt";
  version: 2;
  channel: string;
  electionId: string;
  txId: string;
  blockNumber: number;
  tracking: string;      // 64 lowercase hex characters
}
```

A version 2 receipt holds no choice and no randomness. It shows that a ballot with this tracking code is in a valid block and in the totals. It shows nothing about the choice, because Weft discarded the encryption randomness that could prove it. A voter can show the receipt to anyone, and no one can use it to make a voter prove their vote. This holds only for unmodified Weft, since a modified Weft could keep the randomness.

When the voter turns on Keep the receipt in Weft, Weft keeps the receipt with the transaction, and also seals the choice as a note for the voter alone, with AES-GCM under the receipt key from ADR 0006. The note is shown only in Weft, and proves nothing to anyone else. No method reads either back.

### Checking it in the explorer

Link the voter to the election page with the tracking code:

```text
<explorer>/channels/<channel>/elections/<electionId>?tracking=<tracking>#receipt
```

The explorer finds the ballot by its tracking code, or by its transaction ID, and shows the block, that its proofs verify and that it is in the totals. It needs no choice, so the message hand-off for version 1 receipts isn't used, and the address holds nothing secret.

On request, the election page also re-checks the whole election in Web Workers, from ledger data the page has read: the ceremony record, every ballot proof, the totals, every decryption share proof and the tally. It shows progress, and the first failure by transaction.

## Errors

| Code | Name | When |
|---|---|---|
| `4001` | UserRejected | The voter closed the window or pressed Reject. |
| `4200` | UnsupportedMethod | Normal Weft: it doesn't offer `weft_castBallot`. |
| `4300` | NoIdentity | Weft has no network with that channel, or no identity that can vote in this election. `data.voterMsps` lists the organisations whose voters can. |
| `4301` | CertificateExpired | The X.509 identity that would vote has expired. |
| `4400` | ElectionUnavailable | Weft couldn't read an open private election with that ID: it doesn't exist, isn't open, has closed, or its record isn't one Weft reads. `data.state` has the state when there is one. New in Weft Experimental. |
| `-32002` | RequestPending | This site already has a request waiting in Weft. |
| `-32602` | InvalidParams | A missing or malformed param. The message names it. |
| `5001` | TransactionFailed | The contract refused the ballot, for example "This identity has already voted in this election." `data` has the details. |
| `5002` | NetworkUnavailable | The relay couldn't be reached. |
| `-32603` | Internal | Anything else, including Weft refusing to sign a proposal that isn't the ballot it made. |
