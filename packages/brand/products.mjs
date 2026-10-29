// Addresses of Weft's products, from products.json.
//
//   import { productUrl } from "@weftwallet/brand/products";
//   productUrl("docs")                 // https://docs.weft.ifeanyiugwu.dev
//   productUrl("docs", { dev: true })  // http://localhost:4322
//   productUrl("docs", { path: "/operators/explorer/" })
import registry from "./products.json" with { type: "json" };

export const domain = registry.domain;
export const products = registry.products;

/**
 * Where a product lives, or null if it has no site (the explorer and the
 * wallet). `dev` gives the local address that `pnpm dev:<id>` serves.
 */
export function productUrl(id, { dev = false, path = "" } = {}) {
  const p = products[id];
  if (!p) throw new Error(`Unknown product ${id}`);
  const base = dev ? p.dev : p.subdomain === null ? null : `https://${p.subdomain ? `${p.subdomain}.` : ""}${domain}`;
  return base === null ? null : base + path;
}
