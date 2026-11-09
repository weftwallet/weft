# 0004: Build an explorer that each organisation hosts

Accepted on 20 October 2026. Decided by Ifeanyi Ugwu.

## Context and problem

Ethereum has Etherscan: one public site that reads a public chain, where anyone can check what happened. Fabric has no equivalent.

A Fabric ledger is readable only by members of its channel. An explorer has to read it as a member, which means an organisation runs it, with that organisation's identity, from that organisation's peers.

Work on the main open-source option has stopped. Hyperledger Explorer was archived, and the community lab that restarted it may not be maintained ([LF Decentralized Trust, March 2025](https://www.lfdecentralizedtrust.org/blog/blockchain-pioneers-hyperledger-explorer)).

A consortium often adopts Fabric so that its members can watch each other: on a shared ledger, a bad entry is visible to every organisation. People outside the operations team see that through an explorer. An election needs two properties at once. Anyone can check the count, and nobody can see how a person voted.

Weft already has most of the reading side: the protobuf decoder that checks what the wallet signs, the plain-English explanations of validation codes, and an identity model that ties people to organisations.

## Decision drivers

- A reader can check that the organisations agree, without trusting any one of them.
- The relay stays stateless and holds no identity (ADR 0001).
- Each organisation decides what its explorer discloses.

## Considered options

1. A separate app, `apps/explorer`, that each organisation runs for itself (chosen).
2. A revived Hyperledger Explorer. It reads peers directly with its own configuration and has no cross-organisation checks. Taking over an archived codebase costs more than a focused new app built on Weft's decoder.
3. Explorer endpoints in the relay. They would make the relay stateful and give it a signing identity, which undoes [0001](0001-relay-for-network-access.md).
4. One shared explorer for the whole network. It is simpler to run, but it puts all trust in whoever hosts it, which is the problem this decision exists to remove.

## Decision

`apps/explorer` is a separate app from the wallet and the relay. Each organisation that wants an explorer runs its own instance.

### Hosting and reading the ledger

An explorer instance has two parts:

- An indexer connects to its organisation's peers with `@hyperledger/fabric-gateway` and a dedicated read-only identity. It reads blocks through the deliver service and the `qscc` system chaincode (chain height, blocks by number, transactions by ID), decodes them with `@weftwallet/core`, and stores them in a database for search.
- A web app serves pages and an API from that database.

The relay stays stateless, offline-signing and only for wallets. An explorer needs its own identity and keeps state, and the relay avoids both by design.

Like the playground, an instance runs locally for development, privately inside an organisation, or publicly.

### What each organisation publishes

The operator sets a policy per channel and per contract:

| Level | Who can see it |
|---|---|
| `public` | Anyone, without signing in. |
| `members` | Anyone who signs in with an identity from an organisation in the channel. |
| `hidden` | Nobody. The explorer doesn't index it. |

A `public` channel can have `members`-only contracts. The open part of a network is then public, and the rest needs an identity. Within a published contract, the operator can also hide write-set values, showing only keys and value hashes, and hide the submitter's identity.

Private data never reaches the shared ledger, only its hash. The explorer can show that a private write happened and can never show its value.

### Signing in with Weft

The `members` level uses a new provider method, `weft_signIn`. The wallet builds the message itself from fixed fields (a `weft-sign-in:v1` prefix, the site's origin, a nonce from the site, issue and expiry times). It shows the message in an approval window that says it doesn't sign a transaction, and signs it with the active identity's key.

A sign-in can't be turned into a Fabric proposal or transaction, because the wallet builds the bytes and never signs bytes a site supplies. The explorer verifies the signature, then checks the certificate against the channel configuration: it must chain to one of the member MSPs' root CAs. A signed-in member sees `members` data and the history of their own identity's transactions.

### Cross-checking between organisations

An explorer run by one organisation shows only what that organisation reports. Agreement between organisations is the explorer's main feature:

- Each instance publishes signed checkpoints: channel, block number and block header hash, signed with the instance's identity.
- Each instance is configured with the other organisations' explorer URLs. It fetches their checkpoints and shows, per block, how many agree: "3 of 4 organisations report this block".
- For members-only channels, an instance signs its requests to the others with its identity, and the others serve checkpoints and blocks only to a member organisation's explorer.
- A mismatch or a missing block shows as a warning on that block and on the channel page.

The page in the browser checks what it can without trusting the server it came from. Each block header carries the previous block's hash, and the page checks that a run of blocks links up. Endorsement signatures can be verified against the certificates in the channel's configuration block. The same decoder Weft uses before signing does this in the page.

### Elections

A ballot contract designed for this explorer:

- writes each ballot to a private data collection and puts a hash commitment of the ballot on the shared ledger
- gives the voter a receipt: transaction ID and commitment
- publishes the tally from the contract when voting closes

On a `public` channel, the explorer shows the number of commitments, the tally, and a receipt check: anyone with a receipt can confirm their commitment is in a committed, valid block. Every organisation's explorer shows the same counts, or the mismatch is visible.

This proves the ballot was counted and that no ballots were added or removed after commitment. It doesn't hide who voted from channel members, because a Fabric transaction carries its submitter's certificate and every member's peer stores it. The explorer can hide the submitter from public view. Secrecy against the member organisations themselves needs cryptography beyond this design (blind signatures, mixnets or homomorphic tallying). That is out of scope here, and a voting deployment must say so to its voters.

### Phases

1. Indexer and web app for one organisation, `public` level only, local and hosted.
2. `weft_signIn` and the `members` level.
3. Signed checkpoints and cross-checking between instances.
4. The ballot contract template and the receipt check.

All four phases are built: `apps/explorer`, `weft_signIn`, signed checkpoints, and `contracts/ballot` with the explorer's election pages.

## Consequences

- Operators run a second service with its own identity and database. A read-only identity limits what a compromised explorer can do: it can read what its organisation can read, and can't transact.
- Publishing is a disclosure decision. Every channel defaults to `hidden`, and the operator turns things on.
- `weft_signIn` adds a second kind of signature to the wallet. It needs its own security review, and the approval window must make clear it isn't a transaction.
- Cross-checking needs at least two organisations running instances. With one, the explorer still works and shows "1 of 1".

## More information

- [Run an explorer](../../apps/docs/src/content/docs/operators/explorer.md) and [Run an election](../../apps/docs/src/content/docs/guides/elections.md) are the guides for running each.
- See also [0007](0007-private-tally.md) and [0008](0008-idemix-voter-credentials.md), experimental records that hide the choice and who voted. This record remains the main product's decision.
