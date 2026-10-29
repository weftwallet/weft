# @weftwallet/site

Weft's front page, and the join page that invite links open (`/join/`).

```sh
pnpm dev     # http://localhost:4321
pnpm build   # static site in dist/
```

Pages are built in the shared shell from `@weftwallet/ui`, with the tokens from `@weftwallet/brand`. Links to the other products come from `packages/brand/products.json`: local under `pnpm dev` (or any build with `WEFT_PRODUCTS=dev`), public otherwise.
