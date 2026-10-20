# Ballot contract

A Fabric contract for elections that can be counted and checked without revealing anyone's choice. It's the template for the voting case in [ADR 0004](../../docs/adr/0004-explorer-hosted-by-each-organisation.md), and the [Weft explorer](../../apps/explorer) shows its elections.

- `CreateElection(id, title, optionsJson, closesAt)`
- `CastVote(id)`, with the choice as transient data `ballot` = `{"option": "...", "salt": "<32+ hex characters>"}`. Returns the receipt `{ electionId, txId, commitment }`.
- `CloseElection(id)`, by the organisation that created it, after `closesAt`.
- `GetElection(id)`

Each ballot goes to the `ballots` private data collection. The shared ledger gets a commitment, SHA-256 of `id`, the option and the salt, joined by newlines. Closing the election reads the private ballot behind each commitment and publishes the tally.

## Build and test

```sh
npm install
npm test
```

## Deploy

Build first; the package carries `dist/`. Approve and commit with the collection config, and list every organisation that votes in its policy:

```sh
npm run build
peer lifecycle chaincode package ballot.tar.gz --path . --lang node --label ballot_1
peer lifecycle chaincode approveformyorg ... --name ballot --collections-config collections_config.json
peer lifecycle chaincode commit ... --name ballot --collections-config collections_config.json
```

## What it doesn't do

Every Fabric transaction carries its submitter's certificate, and every member organisation's peer stores it. The contract keeps the choice secret, not the fact that someone voted, and the organisations' peers can read the private collection. Hiding a voter's choice from the organisations themselves needs more cryptography than this template has. Say so to your voters.
