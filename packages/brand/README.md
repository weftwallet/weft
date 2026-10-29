# @weftwallet/brand

Weft's logos, product marks, design tokens and product registry, shared by every Weft product. [SYSTEM.md](SYSTEM.md) is the design system: colour roles, type, motion, states, errors and navigation.

## The mark

The mark shows weft threads passing over and under warp threads. The [Brand page](https://weft.ifeanyiugwu.dev/reference/brand/#the-name) explains the name.

There are two drawings of the same idea. Above 32px use the full mark: three wefts over two warps. At 32px and below the full mark's gaps fall under a pixel and blur, so use the small mark: a simpler 2×2 weave fitted to the pixel grid.

| File | Use |
|---|---|
| `logo/mark.svg` | Default. Teal tile, ink threads. |
| `logo/mark-inverted.svg` | On teal or light backgrounds where the tile would disappear. |
| `logo/mark-small.svg` | 32px and below: toolbar icons, favicons, the popup header. A 2×2 weave drawn on the 16px pixel grid, so every thread and gap lands on whole pixels and stays sharp. |
| `logo/lockup-dark.svg` | Mark plus wordmark on dark backgrounds. |
| `logo/lockup-light.svg` | Mark plus wordmark on light backgrounds. |

The wordmark is always lowercase `weft` in Atkinson Hyperlegible Mono, weight 500. In the lockups it's converted to outlines (`scripts/lockups.mjs`), so it looks the same wherever the file is used.

When naming the project next to Fabric, write "weft, an identity wallet for Hyperledger Fabric". Keep "Hyperledger" and "Fabric" out of the name and logo themselves: they are Linux Foundation trademarks.

## Product marks

Weft, the wallet and the docs use the main mark. The playground, the network and the explorer have their own, drawn by `scripts/marks.mjs` into `logo/products/` with a small version for 32px and below. The network and the explorer sit on an ink tile in a teal frame, because an organisation runs them for itself. [SYSTEM.md](SYSTEM.md#marks) has the construction rules.

| File | Mark |
|---|---|
| `logo/products/playground.svg` | The cloth with a pick still to pass |
| `logo/products/network.svg` | The warp alone, in the loom's frame |
| `logo/products/explorer.svg` | The finished cloth, a 3 by 3 weave, in the loom's frame |

## Products and addresses

`products.json` names each product and says where it lives. Apps link to each other with `productUrl()` from `@weftwallet/brand/products`, so changing `domain` there moves every link.

## Colour

| Token | Hex | Role |
|---|---|---|
| Ink | `#0B1218` | Background |
| Slate | `#17212B` | Raised surfaces (cards) |
| Thread | `#3FC1B0` | The only brand accent: primary actions, focus, "valid" |
| Amber | `#E8A33D` | Warnings: expiring certificates, ledger writes |
| Signal | `#E5675B` | Failures: expired certificates, rejected transactions |
| Linen | `#F5F3EE` | Light-theme background |

Amber and Signal are reserved for status. Never use them decoratively, or users stop noticing them. Products use the colour roles in [SYSTEM.md](SYSTEM.md#colour), which follow the theme, rather than these values directly.

## Type

- Atkinson Hyperlegible Next for interface text, labels and plain-English explanations.
- Atkinson Hyperlegible Mono for anything a user might copy or compare: MSP IDs, enrolment IDs, transaction IDs, fingerprints, function names, arguments.

Both are from the Braille Institute, drawn so that characters people confuse (0 and O, 1, l and I) differ in shape. Both are free under the SIL Open Font License; `@fontsource/atkinson-hyperlegible-next` and `@fontsource/atkinson-hyperlegible-mono` package them.

## Tokens

`tokens.css` exposes everything as `--weft-*` custom properties, in both themes; `tokens.json` has the same values for tools. Both are generated: edit `scripts/tokens.mjs`, then run `pnpm --filter @weftwallet/brand tokens`.
