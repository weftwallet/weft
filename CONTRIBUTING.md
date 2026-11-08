# Contributing

## Setup

```sh
pnpm install
pnpm test        # every package's unit tests and the playground's own (playground/test), not the browser tests
pnpm typecheck   # tsc everywhere, wxt prepare for the extension and astro check for Weft Playground
```

`pnpm test` needs no Fabric CA and no Docker. The browser tests are their own script, `pnpm test:e2e` (below). With Go on your `PATH`, `packages/idemix`'s tests also build the idemix module and its Go test tool; without it they skip and say why.

## How the packages resolve

The apps use `packages/protocol`, `packages/core` and `packages/sdk` in two ways:

- In development, from source. Each package's `exports` has a `weft-source` entry pointing at `src/`, and every development tool asks for it: Vite (`vite.source.ts`, used by the sites, the extension and the tests), TypeScript (`customConditions`), and Node in the relay's and explorer's `dev` scripts (`--conditions=weft-source`). Nothing needs building, and a change in a package shows up on the next reload.
- Built, from `dist/`. Production, the Docker images, the playground and the published packages use this. `pnpm playground:up` and `pnpm test:e2e` build what they run every time.

Inside a package, import with the `.ts` extension (`./bytes.ts`). Node runs the source as it is and doesn't map `.js` to `.ts`; `tsc` rewrites the extension in `dist/`. Publishing removes the `weft-source` entry (`publishConfig.exports`).

## Browser tests

`e2e/` drives the real extension in Chromium against a real Fabric CA, the CA proxy and the relay. It needs no Docker; there are no peers, so contract calls fail fast.

```sh
e2e/scripts/fabric-ca.sh   # once: downloads the Fabric CA server and client into e2e/.bin
pnpm test:e2e              # builds the relay, the sites and the test extension, then runs the suite
```

`pnpm --filter @weftwallet/e2e test:headed` runs the tests that need a windowed browser (they reload the extension), under `xvfb-run` on Linux.

To test against real peers, start the playground (`pnpm playground:up`), then run the suite with `WEFT_E2E_STACK=playground`. That also runs the `@fabric` tests, which submit to the `basic` contract. With `pnpm playground:up --experimental`, the `experimental-stack` Playwright project runs too: its setup creates a fresh private election for the run, and its tests vote in it from a site and from Weft Playground with Weft Experimental, count it with `pnpm playground:count` and check it in both explorers (`e2e/support/experimental.ts`). The `voter-credentials` project does the same for voter credentials: its setup creates a fresh election with voter credentials on `privatevote-chair-2027` and registers two voters on its voters' CA, and its test has them enrol and vote from Weft Playground in two browser profiles, then counts the election and runs both explorers' full check. It registers the voters with `fabric-ca-client`, from `FABRIC_CA_BIN` or the playground's Fabric binaries. Without the experimental stack, those tests are skipped.

`pnpm playground:smoke` checks a running experimental playground without a browser, and prints PASS or FAIL for each step: it reads the relay's invite and the voter invite, checks the voters' CA proxy's issuer key against the invite, registers a new voter and enrols it through the proxy with the idemix module, registers a new Org1 user and enrols it through Org1's CA proxy, casts a private ballot as that user and an anonymous ballot as the voter through the relay, and finds both ballots, checked, in both explorers. It registers new IDs each run, so it can run again on the same stack.

`pnpm check:sideways` (`e2e/scripts/no-sideways-scroll.mjs`) checks that nothing in any product scrolls sideways (`packages/brand/SYSTEM.md`, Overflow). It needs no Fabric CA: run `pnpm build` and `pnpm --filter @weftwallet/extension build` first, and it serves the built sites, runs the explorer on its sample blocks and opens the wallet's popup and windows with the background worker faked. It loads every page at 320, 360 and 1440 wide in both themes and lists each element that scrolls, with the page, the state and the widths. `--only docs,explorer`, `--widths 320`, `--themes dark`, `--pages /operators/` and `--shots <folder>` narrow it or save a screenshot of each state.

CI (`.github/workflows/ci.yml`) runs all three: unit tests and typecheck, the browser tests, and the browser tests against the playground.

## Checks on a Mac with Docker

`pnpm check:mac` (`scripts/mac-check.mjs`) runs, in order, the checks this repository's own machines can't: it needs Docker Desktop or OrbStack running, and Go for the last steps. It takes about half an hour, and takes the playground down first.

1. Docker is running, and `pnpm build`.
2. `pnpm playground:down`, then `pnpm playground:up --experimental`.
3. The private-ballot contract, vendored as the peer gets it, builds in `hyperledger/fabric-ccenv:2.5` with no network, so `go.mod`'s `toolchain go1.26.10` line can't make Go download a toolchain.
4. `pnpm playground:credentials <election>` for each election with voter credentials.
5. `pnpm playground:smoke`.
6. `pnpm playground:count <election> --channel <channel>` on a fresh election it creates, as the e2e tests do.
7. The experimental e2e projects (`experimental-setup`, `experimental-stack`, `voter-credentials-setup`, `voter-credentials`) with `WEFT_E2E_STACK=playground` and the default `playground/.state`.
8. With mkcert installed, `pnpm playground:up --experimental --https` and the smoke test over HTTPS, then back to HTTP. `--no-https` skips it.
9. `go mod download` and `go mod verify` in `examples/private-ballot-contract` and `packages/idemix`, and `pnpm --filter @weftwallet/idemix check:wasm`, which builds the module twice and compares both with the pinned hash. These don't need Docker, so they run whatever happened before.

A step that fails stops the steps that depend on it, with a message that says why; the others still run. It ends with a summary, the path of its log (`.mac-check/mac-check-<time>.log`, with every command's whole output, and `--verbose` shows it as it runs), and the list of what to look at by hand on the running playground: Firefox with normal Weft (`pnpm --filter @weftwallet/extension dev:firefox`) for receipts, the salt Weft generates and the explorer handoff; Weft Experimental in Firefox (`pnpm --filter @weftwallet/extension dev:firefox:experimental`) enrolling and voting; that the extension's content security policy lets it reach the relay and the CA proxies on `http://localhost`; and the timings to note for [Prototype results](apps/docs/src/content/docs/experimental/prototype-results.md).

## Where things go

- A change to what crosses the page/wallet or wallet/relay boundary starts in `packages/protocol`. Update the docs' [Provider API](apps/docs/src/content/docs/dapps/provider-api.md) in the same change.
- Anything security-relevant (signing, decoding, verification) lives in `packages/core`, with tests. The integration tests in `apps/relay/src/offline-signing.test.ts` build real Fabric messages with `@hyperledger/fabric-gateway`; extend them when you touch decoding or verification.
- User-facing wording for Fabric errors lives in `packages/core/src/status.ts`. The table in `apps/docs/.../reference/transaction-codes.md` and the cases in `guides/failures.md` copy it word for word; change all three together.
- Significant design choices get an ADR in `docs/adr`.

## Style

- TypeScript strict mode everywhere. No `any` in public APIs.
- Writing: follow the [Writing rules in SYSTEM.md](packages/brand/SYSTEM.md#writing) for every word a person reads, from UI copy and errors to docs and READMEs. Fabric codes are shown as secondary detail, never as the headline.
- Amber and Signal colours are for status only (see `packages/brand/README.md`).

## Commits and pull requests

Keep each pull request to one change and describe its user-visible effect. Mention any change to the security model explicitly.
