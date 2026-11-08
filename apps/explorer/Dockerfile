# Build from the repository root:
#   docker build -f apps/explorer/Dockerfile -t weft-explorer .
# Needs Node 22.5 or later for node:sqlite.

# The Go toolchain the idemix module is pinned to (packages/idemix/src/pinned.ts).
FROM golang:1.26.10-alpine AS go

FROM node:22-alpine AS build
WORKDIR /repo
RUN corepack enable
# The idemix module (docs/adr/0008) is built from Go source with the pinned
# toolchain. GOTOOLCHAIN=local: Go never downloads another toolchain here.
COPY --from=go /usr/local/go /usr/local/go
ENV PATH=/usr/local/go/bin:$PATH \
    GOTOOLCHAIN=local
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/brand packages/brand
COPY packages/protocol packages/protocol
COPY packages/core packages/core
COPY packages/ui packages/ui
# The private tally (docs/adr/0007), for the experimental private election pages.
COPY packages/tally packages/tally
# The idemix module's Go source and loaders, and the contract's pseudonym
# package, which the module's go.mod takes from ../../examples/private-ballot-contract.
COPY packages/idemix packages/idemix
COPY examples/private-ballot-contract/go.mod examples/private-ballot-contract/go.sum examples/private-ballot-contract/
COPY examples/private-ballot-contract/pseudonym examples/private-ballot-contract/pseudonym
COPY apps/explorer apps/explorer
RUN pnpm install --frozen-lockfile --filter @weftwallet/explorer... \
 && pnpm --filter @weftwallet/protocol build \
 && pnpm --filter @weftwallet/core build \
 && pnpm --filter @weftwallet/tally build \
 && pnpm --filter @weftwallet/idemix build \
 && pnpm --filter @weftwallet/explorer build
# Reproducible: build.mjs builds in a clean copy with -trimpath and the
# modules in go.sum, and deletes the module and fails unless its SHA-256 and
# wasm_exec.js's are the ones in src/pinned.ts.
RUN node packages/idemix/scripts/build.mjs
RUN pnpm deploy --filter @weftwallet/explorer --prod --legacy /out \
 && test -f /out/node_modules/@weftwallet/idemix/dist/wasm/weft-idemix.wasm \
 && test -f /out/node_modules/@weftwallet/idemix/dist/wasm/wasm_exec.js

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning \
    WEFT_EXPLORER_DB=/data/explorer.db
COPY --from=build /out /app
# The module in the image starts, with the pinned hash, so an explorer with
# WEFT_EXPERIMENTAL=1 and privateElections starts from this image.
RUN node --input-type=module -e "const { startIdemixNode } = await import('@weftwallet/idemix/node'); await startIdemixNode(); console.log('The idemix module starts, with the pinned SHA-256.')"
# The index lives on a volume, so it survives new images. It can always be
# rebuilt from the ledger, so losing it costs only time.
RUN mkdir /data && chown node:node /data
VOLUME /data
USER node
EXPOSE 8790
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:${PORT:-8790}/api/v1/status >/dev/null || exit 1
CMD ["node", "dist/main.js"]
