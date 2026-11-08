---
title: Contract API
description: The Go contract for private elections, its functions, arguments, state keys, events and errors.
---

:::caution[Experimental]
This page describes Weft Experimental, a separate build that is not part of the main product, and nothing on it applies to Weft as you install it. No one outside the project has reviewed its cryptography. The contract is built for elections with X.509 voters and with voter credentials, and the playground deploys it. [What is built](#what-is-built) says what uses it.
:::

`examples/private-ballot-contract` is the contract for private elections, shared by the [private tally](/experimental/private-tally-spec/) and [voter credentials](/experimental/voter-credentials/). It is written in Go and deployed as `private-ballot`. The main product's `examples/ballot-contract` stays as it is, with its private collection and version 1 receipts.

## Overview

- It uses `fabric-chaincode-go`'s shim and `cid` package, v2.3.0, and not `fabric-contract-api-go`. `cid` reads the Fabric CA attributes of an X.509 creator and the OU and role of an idemix creator, so a call from either gets an answer. `fabric-contract-api-go` also builds its caller from `cid`, and ignores the error, so it would accept idemix creators too, unlike Node's `fabric-contract-api` ([ADR 0008](/reference/decisions/)). It isn't used because its latest release, v2.2.4, needs Go 1.26.7, newer than the Go in `hyperledger/fabric-ccenv:2.5`, and because it refuses some calls with messages of its own, outside the [error table](#errors). The contract reads the creator's `SerializedIdentity` itself for the voter tag.
- The [election context](/experimental/private-tally-spec/#the-election-context) binds the contract's own name, which the shim doesn't give. The contract reads it from the signed proposal, in the `ChaincodeHeaderExtension` of the channel header, which names the contract the client called and the peer ran. It computes the context when the third round of the ceremony is checked and when the election opens, and from then on uses the `context` in the record.
- It is one Go module, `github.com/ifeanyi-ugwu/weft/examples/private-ballot-contract`, with the tally's verifiers in `internal/tally`. They handle no secret: decoding, the proof checks, the tracking code, totals, the round 1 proof of knowledge, the key and verifying shares, and combining decryption shares.
- It verifies ballot proofs with `github.com/gtank/ristretto255` on `filippo.io/edwards25519`. The module's README gives the reasons for the ristretto255 library. It verifies the [pseudonym proof](/experimental/private-tally-spec/#the-per-election-pseudonym) with its `pseudonym` package, on IBM mathlib, and decodes issuer keys with IBM idemix's dlog package. Weft's WebAssembly module compiles the same `pseudonym` package, so one Go source proves and verifies.
- It uses no private data collection and no transient data. Every argument is public.
- Every function is deterministic, and none reads a clock. A transaction's timestamp is set by the client that sends it, and peers don't compare it with their own clocks. `CreateElection` is the one function that reads it, to refuse a `closesAt` that has already passed, and no other function reads it. Every endorser reads the same timestamp from the proposal, so they agree. A creator that writes a wrong time can only get past the check with a `closesAt` that has already passed, which makes its own election show as past its planned closing time, and the contract doesn't act on `closesAt`. `CastBallot`, `CloseElection` and every other function read no time, and an election stops accepting ballots when it is [closed](#closeelection) on the ledger.
- Its endorsement and lifecycle policies name only X.509 organisations, since idemix organisations can't endorse. The playground uses `AND('Org1MSP.peer','Org2MSP.peer')`.
- The peer builds it in Docker, as for the playground's other contracts, with test-network's `deployCC -ccl go`, which runs `go mod vendor` in the contract's folder. `vendor/` isn't committed, and the `go` line in `go.mod` is no newer than the Go in `hyperledger/fabric-ccenv:2.5`: it is `go 1.26.3`, the oldest Go IBM idemix v0.3.1 builds with, and the image for Fabric 2.5.16 has Go 1.26.4. Its `toolchain` line is `go1.26.10`, the toolchain of Weft's idemix WebAssembly module, which Go downloads on a machine whose Go is older when it vendors the modules. The `main` package is at the module's root, which is where the peer's Go build looks.

Arguments are strings, as in every Fabric contract. JSON arguments are parsed into fixed fields: unknown fields, missing fields and wrong types are refused, in the order [the specification](/experimental/private-tally-spec/#parsing-the-contracts-arguments) sets. Points and scalars are lowercase hex, as the [specification](/experimental/private-tally-spec/#group-and-encoding) says.

## What is built

Everything on this page is built, in `examples/private-ballot-contract`, including elections with voter credentials ([ADR 0008](/reference/decisions/)): `CreateElection` with `voters.kind` `"idemix"`, and `CastAnonymousBallot` with the pseudonym proof. `weft-trustee create` creates one with `--voter-credentials` and `--issuer-key`. On the native network the step 4 tests ran on, voter credentials from Fabric CA 1.5.17 voted in such an election and were counted, and the refusals for a second ballot, another affiliation, the admin role, a changed proof, a proof from another voter's transaction, an election pinning another issuer key and the wrong cast function came back word for word.

The playground deploys it on every election's channel, and seeds `budget-2027` and `chair-2027`, with voter credentials, with [`weft-trustee`](/experimental/key-ceremony/#the-trustee-tool). Weft Experimental enrols from a voter invite and casts `CastAnonymousBallot` ([Voter credentials](/experimental/voter-credentials/#what-is-built)), and the playground's test drivers do the same with the idemix module in Node, through the relay.

## Election states

| State | Meaning | Next |
|---|---|---|
| `keygen` | The key ceremony is running. No ballots. | `open`, `failed` or `cancelled` |
| `open` | The key exists. Ballots are accepted until k trustees close the election. | `decrypting` |
| `decrypting` | Voting has closed and the totals are written. Trustees post decryption shares. | `counted` |
| `counted` | The tally is published. | None |
| `failed` | A trustee reported a bad share in the ceremony. | None |
| `cancelled` | The creator's organisation cancelled the election during the ceremony. | None |

`closesAt` is the planned closing time. The contract compares it with the transaction's timestamp once, when the election is created, stores it for Weft and explorers to show, and doesn't act on it after that. Once `closesAt` has passed, the election stays `open` and keeps accepting ballots until the trustees close it with [`CloseElection`](#closeelection). Weft and explorers show that as "Open, past its planned closing time", and show `decrypting` as "Counting".

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

Each trustee's `id` is its identifier, the scalar i as 64 lowercase hex characters, in the order of the trustee list. `publicKey`, `verifyingShares`, `context` and `fingerprint` are there from `open` on.

`voters` is one of:

- `{ "kind": "x509", "msps": [...] }`: X.509 identities of these organisations vote. The private tally only.
- `{ "kind": "idemix", "msp": "ChairVoters2027MSP", "affiliation": "voters", "role": "member", "issuerPublicKey": "<base64>", "issuerKeyHash": "<64 hex characters>", "curve": "FP256BN_AMCL" }`: voter credentials from this idemix organisation vote, if their organisational unit is `affiliation` and their role is member. `issuerPublicKey` is the issuer's `IssuerPublicKey` file in base64, pinned at creation, and `issuerKeyHash` is SHA-256 of its bytes, which the contract checks. The contract can't read the channel configuration, so explorers compare `issuerKeyHash` with SHA-256 of the organisation's key in the configuration block. The affiliation and the role are pinned because an idemix MSP accepts every credential from its issuer key, including those of the voters' CA's own identities ([Voter credentials](/experimental/voter-credentials/#which-credentials-can-vote)).

In `failed`, the record also has `reportedBy`, the MSP ID of the trustee organisation that reported a bad share. The `ElectionFailed` event names the sender too. From `decrypting` on, the record also has `ballots` (the number accepted), `totals` (one `{ a, b }` per option) and `closedBy` (the MSP IDs of the trustees whose requests closed it, in the order of the trustee list). From `counted`, it also has `tally: { counts: { "<option>": n }, total }`, with the counts in option order.

Every function that writes returns the election record as it is after the call, except `CastBallot`, which returns its own result.

## Functions

| Function | Arguments | Who can call it | When |
|---|---|---|---|
| [`CreateElection`](#createelection) | `electionJson` | A trustee identity of one of the named trustee organisations | Any time |
| [`PostCommitments`](#postcommitments) | `electionId`, `round1Json` | A trustee | `keygen` |
| [`PostShares`](#postshares) | `electionId`, `round2Json` | A trustee | `keygen`, after every round 1 |
| [`ConfirmShares`](#confirmshares) | `electionId`, `proofJson` | A trustee | `keygen`, after every round 2 |
| [`ReportBadShare`](#reportbadshare) | `electionId`, `fromTrustee` | A trustee that hasn't confirmed | `keygen`, after every round 2 |
| [`CancelElection`](#cancelelection) | `electionId` | A trustee identity of the creator's organisation | `keygen` |
| [`OpenElection`](#openelection) | `electionId` | Anyone with an X.509 identity in the channel | `keygen`, after every confirmation |
| [`CastBallot`](#castballot) | `electionId`, `ballotJson` | An X.509 voter | `open` |
| [`CastAnonymousBallot`](#castanonymousballot) | `electionId`, `ballotJson`, `pseudonymJson` | A voter credential of the election's voter organisation, with its affiliation and the role member | `open` |
| [`CloseElection`](#closeelection) | `electionId` | A trustee, once | `open` |
| [`PostDecryptionShare`](#postdecryptionshare) | `electionId`, `shareJson` | A trustee | `decrypting` |
| [`PublishTally`](#publishtally) | `electionId` | Anyone with an X.509 identity in the channel | `decrypting`, with k shares |
| `GetElection` | `electionId` | Anyone who can read the channel | Any time |
| `GetCeremony` | `electionId` | Anyone who can read the channel | Any time |
| `GetBallot` | `electionId`, `tracking` | Anyone who can read the channel | Any time |
| `GetDecryptionShares` | `electionId` | Anyone who can read the channel | Any time |

A trustee identity is an X.509 identity whose certificate carries the Fabric CA attribute `weft.trustee=true`. A trustee is a trustee identity of one of the election's trustee organisations. The contract works out which trustee is calling from the MSP ID, so trustee arguments don't name themselves.

The contract checks the caller itself, with `cid`, from the creator's MSP ID and its `weft.trustee` attribute. Endorsement policies, at chaincode or key level, say which peers must sign a result and can't name the client that submits it.

### CreateElection

`electionJson` has `id`, `title`, `options`, `closesAt`, `trustees` (MSP IDs, in order), `threshold` and `voters`. It is parsed as the other JSON arguments are, with "The election" in the messages, and `voters` is read last: its `kind` chooses the fields the rest of it has, `msps` for `"x509"`, and `msp`, `affiliation`, `role`, `issuerPublicKey`, `issuerKeyHash` and `curve`, in that order, for `"idemix"`. A threshold is a number, and `2`, `2.0` and `2e0` are all 2. The caller's organisation becomes `creatorMsp`. Once it parses, the contract checks, in this order, that:

- the caller is a trustee identity of one of the named trustee organisations
- the ID is 1 to 64 letters, digits, `-` or `_`
- the title is 1 to 200 characters, counted as Unicode code points
- there are 2 to 20 different options
- `closesAt` is a UTC time written as `2027-01-31T17:00:00.000Z`, later than the transaction's timestamp
- there are at least two trustee organisations, all different
- the threshold is 2 to n
- for voter credentials, in this order: the curve is `FP256BN_AMCL`; the affiliation isn't empty; the role is `member`; `issuerPublicKey` is standard base64, with its padding and without line breaks, of an IBM idemix `IssuerPublicKey` that passes IBM idemix's own check for the curve (its points are on the curve and its proof of knowledge verifies), whose `HSk` and `HRand` aren't the identity, and that has Fabric's four attribute names, `OU`, `Role`, `EnrollmentID` and `RevocationHandle`, in that order; and `issuerKeyHash` is SHA-256 of the bytes `issuerPublicKey` decodes to, as 64 lowercase hex characters. It isn't the key's own `hash` field, which IBM idemix computes differently.
- for X.509 voters, `voters.msps` names at least one organisation, all different

The title limit counts code points, so it is the same in every script, and Go and JavaScript count code points the same way. They count UTF-16 units and user-perceived characters differently, and the second depends on Unicode tables that change between versions, so endorsers could disagree. 200 code points holds a full motion title and keeps the record small, and Weft, `weft-trustee` and explorers show the title on one or two lines.

`closesAt` is compared with the transaction's timestamp, which the client sets, and with no clock. This is the only place the contract reads that timestamp. The check catches a creator's mistake: a creator that writes a wrong time can only make its own election show as past its planned closing time, and the contract doesn't act on `closesAt`.

It assigns identifiers 1 to n in the trustees' order and writes the election in `keygen`. Returns the election record. Event `ElectionCreated`.

### PostCommitments

Round 1. `round1Json` is `{ "commitments": [<point>, ...], "proof": <128 hex>, "ceremonyKey": <point> }`, with k commitments and the proof of knowledge in noble's FROST DKG format, its 64 bytes `R` then `z`. The contract checks the proof, that no commitment and not the one-time key is the identity, and that this trustee hasn't posted round 1. Event `CeremonyStep` with `round: 1`.

### PostShares

Round 2. `round2Json` is `{ "shares": [{ "to": <id>, "nonce": <24 hex>, "box": <96 hex> }, ...] }`, one per other trustee, with `to` the recipient's identifier as a scalar. The contract checks that every other trustee gets exactly one share, of the right length. It can't check the shares themselves. Event `CeremonyStep` with `round: 2`.

### ConfirmShares

Round 3. `proofJson` is `{ "c": <scalar>, "z": <scalar> }`, the proof that the trustee holds the secret behind its verifying share. The contract checks it against the verifying share it computes from the round 1 commitments. Event `CeremonyStep` with `round: 3`.

### ReportBadShare

`fromTrustee` is the identifier of the trustee whose share failed its check, as the record's trustee list writes it. A trustee that has posted round 3 has said its shares checked, so the contract refuses a report from it. The election moves to `failed`, and the record gets `reportedBy`, the caller's MSP ID. Event `ElectionFailed`.

### CancelElection

Moves an election that is still in `keygen` to `cancelled`. Event `ElectionCancelled`.

### OpenElection

Once every trustee has confirmed, computes the election key, the verifying shares, `context` and `fingerprint`, and moves the election to `open`. Every endorser computes the same values from the round 1 commitments. Event `ElectionOpened` with the fingerprint. `weft-trustee confirm` calls it when its confirmation is the last one.

### CastBallot

For an election with X.509 voters. After the election's state, the contract checks that the election has X.509 voters, that the creator's MSP ID is one of `voters.msps` and that the creator is an X.509 identity, then runs the checks in the [specification](/experimental/private-tally-spec/#what-the-contract-checks), with the voter tag from the creator's certificate. Returns `{ "electionId", "txId", "tracking" }`. Event `BallotCast` with the election ID and tracking code.

### CastAnonymousBallot

For an election with voter credentials. `pseudonymJson` is the [pseudonym proof](/experimental/private-tally-spec/#the-proof-as-an-argument), `{ "pseudonym": <point>, "c": <scalar>, "ssk": <scalar>, "sr": <scalar> }`, with the pseudonym as 64 bytes and each scalar as 32 bytes of FP256BN, in lowercase hex. The contract checks, in this order, stopping at the first failure:

1. The election exists and is `open`.
2. The election has voter credentials. Otherwise: "This election has X.509 voters, so its ballots are cast with CastBallot."
3. The creator's MSP ID is `voters.msp`.
4. The creator is an idemix identity: its `id_bytes` decode as a `SerializedIdemixIdentity` whose `nym_x` and `nym_y`, 32 bytes each, are a point of G1.
5. The creator's organisational unit, from its `ou` field, is `voters.affiliation`, and its role, from its `role` field, is member, as `cid` reads them. The peer's idemix MSP has already checked that the credential behind the Nym carries both. A credential with Fabric CA's role 2 passes the channel's `member` policies, and this check is what refuses it.
6. The ballot parses and decodes.
7. `pseudonymJson` parses and decodes.
8. It makes the voter tag from the pseudonym and the tracking code from the ballot.
9. The pseudonym proof verifies against the creator's Nym, the pinned issuer key and the tracking code.
10. The ballot's proofs verify, its ciphertexts don't repeat, and the credential hasn't voted in this election.

The [specification](/experimental/private-tally-spec/#what-the-contract-checks) has each step. The contract stores the pseudonym proof with the ballot. Returns and emits the same as `CastBallot`.

### CloseElection

A trustee asks to close voting. The contract refuses a trustee that has already asked, and otherwise records the request under `close` `<id>` `<trustee>`. If at least k trustees have then asked, it reads every accepted ballot of the election, adds them up per option, writes `ballots`, `totals` and `closedBy`, and moves the election to `decrypting`. Otherwise the election stays `open`. Event `ElectionClosed` with the number of ballots when the call closes the election, and `CloseRequested` with the trustee when it doesn't.

The transaction that closes the election is the cut-off, whatever any timestamp says:

- `CastBallot` and `CastAnonymousBallot` read the election record, which the close rewrites. A ballot committed before the close is counted. A ballot committed after it fails validation with `MVCC_READ_CONFLICT`, whenever it was endorsed, and a ballot endorsed after it is refused with "Voting has closed."
- The close reads every ballot by range, so its read set grows with the electorate. A ballot committed between the close's endorsement and its commit makes the close fail validation with `PHANTOM_READ_CONFLICT`. Call it again.
- A call from a trustee that has already asked is refused, so it writes nothing and emits no event. The request that brings the number to k closes the election in the same transaction, so asking again could never close it. Two requests endorsed at the same moment each see only their own. The one committed second fails validation with `MVCC_READ_CONFLICT`, because it read the first one's key, and calling again completes the close.

Only trustees can close, and k of them are needed, because k trustees together already decide whether the totals are ever decrypted. No group smaller than k can end voting, and any group large enough to stop a close by not asking, n - k + 1 trustees, could already stop the count by withholding its decryption shares. The contract doesn't stop k trustees closing before `closesAt`. `weft-trustee close` asks for `--early` to do that, and explorers show the block the election closed in beside `closesAt`.

### PostDecryptionShare

`shareJson` is `{ "shares": [{ "d": <point>, "c": <scalar>, "z": <scalar> }, ...] }`, one per option. The contract refuses a share while the election is in `keygen` or `open`, before voting has closed and the totals exist, checks every proof against the trustee's verifying share and the totals, and accepts one share per trustee. Event `DecryptionSharePosted`.

### PublishTally

Once at least k trustees have posted shares, combines the k with the lowest identifiers, finds each count, checks they add up to `ballots`, writes `tally` and moves the election to `counted`. Event `TallyPublished` with the counts and total. `weft-trustee decrypt` calls it when its share is the k-th.

### Readers

`GetCeremony` returns `{ "electionId", "trustees": [{ "id", "msp", "round1", "round2", "confirmation", "closeRequested" }] }` in the order of the trustee list, with each post as the contract stored it and `null` for one not yet posted, and `closeRequested` true once that trustee has asked to close. `GetBallot` returns `{ "txId", "tracking", "ballot", "pseudonym"? }` for a tracking code, with `pseudonym` the stored pseudonym proof for a ballot with a voter credential. `GetDecryptionShares` returns `{ "electionId", "shares": [{ "id", "msp", "shares" }] }`, every posted share in the order of the trustee list. Explorers read the same data from blocks, and don't need these.

## State keys

Composite keys, with the object type first. `<trustee>` is the trustee's MSP ID, and `<voter tag>` is 64 lowercase hex characters. Each post is stored as JSON with the format's fields in the format's order, whatever order the argument had.

| Key | Value |
|---|---|
| `election` `<id>` | The election record |
| `ceremony1` `<id>` `<trustee>` | A trustee's round 1 |
| `ceremony2` `<id>` `<trustee>` | A trustee's round 2 |
| `confirm` `<id>` `<trustee>` | A trustee's confirmation proof |
| `ballot` `<id>` `<txId>` | `{ tracking, ballot, pseudonym? }`, with `pseudonym` the pseudonym proof of a ballot with a voter credential |
| `tracking` `<id>` `<tracking>` | The transaction ID |
| `ciphertext` `<id>` `<a>` | The transaction ID, one key per ciphertext, for the repeated-ciphertext check |
| `voted` `<id>` `<voter tag>` | A marker, the ballot's transaction ID: this voter or credential has voted |
| `close` `<id>` `<trustee>` | A marker, the request's transaction ID: this trustee has asked to close voting |
| `dshare` `<id>` `<trustee>` | A trustee's decryption share |

The markers hold a transaction ID because Fabric deletes a key that is written with an empty value.

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
| `ElectionClosed` | `electionId`, `ballots`, `closedBy` (MSP IDs, in the order of the trustee list) |
| `DecryptionSharePosted` | `electionId`, `trustee` |
| `TallyPublished` | `electionId`, `counts`, `total` |
| `ElectionFailed` | `electionId`, `reportedBy`, `fromTrustee` (both MSP IDs) |
| `ElectionCancelled` | `electionId` |

## Errors

Each error says what happened and, where the caller can do something about it, what to do. Weft returns them to the web app as `5001` TransactionFailed with the contract's message.

| Error | When |
|---|---|
| `There's no election <id>.` | Any call with an unknown election ID. |
| `The contract has no function <name>.` | A call to a function the contract doesn't have. |
| `<function> takes <n> arguments: <names>.` | A call with another number of arguments, for example "CastBallot takes 2 arguments: electionId and ballotJson." |
| `Election <id> already exists.` | `CreateElection` with an ID in use. |
| `Election IDs are 1 to 64 letters, digits, - or _.` | `CreateElection`. |
| `Election titles are 1 to 200 characters.` | `CreateElection` with an empty title or a longer one, counted in Unicode code points. |
| `An election has 2 to 20 options, all different.` | `CreateElection`. |
| `An election has at least two trustee organisations, all different.` | `CreateElection`. |
| `The threshold must be from 2 to the number of trustees.` | `CreateElection`. |
| `closesAt isn't a time in the form 2027-01-31T17:00:00.000Z.` | `CreateElection`. |
| `closesAt isn't later than this transaction's timestamp, <time>.` | `CreateElection` with a `closesAt` that has passed, by the timestamp the client wrote in the transaction. |
| `An election has at least one voter organisation, all different.` | `CreateElection` with X.509 voters and an empty `voters.msps`, or one that names an organisation twice. |
| `The curve <curve> isn't supported: voter credentials use FP256BN_AMCL.` | `CreateElection` with voter credentials on another curve. |
| `voters.affiliation is empty.` | `CreateElection` with voter credentials and an empty affiliation, which is the root affiliation that Fabric CA's bootstrap admin has. |
| `voters.role isn't member, the only role that can vote.` | `CreateElection` with voter credentials and another role. |
| `The issuer key isn't an idemix issuer public key for FP256BN_AMCL.` | `CreateElection` with an `issuerPublicKey` that isn't base64, doesn't decode, fails IBM idemix's check or has other attribute names. |
| `issuerKeyHash isn't SHA-256 of the issuer key.` | `CreateElection` with an `issuerKeyHash` that isn't 64 lowercase hex characters, or isn't SHA-256 of the key's bytes. |
| `The election isn't in the version 1 format: voters.kind is neither "x509" nor "idemix".` | `CreateElection` with another kind of voters. |
| `<MSP> isn't one of the trustee organisations named in this election.` | `CreateElection` from an organisation that isn't in `trustees`. |
| `<MSP> isn't a trustee of this election.` | A trustee function, including `CloseElection`, from another organisation. |
| `This identity can't act as a trustee: its certificate doesn't carry weft.trustee=true.` | `CreateElection`, `CancelElection` or a trustee function from an identity without the attribute. |
| `<MSP> didn't create this election, so it can't cancel it.` | `CancelElection` from another organisation. |
| `The key ceremony has ended: the election is in <state>.` | A ceremony function, `ReportBadShare`, `CancelElection` or `OpenElection` outside `keygen`. |
| `<MSP> has already posted round <n>.` | A second post in the same round, including a second confirmation in round 3. |
| `Round <n> isn't finished: waiting for <MSP>.` | A round, a report or `OpenElection` before the round before it ended. |
| `The proof of knowledge from <MSP> doesn't verify.` | `PostCommitments`, including a proof that isn't 64 bytes, a non-canonical `R` or `z`, an identity `R`, and another trustee's round 1. |
| `Round 1 from <MSP> has <n> commitments; this election's threshold is <k>.` | `PostCommitments` with other than k commitments. |
| `Commitment <t> from <MSP> is the identity point.` | `PostCommitments`. |
| `The one-time key from <MSP> is the identity point.` | `PostCommitments`. |
| `Round 2 from <MSP> doesn't send exactly one share to each other trustee.` | `PostShares` with a share missing, repeated, to the sender itself or to an identifier that isn't a trustee's. |
| `The confirmation from <MSP> doesn't match its verifying share.` | `ConfirmShares`. |
| `Trustee <id> isn't another trustee of this election.` | `ReportBadShare` naming an unknown identifier or the caller's own. |
| `<MSP> has already confirmed its shares, so it can't report a bad share.` | `ReportBadShare` from a trustee that has posted round 3. |
| `This identity can't open the election: it isn't an X.509 identity.` | `OpenElection` from a voter credential. The same message, with `vote in this election`, answers `CastBallot` from an idemix identity of a voter organisation. |
| `The election isn't open: it is in <state>.` | A ballot, or `CloseElection`, in `keygen`, `failed` or `cancelled`. |
| `Voting has closed.` | A ballot in `decrypting` or `counted`. |
| `Voting has already closed: the election is in <state>.` | `CloseElection` in `decrypting` or `counted`. |
| `<MSP> has already asked to close voting.` | A second `CloseElection` from the same trustee while the election is `open`. It writes nothing and emits no event. |
| `This identity can't vote in this election: <MSP> isn't one of its voter organisations.` | `CastBallot` from an MSP that isn't in `voters.msps`, or `CastAnonymousBallot` from one that isn't `voters.msp`. |
| `This election has voter credentials, so its ballots are cast with CastAnonymousBallot.` | `CastBallot` in an election with voter credentials, from any identity. |
| `This election has X.509 voters, so its ballots are cast with CastBallot.` | `CastAnonymousBallot` in an election with X.509 voters, from any identity. |
| `This identity can't vote in this election: it isn't a voter credential.` | `CastAnonymousBallot` from an identity of `voters.msp` whose `id_bytes` aren't an idemix identity. |
| `This credential can't vote in this election: its affiliation isn't <affiliation>.` | `CastAnonymousBallot` from a credential with another organisational unit, such as the voters' CA's bootstrap admin, whose affiliation is the root. |
| `This credential can't vote in this election: its role isn't member.` | `CastAnonymousBallot` from a credential with the admin role. |
| `The ballot isn't for this election.` | Wrong `v` or `electionId`. |
| `The ballot has <n> ciphertexts; this election has <L> options.` | Wrong length. |
| `The ballot has <n> bit proofs; this election has <L> options.` | Wrong length. |
| `Ciphertext <j> has no randomness.` | An identity point. |
| `Ciphertext <j> is not a 0 or a 1.` | A bit proof fails. This includes a ballot under another key, a changed proof and a ballot copied from another voter. |
| `The ballot does not choose exactly one option.` | The sum proof fails. |
| `Ciphertexts <i> and <j> have the same randomness.` | Two ciphertexts in one ballot with the same `a`, including two identical ciphertexts, with i and j the first such pair. |
| `A ciphertext in this ballot is already on the ledger.` | A repeated ciphertext. |
| `The pseudonym proof is not valid.` | `CastAnonymousBallot` with a proof that doesn't verify, including one copied from another voter's transaction, one made for another ballot, election, channel or issuer key, and one whose T1 or T2 is the identity. |
| `This identity has already voted in this election.` | A second ballot from an X.509 voter. |
| `This credential has already voted in this election.` | A second ballot from a voter credential. |
| `Voting hasn't closed yet: the election is in <state>, and decryption shares are posted once it is in decrypting.` | `PostDecryptionShare` in `keygen` or `open`. |
| `The election is in <state>: decryption shares are posted while it is in decrypting.` | `PostDecryptionShare` in `counted`, `failed` or `cancelled`. |
| `<MSP> has already posted its decryption share.` | A second `PostDecryptionShare` from the same trustee. |
| `The decryption share has <n> entries; this election has <L> options.` | `PostDecryptionShare` with the wrong length. |
| `Share <j> from <MSP> does not match its key.` | `PostDecryptionShare`. |
| `This identity can't publish the tally: it isn't an X.509 identity.` | `PublishTally` from a voter credential. |
| `The tally is already published.` | `PublishTally` in `counted`. |
| `The tally can't be published: the election is in <state>.` | `PublishTally` in any other state but `decrypting`. |
| `The tally needs <k> decryption shares; <m> have been posted.` | `PublishTally` too early. |
| `A count is larger than the number of ballots, so the totals or shares are wrong.` | `PublishTally`, which should never happen with verified shares. |
| `The counts add up to <s>, not to the <N> ballots, so the totals or shares are wrong.` | `PublishTally`, which should never happen with verified shares. |
| `There's no ballot with tracking code <tracking> in election <id>.` | `GetBallot` with a tracking code no accepted ballot has. |

Every JSON argument (the election, the ballot, each ceremony post, the decryption share and the pseudonym proof) is refused with one of these when it doesn't parse or decode, `<thing>` being `The election`, `The ballot`, `The round 1 post`, `The round 2 post`, `The confirmation`, `The decryption share` or `The pseudonym proof`, and `<path>` a field such as `ciphertexts[1].a`:

| Error | When |
|---|---|
| `<thing> isn't JSON.` | The argument doesn't parse. |
| `<thing> isn't a JSON object.` | It parses to something else, including `null`. |
| `<thing> isn't in the version 1 format: it has an unknown field, <path>.` | A field the format doesn't have. With several, the first in byte order. |
| `<thing> isn't in the version 1 format: <path> is missing.` | A field the format needs. |
| `<thing> isn't in the version 1 format: <path> isn't a string.` | Likewise `a number`, `a list` or `an object`, for a value of the wrong type, including `null`. |
| `<thing>'s <path> isn't a canonical point.` | Not 32 bytes of lowercase hex, or not a canonical RFC 9496 encoding. In the pseudonym proof, not 64 bytes of lowercase hex, a coordinate of p or more, or not a point on FP256BN. |
| `<thing>'s <path> isn't a canonical scalar.` | Not 32 bytes of lowercase hex, or l or more. In the pseudonym proof, r or more. |
| `<thing>'s <path> isn't <n> bytes of lowercase hex.` | A round 2 `nonce` that isn't 12 bytes, or a `box` that isn't 48. |

A count of 1 takes the singular in every message: `1 ciphertext`, `1 entry`, `1 has been posted`, `1 argument`.

Every negative [test vector](/experimental/private-tally-spec/#test-vectors) carries the message from this table that the contract must return for it. The contract's Go tests drive every vector through the contract's functions, reach every row of these tables but those that only voter credentials can reach, and fail on any refusal that isn't a row here.
