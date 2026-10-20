<p align="center">
  <img src="packages/brand/logo/mark.svg" width="72" height="72" alt="">
</p>

<h1 align="center">weft</h1>

<p align="center">An identity wallet for Hyperledger Fabric.<br>
The network is the warp. Your identity and transactions are the weft, woven through it.</p>

---

Weft is a browser extension that does for permissioned Fabric networks what MetaMask does for Ethereum: web apps ask, you see exactly what they want, you approve or reject. Fabric has no coins, gas or addresses, so Weft is built around what Fabric actually has: X.509 identities issued by your organisation's CA, channels, contracts, and endorsement.

- **Identity first.** Your certificate, MSP ID, role and attributes, with expiry shown up front and one-click renewal.
- **Readable approvals.** Channel, contract, function and decoded arguments; reads (teal) look different from ledger writes (amber).
- **Keys never leave the browser.** Non-extractable WebCrypto keys. The relay sees only certificates, unsigned messages and signatures.
- **Verified before signing.** Weft decodes every Fabric message it's asked to sign and refuses anything that doesn't match what you approved.
- **Failures in plain English.** `ENDORSEMENT_POLICY_FAILURE` becomes "Not enough organisations approved it", with per-peer details.

## How it works

```
 Browser                                   Your organisation
┌───────────────────────────────┐         ┌────────────────────────────────┐
│ Web app ──window.weft──┐      │         │                                │
│                        ▼      │  HTTPS  │  Weft relay ──gRPC──▶ Peer     │
│  Weft extension (keys, ───────┼────────▶│  (offline-signing gateway)     │
│  approvals, verification)     │         │                                │
│                               │────────▶│  Fabric CA (enrol, re-enrol)   │
└───────────────────────────────┘         └────────────────────────────────┘
```

Browsers can't speak Fabric's gRPC, so each organisation runs a small stateless **relay** using the official `@hyperledger/fabric-gateway` SDK in offline-signing mode. The relay builds unsigned messages; the extension verifies and signs them; the relay forwards the signed bytes. Organisations share an **invite link** so users join without typing URLs. See [`docs/adr`](docs/adr) for the reasoning.

## Repository

| Path | Package | What it is |
|---|---|---|
| `apps/extension` | `@weftwallet/extension` | The MV3 browser extension (WXT + React). |
| `apps/relay` | `@weftwallet/relay` | The relay service (Fastify + fabric-gateway). Dockerfile included. |
| `apps/docs` | `@weftwallet/docs` | The documentation site (Astro Starlight). |
| `packages/protocol` | `@weftwallet/protocol` | Types shared by everything: provider API, errors, relay API, invites. |
| `packages/core` | `@weftwallet/core` | Signing, certificates, Fabric CA client, message decoding and verification, relay client. |
| `packages/sdk` | `@weftwallet/sdk` | What dApps import to talk to the wallet. |
| `packages/cli` | `@weftwallet/cli` | `weft` command for operators: build invites from connection profiles, share links and QR codes, check a deployment. |
| `packages/brand` | `@weftwallet/brand` | Logo files and design tokens. |
| `playground/` | – | `pnpm playground:up`: a local Fabric network with the relay and demo users, for the docs' playground page. |
| `examples/` | – | A plain-HTML demo dApp and a sample org invite. |
| `docs/adr/` | – | Architecture decision records. |

## Develop

Requires Node 22 and pnpm 10.

```sh
pnpm install
pnpm build          # packages first, then apps
pnpm test           # core unit tests + relay/core offline-signing integration tests
pnpm typecheck
```

Then, in separate terminals:

```sh
pnpm dev:extension  # Chrome with the extension loaded, hot reload
pnpm dev:relay      # needs apps/relay/.env, see .env.example
pnpm dev:docs       # http://localhost:4321
```

To try everything against a real network on your machine:

```sh
pnpm playground:up   # Fabric test-network, the basic contract, demo users and the relay (needs Docker)
pnpm dev:docs        # then open http://localhost:4321/playground/
```

See [`playground/README.md`](playground/README.md).

## Status

Early. The extension, relay, SDK and docs work end to end; see the security model's "Not covered yet" list before trusting it with production identities. Notably, keys are protected at rest only by the browser profile until passkey wrapping lands.

## License

[Apache-2.0](LICENSE). Hyperledger and Fabric are trademarks of the Linux Foundation; Weft is an independent project and is not affiliated with or endorsed by it.
