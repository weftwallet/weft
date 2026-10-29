// @ts-check
import { productUrl } from "@weftwallet/brand/products";
import { defineConfig } from "astro/config";
import { source } from "../../vite.source.ts";

// Its address, and the port `pnpm dev` serves it on, come from
// packages/brand/products.json.
export default defineConfig({
  site: productUrl("site") ?? undefined,
  server: { port: Number(new URL(productUrl("site", { dev: true }) ?? "").port) },
  // Reads the workspace packages from their source, so a stale build is never used.
  vite: source,
});
