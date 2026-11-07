---
title: Contract API
description: The planned Go contract for private elections, its functions, arguments, state keys, events and errors.
---

:::caution[Experimental]
This page describes Weft Experimental, a separate build that is not part of the main product, and nothing on it applies to Weft as you install it. No one outside the project has reviewed its cryptography. None of it is built yet, and the page describes the planned design.
:::

`examples/private-ballot-contract` is the contract for private elections, shared by the [private tally](/experimental/private-tally-spec/) and [voter credentials](/experimental/voter-credentials/). It is written in Go and deployed as `private-ballot`. The main product's `examples/ballot-contract` stays as it is, with its private collection and version 1 receipts.

## Overview

- It uses `fabric-chaincode-go`'s shim and `cid` package, which handle idemix creators. Whether `fabric-contract-api-go` does too is to be checked while building it. Node's `fabric-contract-api` doesn't ([ADR 0008](/reference/decisions/)).
- It verifies ballot proofs with a Go ristretto255 library, still to be chosen, and the pseudonym proof with IBM's idemix library, from the same Go source as Weft's WebAssembly build.
- It uses no private data collection and no transient data. Every argument is public.
- Every function is deterministic. The only clock it reads is the transaction's timestamp.
- Its endorsement and lifecycle policies name only X.509 organisations, since idemix organisations can't endorse. The playground uses `AND('Org1MSP.peer','Org2MSP.peer')`.

Arguments are strings, as in every Fabric contract. JSON arguments are parsed into fixed fields: unknown fields, missing fields and wrong types are refused. Points and scalars are lowercase hex, as the [specification](/experimental/private-tally-spec/#group-and-encoding) says.

## Election states

| State | Meaning | Next |
|---|---|---|
| `keygen` | The key ceremony is running. No ballots. | `open`, `failed` or `cancelled` |
| `open` | The key exists. Ballots are accepted until `closesAt`. | `decrypting` |
| `decrypting` | The totals are written. Trustees post decryption shares. | `counted` |
| `counted` | The tally is published. | None |
| `failed` | A trustee reported a bad share in the ceremony. | None |
| `cancelled` | The creator cancelled the election during the ceremony. | None |

## The election record

```json
{
  "v": 1,
  "id": "budget-2027",
  "title": "Budget 2027",
  "options": ["Plan A", "Plan B", "Plan C"],
  "closesAt": "2027-01-31T17:00:00.000Z",
  "creatorMsp": "Org1MSP",
  "trustees": [
    { "id": "0100000000000000000000000000000000000000000000000000000000000000", "msp": "Org1MSP" },
    { "id": "0200000000000000000000000000000000000000000000000000000000000000", "msp": "Org2MSP" }
  ],
  "threshold": 2,
  "voters": { "kind": "x509", "msps": ["Org1MSP", "Org2MSP"] },
  "state": "open",
  "publicKey": "<point>",
  "verifyingShares": ["<point>", "<point>"],
  "context": "<64 hex characters>",
  "fingerprint": "3f9a 61c2 08de 77b1 c4e0"
}
```

`voters` is one of:

- `{ "kind": "x509", "msps": [...] }`: X.509 identities of these organisations vote. The private tally only.
- `{ "kind": "idemix", "msp": "ChairVoters2027MSP", "issuerPublicKey": "<base64>", "issuerKeyHash": "<hex>", "curve": "FP256BN_AMCL" }`: voter credentials from this idemix organisation vote. `issuerPublicKey` is the issuer's `IssuerPublicKey` protobuf, pinned at creation. The contract can't read the channel configuration, so explorers compare `issuerKeyHash` with the organisation's key in the configuration block.

From `decrypting` on, the record also has `ballots` (the number accepted) and `totals` (one `{ a, b }` per option). From `counted`, it also has `tally: { counts: { "<option>": n }, total }`.

## Functions

| Function | Arguments | Who can call it | When |
|---|---|---|---|
| [`CreateElection`](#createelection) | `electionJson` | A member of one of the named trustee organisations | Any time |
| [`PostCommitments`](#postcommitments) | `electionId`, `round1Json` | A trustee | `keygen` |
| [`PostShares`](#postshares) | `electionId`, `round2Json` | A trustee | `keygen`, after every round 1 |
| [`ConfirmShares`](#confirmshares) | `electionId`, `proofJson` | A trustee | `keygen`, after every round 2 |
| [`ReportBadShare`](#reportbadshare) | `electionId`, `fromTrustee` | A trustee | `keygen`, after every round 2 |
| [`CancelElection`](#cancelelection) | `electionId` | A member of the creator's organisation | `keygen` |
| [`OpenElection`](#openelection) | `electionId` | Anyone with an X.509 identity in the channel | `keygen`, after every confirmation |
| [`CastBallot`](#castballot) | `electionId`, `ballotJson` | An X.509 voter | `open`, before `closesAt` |
| [`CastAnonymousBallot`](#castanonymousballot) | `electionId`, `ballotJson`, `pseudonymJson` | A voter credential | `open`, before `closesAt` |
| [`CloseElection`](#closeelection) | `electionId` | Anyone with an X.509 identity in the channel | `open`, after `closesAt` |
| [`PostDecryptionShare`](#postdecryptionshare) | `electionId`, `shareJson` | A trustee | `decrypting` |
| [`PublishTally`](#publishtally) | `electionId` | Anyone with an X.509 identity in the channel | `decrypting`, with k shares |
| `GetElection` | `electionId` | Anyone who can read the channel | Any time |
| `GetCeremony` | `electionId` | Anyone who can read the channel | Any time |
| `GetBallot` | `electionId`, `tracking` | Anyone who can read the channel | Any time |
| `GetDecryptionShares` | `electionId` | Anyone who can read the channel | Any time |

A trustee is an X.509 identity of a trustee organisation whose certificate carries the attribute `weft.trustee=true`. The contract works out which trustee is calling from the MSP ID, so trustee arguments don't name themselves.

### CreateElection

`electionJson` has `id`, `title`, `options`, `closesAt`, `trustees` (MSP IDs, in order), `threshold` and `voters`. The contract checks that:

- the ID is 1 to 64 letters, digits, `-` or `_`
- there are 2 to 20 different options
- `closesAt` is in the future
- there are at least two trustee organisations, all different
- the threshold is 2 to n
- for idemix voters, the issuer key parses for the named curve

It assigns identifiers 1 to n in the trustees' order and writes the election in `keygen`. Returns the election record. Event `ElectionCreated`.

### PostCommitments

Round 1. `round1Json` is `{ "commitments": [<point>, ...], "proof": { ... }, "ceremonyKey": <point> }`, with k commitments and the proof of knowledge in noble's FROST DKG format. The contract checks the proof and that this trustee hasn't posted round 1. Event `CeremonyStep` with `round: 1`.

### PostShares

Round 2. `round2Json` is `{ "shares": [{ "to": <id>, "nonce": <24 hex>, "box": <96 hex> }, ...] }`, one per other trustee. The contract checks that every other trustee gets exactly one share, of the right length. It can't check the shares themselves. Event `CeremonyStep` with `round: 2`.

### ConfirmShares

Round 3. `proofJson` is `{ "c": <scalar>, "z": <scalar> }`, the proof that the trustee holds the secret behind its verifying share. The contract checks it against the verifying share it computes from the round 1 commitments. Event `CeremonyStep` with `round: 3`.

### ReportBadShare

`fromTrustee` is the identifier of the trustee whose share failed its check. The election moves to `failed`. Event `ElectionFailed`.

### CancelElection

Moves an election that is still in `keygen` to `cancelled`. Event `ElectionCancelled`.

### OpenElection

Once every trustee has confirmed, computes the election key, the verifying shares, `context` and `fingerprint`, and moves the election to `open`. Every endorser computes the same values from the round 1 commitments. Event `ElectionOpened` with the fingerprint.

### CastBallot

For an election with X.509 voters. The creator's MSP ID must be one of `voters.msps`. Runs the checks in the [specification](/experimental/private-tally-spec/#what-the-contract-checks), with the voter tag from the creator's certificate. Returns `{ "electionId", "txId", "tracking" }`. Event `BallotCast` with the election ID and tracking code.

### CastAnonymousBallot

For an election with voter credentials. The creator must be an idemix identity of `voters.msp`. `pseudonymJson` is `{ "pseudonym": <base64>, "c": <base64>, "ssk": <base64>, "sr": <base64> }`. The contract reads the Nym from the creator, checks the [pseudonym proof](/experimental/voter-credentials/#the-per-election-pseudonym) against the pinned issuer key with the ballot's tracking code as context, then runs the same checks as `CastBallot` with the voter tag made from the pseudonym. Returns and emits the same as `CastBallot`.

### CloseElection

After `closesAt`, reads every accepted ballot of the election, adds them up per option, writes `ballots` and `totals`, and moves the election to `decrypting`. Event `ElectionClosed` with the number of ballots.

`CloseElection` reads every ballot by range, so its read set grows with the electorate. A ballot endorsed just before `closesAt` and committed after `CloseElection` was endorsed makes the close fail validation with a phantom read conflict. Call it again.

### PostDecryptionShare

`shareJson` is `{ "shares": [{ "d": <point>, "c": <scalar>, "z": <scalar> }, ...] }`, one per option. The contract checks every proof against the trustee's verifying share and the totals. Event `DecryptionSharePosted`.

### PublishTally

Once at least k trustees have posted shares, combines the k with the lowest identifiers, finds each count, checks they add up to `ballots`, writes `tally` and moves the election to `counted`. Event `TallyPublished` with the counts and total.

### Readers

`GetCeremony` returns every trustee's round 1, round 2 and confirmation as posted. `GetBallot` returns `{ "txId", "tracking", "ballot", "pseudonym"? }` for a tracking code. `GetDecryptionShares` returns every posted share. Explorers read the same data from blocks, and don't need these.

## State keys

Composite keys, with the object type first:

| Key | Value |
|---|---|
| `election` `<id>` | The election record |
| `ceremony1` `<id>` `<trustee>` | A trustee's round 1 |
| `ceremony2` `<id>` `<trustee>` | A trustee's round 2 |
| `confirm` `<id>` `<trustee>` | A trustee's confirmation proof |
| `ballot` `<id>` `<txId>` | `{ tracking, ballot, pseudonym? }` |
| `tracking` `<id>` `<tracking>` | The transaction ID |
| `ciphertext` `<id>` `<a>` | The transaction ID, one key per ciphertext, for the repeated-ciphertext check |
| `voted` `<id>` `<voter tag>` | An empty marker: this voter or credential has voted |
| `dshare` `<id>` `<trustee>` | A trustee's decryption share |

Each ballot, ciphertext and marker has a key of its own, so concurrent ballots never write the same key. The totals are computed once, at close, rather than kept as a running sum, which every concurrent ballot would conflict on.

## Events

Fabric keeps one event per transaction. Each payload is JSON with `electionId`.

| Event | Payload |
|---|---|
| `ElectionCreated` | `electionId` |
| `CeremonyStep` | `electionId`, `round`, `trustee` (MSP ID) |
| `ElectionOpened` | `electionId`, `fingerprint` |
| `BallotCast` | `electionId`, `tracking` |
| `ElectionClosed` | `electionId`, `ballots` |
| `DecryptionSharePosted` | `electionId`, `trustee` |
| `TallyPublished` | `electionId`, `counts`, `total` |
| `ElectionFailed` | `electionId`, `reportedBy`, `fromTrustee` |
| `ElectionCancelled` | `electionId` |

## Errors

Each error says what happened and, where the caller can do something about it, what to do. Weft returns them to the web app as `5001` TransactionFailed with the contract's message.

| Error | When |
|---|---|
| `There's no election <id>.` | Any call with an unknown election ID. |
| `Election <id> already exists.` | `CreateElection` with an ID in use. |
| `Election IDs are 1 to 64 letters, digits, - or _.` | `CreateElection`. |
| `An election has 2 to 20 options, all different.` | `CreateElection`. |
| `The threshold must be from 2 to the number of trustees.` | `CreateElection`. |
| `<MSP> isn't a trustee of this election.` | A trustee function from another organisation. |
| `This identity can't act as a trustee: its certificate doesn't carry weft.trustee=true.` | A trustee function from an identity without the attribute. |
| `<MSP> has already posted round <n>.` | A second post in the same round. |
| `Round <n> isn't finished: waiting for <MSP>.` | A round started before the one before it ended. |
| `The proof of knowledge from <MSP> doesn't verify.` | `PostCommitments`. |
| `The confirmation from <MSP> doesn't match its verifying share.` | `ConfirmShares`. |
| `The election isn't open: it is in <state>.` | A ballot outside `open`. |
| `Voting has closed.` | A ballot at or after `closesAt`. |
| `Voting is open until <closesAt>.` | `CloseElection` too early. |
| `This identity can't vote in this election: <MSP> isn't one of its voter organisations.` | `CastBallot` from another MSP, or either cast function for the wrong kind of voter. |
| `The ballot isn't for this election.` | Wrong `v` or `electionId`. |
| `The ballot has <n> ciphertexts; this election has <L> options.` | Wrong length. |
| `Ciphertext <j> has no randomness.` | An identity point. |
| `Ciphertext <j> is not a 0 or a 1.` | A bit proof fails. This includes a ballot under another key, a changed proof and a ballot copied from another voter. |
| `The ballot does not choose exactly one option.` | The sum proof fails. |
| `A ciphertext in this ballot is already on the ledger.` | A repeated ciphertext. |
| `The pseudonym proof is not valid.` | `CastAnonymousBallot`, including a proof copied from another voter. |
| `This identity has already voted in this election.` | A second ballot from an X.509 voter. |
| `This credential has already voted in this election.` | A second ballot from a voter credential. |
| `Share <j> from <MSP> does not match its key.` | `PostDecryptionShare`. |
| `The tally needs <k> decryption shares; <m> have been posted.` | `PublishTally` too early. |
| `A count is larger than the number of ballots, so the totals or shares are wrong.` | `PublishTally`, which should never happen with verified shares. |
