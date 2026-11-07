# @weftwallet/extension

Weft Wallet, the browser extension (Manifest V3), built with [WXT](https://wxt.dev) and React.

## Run it

```sh
pnpm install
pnpm dev:extension   # opens its own Chrome with Weft loaded, and reloads it as you edit
```

That Chrome keeps its profile in `.wxt/chrome-data`, so the wallet you set up in it is still there next time. Delete the folder to start from a new wallet. `dev:firefox` does the same with its own Firefox, in `.wxt/firefox-data`. Before reusing that, web-ext reads Firefox's own `profiles.ini` to make sure it isn't your everyday profile. macOS can block your terminal from reading that file. When it does, the dev Firefox starts with a new profile each time and WXT says so. To keep the profile, give your terminal app access in **System Settings › Privacy & Security › Full Disk Access**, or allow it when macOS asks.

To change how either browser starts (another browser, a page to open), add a `web-ext.config.ts` here, which git ignores; see [WXT's browser startup options](https://wxt.dev/guide/essentials/config/browser-startup).

`pnpm --filter @weftwallet/extension build` writes an unpacked extension to `.output/chrome-mv3`. Load it from `chrome://extensions` with **Developer mode → Load unpacked**. `pnpm zip` produces the store upload.

### Firefox

Weft runs in Firefox 140 or later, as Manifest V3 like Chrome.

```sh
pnpm --filter @weftwallet/extension dev:firefox            # opens its own Firefox with Weft loaded
pnpm --filter @weftwallet/extension build -b firefox       # writes .output/firefox-mv3
```

To load a build by hand, open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on** and pick `manifest.json` in `.output/firefox-mv3`. Firefox removes a temporary add-on when it closes.

## Weft Experimental

`WEFT_EXPERIMENTAL=1` builds Weft Experimental from this same project: a separate extension for features that no one outside the project has reviewed and that aren't part of Weft ([ADR 0009](../../docs/adr/0009-experimental-track.md), [Experimental features](../docs/src/content/docs/experimental/overview.md)). It isn't offered in browser stores.

```sh
pnpm --filter @weftwallet/extension dev:experimental            # its own Chrome, profile in .wxt/chrome-data-experimental
pnpm --filter @weftwallet/extension dev:firefox:experimental    # its own Firefox, profile in .wxt/firefox-data-experimental
pnpm --filter @weftwallet/extension build:experimental          # .output-experimental/chrome-mv3
pnpm --filter @weftwallet/extension build:experimental -b firefox
pnpm --filter @weftwallet/extension build:e2e:experimental      # .output-e2e-experimental, for the e2e tests
```

It is named Weft Experimental, in the manifest, the popup and the windows' titles, and its welcome says it is a separate build. It has its own output folder, so Chrome gives the unpacked extension its own ID, and its own Firefox add-on ID, `experimental@weft.ifeanyiugwu.dev`. Its storage is therefore its own, and it shares no identities, keys, receipts or settings with Weft. Load it in a browser profile without Weft, since the first of the two to load on a page provides `window.weft`.

`lib/experimental.ts` holds the one constant that gates experimental code, `EXPERIMENTAL`, which `wxt.config.ts` sets at build time from `import.meta.env.WEFT_EXPERIMENTAL`. Experimental code runs only inside `if (EXPERIMENTAL)`, so the normal build leaves it out; the e2e tests check that the normal build contains none of it. The same file lists the experimental features that `window.weft.features` adds: none yet, so both builds report `["receipts"]`. `castBallot` and then `voterCredentials` are added there when they are built.

## How it fits together

```
web page ──window.weft──▶ inpage.content.ts   (main world, no privileges)
                              │ window.postMessage
                              ▼
                         bridge.content.ts    (isolated world)
                              │ runtime.sendMessage
                              ▼
                         background.ts        (background worker: keys, approvals, relay calls)
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
| `lib/experimental.ts` | The build switch for Weft Experimental: `EXPERIMENTAL`, the product's name, and `window.weft.features`. |
| `lib/receipts.ts` | Ballot receipts kept at the user's request, their choice and salt sealed with a key derived from the vault key (ADR 0006). |
| `entrypoints/popup/` | Home, identities, add-identity flows, transaction detail. |
| `entrypoints/approve/` | Connect and signature approval screens, with "Keep the receipt in Weft" for a vote. |
| `entrypoints/receipt/` | A small window that opens the explorer for a kept receipt and hands it the choice and salt by message. |

## Permissions

The manifest asks only for `storage`. CA and relay hosts differ per organisation, so Weft asks for each host at runtime when you add a network (`optional_host_permissions`). The content scripts run on HTTPS pages and on `localhost` for development.

## Icons

`public/icon/*.png` are rendered from `packages/brand/logo` by `scripts/render-icons.mjs`. The 16 and 32px icons use the pixel-fitted `mark-small.svg`; 48 and 128 use the full `mark.svg`.

`public/icon-experimental/*.png` are Weft Experimental's, rendered by the same script from `logo/products/experimental.svg` and `experimental-small.svg`: the main mark with its bottom edge pinked. Each build ships only its own set.
