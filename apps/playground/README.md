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

A section marked `data-feature` shows only when `window.weft.features` lists that feature. `src/components/PrivateElection.astro`, the "Private election" section for `weft_castBallot`, is marked `castBallot`, which only Weft Experimental lists, and no build lists it yet. So with Weft, and with Weft Experimental as built today, the section stays hidden. See [Experimental features](../docs/src/content/docs/experimental/overview.md).
