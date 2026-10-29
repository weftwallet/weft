# @weftwallet/playground

Weft Playground: a small dApp for trying Weft against any network that publishes an invite, including the local one `pnpm playground:up` starts.

```sh
pnpm dev     # http://localhost:4323
pnpm build   # static site in dist/
```

Pages are built in the shared shell from `@weftwallet/ui`, with the tokens from `@weftwallet/brand`. Links to the other products come from `packages/brand/products.json`: local under `pnpm dev` (or any build with `WEFT_PRODUCTS=dev`), public otherwise.
