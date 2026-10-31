// Addresses of Weft's products, from products.json.
//
//   import { productUrl } from "@weftwallet/brand/products";
//   productUrl("docs")                 // https://docs.weft.ifeanyiugwu.dev
//   productUrl("docs", { dev: true })  // http://localhost:4322
//   productUrl("docs", { path: "/operators/explorer/" })
//   productUrl("docs", { domain: "weft.example.org" })  // https://docs.weft.example.org
import registry from "./products.json" with { type: "json" };

export const domain = registry.domain;
export const products = registry.products;

/**
 * The public demo network, when one is hosted: its invite URL and its
 * organisations' explorer URLs. Both are empty until then, and the
 * playground and the network page fall back to the local stack. Set them in
 * products.json ("demo") to switch the demo on everywhere at once.
 */
export const demo = {
  invite: registry.demo?.invite || null,
  explorers: (registry.demo?.explorers ?? []).filter(Boolean).map((u) => u.replace(/\/+$/, "")),
};

/**
 * Where a product lives, or null if it has no site (the explorer and the
 * wallet). `dev` gives the local address that `pnpm dev:<id>` serves;
 * `domain` puts the products under another domain than products.json's, for
 * a copy of the sites hosted elsewhere (the explorer's
 * WEFT_EXPLORER_PRODUCTS_DOMAIN).
 */
export function productUrl(id, { dev = false, path = "", domain: under = domain } = {}) {
  const p = products[id];
  if (!p) throw new Error(`Unknown product ${id}`);
  const base = dev ? p.dev : p.subdomain === null ? null : `https://${p.subdomain ? `${p.subdomain}.` : ""}${under}`;
  return base === null ? null : base + path;
}
