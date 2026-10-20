# Contributing

## Setup

```sh
pnpm install
pnpm build
pnpm test
```

## Where things go

- A change to what crosses the page/wallet or wallet/relay boundary starts in `packages/protocol`. Update the docs' [Provider API](apps/docs/src/content/docs/dapps/provider-api.md) in the same change.
- Anything security-relevant (signing, decoding, verification) lives in `packages/core`, with tests. The integration tests in `apps/relay/src/offline-signing.test.ts` build real Fabric messages with `@hyperledger/fabric-gateway`; extend them when you touch decoding or verification.
- User-facing wording for Fabric errors lives in `packages/core/src/status.ts`, and the table in `apps/docs/.../reference/transaction-codes.md` mirrors it.
- Significant design choices get an ADR in `docs/adr`.

## Style

- TypeScript strict mode everywhere. No `any` in public APIs.
- UI copy: plain words, sentence case, say what happened and what to do next. Fabric codes are shown as secondary detail, never as the headline.
- Amber and Signal colours are for status only (see `packages/brand/README.md`).

## Commits and pull requests

Keep each pull request to one change and describe its user-visible effect. Mention any change to the security model explicitly.
