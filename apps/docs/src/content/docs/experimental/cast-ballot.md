---
title: Casting a ballot
description: The weft_castBallot method in Weft Experimental, its request and result, the approval window, receipt version 2 and feature detection.
---

:::caution[Experimental]
This page describes Weft Experimental, a separate build that is not part of the main product, and nothing on it applies to Weft as you install it. No one outside the project has reviewed its cryptography. `weft_castBallot`, its approval window, receipt version 2 in Weft, the SDK's `castBallot()`, the explorer's election pages with the tracking code check, the playground's Private election section, and anonymous ballots with voter credentials in Weft Experimental, the explorer and the playground are built. [What is built](#what-is-built) has the details.
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

Weft Playground shows its "Private election" section only when `castBallot` is present. The section lists the private elections that the invite's explorer publishes, from the explorer's JSON API, and casts with the SDK's `castBallot()`, as below.

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

The request carries no choice, no key and no ballot. The web app can't preselect an option: Weft refuses a request with any other field, such as `choice`, with `-32602`.

`@weftwallet/sdk` has a helper:

```ts
import { getWeft } from "@weftwallet/sdk";

const weft = await getWeft();
if (weft.supports("castBallot")) {
  const { transactionId, receipt } = await weft.castBallot({ channel: "privatevote-budget-2027", chaincode: "private-ballot", electionId: "budget-2027" });
}
```

`weft_castBallot` doesn't need `weft_connect`, as `weft_addNetwork` doesn't. A voter credential is never connected to a site, and the web app has no reason to learn the voter's identity before the vote. Weft asks every time.

## What Weft does

Before any window opens, Weft checks the params. A missing or malformed field fails with `-32602`, and a request from a site that already has one waiting fails with `-32002`. Everything after that happens in the approval window, because reading the election is a signed request and Weft may be locked:

1. If Weft is locked, the window asks for the password or a passkey first ([ADR 0005](/reference/decisions/)).
2. Weft finds a network of the voter's with that channel. With none, it fails with `4300`. When the network was added from an invite, the invite may list the channel now, since each election gets a channel of its own: the window offers Refresh from invite, and the request waits. If the refreshed invite lists the channel, Weft adds it to the network and goes on. Otherwise, or if the voter presses Reject or closes the window, the request fails with `4300`.
3. It reads the election with `GetElection`, by endorsing without submitting. The relay builds the proposal, Weft checks it (ADR 0001's check) and signs it with the identity it holds for the channel: a one-off identity made from its voter credential for that channel if it has one, in the approval window's worker, otherwise the active identity. The relay returns the endorsing peers' signed responses, and Weft sends nothing to the orderer.
4. It checks the peers' signatures on the response, so the relay can't change the record: for an X.509 identity, that a peer of the identity's own organisation signed it, with a certificate that chains to that organisation's CA; for a voter credential, that every endorsement verifies against a CA chain the voter invite pins. If a signature doesn't verify, it fails with `4400`. See [Reading the election](#reading-the-election) below.
5. It checks the record: a private-ballot record of version 1, in `open`. It computes the election context and the [election fingerprint](/experimental/private-tally-spec/#the-election-fingerprint) itself from the record's fields, and refuses a record whose `context` or `fingerprint` differs. Any other record fails with `4400`.
6. It picks the identity that votes. For X.509 voters, the active identity, if its MSP is one of the election's voter organisations. For voter credentials, the credential Weft holds for the election, which must be of the election's voter MSP and have the issuer key the election pinned. With neither, it fails with `4300`.

Weft looks for a voter credential before anything else: one for the request's channel, contract and election ID, from its voter invite. With one, the window opens the credential and starts the idemix module in its own worker first, and the read and the vote are signed by one-off identities of the credential, through the relay the voter invite names, never with the active identity. The window says "Starting Weft's voting module" while it starts. Without one, Weft reads the election with the active identity, and an election with voter credentials then fails with `4300`: "This election needs a voter credential", with `data.voterMsps`.

When Weft's own activity has a committed ballot from this identity in this election, the first screen says so. The contract still decides, and refuses a second ballot.

An election in `open` whose `closesAt` has passed is still open: the trustees haven't [closed it](/experimental/contract-api/#closeelection), and the contract still accepts ballots. Weft lets the voter vote, and the window says the election is past its planned closing time.

Any failure in these steps shows in the window. The site gets `4300` or `4400` as soon as Weft knows, and the window says what happened until the voter closes it. If the relay doesn't answer, the request stays pending and the window offers Try again. Reject, or closing the window, then fails the request with `5002`. Otherwise closing the window, at any step, fails it with `4001`.

### Reading the election

The election key comes from the ledger, never from the web app. A key the web app chose could be one whose secret it holds, and a finished ballot from the web app couldn't be checked to hold the option the voter saw.

The peer's signature check needs the organisation's CA chain, which Fabric CA returns at enrolment. Weft Experimental keeps it with each identity it enrols or re-enrols through a CA. Weft, as you install it, keeps nothing new. An identity added with Import PEM or a certificate request has no chain, and nor has one enrolled before Weft Experimental kept it: re-enrolling it in Weft Experimental keeps one. For those, Weft reads the election without the check and the confirm screen says so. A voter credential's organisation has no peers, so for a voter credential Weft checks the trustee organisations' peers instead, against the CA chains the voter invite pins, and requires every endorsement to verify ([Reading the election](/experimental/voter-credentials/#reading-the-election) in Voter credentials). Without the check, the election fingerprint in the window, which every explorer shows too, is how the voter can check the record.

With the chain, Weft accepts the answer only when:

- its proposal hash is the hash of the proposal Weft signed, as Fabric's endorser computes it, so the answer is to this read of this election on this channel;
- it comes from the contract the site named, with status 200;
- an endorsement from the voter's own MSP carries a certificate with the `peer` role that chains to the kept CA chain and is in date, and its signature over the proposal response and the endorser verifies.

Weft reads the record from inside the signed bytes, never from the relay's copy of the result. Without the chain, it still checks the proposal hash, the contract and the status.

The read is signed by the voter's identity, so the relay and the endorsing peers see that this identity read the election, as they do for any evaluation. With a voter credential, they see an anonymous member of the voter organisation, with a Nym used for nothing else. The window says that Weft read the election through the relay.

### Casting

When the voter presses Sign and vote, Weft's background worker:

1. encrypts the choice under the election key and makes the proofs, bound to the election and to the voter tag, about 20 ms for three options. For a voter credential, the approval window's worker first makes a new idemix identity for the transaction and P, from which the voter tag is made;
2. for a voter credential, has the window's worker make the [per-election pseudonym proof](/experimental/private-tally-spec/#the-per-election-pseudonym), bound to the transaction's Nym and the ballot's tracking code;
3. discards the encryption randomness;
4. asks the relay to build the proposal for `CastBallot` or `CastAnonymousBallot`, and checks the proposal's arguments are exactly the ballot it made, and the pseudonym proof, byte for byte (ADR 0001's check). The creator's `id_bytes` must be exactly the bytes the voter tag was made from, which are the ones the relay put in the read's proposal, with or without the PEM's trailing newline: a ballot bound to another tag would be refused. For a voter credential, the creator must be byte for byte the one-off identity the window's worker made for this transaction;
5. signs, endorses, submits and waits for the commit, as `weft_submit` does. For a voter credential, the window's worker signs each of the three messages, and disposes of the identity after the commit status;
6. computes the tracking code itself and compares it with the one the contract returned.

A ballot that commits after the trustees closed the election fails validation, and a ballot endorsed after it is refused with "Voting has closed." Either way the voter hasn't voted, and the site gets `5001`.

## The approval window

The window has two screens.

The first is for choosing:

- the site's origin, as the browser reports it;
- the election's title, channel, contract and planned closing time, with "Past its planned closing time. The trustees haven't closed it yet." when it has passed;
- the options, from the election record, none selected. Review your vote stays disabled until the voter picks one, and the line under the options says why.

The second is for confirming, titled with the choice ("Vote for Plan B?"), with the choice at the top and Change choice to go back to the first screen:

- who holds the key: "Org1MSP and Org2MSP each hold part of this election's key. Any 2 of them together could read your ballot.";
- the election fingerprint, labelled "Election fingerprint", in five groups of four, with "Weft worked this out from the election's record. Every explorer shows the same.";
- who signs, and what the network sees, under "Voting as". For an X.509 voter: the identity's name and MSP, and "Every organisation can see that you voted." For a voter credential: "An anonymous member of ChairVoters2027MSP", what the network sees (the voter organisation, the shared affiliation, the role), that a second vote from the credential will be refused, and that the vote can't be linked to the voter's other ballots. The voter's name appears nowhere, not even to the voter;
- for a voter credential, the ballot's Pseudonym: its voter tag, shortened to its first and last 8 hex characters, which explorers show beside the ballot, and "The same for every attempt with this credential in chair-2027, so a second ballot is refused. It names no one, and it is different in every election.";
- that Weft read the election, and sends the ballot, through the relay at the relay's host, which sees the voter's network address but not the choice, and whether Weft checked the peers' signatures on the election. For a voter credential, it names who runs the relay, from the voter invite, and which organisations' signatures Weft checked;
- Keep the receipt in Weft, off;
- Sign and vote.

For a voter credential, the first screen's notice says "Anonymous": Weft signs as an anonymous member of the voter organisation, and the site, the relay and each organisation see an encrypted ballot from a voter they can't name. Keep the receipt in Weft says the receipt is sealed with the activity, so the browser's files don't link the credential to the ballot.

The choice stays in the window and the worker. It leaves them only encrypted. Closing the window, or Reject on either screen, fails the request with `4001`.

While Weft works, the title says "Encrypting, signing and submitting" and the body dims. Once the ballot commits, the footer says the block and the tracking code, whether Weft kept the receipt, and links to the explorer's check, and the window closes after a moment. A failure after Sign and vote says what happened at the top of the body, with Close.

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

When the voter turns on Keep the receipt in Weft, Weft keeps the receipt with the transaction, and also seals the choice as a note for the voter alone, with AES-GCM under the receipt key from ADR 0006. The note is shown only in Weft, and proves nothing to anyone else. No method reads either back. For a ballot with a voter credential, the whole activity record, the receipt and the note are sealed together under the voter credentials' key, and shown only while Weft is unlocked ([What Weft stores](/experimental/voter-credentials/#what-weft-stores)).

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
- for a ballot with a voter credential, the per-election pseudonym and its proof, which are arguments too, and the anonymous creator: the voter MSP ID, the affiliation, the role, the one-off Nym and its proof. These name no one, and the browser's full check needs the Nym to check each pseudonym proof.

With `submitter: hide`, it still hides an X.509 submitter: the certificate, the name and enrolment ID in it, and the MSP ID. With `submitter: show`, it shows the certificate too, and the browser computes each tag from it. Where submitters are hidden, the browser checks every proof against the published tag and that no tag repeats, and relies on the explorer's server for the step from the transaction's creator to the tag, which the server checks as it indexes each block. Another organisation's explorer that shows submitters checks that step in the browser. A ballot with a voter credential needs neither: the browser makes its tag from its published pseudonym, and checks the one-off identity's proof and the pseudonym proof with the idemix module, wherever submitters are hidden.

A voter tag names no one. Anyone who holds the voter's certificate can compute its tag for an election, which includes every member organisation, the voter's CA and any site the voter connected the identity to, and see that the voter voted in it. The tag covers the channel and the election ID, so an X.509 voter has a different tag in every election, and the tags an explorer publishes don't link one certificate's ballots across elections. A voter credential's tag comes from its per-election pseudonym and links nothing either.

Election pages are made from the contract's arguments, so the explorer refuses to start with `privateElections` and `values: hash` on the same channel.

## What is built

In Weft Experimental, built with `WEFT_EXPERIMENTAL=1`:

- `weft_castBallot`, with the steps above, in the background worker (`apps/extension/lib/ballot/`), and the approval window's two screens and every failure (`entrypoints/approve/cast-ballot.tsx`). Normal Weft contains none of it and answers `4200`.
- `"castBallot"` in `window.weft.features`.
- The CA chain kept at enrolment and re-enrolment, and the peer signature check on the read.
- Receipt version 2: kept with its transaction, with the sealed note of the choice, in the popup's activity and transaction detail, with Download receipt, Copy receipt and Check in the explorer.
- In `@weftwallet/protocol`, `CastBallotParams`, `CastBallotResult`, `BallotReceiptV2` and `4400` as `ExperimentalErrorCode.ElectionUnavailable`; in `@weftwallet/sdk`, `castBallot()`.
- Anonymous ballots with voter credentials (ADR 0008): the credential picked by the election, the window's idemix worker connected to the background worker by a port (`lib/voter/remote.ts`), the read checked against the voter invite's CA chains, the window's anonymous screens and every failure below, `CastAnonymousBallot` with the voter tag from the pseudonym and the pseudonym proof bound to the tracking code, the proposal's creator compared with the identity Weft made, each identity disposed of after its use, and the sealed activity and receipt, shown in the popup's activity as `CastAnonymousBallot` with the election and "anonymous", and in its transaction detail as signed by "An anonymous member of ChairVoters2027MSP" with its Pseudonym. `"voterCredentials"` in `window.weft.features`.

In the explorer, started with `WEFT_EXPERIMENTAL=1`: the election pages, the tracking code check at `?tracking=<tracking>#receipt`, each ballot's published voter tag and the full check in the browser's workers ([Run an explorer](/operators/explorer/#private-elections)). For an election with voter credentials, each anonymous ballot's creator and pseudonym proof are checked with the idemix module as the block is indexed and again in the full check, its pinned issuer key is compared with the channel's configuration, and the pages show a Pseudonym column and an anonymous submitter ([What the explorer shows](/experimental/voter-credentials/#what-the-explorer-shows)).

In Weft Playground, the Private election section, shown when `window.weft.features` includes `"castBallot"` (`apps/playground/src/components/PrivateElection.astro`). It reads the elections from the explorer the invite names (`/api/v1/channels/<channel>/private-elections` and `/<id>` on every channel whose status lists `privateElections`), so reading needs no connection to Weft. It sends Weft only the channel, the contract and the election ID, and shows the result: the block, receipt version 2 with Download receipt, Copy receipt and a link to the explorer's tracking code check, and the count once the trustees publish it. It says what happened for each error below, with the code under Details. Every request and answer is in the page's provider log, which never holds the choice. For an election with voter credentials it shows the Voters row and Get a voter credential, with the election's voter invite from the relay and Copy voter invite, and its own sentences for `4300` without a credential ("Weft has no voter credential for chair-2027, so no ballot was cast. Copy the voter invite above into Weft Experimental's Join from an invite, enrol as one of the demo voters, then vote again.") and for a credential's second ballot (`5001`, "Your ballot wasn't committed: this voter credential has already voted in chair-2027."). A Weft Experimental without `"voterCredentials"` sees such an election as Needs voter credentials, with no Vote in Weft.

## Errors

| Code | Name | When |
|---|---|---|
| `4001` | UserRejected | The voter closed the window, at any step, or pressed Reject, except while the relay isn't answering. |
| `4200` | UnsupportedMethod | Normal Weft: it doesn't offer `weft_castBallot`. |
| `4300` | NoIdentity | Weft has no identity, no network with that channel, or no identity that can vote in this election: for an election with voter credentials, no credential for it, or one whose issuer key isn't the one the election pinned. `data.voterMsps` lists the organisations whose voters can. The window says which. When the network's invite may list the channel now, the window offers Refresh from invite and the request waits for it. |
| `4301` | CertificateExpired | The X.509 identity that would vote has expired. |
| `4400` | ElectionUnavailable | Weft couldn't read an open private election with that ID: it doesn't exist, isn't open, its record isn't one Weft reads, its `context` or `fingerprint` isn't the one Weft computed, or the peer's signature on it doesn't verify. `data.state` has the state when there is one. The window says which. New in Weft Experimental. |
| `-32002` | RequestPending | This site already has a request waiting in Weft. |
| `-32602` | InvalidParams | A missing or malformed param. The message names it. |
| `5001` | TransactionFailed | The contract refused the ballot, for example "This identity has already voted in this election.", "This credential has already voted in this election.", "The pseudonym proof is not valid." or "Voting has closed.", or the ballot failed validation because the election closed first. `data` has the details. |
| `5002` | NetworkUnavailable | The relay couldn't be reached. While Weft reads the election, the window offers Try again, and the request fails with `5002` when the voter presses Reject or closes the window instead. |
| `-32603` | Internal | Anything else, including Weft refusing to sign a proposal that isn't the ballot and the identity it made, and Weft Experimental's voting module not starting or failing. |
