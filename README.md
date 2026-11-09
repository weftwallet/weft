<p align="center">
  <img src="packages/brand/logo/mark.svg" width="72" height="72" alt="">
</p>

<h1 align="center">weft</h1>

<p align="center">An identity wallet for Hyperledger Fabric.<br>
It holds the certificate your organisation's CA issued you and signs only the transactions you approve.</p>

---

Weft is a browser extension that does for permissioned Fabric networks what MetaMask does for Ethereum. A web app sends a request and Weft shows exactly what it would sign. You approve or reject it.

Fabric has no coins, gas or addresses. Weft is built around X.509 identities issued by your organisation's CA, channels, contracts and endorsement.

- The home screen shows your certificate, MSP ID, role and attributes, with the expiry date and a button to renew it.
- Every request shows the channel, contract, function and decoded arguments. Reads are teal and ledger writes are amber.
- Private keys are encrypted with your password and used as non-extractable WebCrypto keys. Weft locks itself, and unlocks with the password or a passkey. The relay sees only certificates, unsigned messages and signatures.
- Weft decodes every Fabric message it's asked to sign and refuses anything that doesn't match what you approved.
- Failures are explained in plain English: `ENDORSEMENT_POLICY_FAILURE` becomes "Not enough organisations endorsed it", with per-peer details.

## How it works

```
 Browser                                   Your organisation
┌───────────────────────────────┐         ┌────────────────────────────────┐
│ Web app ──window.weft──┐      │         │                                │
│                        ▼      │  HTTPS  │  Relay ──gRPC──▶ Peer          │
│  Weft extension (keys, ───────┼────────▶│  (offline-signing gateway)     │
│  approvals, verification)     │         │                                │
│                               │────────▶│  Fabric CA (enrol, re-enrol)   │
└───────────────────────────────┘         └────────────────────────────────┘
```

Browsers can't open gRPC connections to Fabric peers, so each organisation runs a stateless **relay** using the official `@hyperledger/fabric-gateway` SDK in offline-signing mode. The relay builds unsigned messages; the extension verifies and signs them; the relay forwards the signed bytes. Organisations share an **invite link** so users join without typing URLs. See [`docs/adr`](docs/adr) for the reasoning.

## Repository

| Path | Package | What it is |
|---|---|---|
| `apps/extension` | `@weftwallet/extension` | The MV3 browser extension (WXT + React). |
| `apps/relay` | `@weftwallet/relay` | The relay service (Fastify + fabric-gateway). Dockerfile included. |
| `apps/explorer` | `@weftwallet/explorer` | A block explorer one organisation runs for the channels it publishes. |
| `apps/site` | `@weftwallet/site` | The Weft site, and the join page invite links open. |
| `apps/docs` | `@weftwallet/docs` | Weft Docs, the documentation (Astro Starlight). |
| `apps/playground` | `@weftwallet/playground` | Weft Playground: try a dApp against a Fabric network from the browser. |
| `apps/network` | `@weftwallet/network` | Weft Network: every organisation's explorer on one page, and the invite maker. |
| `packages/protocol` | `@weftwallet/protocol` | Types shared by everything: provider API, errors, relay API, invites. |
| `packages/core` | `@weftwallet/core` | Signing, certificates, Fabric CA client, message decoding and verification, relay client. |
| `packages/sdk` | `@weftwallet/sdk` | What dApps import to call Weft. |
| `packages/cli` | `@weftwallet/cli` | `weft` command for operators: build invites from connection profiles, share links and QR codes, check a deployment. |
| `packages/brand` | `@weftwallet/brand` | The design system: tokens, logos and product marks, and where each product lives (`products.json`). |
| `packages/ui` | `@weftwallet/ui` | The page shell, base styles and links between products, shared by the Weft site, the playground and Weft Network. |
| `playground/` | None | `pnpm playground:up`: a local Fabric network with the relay, an explorer and demo users, for the playground. |
| `examples/` | None | A plain-HTML demo dApp, a sample invite, and a ballot contract for elections the explorer can check. |
| `docs/adr/` | None | Architecture decision records. |

## Develop

Requires Node 22, from 22.23.4 (the repository's `.nvmrc` says 22), and pnpm 10.

```sh
pnpm install
pnpm test           # core unit tests + relay/core offline-signing integration tests
pnpm typecheck
```

Then start the sites, all in one terminal:

```sh
pnpm dev                     # the site, docs, playground and network
pnpm dev site playground     # only these
pnpm dev all                 # the sites and the extension
pnpm dev --stream            # start on the stream rather than the tabs
```

Each product gets a tab of its own logs. `s` switches to one stream of them all, labelled, and `t` back to the tabs. `r` restarts the product you're on, `/` searches, `f` picks which products the stream shows, and `q` stops them all and leaves their output in your terminal. Piped or in CI, it prints the labelled lines instead. The terminal view is [`@laravel/multiplex`](https://github.com/laravel/multiplex).

The addresses are http://localhost:4321 (site), 4322 (docs), 4323 (playground) and 4324 (network). A product already running elsewhere isn't started twice: its tab says where it is.

Each product also has its own command, for a terminal of its own:

```sh
pnpm dev:extension  # Chrome with the extension loaded, hot reload
pnpm dev:relay      # needs apps/relay/.env, see .env.example
pnpm dev:explorer   # set its variables in apps/explorer/.env, see the explorer docs
pnpm dev:site       # http://localhost:4321, the Weft site
pnpm dev:docs       # http://localhost:4322
pnpm dev:playground # http://localhost:4323
pnpm dev:network    # http://localhost:4324
```

`pnpm dev relay` and `pnpm dev explorer` work too, but the playground stack runs its own relay and explorer on the same ports, so while the stack is up their tabs say so instead.

Each product's address, local and public, is in `packages/brand/products.json`; their links to each other follow it.

None of these need a build: they read `packages/` from source, so a change there shows up straight away. `pnpm build` (packages first, then apps) is for running the built apps, as production and the playground do. See [CONTRIBUTING.md](CONTRIBUTING.md#how-the-packages-resolve).

To try everything against a real network on your machine:

```sh
pnpm playground:up   # Fabric test-network, the basic contract, demo users, the relay and an explorer (needs Docker)
pnpm dev             # then open http://localhost:4323
                     # the explorer is at http://localhost:8790
```

See [`playground/README.md`](playground/README.md).

## Status

Weft is in early development. The extension, relay, SDK and docs work end to end; see the security model's "Not covered yet" list before trusting it with production identities.

## Licence

[Apache 2.0](LICENSE). Hyperledger and Fabric are trademarks of the Linux Foundation; Weft is an independent project and is not affiliated with or endorsed by it.
