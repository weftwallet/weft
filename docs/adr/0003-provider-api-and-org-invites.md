# 0003: A small request-based provider API, and org invites for onboarding

**Status:** Accepted
**Date:** 2026-10-19

## Context

dApps need one stable way to find the wallet and ask it to do things. Ethereum settled on EIP-1193: a single `request({ method, params })` function plus events. Fabric users also need a way to get the right connection details (relay URL, CA URL, MSP ID, channels) without typing them.

## Decision

### Provider

The extension injects `window.weft`, an object with:

- `request({ method, params })` returning a Promise,
- `on(event, listener)` / `off(event, listener)`,
- `isWeft: true` and a `version` string.

Methods are namespaced `weft_*` and listed in `@weftwallet/protocol`:

| Method | Approval | Purpose |
|---|---|---|
| `weft_connect` | Yes, once per origin | Grants the site access to the active identity's public details |
| `weft_identity` | No (after connect) | Returns MSP ID, common name, attributes, expiry |
| `weft_networks` | No (after connect) | Lists networks and channels the identity can use |
| `weft_evaluate` | Yes | Signs and runs a read-only query |
| `weft_submit` | Yes | Signs, endorses, submits and waits for commit |

Errors use numeric codes in the style of EIP-1193 (`4001` user rejected, `4100` unauthorised, and so on).

Events: `identityChanged`, `networkChanged`, `disconnect`.

### Org invites

An organisation publishes an **invite**: a small JSON document, optionally signed, carrying its display name, MSP ID, CA URL, relay URL and channels. It is shared as a `weft://invite?u=<https url>` link or a QR code of that link. The wallet fetches the JSON over HTTPS and shows the user what they are joining before enrolling.

## Consequences

- dApps written against `@weftwallet/sdk` work unchanged if the transport under the wallet changes.
- Invites move the "which URL do I type?" problem to network administrators, who already have the answers.

## Update (2026-10-20): publishing and accepting invites

- **Publishing.** Operators build invites from the Fabric connection profile they already have: the relay can serve one at `/.well-known/weft-invite.json`, `@weftwallet/cli` can write one, and the docs site has an in-browser invite maker. The relay URL and, often, the channels aren't in connection profiles, so the operator supplies them.
- **Accepting.** `weft_addNetwork({ url })` lets a page, typically the hosted join page or an org portal, hand an invite URL to the wallet. The wallet fetches the invite itself from that URL after the user agrees, so a page can't alter what the user sees. Like MetaMask's add-network flow, it doesn't require `weft_connect`.
- **QR codes** encode the join link. Because the wallet is a desktop extension, it reads codes from the visible tab or a pasted screenshot rather than a camera.
