# 0001: Reach the network through a stateless relay

**Status:** Accepted
**Date:** 2026-10-19

## Context

A Fabric client connects to the peer Gateway service over gRPC (HTTP/2 with trailers). Browsers, including extension service workers, cannot open native gRPC connections. The options are:

1. **gRPC-web through Envoy** in front of each peer. Works, but every organisation must deploy and maintain Envoy, and the extension would have to build Fabric protobuf messages itself.
2. **A relay** that uses the official `@hyperledger/fabric-gateway` SDK in *offline signing* mode. The relay builds the unsigned proposal, transaction and commit-status messages; the wallet signs them; the relay forwards the signed bytes.
3. **Org-specific REST APIs.** Every network does this differently, so the wallet could never be generic.

## Decision

Use option 2. `apps/relay` is an HTTP service that each organisation (or a network operator) runs next to its peers.

The relay is **stateless**. Every request carries the bytes it needs, so any replica can serve any step, and a restart loses nothing. A submit takes four calls and an evaluate takes two:

| Step | Wallet sends | Relay returns |
|---|---|---|
| `POST /v1/proposals` | channel, contract, function, args, signer certificate + MSP ID | unsigned proposal bytes |
| `POST /v1/proposals/evaluate` | proposal bytes + signature | result |
| `POST /v1/proposals/endorse` | proposal bytes + signature | transaction bytes, tx ID, result |
| `POST /v1/transactions/submit` | transaction bytes + signature | commit-status request bytes |
| `POST /v1/commits/status` | commit bytes + signature | validation code, block number |

## Consequences

- **Private keys never leave the wallet.** The relay only ever sees public certificates, unsigned messages and signatures.
- The relay sees transaction contents. That is acceptable because it runs inside the organisation's own boundary, next to peers that see the same data.
- A malicious relay could hand the wallet a different proposal from the one the dApp asked for. The wallet therefore **decodes the proposal bytes it is asked to sign and checks channel, contract, function and arguments** against the approved request before signing. This check lives in `@weftwallet/core` (`verifyProposal`) and is mandatory.
- Organisations get one more service to run. The invite (see ADR 0003) carries its URL, so users never type it.
