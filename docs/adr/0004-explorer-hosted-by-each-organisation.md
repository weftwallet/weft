# 0004: An explorer that each organisation hosts

**Status:** Proposed
**Date:** 2026-10-20

## Context

Ethereum has Etherscan: one public site that reads a public chain, and anyone can check what happened. Fabric has no equivalent, for two reasons.

First, a Fabric ledger is readable only by members of its channel. Something has to read it as a member, so an explorer is run by an organisation, with that organisation's identity, from that organisation's peers.

Second, the main open-source option has stopped. Hyperledger Explorer was archived, and the community lab that restarted it may not be maintained ([LF Decentralized Trust, March 2025](https://www.lfdecentralizedtrust.org/blog/blockchain-pioneers-hyperledger-explorer)).

A consortium often adopts Fabric so that its members can watch each other: a shared ledger where a bad entry is visible to every organisation. An explorer is how people outside the operations team see that. Voting is the sharpest case: anyone should be able to check the count, and nobody should be able to see how a person voted.

Weft already has most of the reading side: the protobuf decoder that checks what the wallet signs, the plain-English explanations of validation codes, and an identity model that ties people to organisations.

## Decision

Build `apps/explorer`, a separate app from the wallet and the relay. Each organisation that wants an explorer runs its own instance.

### Hosting and reading the ledger

An explorer instance has two parts:

- An **indexer** that connects to its organisation's peers with `@hyperledger/fabric-gateway` and a dedicated read-only identity. It reads blocks through the deliver service and the `qscc` system chaincode (chain height, blocks by number, transactions by ID), decodes them with `@weftwallet/core`, and stores them in a database for search.
- A **web app** that serves pages and an API from that database.

The relay stays as it is: stateless, offline-signing, and only for wallets. An explorer needs its own identity and keeps state, and the relay avoids both by design.

Like the playground, an instance runs locally for development, privately inside an organisation, or publicly.

### What each organisation publishes

The operator sets a policy per channel and per contract:

| Level | Who can see it |
|---|---|
| `public` | Anyone, without signing in. |
| `members` | Anyone who signs in with an identity from an organisation in the channel. |
| `hidden` | Nobody. The explorer doesn't index it. |

A `public` channel can have `members`-only contracts, so the open part of a network is public and the rest needs an identity. Within a published contract, the operator can also hide write-set values and show only keys and value hashes, and hide the submitter's identity.

Private data never reaches the shared ledger, only its hash, so the explorer can show that a private write happened and can never show its value.

### Signing in with Weft

The `members` level uses a new provider method, `weft_signIn`. The wallet builds the message itself from fixed fields (a `weft-sign-in:v1` prefix, the site's origin, a nonce from the site, issue and expiry times), shows it in an approval window that says it doesn't sign a transaction, and signs it with the active identity's key.

Because the wallet builds the bytes and never signs bytes a site supplies, a sign-in can't be turned into a Fabric proposal or transaction. The explorer verifies the signature, then checks the certificate against the channel configuration: it must chain to one of the member MSPs' root CAs. A signed-in member sees `members` data and the history of their own identity's transactions.

### Cross-checking between organisations

One organisation's explorer only says "trust us". The explorer's main feature is agreement between organisations:

- Each instance publishes signed **checkpoints**: channel, block number, and block header hash, signed with the instance's identity.
- Each instance is configured with the other organisations' explorer URLs. It fetches their checkpoints and shows, per block, how many agree: "3 of 4 organisations report this block".
- A mismatch or a missing block shows as a warning on that block and on the channel page.

The browser checks what it can without trusting the server it came from. Each block header carries the previous block's hash, so a run of blocks either links up or it doesn't. Endorsement signatures can be verified against the certificates in the channel's configuration block. The same decoder Weft uses before signing does this in the page.

### The voting case

A ballot contract designed for this explorer:

- Writes each ballot to a private data collection. The shared ledger gets a hash commitment of the ballot.
- Gives the voter a receipt: transaction ID and commitment.
- Publishes the tally from the contract when voting closes.

The explorer shows, on a `public` channel, the number of commitments, the tally, and a receipt check: anyone with a receipt can confirm their commitment is in a committed, valid block. Every organisation's explorer shows the same counts, or the mismatch is visible.

This proves the ballot was counted and that no ballots were added or removed after commitment. It doesn't hide who voted from channel members: a Fabric transaction carries its submitter's certificate, and every member's peer stores it. The explorer can hide the submitter from public view, but secrecy against the member organisations themselves needs cryptography beyond this design (blind signatures, mixnets or homomorphic tallying). That's out of scope here, and a voting deployment must say so to its voters.

## Alternatives

- **Revive Hyperledger Explorer.** It reads peers directly with its own configuration and has no cross-organisation checks. Taking over an archived codebase costs more than a focused new app built on Weft's decoder.
- **Add explorer endpoints to the relay.** That would make the relay stateful and give it a signing identity, which undoes [0001](0001-relay-for-network-access.md).
- **One shared explorer for the whole network.** Simpler to run, but it puts all trust in whoever hosts it, which is the problem this decision exists to remove.

## Consequences

- Operators run a second service with its own identity and database. A read-only identity limits what a compromised explorer can do: it can read what its organisation can read, and can't transact.
- Publishing is a disclosure decision. Defaults are `hidden` for every channel, and the operator turns things on.
- `weft_signIn` adds a second kind of signature to the wallet. It needs its own security review, and the approval window must make clear it isn't a transaction.
- Cross-checking needs at least two organisations running instances. With one, the explorer still works but shows "1 of 1".

## Phases

1. Indexer and web app for one organisation, `public` level only, local and hosted.
2. `weft_signIn` and the `members` level.
3. Signed checkpoints and cross-checking between instances.
4. The ballot contract template and the receipt check.
