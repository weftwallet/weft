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

It is named Weft Experimental, in the manifest, the popup and the windows' titles, and its welcome says it is a separate build. It has its own output folder, so Chrome gives the unpacked extension its own ID, and its own Firefox add-on ID, `experimental@weft.ifeanyiugwu.dev`. Its storage is therefore its own, and it shares no identities, keys, receipts or settings with Weft. It can share a browser profile with Weft: each announces its own provider to pages and talks to it on its own channel (docs/adr/0010), and the first of the two to load on a page provides `window.weft`.

`lib/experimental.ts` holds the one constant that gates experimental code, `EXPERIMENTAL`, which `wxt.config.ts` sets at build time from `import.meta.env.WEFT_EXPERIMENTAL`. Experimental code runs only inside `if (EXPERIMENTAL)`, so the normal build leaves it out; the e2e tests check that the normal build contains none of it. A branch that imports a whole experimental module tests `import.meta.env.WEFT_EXPERIMENTAL` itself, in the importing file, because the bundler folds a constant from another module only after it has chosen the modules; the file explains this. The same file lists the experimental features that `window.weft.features` adds: Weft Experimental reports `["receipts", "castBallot", "voterCredentials"]`, and Weft `["receipts"]`.

Weft Experimental draws its own mark, the main mark with its bottom edge pinked (`logo/products/experimental.svg` and `experimental-small.svg`), in its popup and windows.

### Casting a ballot

Weft Experimental offers `weft_castBallot` ([Casting a ballot](../docs/src/content/docs/experimental/cast-ballot.md), ADR 0007). Normal Weft answers it with 4200.

| Path | What it does |
|---|---|
| `lib/ballot/params.ts` | Checks the request's three params before any window opens. |
| `lib/ballot/read.ts` | Reads the endorsed answer to `GetElection`: the proposal hash, the peer's signature against the kept CA chain, the record, and the context and fingerprint Weft computes itself. |
| `lib/ballot/cast.ts` | The relay flows: the read, which endorses and submits nothing, and the cast, which checks the proposal is exactly the ballot and the voter tag's bytes before signing. |
| `lib/ballot/failures.ts` | What the window and the site are told for each failure, with the documented codes. |
| `lib/ballot/handler.ts` | The request in the background worker: the window, the read, encrypting and proving with `@weftwallet/tally`, the commit and receipt version 2. |
| `entrypoints/approve/cast-ballot.tsx` | The window's two screens and its failure states, loaded only by Weft Experimental. |
| `components/popup/BallotReceipt.tsx` | A kept version 2 receipt in a transaction's detail. |

When Weft Experimental enrols or re-enrols an identity, it keeps the CA chain the CA returns (`caChain` on the identity), to check a peer's signature on an election it reads. Weft keeps nothing new: in its build, the enrolment code adds no field.

`lib/ballot/test/fabric.ts` is a relay for the tests, which builds real Fabric Gateway messages around a fake private-ballot contract, with `CastAnonymousBallot` for idemix signers, and can lie in each way the checks catch.

### Voter credentials

Weft Experimental holds Idemix voter credentials and casts anonymous ballots with them ([Voter credentials](../docs/src/content/docs/experimental/voter-credentials.md), ADR 0008). It carries IBM's idemix library as WebAssembly from `packages/idemix`: `wxt.config.ts` copies `weft-idemix.wasm` and `wasm_exec.js` into its build at `/idemix/`, building them first when `packages/idemix/dist/wasm` has none with the pinned hash (that needs Go), and gives its extension pages `script-src 'self' 'wasm-unsafe-eval'; object-src 'self';`. Normal Weft has neither, and says only, for a voter invite, that it needs Weft Experimental.

| Path | What it does |
|---|---|
| `lib/voter/invite.ts` | Join from an invite reads a voter invite as well as an organisation's, with `@weftwallet/core`'s `parseVoterInvite`. |
| `lib/voter/enrol.ts` | Getting a voter credential, in the popup, in the order that sends nothing secret before a check that can fail, and what the voter is told for each failure. |
| `lib/voter/module.ts`, `lib/voter/idemix.worker.ts` | Starts the module in a dedicated worker of the page that needs it, the popup or the approval window, and measures it with the User Timing API. The background worker never runs it. |
| `lib/voter/seal.ts` | The voter credentials' key, HKDF of the vault key, and sealing the credential's secrets. The page that needs them seals or opens them itself. |
| `lib/voter/store.ts` | The credentials in the background worker: one per election, never an identity. |
| `lib/voter/activity.ts` | An anonymous ballot's activity and receipt, sealed whole. |
| `lib/voter/remote.ts` | The port between the approval window's module and the background worker, which carries five calls: a new identity, a signature, the pseudonym, the pseudonym proof and disposing of an identity. |
| `components/popup/VoterCredential.tsx` | The voter invite's review and Get a voter credential, the credentials' group in Identities, a credential's detail with Remove credential, and Home with only voter credentials. Loaded only by Weft Experimental. |

The ballot handler (`lib/ballot/handler.ts`) picks the credential for the election the site names, reads the election through the invite's relay with a one-off identity, checks every endorsement against the invite's CA chains, and casts `CastAnonymousBallot` with the voter tag from the pseudonym and the pseudonym proof, signing through the window's port. The approval window (`entrypoints/approve/cast-ballot.tsx`) starts the module before the read, and names no one on either screen.

## How it fits together

```
web page ──window.weft──▶ inpage.content.ts   (main world, no privileges)
                              │ window.postMessage, on this wallet's channel
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
| `entrypoints/inpage.content.ts` | Installs this wallet's provider (`lib/page-provider.ts`): announces it with `weft:announceProvider`, and defines `window.weft` and fires `weft#initialized` when no Weft has yet. |
| `entrypoints/bridge.content.ts` | Runs `lib/bridge.ts`: forwards requests on this wallet's channel to the background, and events only to connected origins. |
| `entrypoints/background.ts` | Routes popup and provider messages. The site origin comes from the browser, never the message. |
| `lib/provider.ts` | Connect checks, approval windows, evaluate/submit through the relay, activity records. |
| `lib/wallet.ts` | Identities and networks: enrol, import, CSR, re-enrol, signing. |
| `lib/db.ts` | IndexedDB. Private keys are non-extractable `CryptoKey`s. Weft Experimental adds two stores, for voter credentials and sealed anonymous activity. |
| `lib/experimental.ts` | The build switch for Weft Experimental: `EXPERIMENTAL`, the product's name and rdns, and `window.weft.features`. |
| `lib/receipts.ts` | Ballot receipts kept at the user's request, their choice and salt sealed with a key derived from the vault key (ADR 0006). In Weft Experimental, also version 2 receipts, with the voter's note of the choice sealed the same way (ADR 0007). |
| `entrypoints/popup/` | Home, identities, add-identity flows, transaction detail. |
| `entrypoints/approve/` | Connect and signature approval screens, with "Keep the receipt in Weft" for a vote. |
| `entrypoints/receipt/` | A small window that opens the explorer for a kept receipt and hands it the choice and salt by message. |

## Permissions

The manifest asks only for `storage`. CA and relay hosts differ per organisation, so Weft asks for each host at runtime when you add a network (`optional_host_permissions`). The content scripts run on HTTPS pages and on `localhost` for development.

## Icons

`public/icon/*.png` are rendered from `packages/brand/logo` by `scripts/render-icons.mjs`. The 16 and 32px icons use the pixel-fitted `mark-small.svg`; 48 and 128 use the full `mark.svg`.

`public/icon-experimental/*.png` are Weft Experimental's, rendered by the same script from `logo/products/experimental.svg` and `experimental-small.svg`: the main mark with its bottom edge pinked. Each build ships only its own set.
