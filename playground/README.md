# Weft playground stack

`pnpm playground:up` starts a local Hyperledger Fabric network configured for Weft. Use it to try the wallet, build a dApp, or run the docs' playground page against a real network on your machine.

```sh
pnpm playground:up       # first run downloads Fabric (5 to 10 minutes)
pnpm playground:up --https   # the same, with the CA on https://localhost:7443 (needs mkcert)
pnpm dev:docs            # in another terminal
# open http://localhost:4321/playground/
pnpm playground:down     # stop everything and remove the network
pnpm playground:status   # what's running
pnpm playground:explorer # start or restart only the explorers, on a running stack
```

## Requirements

- Docker (Docker Desktop or OrbStack), running
- git and curl
- [mkcert](https://github.com/FiloSottile/mkcert), only for `--https` (`brew install mkcert` on macOS)

## What it runs

| Piece | Where | Notes |
|---|---|---|
| Fabric `test-network` | Docker | Two orgs, Raft orderer, a CA per org, channel `mychannel` |
| `basic` contract | `mychannel` | fabric-samples' asset-transfer (TypeScript) |
| `ballot` contract | `mychannel` | `examples/ballot-contract`, with its private collection. `seed-elections.mjs` adds `team-lunch` (counted) and `board-2026` (open); receipts for the seeded ballots are in `.state/receipts.json` |
| Org1 CA proxy | `http://localhost:7080`, or `https://localhost:7443` with `--https` | Forwards to the CA's HTTPS on 7054, so the browser can enrol (see below) |
| Weft relay | `http://localhost:8787` | Talks to `peer0.org1`; serves the invite at `/.well-known/weft-invite.json` |
| Explorers | `http://localhost:8790` (Org1), `http://localhost:8791` (Org2) | Each reads `mychannel` from its own organisation's peer, publishes what `explorer.yaml` or `explorer-org2.yaml` allows, and cross-checks with the other. Org1's also publishes the ballots' private data hashes. Org2's publishes less: no submitters, private data by name only, and `basic` for members only. The invite names Org1's, so Weft links activity to it |

## Demo users (Org1)

| Enrollment ID | Secret | Attributes |
|---|---|---|
| `alice` | `alicepw` | `role=auditor` |
| `bob` | `bobpw` | `role=trader` |

## Why the playground uses a CA proxy

The test network's CA serves HTTPS with a self-signed certificate. Browsers reject it, and accepting it in a tab doesn't help: the extension's background worker still refuses it, so enrolment fails with "Failed to fetch". The proxy talks HTTPS to the CA, verifying it against the CA's own root certificate, and serves plain HTTP on `localhost`, which browsers allow. This mode needs no certificate installed or trusted.

### HTTPS with `--https`

Real organisations give an `https://` CA URL, so use `pnpm playground:up --https` to test that path. The script runs `mkcert -install`, which adds mkcert's root to your system's trusted certificates (it may ask for your password the first time), makes a `localhost` certificate in `playground/.state`, and serves the proxy on `https://localhost:7443`. Chrome trusts the system's certificates, and unlike a certificate accepted in a tab, that trust reaches the extension too. Firefox keeps its own list: mkcert adds its root there if `certutil` is installed (`brew install nss`).

If mkcert isn't installed, `--https` stops before doing anything and tells you to install it or drop the flag.

Restart the stack to switch between the two (`pnpm playground:down`, then `up` with or without `--https`), and rejoin from the playground, since the invite's CA URL changes.

## Using your own fabric-samples

Set `WEFT_FABRIC_SAMPLES` to an existing checkout that has `bin/` and `test-network/`; otherwise the script downloads Fabric 2.5 and Fabric CA 1.5 into `playground/.fabric` (git-ignored).

## Hosting it

The same pieces run on a server. Put the relay and the CA proxy behind real TLS (the proxy takes `--cert` and `--key`), set the relay's `WEFT_PUBLIC_URL`, and point the docs playground's `?invite=` at the public invite. For a public demo, add rate limiting and reset the network on a schedule.
