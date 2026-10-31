export type ProductId = "site" | "docs" | "playground" | "network" | "explorer" | "wallet";
export interface Product {
  name: string;
  summary: string;
  mark: string;
  markSmall: string;
  /** The product's loader: its mark with a pick pulled through, animated. */
  loader: string;
  /** The loader on the 16px pixel grid, for 24px and below. */
  loaderSmall: string;
  /** "" is the domain itself; null means no public site. */
  subdomain: string | null;
  dev: string | null;
}
export declare const domain: string;
export declare const products: Record<ProductId, Product>;
/** The public demo network: null and [] until one is hosted (products.json "demo"). */
export declare const demo: { invite: string | null; explorers: string[] };
/** Where a product lives. `domain` replaces products.json's domain; `dev` gives the local address instead. */
export declare function productUrl(id: ProductId, options?: { dev?: boolean; path?: string; domain?: string }): string | null;
