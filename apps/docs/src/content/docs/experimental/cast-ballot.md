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

Before any window opens, Weft checks the params. A missing or malformed field fails with `-32602`, and a request from a site that already has one waiting fails with `-32002`. Everything after that happens in the approval window, because reading the election is a signed request and Weft may be locked:

1. If Weft is locked, the window asks for the password or a passkey first ([ADR 0005](/reference/decisions/)).
2. Weft finds a network of the voter's with that channel. With none, it fails with `4300`.
3. It reads the election with `GetElection`, by endorsing without submitting. The relay builds the proposal, Weft checks it (ADR 0001's check) and signs it with the identity it holds for the channel: its voter credential for that channel if it has one, otherwise the active identity. The relay returns the endorsing peers' signed responses, and Weft sends nothing to the orderer.
4. It checks that a peer of its identity's own organisation signed the response, with a certificate that chains to that organisation's CA, so the relay can't change the record. If the signature doesn't verify, it fails with `4400`. See [the limits](#reading-the-election) below.
5. It checks the record: a private-ballot record of version 1, in `open`. It computes the election context and the [election fingerprint](/experimental/private-tally-spec/#the-election-fingerprint) itself from the record's fields, and refuses a record whose `context` or `fingerprint` differs. Any other record fails with `4400`.
6. It picks the identity that votes. For X.509 voters, the active identity, if its MSP is one of the election's voter organisations. For voter credentials, the credential Weft holds for the election's voter MSP whose issuer key is the one the election pinned. With neither, it fails with `4300`.

An election in `open` whose `closesAt` has passed is still open: the trustees haven't [closed it](/experimental/contract-api/#closeelection), and the contract still accepts ballots. Weft lets the voter vote, and the window says the election is past its planned closing time.

Any failure in these steps shows in the window. The site gets `4300` or `4400` as soon as Weft knows, and the window says what happened until the voter closes it. If the relay doesn't answer, the request stays pending and the window offers Try again. Reject, or closing the window, then fails the request with `5002`. Otherwise closing the window, at any step, fails it with `4001`.

### Reading the election

The election key comes from the ledger, never from the web app. A key the web app chose could be one whose secret it holds, and a finished ballot from the web app couldn't be checked to hold the option the voter saw.

The peer's signature check needs the organisation's CA chain, which Fabric CA returns at enrolment and Weft doesn't keep today. Until it does, and for identities enrolled before it does, Weft reads the election without that check and the window says so. For a voter credential, whose organisation has no peers, the check is defined with [voter credentials](/experimental/voter-credentials/). Without the check, the election fingerprint in the window, which every explorer shows too, is how the voter can check the record.

The read is signed by the voter's identity, so the relay and the endorsing peers see that this identity read the election, as they do for any evaluation. The window says that Weft read the election through the relay.

### Casting

When the voter presses Sign and vote, Weft's background worker:

1. encrypts the choice under the election key and makes the proofs, bound to the election and to the voter tag, about 20 ms for three options;
2. for a voter credential, makes a new idemix identity for the transaction and the per-election pseudonym proof, bound to the ballot's tracking code;
3. discards the encryption randomness;
4. asks the relay to build the proposal for `CastBallot` or `CastAnonymousBallot`, and checks the proposal's arguments are exactly the ballot it made (ADR 0001's check, with the creator compared byte for byte for a voter credential);
5. signs, endorses, submits and waits for the commit, as `weft_submit` does;
6. computes the tracking code itself and compares it with the one the contract returned.

A ballot that commits after the trustees closed the election fails validation, and a ballot endorsed after it is refused with "Voting has closed." Either way the voter hasn't voted, and the site gets `5001`.

## The approval window

The window has two screens.

The first is for choosing:

- the site's origin, as the browser reports it;
- the election's title, channel, contract and planned closing time, with "Past its planned closing time. The trustees haven't closed it yet." when it has passed;
- the options, from the election record, none selected. Next stays disabled until the voter picks one.

The second is for confirming, with the choice at the top and Change choice to go back to the first screen:

- who holds the key: "Org1MSP and Org2MSP each hold part of this election's key. Any 2 of them together could read your ballot.";
- the election fingerprint, labelled "Election fingerprint", in five groups of four, with "Weft worked this out from the election's record. Every explorer shows the same.";
- who signs, and what the network sees. For an X.509 voter: the identity's name and MSP, and "Every organisation can see that you voted." For a voter credential: "An anonymous member of ChairVoters2027MSP", what the network sees (the voter organisation, the shared affiliation, the role), that a second vote from the credential will be refused, and that the vote can't be linked to the voter's other ballots;
- that Weft read the election, and sends the ballot, through the relay at the relay's host, which sees the voter's network address but not the choice, and whether Weft checked the peer's signature on the election;
- Keep the receipt in Weft, off;
- Sign and vote.

The choice stays in the window and the worker. It leaves them only encrypted. Closing the window, or Reject on either screen, fails the request with `4001`.

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
  blockNumber: number;   // a number, as in a version 1 receipt
  tracking: string;      // 64 lowercase hex characters
}
```

`blockNumber` is a number in the receipt, as in version 1 receipts, which the explorer's receipt check already reads, and a string in the result, as in every provider result.

A version 2 receipt holds no choice and no randomness. It shows that a ballot with this tracking code is in a valid block and in the totals. It shows nothing about the choice, because Weft discarded the encryption randomness that could prove it. A voter can show the receipt to anyone, and no one can use it to make a voter prove their vote. This holds only for unmodified Weft, since a modified Weft could keep the randomness.

When the voter turns on Keep the receipt in Weft, Weft keeps the receipt with the transaction, and also seals the choice as a note for the voter alone, with AES-GCM under the receipt key from ADR 0006. The note is shown only in Weft, and proves nothing to anyone else. No method reads either back.

### Checking it in the explorer

Link the voter to the election page with the tracking code:

```text
<explorer>/channels/<channel>/elections/<electionId>?tracking=<tracking>#receipt
```

The explorer finds the ballot by its tracking code, or by its transaction ID, and shows the block, that its proofs verify and that it is in the totals. It needs no choice, so the message hand-off for version 1 receipts isn't used, and the address holds nothing secret.

On request, the election page also re-checks the whole election in Web Workers, from ledger data the page has read: the ceremony record, every ballot proof, the totals, every decryption share proof and the tally. It shows progress, and the first failure by transaction.

### What the explorer publishes

Every ballot proof is bound to the [voter tag](/experimental/private-tally-spec/#the-voter-tag), so the browser's full check needs each ballot's tag. On a channel whose policy has `privateElections`, an explorer started with `WEFT_EXPERIMENTAL=1` publishes, for every transaction of that contract:

- the transaction ID, block, time and function, and its arguments: ballots, ceremony posts and decryption shares, which are public by design;
- for a ballot, its tracking code and its voter tag, as 64 lowercase hex characters, even when the policy has `submitter: hide`;
- for a ballot with a voter credential, the per-election pseudonym and its proof, which are arguments too.

With `submitter: hide`, it still hides the submitter: the certificate, the name and enrolment ID in it, and the MSP ID. With `submitter: show`, it shows the certificate too, and the browser computes each tag from it. Where submitters are hidden, the browser checks every proof against the published tag and that no tag repeats, and relies on the explorer's server for the step from the transaction's creator to the tag, which the server checks as it indexes each block. Another organisation's explorer that shows submitters checks that step in the browser.

A voter tag names no one. Anyone who holds the voter's certificate can compute its tag for an election, which includes every member organisation, the voter's CA and any site the voter connected the identity to, and see that the voter voted in it. The tag covers the channel and the election ID, so an X.509 voter has a different tag in every election, and the tags an explorer publishes don't link one certificate's ballots across elections. A voter credential's tag comes from its per-election pseudonym and links nothing either.

Election pages are made from the contract's arguments, so the explorer refuses to start with `privateElections` and `values: hash` on the same channel.

## Errors

| Code | Name | When |
|---|---|---|
| `4001` | UserRejected | The voter closed the window, at any step, or pressed Reject, except while the relay isn't answering. |
| `4200` | UnsupportedMethod | Normal Weft: it doesn't offer `weft_castBallot`. |
| `4300` | NoIdentity | Weft has no network with that channel, or no identity that can vote in this election. `data.voterMsps` lists the organisations whose voters can. The window says which. |
| `4301` | CertificateExpired | The X.509 identity that would vote has expired. |
| `4400` | ElectionUnavailable | Weft couldn't read an open private election with that ID: it doesn't exist, isn't open, its record isn't one Weft reads, its `context` or `fingerprint` isn't the one Weft computed, or the peer's signature on it doesn't verify. `data.state` has the state when there is one. The window says which. New in Weft Experimental. |
| `-32002` | RequestPending | This site already has a request waiting in Weft. |
| `-32602` | InvalidParams | A missing or malformed param. The message names it. |
| `5001` | TransactionFailed | The contract refused the ballot, for example "This identity has already voted in this election." or "Voting has closed.", or the ballot failed validation because the election closed first. `data` has the details. |
| `5002` | NetworkUnavailable | The relay couldn't be reached. While Weft reads the election, the window offers Try again, and the request fails with `5002` when the voter presses Reject or closes the window instead. |
| `-32603` | Internal | Anything else, including Weft refusing to sign a proposal that isn't the ballot it made. |
