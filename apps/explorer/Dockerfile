# Build from the repository root:
#   docker build -f apps/explorer/Dockerfile -t weft-explorer .
# Needs Node 22.5 or later for node:sqlite.
FROM node:22-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/brand packages/brand
COPY packages/protocol packages/protocol
COPY packages/core packages/core
COPY packages/ui packages/ui
COPY apps/explorer apps/explorer
RUN pnpm install --frozen-lockfile --filter @weftwallet/explorer... \
 && pnpm --filter @weftwallet/protocol build \
 && pnpm --filter @weftwallet/core build \
 && pnpm --filter @weftwallet/explorer build \
 && pnpm deploy --filter @weftwallet/explorer --prod --legacy /out

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning \
    WEFT_EXPLORER_DB=/data/explorer.db
COPY --from=build /out /app
# The index lives on a volume, so it survives new images. It can always be
# rebuilt from the ledger, so losing it costs only time.
RUN mkdir /data && chown node:node /data
VOLUME /data
USER node
EXPOSE 8790
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:${PORT:-8790}/api/v1/status >/dev/null || exit 1
CMD ["node", "dist/main.js"]
