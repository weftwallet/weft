# @weftwallet/brand

Logo files and design tokens shared by the extension and the docs site.

## The mark

Three weft threads passing over and under two warp threads: the network is the warp, your identity and transactions are the weft woven through it. It also reads as a ledger's rows.

| File | Use |
|---|---|
| `logo/mark.svg` | Default. Teal tile, ink threads. |
| `logo/mark-inverted.svg` | On teal or light backgrounds where the tile would disappear. |
| `logo/mark-small.svg` | 16–24px. The weave is dropped and the threads become three bars so they stay legible. |
| `logo/lockup-dark.svg` | Mark plus wordmark on dark backgrounds. |
| `logo/lockup-light.svg` | Mark plus wordmark on light backgrounds. |

The wordmark is always lowercase `weft` in IBM Plex Mono, weight 500.

When naming the project next to Fabric, write "weft — an identity wallet for Hyperledger Fabric". Keep "Hyperledger" and "Fabric" out of the name and logo themselves: they are Linux Foundation trademarks.

## Colour

| Token | Hex | Role |
|---|---|---|
| Ink | `#0B1218` | Background |
| Slate | `#17212B` | Raised surfaces (cards) |
| Thread | `#3FC1B0` | The only brand accent: primary actions, focus, "valid" |
| Amber | `#E8A33D` | Warnings: expiring certificates, ledger writes |
| Signal | `#E5675B` | Failures: expired certificates, rejected transactions |
| Linen | `#F5F3EE` | Light-theme background |

Amber and Signal are reserved for status. Never use them decoratively, or users stop noticing them.

## Type

- **IBM Plex Sans** for interface text, labels and plain-English explanations.
- **IBM Plex Mono** for anything a user might copy or compare: MSP IDs, transaction IDs, fingerprints, function names, arguments.

## Tokens

`tokens.css` exposes everything as `--weft-*` custom properties; `tokens.json` has the same values for tools.
