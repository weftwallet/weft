# 0010: Announce each Weft's provider, in the style of EIP-6963

Accepted on 9 November 2026. Decided by Ifeanyi Ugwu.

## Context and problem

Weft and Weft Experimental (ADR 0009) install side by side, and each runs two content scripts in every page: a provider in the page's own world and a bridge in the extension's isolated world, which talk by `window.postMessage`. Before this record, both wallets tagged those messages with the same two names from `MESSAGE_TARGET` in `@weftwallet/protocol`, `weft:to-wallet` and `weft:to-page`. With both installed:

- both bridges answered every request, so one `weft_connect` opened two approval windows, one in each wallet;
- the page took whichever response came first;
- both wallets' events reached the one `window.weft`, so a page heard about identity changes in a wallet it wasn't using;
- the second provider to load stopped when `window.weft` existed, so no page could reach the second wallet.

Ethereum wallets had the same problem with `window.ethereum`. EIP-6963 has each wallet dispatch an event that carries its provider and a description of itself, and lets a page ask every wallet to announce itself again.

## Decision drivers

- One request reaches one wallet and opens at most one window.
- A page can tell the two wallets apart and choose one, for example the one that lists `"castBallot"`.
- Pages written for `window.weft` keep working unchanged.
- Nothing depends on which extension's scripts the browser runs first.

## Considered options

1. Announcement events, with one message channel per wallet, in the style of EIP-6963 (chosen).
2. One channel per wallet and nothing else. A request stops reaching both wallets, but a page still sees only the first wallet to load.
3. A shared list on `window`, such as `window.weftProviders`, that each wallet adds to. A page has to read it after every wallet has loaded, and any script can change the list.
4. No change, with a separate browser profile for each wallet, as ADR 0009 asked of testers before this record. Anyone with both installed still gets two windows and mixed events.

## Decision

### Announcements

Each wallet's provider script dispatches a `CustomEvent` named `weft:announceProvider` on `window`, once when it loads and again each time it hears `weft:requestProvider`, a plain `Event` that a page dispatches to ask every wallet to announce itself. The event's detail is frozen and has two fields, `info` and `provider`. The names are EIP-6963's with `weft:` in place of `eip6963:`, so Ethereum pages' listeners never receive them.

`info` is frozen too, and has four fields:

- `uuid`: from `crypto.randomUUID()`, new each time the page loads. A wallet announces the same UUID until the page reloads, so a page can drop repeats.
- `name`: "Weft" or "Weft Experimental".
- `icon`: the product's mark as an SVG data URI. Weft has the main mark, and Weft Experimental its own mark with the pinked edge (`packages/brand/logo/products/experimental.svg`).
- `rdns`: `dev.ifeanyiugwu.weft` for Weft and `dev.ifeanyiugwu.weft.experimental` for Weft Experimental. It names the product and stays the same across versions.

`@weftwallet/protocol` exports the event names, the two rdns values, the `WeftProviderInfo` and `WeftProviderDetail` types, and the events' entries in `WindowEventMap`.

### One channel per wallet

The tag on every message between a provider and its bridge ends with the wallet's rdns: `weft:to-wallet:dev.ifeanyiugwu.weft` and `weft:to-page:dev.ifeanyiugwu.weft` for Weft, and the same names ending in `.experimental` for Weft Experimental. `messageTargets(rdns)` in `@weftwallet/protocol` builds both. A bridge answers only requests tagged for its own wallet, and a provider accepts only responses and events tagged for its own wallet. Each wallet's background worker sends events only to its own bridge, so each provider hears only its own wallet.

### window.weft

The first wallet to load still defines `window.weft`, not writable and not configurable, and fires `weft#initialized`. The second builds its own provider and announces it. It leaves `window.weft` as it is and fires no `weft#initialized`. A page that reads only `window.weft` works as before, with whichever wallet loaded first.

### The SDK and Weft's own pages

`@weftwallet/sdk` adds `detectProviders()`, which asks every wallet to announce itself, listens for 500 milliseconds by default, and returns one `{ info, provider }` per UUID. `detectProvider()` and `getWeft()` take an optional `rdns` to prefer one wallet, and use `window.weft` when that wallet doesn't announce itself within 500 milliseconds of another Weft being found. `WeftClient` has `info` when it was built from an announcement. Without an `rdns`, the SDK behaves as before.

With both wallets installed, Weft Playground lets the visitor choose the wallet the whole page uses, and remembers the choice. Its Private election section uses that wallet, and offers to switch the page to the wallet that lists `"castBallot"` when the chosen one doesn't. With both wallets installed, the Weft site's invite page offers "Add to Weft" and "Add to Weft Experimental", and Weft Network offers "Sign in with Weft" and "Sign in with Weft Experimental". With one wallet, each page shows what it showed before.

### What info claims

`info` is what the announcer says about itself. Any script on the page can dispatch `weft:announceProvider` with a provider named "Weft" and Weft's rdns, as any script that runs first can define `window.weft`. An announcement gets the same trust as `window.weft`: it is part of the page. The user sees which wallet is asking in that wallet's own approval window, which a page can't draw.

## Consequences

- With both wallets installed, one request opens one approval window, in the wallet it was sent to, and each page hears only the events of the wallet it uses.
- A page can list both wallets and choose by `rdns` or by `features`. A page that changes nothing reaches the first wallet to load, as before.
- Two announcements can claim the same `rdns`. `detectProviders()` keeps both, since each has its own UUID, and leaves the choice to the page.
- The untagged names `weft:to-wallet` and `weft:to-page` reach no bridge now. They were never part of the provider API, and a wallet's provider and bridge always come from the same build.
- Each page's provider script carries the product's mark as a data URI, between 1 and 2 KB.

## More information

- The [Provider API](../../apps/docs/src/content/docs/dapps/provider-api.md#more-than-one-weft) describes the announcements for web apps.
- [EIP-6963: Multi Injected Provider Discovery](https://eips.ethereum.org/EIPS/eip-6963).
- See also [0003](0003-provider-api-and-org-invites.md), which defines `window.weft`, and [0009](0009-experimental-track.md), which makes Weft Experimental a separate extension.
