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

That shows what your peers recorded. To show that other organisations recorded the same, explorers exchange signed checkpoints: see [Cross-checking](#cross-checking).

## Choose what to publish

Everything starts hidden. The policy file turns channels on, and can hide contracts within them:

```yaml
organisation: Org1
channels:
  supply:
    level: public       # public, members or hidden (the default)
    values: show        # show, or hash: arguments and written values appear as SHA-256 only
    submitter: show     # show, or hide: who submitted each transaction
    privateData: names  # names, or hashes: private data with each key's and value's SHA-256
    contracts:          # contracts not listed take the channel's level
      shipments: public
      pricing: hidden
```

| Setting | Effect |
|---|---|
| `level: public` | Anyone can see the channel without signing in. |
| `level: members` | Visible to people who [sign in with Weft](#signing-in) with an identity from an organisation in the channel. |
| `level: hidden` | Not indexed at all. |
| `elections: ballot` | The channel's [ballot contract](/guides/elections/). The explorer adds election pages with results and receipt checks. |
| `values: hash` | Arguments, written values, return values and event payloads are shown as SHA-256 hashes. Keys are still shown. |
| `submitter: hide` | Transactions show no submitter. Endorsing organisations are still shown, since they're peers, not people. |
| `privateData: hashes` | Transactions list the SHA-256 of each private data key and value, with a check for anyone holding a value to confirm it's the one recorded. Without it, private data is shown by collection and count only. |

A contract can be more private than its channel, never less: `members` contracts on a `public` channel show their transactions to everyone as "members only", with the ID, time and status, and the details to signed-in members.

A transaction that calls a hidden contract still appears in its block, with its ID, time and status only, so the block's transaction count stays true. Writes a public contract makes to a hidden one are left out.

Private data never reaches the shared ledger: the peers of the organisations in a collection keep the values, and every peer keeps only their hashes, so the explorer never shows private values, whatever the policy says. It shows which collections a transaction used and how many keys it read and wrote, and with `privateData: hashes`, the hashes themselves.

:::caution[Hashes of guessable values]
A hash hides a value only when it's hard to guess. If a value has few possibilities, such as yes or no, or a price in a known range, anyone can hash each one and compare. Publish hashes only for collections whose values include something random. The ballot contract stores each ballot with the voter's random salt for this reason.
:::

## Channel configuration changes

Config blocks hold the channel's whole configuration. The explorer compares each one with the one before and says what changed, in words: an organisation joined or left, a CA, anchor peer or orderer endpoint was added or removed, consenters changed, blocks are cut differently, capabilities or policies changed. It names who signed the update, and shows the members, ordering, capabilities and policies the change left. If something changed that it doesn't summarise, it says that too. Configuration updates often have no transaction ID, so their block page shows them.

## Configuration

| Variable | Required | Description |
|---|---|---|
| `WEFT_PEER_ENDPOINT` | Yes | Peer Gateway address, as for the relay. |
| `WEFT_PEER_TLS_CA_CERT` | For TLS | PEM of the CA that signed the peer's TLS certificate. |
| `WEFT_PEER_HOST_ALIAS` | No | TLS server name to expect. |
| `WEFT_EXPLORER_MSP_ID` | Yes | Your MSP ID, for example `Org1MSP`. |
| `WEFT_EXPLORER_CERT` | Yes | The explorer identity's certificate: a PEM file, or an MSP `signcerts` folder. |
| `WEFT_EXPLORER_KEY` | Yes | Its private key: a PEM file, or an MSP `keystore` folder. |
| `WEFT_EXPLORER_POLICY` | Yes | Path to the policy file. |
| `WEFT_EXPLORER_DB` | No | SQLite file. Default `explorer.db`. |
| `WEFT_EXPLORER_NAME` | No | Name shown on the pages. Defaults to the policy's `organisation`, then the MSP ID. |
| `WEFT_EXPLORER_PUBLIC_URL` | Behind a proxy | The address people open, for example `https://explorer.org1.example`. Sign-ins must name it. Defaults to the address each request arrived at. |
| `WEFT_EXPLORER_SESSION_SECRET` | No | Signs session cookies. Without it, a random secret is made at start, which signs everyone out when the explorer restarts. |
| `WEFT_EXPLORER_PEERS` | No | Other organisations' explorers to cross-check with, comma-separated base URLs. HTTPS, except `localhost`. |
| `WEFT_EXPLORER_NETWORK_PAGE` | No | The [network page](/operators/network/) that block pages link to, for checking a block without relying on this explorer. It's also the only page whose Weft sign-ins this explorer accepts, for members-only channels. Defaults to [Weft Network](weft:network/); set it to your own copy, or `off`. |
| `WEFT_EXPLORER_PRODUCTS_DOMAIN` | No | Where the other Weft products are, for the products menu, the footer and the "Get Weft" link: the domain the Weft sites are under, such as `weft.example.org`, which puts the docs at `docs.weft.example.org`. `dev` links to the local sites instead; `pnpm dev:explorer` and the playground set it. Defaults to the domain in `packages/brand/products.json`. The default network page is under it too. |
| `WEFT_EXPLORER_RECEIPT_ORIGINS` | No | Your voting web apps' origins, comma-separated, for example `https://vote.example.org`: an election page they open takes a receipt's choice and salt from them by message, so the voter doesn't enter them. HTTPS, except `localhost`. Weft Playground, where the products are, and Weft itself are always accepted. See [Run an election](/guides/elections/#checking-a-receipt-in-the-explorer). |
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

With Docker, from the repository root:

```sh
docker build -f apps/explorer/Dockerfile -t weft-explorer .
docker run -p 8790:8790 \
  -e WEFT_PEER_ENDPOINT=peer0.org1.example.com:7051 \
  -e WEFT_PEER_TLS_CA_CERT=/etc/weft/peer-tls-ca.pem \
  -e WEFT_EXPLORER_MSP_ID=Org1MSP \
  -e WEFT_EXPLORER_CERT=/etc/weft/explorer/signcerts \
  -e WEFT_EXPLORER_KEY=/etc/weft/explorer/keystore \
  -e WEFT_EXPLORER_POLICY=/etc/weft/explorer.yaml \
  -e WEFT_EXPLORER_PUBLIC_URL=https://explorer.org1.example.com \
  -e WEFT_EXPLORER_SESSION_SECRET=… \
  -v /etc/weft:/etc/weft:ro \
  -v weft-explorer:/data \
  weft-explorer
```

The image keeps its index in `/data`, a volume, so a new image continues from the last stored block. It runs as an unprivileged user and reports its health from `/api/v1/status`. Put it behind your usual TLS-terminating proxy, at the root of its address.

The first start reads the whole channel from block 0. After that it carries on from the last stored block. If the database comes from a different network (block 0 doesn't match), the explorer stops indexing that channel and says so; delete the file to start again.

The database holds only what the policy published. When you change the policy and restart, the explorer clears the database and indexes every block again under the new policy, so nothing you've since hidden stays visible.

## Signing in

When anything is published at `members`, the explorer shows **Sign in with Weft**. Weft asks the user to connect, then shows a sign-in window that says it doesn't sign a transaction. The explorer checks:

- the message names this explorer's address and a nonce it issued in the last five minutes, used once;
- the signature matches the certificate;
- the certificate chains to the root certificates of the claimed MSP, read from the channel's configuration blocks, is in date, and isn't on a revocation list that MSP's CA signed.

A signed-in person is a member of every published channel whose configuration lists their MSP. They see that channel's `members` level, and **Your transactions** lists the ones their identity submitted. Sessions last eight hours, in an HTTP-only cookie.

Revocation lists come from the same place peers read them: each organisation's MSP in the channel configuration. The explorer applies them to sign-ins, to other explorers' signed checkpoints and requests, and publishes them at `/api/v1/channels/:channel/members`, so Weft Network and Weft can check too. A certificate revoked after someone signed in keeps their session until it ends, up to eight hours.

## Cross-checking

Each explorer signs a checkpoint for every public channel: its latest block number and that block's hash, signed with the explorer's identity. Every block carries the hash of the one before, so one matching checkpoint at block 1,000 means both ledgers agree on all 1,001 blocks.

List the other organisations' explorers in `WEFT_EXPLORER_PEERS`. Every 15 seconds the explorer fetches their checkpoints and checks each one:

- the signature matches the certificate;
- the certificate was issued by the CA of the MSP it names, read from the channel's configuration blocks, and is in date;
- the block hash matches its own at that height.

Pages then say how many organisations agree: each block shows "3 of 4 organisations report this block", and the channel card lists each organisation as agreeing, still catching up, unreachable, or disagreeing from a given block. When a checkpoint disagrees, the explorer searches the other explorer's public block hashes for the first block that differs.

Members-only channels are cross-checked too. A members-only channel's checkpoint and blocks are for its members, so each explorer signs its requests to the others with its own identity: a statement of the path it asks for, when, and its MSP ID. The other explorer serves it only if the signature matches, the request is under five minutes old, and the certificate was issued by the CA of an organisation in that channel's configuration. Serve each explorer at the root of its address, since the signature covers the path.

## In the playground

`pnpm playground:up` starts an explorer for each organisation, each reading `mychannel` and a members-only channel, `members`, from its own organisation's peer:

| Explorer | Policy | Publishes |
|---|---|---|
| Org1, [localhost:8790](http://localhost:8790) | `playground/explorer.yaml` | Everything, with submitters and the ballots' private data hashes. Contract approvals (`_lifecycle`) are for signed-in members only. |
| Org2, [localhost:8791](http://localhost:8791) | `playground/explorer-org2.yaml` | No submitters. The `basic` contract's transactions are for signed-in members only. |

Both show the elections the playground seeds and, once you sign in, the `members` channel's assets, and they cross-check each other, so you can see two organisations publish different amounts of the same ledger and still agree on every block. The [playground](weft:playground/) lists both, with things to try. Org1's invite names its explorer, so Weft links each transaction in its activity to it. If your playground was already running, restart only the explorers with `pnpm playground:explorer`.

To link Weft to your own explorer, add `explorerUrl` to your organisation's [invite](/operators/invites/). To show every organisation's explorer on one page, link to [Weft Network](weft:network/) with `?explorer=<your explorer>`.

## API

Everything the pages show is also JSON, readable from any origin, since it's public by definition.

| Endpoint | Returns |
|---|---|
| `GET /api/v1/status` | The explorer's name and MSP ID, then each published channel's height, transaction count, link check results, the peer's own height, and what the explorer publishes for it (`publishes`: values, submitters, members-only contracts and whether it has election pages). |
| `GET /api/v1/channels/:channel/blocks?before=&limit=` | Blocks, newest first. |
| `GET /api/v1/channels/:channel/blocks/:number` | One block and its transactions. |
| `GET /api/v1/channels/:channel/transactions?contract=&org=&before=&limit=` | Transactions, newest first, optionally for one contract or submitting MSP. |
| `GET /api/v1/channels/:channel/transactions/:txId` | One transaction. |
| `GET /api/v1/channels/:channel/headers?from=&to=` | Block headers (`number`, `previousHash`, `dataHash`, `hash`), oldest first, up to 1,000 at a time, for recomputing hashes elsewhere. |
| `GET /api/v1/channels/:channel/members` | Each member organisation's root and intermediate CA certificates and revocation lists (`crls`), from the channel configuration, for checking whose certificate signed a checkpoint. |
| `GET /api/v1/channels/:channel/checkpoint` | This explorer's signed checkpoint: `{ channel, mspId, number, hash, signedAt, message, signature, certificate }`. For a members-only channel, only to its members. |
| `GET /api/v1/channels/:channel/organisations` | What each cross-checked organisation last reported, and how far it agrees. |

Channels that aren't published answer 404, the same as channels that don't exist.
