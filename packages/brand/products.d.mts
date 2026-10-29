export type ProductId = "site" | "docs" | "playground" | "network" | "explorer" | "wallet";
export interface Product {
  name: string;
  summary: string;
  mark: string;
  markSmall: string;
  /** "" is the domain itself; null means no public site. */
  subdomain: string | null;
  dev: string | null;
}
export declare const domain: string;
export declare const products: Record<ProductId, Product>;
export declare function productUrl(id: ProductId, options?: { dev?: boolean; path?: string }): string | null;
