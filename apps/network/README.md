# @weftwallet/network

Weft Network: every organisation's explorer for one network on one page (`/`), and the invite maker (`/invite/`).

```sh
pnpm dev     # http://localhost:4324
pnpm build   # static site in dist/
```

Pages are built in the shared shell from `@weftwallet/ui`, with the tokens from `@weftwallet/brand`. Links to the other products come from `packages/brand/products.json`: local under `pnpm dev` (or any build with `WEFT_PRODUCTS=dev`), public otherwise.

With `demo.explorers` set in `packages/brand/products.json` (the demo network's explorer URLs), the network page opens on those organisations side by side, with the field below labelled "Your network"; otherwise it looks for the local stack. See the brand README, "The demo network".
