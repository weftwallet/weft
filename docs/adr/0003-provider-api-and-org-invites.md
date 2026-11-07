# 0003: Use a request-based provider API, and onboard through invites

Accepted on 19 October 2026, extended on 20 October 2026. Decided by Ifeanyi Ugwu.

## Context and problem

dApps need one stable way to find the wallet and ask it to do things. Ethereum settled on EIP-1193: a single `request({ method, params })` function plus events.

To join a Fabric network, a user's wallet needs its relay URL, CA URL, MSP ID and channels. Network administrators already hold these details, most of them in the Fabric connection profile an operator already has. Connection profiles don't hold the relay URL, and often not the channels.

A web page that passes connection details to the wallet controls what those details say.

## Decision

### Provider

The extension injects `window.weft`, an object with:

- `request({ method, params })`, which returns a Promise
- `on(event, listener)` and `off(event, listener)`
- `isWeft: true` and a `version` string

Methods are namespaced `weft_*` and listed in `@weftwallet/protocol`:

| Method | Approval | Purpose |
|---|---|---|
| `weft_connect` | Yes, once per origin | Grants the site access to the active identity's public details |
| `weft_identity` | No (after connect) | Returns MSP ID, common name, attributes, expiry |
| `weft_networks` | No (after connect) | Lists networks and channels the identity can use |
| `weft_evaluate` | Yes | Signs and runs a read |
| `weft_submit` | Yes | Signs, endorses, submits and waits for commit |
| `weft_addNetwork` | Yes, and no `weft_connect` needed | Hands the wallet an invite URL |

Errors use numeric codes in the style of EIP-1193 (`4001` user rejected, `4100` unauthorised, and so on). The events are `identityChanged`, `networkChanged` and `disconnect`.

### Invites

An organisation publishes an invite: a JSON document, optionally signed, carrying its display name, MSP ID, CA URL, relay URL and channels. It is shared as a `weft://invite?u=<https url>` link or as a QR code of that link. The wallet fetches the JSON over HTTPS and shows the user what they are joining before enrolling.

Operators build an invite from their Fabric connection profile and supply the relay URL and, often, the channels themselves. The relay can serve an invite at `/.well-known/weft-invite.json`, `@weftwallet/cli` can write one, and the docs site has an in-browser invite maker.

A page, typically the hosted join page or an organisation's portal, hands an invite URL to the wallet with `weft_addNetwork({ url })`. After the user agrees, the wallet fetches the invite from that URL itself, and the page can't alter what the user sees. Like MetaMask's add-network flow, `weft_addNetwork` doesn't require `weft_connect`.

A QR code encodes the join link. Because Weft is a desktop extension, it reads codes from the visible tab or a pasted screenshot instead of a camera.

The provider and the invite format date from 19 October 2026. Building invites from a connection profile, `weft_addNetwork` and reading QR codes from the tab or a screenshot were added on 20 October 2026.

## Consequences

- dApps written against `@weftwallet/sdk` work unchanged if the transport under the wallet changes.
- Network administrators, who already hold the connection details, supply them once in the invite, and users no longer type URLs.

## More information

- [Provider API](../../apps/docs/src/content/docs/dapps/provider-api.md) lists the methods, events and error codes.
- [Publish an invite](../../apps/docs/src/content/docs/operators/invites.md) is the operator's guide.
