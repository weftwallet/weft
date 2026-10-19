# @weftwallet/extension

The Weft browser extension (Manifest V3), built with [WXT](https://wxt.dev) and React.

## Run it

```sh
pnpm install
pnpm --filter "./packages/**" build   # the extension imports the built packages
pnpm --filter @weftwallet/extension dev     # opens Chrome with the extension loaded and hot reload
```

`pnpm --filter @weftwallet/extension build` writes an unpacked extension to `.output/chrome-mv3`. Load it from `chrome://extensions` with **Developer mode → Load unpacked**. `pnpm zip` produces the store upload.

## How it fits together

```
web page ──window.weft──▶ inpage.content.ts   (main world, no privileges)
                              │ window.postMessage
                              ▼
                         bridge.content.ts    (isolated world)
                              │ runtime.sendMessage
                              ▼
                         background.ts        (service worker: keys, approvals, relay calls)
                              │ opens
                              ▼
                         approve.html         (approval window)
```

| Path | What it does |
|---|---|
| `entrypoints/inpage.content.ts` | Defines `window.weft` and fires `weft#initialized`. |
| `entrypoints/bridge.content.ts` | Forwards requests to the background; forwards events only to connected origins. |
| `entrypoints/background.ts` | Routes popup and provider messages. The site origin comes from the browser, never the message. |
| `lib/provider.ts` | Connect checks, approval windows, evaluate/submit through the relay, activity records. |
| `lib/wallet.ts` | Identities and networks: enrol, import, CSR, re-enrol, signing. |
| `lib/db.ts` | IndexedDB. Private keys are non-extractable `CryptoKey`s. |
| `entrypoints/popup/` | Home, identities, add-identity flows, transaction detail. |
| `entrypoints/approve/` | Connect and signature approval screens. |

## Permissions

The manifest asks only for `storage`. CA and relay hosts differ per organisation, so Weft asks for each host at runtime when you add a network (`optional_host_permissions`). The content scripts run on HTTPS pages and on `localhost` for development.

## Icons

`public/icon/*.png` are rendered from `packages/brand/logo` by `scripts/render-icons.mjs`. The 16 and 32px icons use the pixel-fitted `mark-small.svg`; 48 and 128 use the full `mark.svg`.
