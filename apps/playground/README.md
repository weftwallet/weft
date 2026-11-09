# @weftwallet/playground

Weft Playground: a dApp for trying Weft against any network that publishes an invite, including the local one `pnpm playground:up` starts.

```sh
pnpm dev     # http://localhost:4323
pnpm build   # static site in dist/
```

Pages are built in the shared shell from `@weftwallet/ui`, with the tokens from `@weftwallet/brand`. Links to the other products come from `packages/brand/products.json`: local under `pnpm dev` (or any build with `WEFT_PRODUCTS=dev`), public otherwise.

## The demo network

With no network running, the page opens on "Weft not found" and an empty invite field, and looks for the local stack in the background (`pnpm playground:up`). To open it on a hosted demo network instead, set `demo.invite` in `packages/brand/products.json` to that network's invite URL (`https://relay.demo.example/.well-known/weft-invite.json`) and rebuild. The page then loads that invite first, marks it with a "Demo network" chip, and still accepts any other invite typed in or given with `?invite=`. The same file's `demo.explorers` opens Weft Network on the demo's explorers. Leave both empty to keep today's behaviour.

## Weft and Weft Experimental in one browser

With one Weft installed, the page uses `window.weft`, and the chip in step 1 says "Weft 0.1.0 detected". With Weft and Weft Experimental both installed (docs/adr/0010), the page lists the wallets that announce themselves with `weft:announceProvider`, and under the chip offers a choice of the one it uses, each option with the wallet's name and the mark it announced. The chip then names that wallet and its version, for example "Using Weft Experimental 0.1.0".

The choice is one for the whole page (`src/scripts/wallet-choice.ts`): joining, connecting, the identity, contract calls, elections, the Private election section, the wallet's events and the provider log all use the chosen wallet's provider. The default is the wallet that defined `window.weft`, found among the announcements by provider identity. A visitor's choice is kept by `rdns` in `localStorage`, under `weft-playground-wallet`, and used on their next visit when that wallet is installed; otherwise the page falls back to the default.

Switching wallet takes the page's event listeners off the old wallet's provider and adds them to the new one, forgets what belonged to the old wallet (the connection, the identity and the elections it voted in), asks the new wallet whether this page is connected already, and adds a "switched to" entry to the provider log. With two wallets, each log entry names the wallet it went to or came from, and the code the page shows calls `getWeft({ rdns: "<the chosen wallet's rdns>" })`. With one, the log and the code are as before.

## Sections for experimental builds

A section marked `data-feature` shows only when a Weft in the browser lists that feature in its `features`. `src/components/PrivateElection.astro`, the "Private election" section for `weft_castBallot`, is marked `castBallot`, which only Weft Experimental lists, so with Weft alone the section stays hidden. With both installed and Weft chosen, the section says that Weft doesn't offer private elections and offers Use Weft Experimental, which switches the whole page to Weft Experimental.

With Weft Experimental chosen, the section lists the private elections that the invite's explorer publishes: it reads the explorer's status for the channels with `privateElections`, then `/api/v1/channels/<channel>/private-elections` and each election's record from its JSON API, so it needs no connection to Weft. Vote in Weft calls the SDK's `castBallot()` with the channel, the contract and the election ID, and nothing else: the voter chooses in Weft's window. The section shows the block, the version 2 receipt with Download receipt, Copy receipt and a link to the explorer's tracking code check, and the tally once the trustees publish it, updated from the explorer every 15 seconds or with Refresh. Each error from Weft is said in words, with its code under Details. Every request goes in the provider log, through `src/scripts/provider-log.ts`, which the other sections use too. See [Experimental features](../docs/src/content/docs/experimental/overview.md) and [Casting a ballot](../docs/src/content/docs/experimental/cast-ballot.md).
