---
title: Deploy the relay
description: Run the relay next to your organisation's peers so browsers can reach the Fabric Gateway.
---

Browsers can't open gRPC connections to Fabric peers, so each organisation runs an HTTP **relay** next to its peers. It uses the official `@hyperledger/fabric-gateway` SDK in offline-signing mode:

1. The relay builds an unsigned proposal for the wallet's certificate.
2. The wallet checks it, signs it, and sends the signature back.
3. The relay forwards the signed message to the peer's Gateway service, and repeats for the transaction and its commit status.

The relay **never holds private keys** and keeps **no state** between requests, so you can run as many replicas as you like behind a load balancer.

## Configuration

| Variable | Required | Description |
|---|---|---|
| `WEFT_PEER_ENDPOINT` | Yes | Peer Gateway address, for example `peer0.org1.example.com:7051`. |
| `WEFT_PEER_TLS_CA_CERT` | For TLS | Path to the PEM of the CA that signed the peer's TLS certificate. Omit only for plaintext dev networks. |
| `WEFT_PEER_HOST_ALIAS` | No | TLS server name to expect, when the endpoint is an IP or tunnel. |
| `WEFT_ALLOWED_ORIGINS` | No | Comma-separated browser origins allowed by CORS. Default `*`. |
| `WEFT_ALLOWED_MSP_IDS` | No | Refuse signers from any other MSP. Recommended. |
| `WEFT_MAX_GATEWAYS` | No | Cached connections, one per signer. Default `256`. |
| `PORT` | No | Default `8787`. |
| `WEFT_PUBLIC_URL` | For invites | The relay's public URL, as wallets reach it. |
| `WEFT_CONNECTION_PROFILE` | No | Your Fabric connection profile (JSON or YAML). The relay builds and serves your [invite](/operators/invites/) from it. |
| `WEFT_INVITE_CHANNELS` | No | Comma-separated channels for the invite, when the profile doesn't list them. |
| `WEFT_INVITE_ORGANIZATION` | No | Which organisation in the profile, when it lists several. |
| `WEFT_INVITE_NETWORK` | No | Display name for the network. Defaults to the profile's `name`. |
| `WEFT_INVITE_FILE` | No | A ready-made invite JSON to serve instead. |
| `WEFT_JOIN_PAGE` | No | Join page used in the share link printed at startup. Defaults to the hosted Weft page. |

## Run it

With Node 22:

```sh
pnpm install && pnpm build
WEFT_PEER_ENDPOINT=peer0.org1.example.com:7051 \
WEFT_PEER_TLS_CA_CERT=/etc/weft/peer-tls-ca.pem \
WEFT_ALLOWED_MSP_IDS=Org1MSP \
pnpm --filter @weftwallet/relay start
```

With Docker, from the repository root:

```sh
docker build -f apps/relay/Dockerfile -t weft-relay .
docker run -p 8787:8787 \
  -e WEFT_PEER_ENDPOINT=peer0.org1.example.com:7051 \
  -e WEFT_PEER_TLS_CA_CERT=/certs/ca.pem \
  -v /path/to/peer-tls:/certs:ro \
  weft-relay
```

Put it behind your usual TLS-terminating proxy: users' wallets must reach it over HTTPS.

## API

All bodies are JSON; byte fields are base64. The wallet calls these in order; you won't call them yourself.

| Endpoint | Purpose |
|---|---|
| `GET /v1/health` | Liveness. |
| `GET /.well-known/weft-invite.json` | Your organisation's invite, when configured. Public; contains no secrets. |
| `POST /v1/proposals` | Build an unsigned proposal for `{ signer, call }`. |
| `POST /v1/proposals/evaluate` | Evaluate a signed proposal on one peer. |
| `POST /v1/proposals/endorse` | Collect endorsements; returns the unsigned transaction. |
| `POST /v1/transactions/submit` | Submit a signed transaction to ordering. |
| `POST /v1/commits/status` | Wait for the signed commit-status request; returns the validation code. |

Errors are `{ "error": { "kind", "message", "details": [{ "mspId", "address", "message" }] } }`, with `details` carrying each peer's response for endorsement failures.

## What the relay can and can't do

- It sees transaction contents, as your peers do. Run it inside the same trust boundary.
- It **cannot** sign as a user. A tampered relay could try to get a user to sign something else, which is why the wallet decodes and checks every message before signing. See the [security model](/reference/security/).

## Experimental: the relay for an election with voter credentials

:::caution[Experimental]
This section describes Weft Experimental, a separate build that is not part of the main product, and nothing in it applies to a relay started without `WEFT_EXPERIMENTAL=1`. No one outside the project has reviewed it. See [Voter credentials](/experimental/voter-credentials/#the-relay).
:::

The relay that an election with voter credentials names in its voter invite accepts one-off idemix identities as signers, from the election's voter MSP.

| Variable | Description |
|---|---|
| `WEFT_EXPERIMENTAL` | `1` turns the experimental behaviour on. Any other value leaves it off. |
| `WEFT_IDEMIX_MSP_IDS` | Comma-separated voter MSPs, one per election, for example `ChairVoters2027MSP`. The relay refuses to start with it and without `WEFT_EXPERIMENTAL=1`. |
| `WEFT_VOTER_INVITES` | A folder of voter invites, one `<election>.json` each, served at `/.well-known/weft-voter-invite/<election>.json`. Each is checked at startup, and must name an MSP in `WEFT_IDEMIX_MSP_IDS`. The relay refuses to start with it and without `WEFT_EXPERIMENTAL=1`. |

A signer is then either `{ "mspId", "certificate" }` or `{ "mspId", "idemixIdentity" }`, the serialized idemix identity in base64. For an idemix signer the relay:

- builds and forwards every message as for an X.509 signer, with the identity's bytes as the creator;
- makes a new gateway for each request and closes it when the request is done, since each identity signs one transaction;
- writes no log line for the request, of any kind: on such a relay, every request other than a `GET` is unlogged until the relay has read its signer as an X.509 one, and an X.509 request gets one line when it completes;
- names no part of the identity in an error.

It refuses an X.509 signer that names one of the voter MSPs. A proxy or load balancer in front of the relay keeps its own access log unless it is set not to, and the election's relay must keep none.
