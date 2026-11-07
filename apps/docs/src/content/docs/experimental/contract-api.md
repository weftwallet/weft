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
- It is one Go module, `github.com/ifeanyi-ugwu/weft/examples/private-ballot-contract`, with the tally's verifiers in `internal/tally`. They handle no secret: decoding, the proof checks, the tracking code, totals, the round 1 proof of knowledge, the key and verifying shares, and combining decryption shares.
- It verifies ballot proofs with a Go ristretto255 library, still to be chosen, and the pseudonym proof with IBM's idemix library, from the same Go source as Weft's WebAssembly build.
- It uses no private data collection and no transient data. Every argument is public.
- Every function is deterministic, and none reads a clock. A transaction's timestamp is set by the client that sends it, and peers don't compare it with their own clocks, so the contract doesn't use it. An election stops accepting ballots when it is [closed](#closeelection) on the ledger.
- Its endorsement and lifecycle policies name only X.509 organisations, since idemix organisations can't endorse. The playground uses `AND('Org1MSP.peer','Org2MSP.peer')`.
- The peer builds it in Docker, as for the playground's other contracts, with test-network's `deployCC -ccl go`, which runs `go mod vendor` in the contract's folder. `vendor/` isn't committed, and the `go` line in `go.mod` is no newer than the Go in `hyperledger/fabric-ccenv:2.5`.

Arguments are strings, as in every Fabric contract. JSON arguments are parsed into fixed fields: unknown fields, missing fields and wrong types are refused. Points and scalars are lowercase hex, as the [specification](/experimental/private-tally-spec/#group-and-encoding) says.

## Election states

| State | Meaning | Next |
|---|---|---|
| `keygen` | The key ceremony is running. No ballots. | `open`, `failed` or `cancelled` |
| `open` | The key exists. Ballots are accepted until k trustees close the election. | `decrypting` |
| `decrypting` | Voting has closed and the totals are written. Trustees post decryption shares. | `counted` |
| `counted` | The tally is published. | None |
| `failed` | A trustee reported a bad share in the ceremony. | None |
| `cancelled` | The creator's organisation cancelled the election during the ceremony. | None |

`closesAt` is the planned closing time. The contract stores it for Weft and explorers to show, and doesn't act on it. Once `closesAt` has passed, the election stays `open` and keeps accepting ballots until the trustees close it with [`CloseElection`](#closeelection). Weft and explorers show that as "Open, past its planned closing time", and show `decrypting` as "Counting".

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
  "fingerprint": "3f9a61c208de77b1c4e0"
}
```

`fingerprint` is the [election fingerprint](/experimental/private-tally-spec/#the-election-fingerprint), 20 lowercase hex characters without spaces. Weft and explorers show it in five groups of four.

`voters` is one of:

- `{ "kind": "x509", "msps": [...] }`: X.509 identities of these organisations vote. The private tally only.
- `{ "kind": "idemix", "msp": "ChairVoters2027MSP", "issuerPublicKey": "<base64>", "issuerKeyHash": "<hex>", "curve": "FP256BN_AMCL" }`: voter credentials from this idemix organisation vote. `issuerPublicKey` is the issuer's `IssuerPublicKey` protobuf, pinned at creation. The contract can't read the channel configuration, so explorers compare `issuerKeyHash` with the organisation's key in the configuration block.

From `decrypting` on, the record also has `ballots` (the number accepted), `totals` (one `{ a, b }` per option) and `closedBy` (the MSP IDs of the trustees whose requests closed it). From `counted`, it also has `tally: { counts: { "<option>": n }, total }`.

## Functions

| Function | Arguments | Who can call it | When |
|---|---|---|---|
| [`CreateElection`](#createelection) | `electionJson` | A trustee identity of one of the named trustee organisations | Any time |
| [`PostCommitments`](#postcommitments) | `electionId`, `round1Json` | A trustee | `keygen` |
| [`PostShares`](#postshares) | `electionId`, `round2Json` | A trustee | `keygen`, after every round 1 |
| [`ConfirmShares`](#confirmshares) | `electionId`, `proofJson` | A trustee | `keygen`, after every round 2 |
| [`ReportBadShare`](#reportbadshare) | `electionId`, `fromTrustee` | A trustee | `keygen`, after every round 2 |
| [`CancelElection`](#cancelelection) | `electionId` | A trustee identity of the creator's organisation | `keygen` |
| [`OpenElection`](#openelection) | `electionId` | Anyone with an X.509 identity in the channel | `keygen`, after every confirmation |
| [`CastBallot`](#castballot) | `electionId`, `ballotJson` | An X.509 voter | `open` |
| [`CastAnonymousBallot`](#castanonymousballot) | `electionId`, `ballotJson`, `pseudonymJson` | A voter credential | `open` |
| [`CloseElection`](#closeelection) | `electionId` | A trustee | `open` |
| [`PostDecryptionShare`](#postdecryptionshare) | `electionId`, `shareJson` | A trustee | `decrypting` |
| [`PublishTally`](#publishtally) | `electionId` | Anyone with an X.509 identity in the channel | `decrypting`, with k shares |
| `GetElection` | `electionId` | Anyone who can read the channel | Any time |
| `GetCeremony` | `electionId` | Anyone who can read the channel | Any time |
| `GetBallot` | `electionId`, `tracking` | Anyone who can read the channel | Any time |
| `GetDecryptionShares` | `electionId` | Anyone who can read the channel | Any time |

A trustee identity is an X.509 identity whose certificate carries the Fabric CA attribute `weft.trustee=true`. A trustee is a trustee identity of one of the election's trustee organisations. The contract works out which trustee is calling from the MSP ID, so trustee arguments don't name themselves.

The contract checks the caller itself, with `cid`, from the creator's MSP ID and its `weft.trustee` attribute. Endorsement policies, at chaincode or key level, say which peers must sign a result and can't name the client that submits it.

### CreateElection

`electionJson` has `id`, `title`, `options`, `closesAt`, `trustees` (MSP IDs, in order), `threshold` and `voters`. The caller's organisation becomes `creatorMsp`. The contract checks that:

- the caller is a trustee identity of one of the named trustee organisations
- the ID is 1 to 64 letters, digits, `-` or `_`
- there are 2 to 20 different options
- `closesAt` is a UTC time written as `2027-01-31T17:00:00.000Z`. It isn't compared with any clock.
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

Once every trustee has confirmed, computes the election key, the verifying shares, `context` and `fingerprint`, and moves the election to `open`. Every endorser computes the same values from the round 1 commitments. Event `ElectionOpened` with the fingerprint. `weft-trustee confirm` calls it when its confirmation is the last one.

### CastBallot

For an election with X.509 voters. The creator's MSP ID must be one of `voters.msps`. Runs the checks in the [specification](/experimental/private-tally-spec/#what-the-contract-checks), with the voter tag from the creator's certificate. Returns `{ "electionId", "txId", "tracking" }`. Event `BallotCast` with the election ID and tracking code.

### CastAnonymousBallot

For an election with voter credentials. The creator must be an idemix identity of `voters.msp`. `pseudonymJson` is `{ "pseudonym": <base64>, "c": <base64>, "ssk": <base64>, "sr": <base64> }`. The contract reads the Nym from the creator, checks the [pseudonym proof](/experimental/voter-credentials/#the-per-election-pseudonym) against the pinned issuer key with the ballot's tracking code as context, then runs the same checks as `CastBallot` with the voter tag made from the pseudonym. Returns and emits the same as `CastBallot`.

### CloseElection

A trustee asks to close voting. The contract records the request under `close` `<id>` `<trustee>`, unless this trustee has already asked. If at least k trustees have then asked, it reads every accepted ballot of the election, adds them up per option, writes `ballots`, `totals` and `closedBy`, and moves the election to `decrypting`. Otherwise the election stays `open`. Event `ElectionClosed` with the number of ballots when the call closes the election, and `CloseRequested` with the trustee when it doesn't.

The transaction that closes the election is the cut-off, whatever any timestamp says:

- `CastBallot` and `CastAnonymousBallot` read the election record, which the close rewrites. A ballot committed before the close is counted. A ballot committed after it fails validation with `MVCC_READ_CONFLICT`, whenever it was endorsed, and a ballot endorsed after it is refused with "Voting has closed."
- The close reads every ballot by range, so its read set grows with the electorate. A ballot committed between the close's endorsement and its commit makes the close fail validation with `PHANTOM_READ_CONFLICT`. Call it again.
- A call from a trustee that has already asked still closes the election once k have asked. Two requests endorsed at the same moment each see only their own, and the next call from either trustee completes the close.

Only trustees can close, and k of them are needed, because k trustees together already decide whether the totals are ever decrypted. No group smaller than k can end voting, and any group large enough to stop a close by not asking, n - k + 1 trustees, could already stop the count by withholding its decryption shares. The contract doesn't stop k trustees closing before `closesAt`. `weft-trustee close` asks for `--early` to do that, and explorers show the block the election closed in beside `closesAt`.

### PostDecryptionShare

`shareJson` is `{ "shares": [{ "d": <point>, "c": <scalar>, "z": <scalar> }, ...] }`, one per option. The contract checks every proof against the trustee's verifying share and the totals, and accepts one share per trustee. Event `DecryptionSharePosted`.

### PublishTally

Once at least k trustees have posted shares, combines the k with the lowest identifiers, finds each count, checks they add up to `ballots`, writes `tally` and moves the election to `counted`. Event `TallyPublished` with the counts and total. `weft-trustee decrypt` calls it when its share is the k-th.

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
| `close` `<id>` `<trustee>` | An empty marker: this trustee has asked to close voting |
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
| `CloseRequested` | `electionId`, `trustee` (MSP ID) |
| `ElectionClosed` | `electionId`, `ballots`, `closedBy` |
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
| `An election has at least two trustee organisations, all different.` | `CreateElection`. |
| `The threshold must be from 2 to the number of trustees.` | `CreateElection`. |
| `closesAt isn't a time in the form 2027-01-31T17:00:00.000Z.` | `CreateElection`. |
| `Elections with voter credentials aren't supported by this version of the contract.` | `CreateElection` with `voters.kind` `"idemix"`, until voter credentials are built. |
| `<MSP> isn't one of the trustee organisations named in this election.` | `CreateElection` from an organisation that isn't in `trustees`. |
| `<MSP> isn't a trustee of this election.` | A trustee function, including `CloseElection`, from another organisation. |
| `This identity can't act as a trustee: its certificate doesn't carry weft.trustee=true.` | `CreateElection`, `CancelElection` or a trustee function from an identity without the attribute. |
| `<MSP> didn't create this election, so it can't cancel it.` | `CancelElection` from another organisation. |
| `The key ceremony has ended: the election is in <state>.` | A ceremony function, `ReportBadShare`, `CancelElection` or `OpenElection` outside `keygen`. |
| `<MSP> has already posted round <n>.` | A second post in the same round, including a second confirmation in round 3. |
| `Round <n> isn't finished: waiting for <MSP>.` | A round, a report or `OpenElection` before the round before it ended. |
| `The proof of knowledge from <MSP> doesn't verify.` | `PostCommitments`. |
| `The confirmation from <MSP> doesn't match its verifying share.` | `ConfirmShares`. |
| `Trustee <id> isn't another trustee of this election.` | `ReportBadShare` naming an unknown identifier or the caller's own. |
| `The election isn't open: it is in <state>.` | A ballot, or `CloseElection`, in `keygen`, `failed` or `cancelled`. |
| `Voting has closed.` | A ballot in `decrypting` or `counted`. |
| `Voting has already closed: the election is in <state>.` | `CloseElection` in `decrypting` or `counted`. |
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
| `The election is in <state>: decryption shares are posted while it is in decrypting.` | `PostDecryptionShare` outside `decrypting`. |
| `<MSP> has already posted its decryption share.` | A second `PostDecryptionShare` from the same trustee. |
| `The decryption share has <n> entries; this election has <L> options.` | `PostDecryptionShare` with the wrong length. |
| `Share <j> from <MSP> does not match its key.` | `PostDecryptionShare`. |
| `The tally is already published.` | `PublishTally` in `counted`. |
| `The tally can't be published: the election is in <state>.` | `PublishTally` in any other state but `decrypting`. |
| `The tally needs <k> decryption shares; <m> have been posted.` | `PublishTally` too early. |
| `A count is larger than the number of ballots, so the totals or shares are wrong.` | `PublishTally`, which should never happen with verified shares. |

Every negative [test vector](/experimental/private-tally-spec/#test-vectors) carries the message from this table that the contract must return for it.
