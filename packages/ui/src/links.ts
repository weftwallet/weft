/**
 * Links between Weft's products. Built pages point at the public addresses
 * from @weftwallet/brand's products.json; `astro dev`, and any build with
 * WEFT_PRODUCTS=dev (the end-to-end tests), point at the local ones.
 */
import { productUrl, products, type ProductId } from "@weftwallet/brand/products";

const local = process.env.WEFT_PRODUCTS ? process.env.WEFT_PRODUCTS === "dev" : import.meta.env.DEV;

/** A product's address, with an optional path such as "/join/". */
export function productHref(id: ProductId, path = "/"): string {
  const url = productUrl(id, { dev: local, path });
  if (!url) throw new Error(`${products[id].name} has no site to link to`);
  return url;
}

/** Products with a site of their own, in the order the switcher lists them. */
export const siteProducts = (["site", "docs", "playground", "network"] as const).map((id) => ({ id, ...products[id] }));
