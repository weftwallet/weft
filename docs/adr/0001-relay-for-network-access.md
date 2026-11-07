# 0001: Reach the network through a stateless relay

Accepted on 19 October 2026. Decided by Ifeanyi Ugwu.

## Context and problem

A Fabric client connects to the peer Gateway service over gRPC (HTTP/2 with trailers). Browsers, including extension service workers, cannot open native gRPC connections. Weft therefore needs a service between the wallet and the peers.

That service builds or forwards every message the wallet signs. If it builds them, it can also build a different message from the one a dApp asked for.

## Decision drivers

- Private keys stay in the wallet.
- One wallet works on every Fabric network, without code for each network.
- What each organisation has to deploy and maintain.
- How much of Fabric's protobuf encoding the extension has to implement.

## Considered options

1. A relay that uses the official `@hyperledger/fabric-gateway` SDK in offline signing mode (chosen).
2. gRPC-web through Envoy in front of each peer. It works, but every organisation would have to deploy and maintain Envoy, and the extension would have to build Fabric protobuf messages itself.
3. Organisation-specific REST APIs. Every network builds them differently, and a wallet built on them could never be generic.

## Decision

`apps/relay` is an HTTP service that each organisation (or a network operator) runs next to its peers. It uses `@hyperledger/fabric-gateway` in offline signing mode. The relay builds the unsigned proposal, transaction and commit-status messages, the wallet signs them, and the relay forwards the signed bytes. The SDK encodes the Fabric protobuf messages on the relay, and the extension only decodes them to check what it signs.

The relay is stateless. Every request carries the bytes it needs, so any replica can serve any step, and a restart loses nothing. A submit takes four calls and an evaluate takes two:

| Step | Wallet sends | Relay returns |
|---|---|---|
| `POST /v1/proposals` | channel, contract, function, args, signer certificate + MSP ID | unsigned proposal bytes |
| `POST /v1/proposals/evaluate` | proposal bytes + signature | result |
| `POST /v1/proposals/endorse` | proposal bytes + signature | transaction bytes, tx ID, result |
| `POST /v1/transactions/submit` | transaction bytes + signature | commit-status request bytes |
| `POST /v1/commits/status` | commit bytes + signature | validation code, block number |

Before signing, the wallet decodes the proposal bytes it is asked to sign and checks channel, contract, function and arguments against the request the user approved. The check is `verifyProposal` in `@weftwallet/core`, and it is mandatory.

## Consequences

- Private keys never leave the wallet. The relay only ever sees public certificates, unsigned messages and signatures.
- The relay sees transaction contents. This is accepted because the relay runs inside the organisation's own boundary, next to peers that see the same data.
- A malicious relay could hand the wallet a different proposal from the one the dApp asked for. `verifyProposal` refuses to sign it.
- Each organisation runs one more service. The invite (ADR 0003) carries the relay's URL, and users never type it.

## More information

- [0003](0003-provider-api-and-org-invites.md) defines the invite.
- [Deploy the relay](../../apps/docs/src/content/docs/operators/relay.md) is the operator's guide.
