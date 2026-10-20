---
title: Run an explorer
description: Publish the parts of your channels you choose, from your own peers, as pages anyone can check.
---

The explorer shows blocks and transactions from your organisation's peers: who called which contract, what it changed, and whether the network accepted it. You decide what it publishes. Each organisation runs its own, because a Fabric ledger can only be read by a member of its channel. ([ADR 0004](/reference/decisions/))

It has two parts in one process:

- An indexer that follows each published channel's blocks through your peer's Gateway, with a read-only identity, and stores what your policy allows in SQLite.
- A web server for the pages and a JSON API. The overview and channel pages update on their own as blocks arrive.

The explorer doesn't sign transactions and holds no wallet keys. Its identity only needs to read the channel.

## What it checks

Each block stores the hash of the block before it. The explorer recomputes every block's header hash and data hash itself, rather than trusting what it's given, and shows any block that doesn't match the one before it or its own transactions. A ledger that was changed after the fact shows up as a broken link.

This shows what your peers recorded. Comparing your view with other organisations' explorers is a later phase.

## Choose what to publish

Everything starts hidden. The policy file turns channels on, and can hide contracts within them:

```yaml
organisation: Org1
channels:
  supply:
    level: public       # public, members or hidden (the default)
    values: show        # show, or hash: arguments and written values appear as SHA-256 only
    submitter: show     # show, or hide: who submitted each transaction
    contracts:          # contracts not listed take the channel's level
      shipments: public
      pricing: hidden
```

| Setting | Effect |
|---|---|
| `level: public` | Anyone can see the channel without signing in. |
| `level: members` | Visible to people who [sign in with Weft](#signing-in) with an identity from an organisation in the channel. |
| `level: hidden` | Not indexed at all. |
| `values: hash` | Arguments, written values, return values and event payloads are shown as SHA-256 hashes. Keys are still shown. |
| `submitter: hide` | Transactions show no submitter. Endorsing organisations are still shown, since they're peers, not people. |

A contract can be more private than its channel, never less: `members` contracts on a `public` channel show their transactions to everyone as "members only", with the ID, time and status, and the details to signed-in members.

A transaction that calls a hidden contract still appears in its block, with its ID, time and status only, so the block's transaction count stays true. Writes a public contract makes to a hidden one are left out.

Private data collections never reach the shared ledger, only their hashes, so the explorer can't show them whatever the policy says.

## Configuration

| Variable | Required | Description |
|---|---|---|
| `WEFT_PEER_ENDPOINT` | Yes | Peer Gateway address, as for the relay. |
| `WEFT_PEER_TLS_CA_CERT` | For TLS | PEM of the CA that signed the peer's TLS certificate. |
| `WEFT_PEER_HOST_ALIAS` | No | TLS server name to expect. |
| `WEFT_EXPLORER_MSP_ID` | Yes | Your MSP ID, e.g. `Org1MSP`. |
| `WEFT_EXPLORER_CERT` | Yes | The explorer identity's certificate: a PEM file, or an MSP `signcerts` folder. |
| `WEFT_EXPLORER_KEY` | Yes | Its private key: a PEM file, or an MSP `keystore` folder. |
| `WEFT_EXPLORER_POLICY` | Yes | Path to the policy file. |
| `WEFT_EXPLORER_DB` | No | SQLite file. Default `explorer.db`. |
| `WEFT_EXPLORER_NAME` | No | Name shown on the pages. Defaults to the policy's `organisation`, then the MSP ID. |
| `WEFT_EXPLORER_PUBLIC_URL` | Behind a proxy | The address people open, e.g. `https://explorer.org1.example`. Sign-ins must name it. Defaults to the address each request arrived at. |
| `WEFT_EXPLORER_SESSION_SECRET` | No | Signs session cookies. Without it, a random secret is made at start, which signs everyone out when the explorer restarts. |
| `PORT` | No | Default `8790`. |

Register a client identity for the explorer with your CA rather than reusing a person's. It needs to satisfy the channel's `Readers` policy, which a client of a member organisation does.

## Run it

```sh
pnpm install && pnpm build
WEFT_PEER_ENDPOINT=peer0.org1.example.com:7051 \
WEFT_PEER_TLS_CA_CERT=/etc/weft/peer-tls-ca.pem \
WEFT_EXPLORER_MSP_ID=Org1MSP \
WEFT_EXPLORER_CERT=/etc/weft/explorer/signcerts \
WEFT_EXPLORER_KEY=/etc/weft/explorer/keystore \
WEFT_EXPLORER_POLICY=/etc/weft/explorer.yaml \
WEFT_EXPLORER_DB=/var/lib/weft/explorer.db \
node apps/explorer/dist/main.js
```

The first start reads the whole channel from block 0. After that it carries on from the last stored block. If the database comes from a different network (block 0 doesn't match), the explorer stops indexing that channel and says so; delete the file to start again.

The database holds only what the policy published. When you change the policy and restart, the explorer clears the database and indexes every block again under the new policy, so nothing you've since hidden stays visible.

## Signing in

When anything is published at `members`, the explorer shows **Sign in with Weft**. Weft asks the user to connect, then shows a sign-in window that says it doesn't sign a transaction. The explorer checks:

- the message names this explorer's address and a nonce it issued in the last five minutes, used once;
- the signature matches the certificate;
- the certificate chains to the root certificates of the claimed MSP, read from the channel's configuration blocks, and is in date.

A signed-in person is a member of every published channel whose configuration lists their MSP. They see that channel's `members` level, and **Your transactions** lists the ones their identity submitted. Sessions last eight hours, in an HTTP-only cookie.

Certificate revocation lists aren't checked yet, so a revoked certificate that is still in date can sign in until its session ends.

## In the playground

`pnpm playground:up` starts an explorer for Org1 on [localhost:8790](http://localhost:8790), reading as Org1's `User1` and publishing `mychannel` with the policy in `playground/explorer.yaml`. The contract approvals (`_lifecycle`) are members-only there, so sign in with a demo user to see them. If your playground was already running, start just the explorer with `pnpm playground:explorer`.

## API

Everything the pages show is also JSON, readable from any origin, since it's public by definition.

| Endpoint | Returns |
|---|---|
| `GET /api/v1/status` | Each published channel's height, transaction count, link check results and the peer's own height. |
| `GET /api/v1/channels/:channel/blocks?before=&limit=` | Blocks, newest first. |
| `GET /api/v1/channels/:channel/blocks/:number` | One block and its transactions. |
| `GET /api/v1/channels/:channel/transactions?contract=&org=&before=&limit=` | Transactions, newest first, optionally for one contract or submitting MSP. |
| `GET /api/v1/channels/:channel/transactions/:txId` | One transaction. |

Channels that aren't published answer 404, the same as channels that don't exist.
