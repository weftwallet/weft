# @weftwallet/docs

Weft Docs: guides for people using Weft, building dApps and running networks, built with [Astro Starlight](https://starlight.astro.build).

```sh
pnpm dev     # http://localhost:4322
pnpm build   # static site in dist/
```

Pages live in `src/content/docs`. Colours map to the brand tokens in `src/styles/theme.css`.

The docs link to the other Weft products with `weft:` links, such as `[the playground](weft:playground/)` or `<LinkCard href="weft:network/" />`. They're resolved from `packages/brand/products.json`: to the local dev servers under `pnpm dev` (or any build with `WEFT_PRODUCTS=dev`), and to the public addresses otherwise. The pages that moved to other products redirect there.
