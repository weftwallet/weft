# Contributing

## Setup

```sh
pnpm install
pnpm test
```

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

CI (`.github/workflows/ci.yml`) runs all three: unit tests and typecheck, the browser tests, and the browser tests against the playground.

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
