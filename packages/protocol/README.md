# @weftwallet/protocol

Types and constants shared by every part of Weft: the `window.weft` provider methods and events, error codes, ballot receipts and the messages that hand one to the explorer, the provider announcement (`weft:announceProvider` and `weft:requestProvider`, with `WeftProviderInfo`, `WeftProviderDetail` and each product's rdns, docs/adr/0010), the window-messaging envelope between page and extension, the relay HTTP API, and the invite schema.

Each wallet's provider and bridge tag their messages with the wallet's own channel, which `messageTargets(rdns)` builds, for example `weft:to-wallet:dev.ifeanyiugwu.weft`. `MESSAGE_TARGET` holds the start of each tag, without the rdns.

Changing anything here changes a public contract. Update the docs' Provider API page in the same change.
