# Weft playground stack

A local Hyperledger Fabric network ready for Weft, in one command. Use it to try the wallet, build a dApp, or run the docs' playground page against a real network on your machine.

```sh
pnpm playground:up       # first run downloads Fabric (~5–10 minutes)
pnpm dev:docs            # in another terminal
# open http://localhost:4321/playground/
pnpm playground:down     # stop everything and remove the network
pnpm playground:status   # what's running
```

## Requirements

- Docker (Docker Desktop or OrbStack), running
- git and curl
- [mkcert](https://github.com/FiloSottile/mkcert), recommended: `brew install mkcert` on macOS. Without it the browser won't trust the local CA; the script tells you the workaround.

## What it runs

| Piece | Where | Notes |
|---|---|---|
| Fabric `test-network` | Docker | Two orgs, Raft orderer, a CA per org, channel `mychannel` |
| `basic` contract | `mychannel` | fabric-samples' asset-transfer (TypeScript) |
| Org1 CA proxy | `https://localhost:7443` | Serves a mkcert certificate and forwards to the CA on 7054, so the browser can enrol |
| Weft relay | `http://localhost:8787` | Talks to `peer0.org1`; serves the invite at `/.well-known/weft-invite.json` |

## Demo users (Org1)

| Enrollment ID | Secret | Attributes |
|---|---|---|
| `alice` | `alicepw` | `role=auditor` |
| `bob` | `bobpw` | `role=trader` |

## Using your own fabric-samples

Set `WEFT_FABRIC_SAMPLES` to an existing checkout that has `bin/` and `test-network/`; otherwise the script downloads Fabric 2.5 and Fabric CA 1.5 into `playground/.fabric` (git-ignored).

## Hosting it

The same pieces run on a server. Put the relay and the CA proxy behind real TLS, set the relay's `WEFT_PUBLIC_URL`, and point the docs playground's `?invite=` at the public invite. For a public demo, add rate limiting and reset the network on a schedule.
