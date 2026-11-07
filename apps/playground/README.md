# @weftwallet/playground

Weft Playground: a dApp for trying Weft against any network that publishes an invite, including the local one `pnpm playground:up` starts.

```sh
pnpm dev     # http://localhost:4323
pnpm build   # static site in dist/
```

Pages are built in the shared shell from `@weftwallet/ui`, with the tokens from `@weftwallet/brand`. Links to the other products come from `packages/brand/products.json`: local under `pnpm dev` (or any build with `WEFT_PRODUCTS=dev`), public otherwise.

## The demo network

With no network running, the page opens on "Weft not found" and an empty invite field, and looks for the local stack in the background (`pnpm playground:up`). To open it on a hosted demo network instead, set `demo.invite` in `packages/brand/products.json` to that network's invite URL (`https://relay.demo.example/.well-known/weft-invite.json`) and rebuild. The page then loads that invite first, marks it with a "Demo network" chip, and still accepts any other invite typed in or given with `?invite=`. The same file's `demo.explorers` opens Weft Network on the demo's explorers. Leave both empty to keep today's behaviour.

## Sections for experimental builds

A section marked `data-feature` shows only when `window.weft.features` lists that feature. `src/components/PrivateElection.astro`, the "Private election" section for `weft_castBallot`, is marked `castBallot`, which only Weft Experimental lists, so with Weft the section stays hidden.

With Weft Experimental, the section lists the private elections that the invite's explorer publishes: it reads the explorer's status for the channels with `privateElections`, then `/api/v1/channels/<channel>/private-elections` and each election's record from its JSON API, so it needs no connection to Weft. Vote in Weft calls the SDK's `castBallot()` with the channel, the contract and the election ID, and nothing else: the voter chooses in Weft's window. The section shows the block, the version 2 receipt with Download receipt, Copy receipt and a link to the explorer's tracking code check, and the tally once the trustees publish it, updated from the explorer every 15 seconds or with Refresh. Each error from Weft is said in words, with its code under Details. Every request goes in the provider log, through `src/scripts/provider-log.ts`, which the other sections use too. See [Experimental features](../docs/src/content/docs/experimental/overview.md) and [Casting a ballot](../docs/src/content/docs/experimental/cast-ballot.md).
