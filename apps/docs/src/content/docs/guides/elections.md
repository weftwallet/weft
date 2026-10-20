---
title: Run an election
description: Ballots kept private, commitments on the ledger, a result anyone can count, and receipts voters can check.
---

The [ballot contract](https://github.com/ifeanyi-ugwu/weft/tree/main/examples/ballot-contract) and the [explorer](/operators/explorer/) together let a consortium run an election where:

- each organisation's explorer shows how many ballots were cast, and the result once voting closes;
- anyone can check that the published total matches the ballots on the ledger;
- each voter can check that their ballot is in a valid block, and that it's a vote for what they chose;
- the organisations' explorers compare their copies of the ledger, so no one can quietly change the count.

## How a ballot stays private

A ballot is sent as transient data, which never reaches the shared ledger. The contract writes it to a private data collection and puts a commitment on the ledger: SHA-256 of the election ID, the choice and a random salt the voter's app picks. Only someone who knows the choice and the salt can tell which choice a commitment is for.

The voter keeps a receipt: the transaction ID, the commitment, their choice and the salt.

## Voting from a web app

```ts
const weft = await getWeft();
await weft.connect();

const salt = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
const result = await weft.submit({
  channel: "elections",
  chaincode: "ballot",
  fn: "CastVote",
  args: ["board-2026"],
  transient: { ballot: JSON.stringify({ option: "Ada", salt }) },
});

// Give this to the voter to keep.
const receipt = { ...JSON.parse(result.text!), option: "Ada", salt };
```

Weft's approval window lists `ballot` as a private input and doesn't show its value, so show the voter their choice in your app before they sign.

## Showing it in the explorer

Name the ballot contract in the channel's policy, and hide submitters, so the explorer doesn't list who voted:

```yaml
channels:
  elections:
    level: public
    submitter: hide
    elections: ballot
```

The explorer then has an **Elections** page per channel. Each election shows:

- how many ballots it counts on the ledger;
- the published result, and whether its total matches those ballots;
- a receipt check. A voter enters the transaction ID, and optionally the commitment, to see that their ballot is in a valid block. To confirm it's a vote for their choice, they enter the choice and the salt, which the page checks in the browser without sending them anywhere.

## What it can't do

A Fabric transaction carries its submitter's certificate, and every member organisation's peer keeps it. So this proves the count and lets voters check their ballot, but it doesn't hide who voted, or their choice, from the member organisations themselves: their peers can read the private collection. Hiding that needs cryptography beyond this design (blind signatures, mixnets or homomorphic tallying). Tell your voters what the system does and doesn't hide. ([ADR 0004](/reference/decisions/))
