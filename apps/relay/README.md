# @weftwallet/relay

A stateless HTTP relay between the Weft wallet and a Fabric peer's Gateway service. It uses `@hyperledger/fabric-gateway` in offline-signing mode, so it never holds private keys. Why it exists: [ADR 0001](../../docs/adr/0001-relay-for-network-access.md).

```sh
cp .env.example .env     # point it at your peer
pnpm dev                 # from this folder
```

Configuration, Docker and the API are documented in [Deploy the relay](../docs/src/content/docs/operators/relay.md).

`pnpm test` runs the offline-signing integration tests: real proposals built by fabric-gateway, decoded, verified and signed by `@weftwallet/core`, and accepted back by fabric-gateway. No network needed.
