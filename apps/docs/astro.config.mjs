// @ts-check
import starlight from "@astrojs/starlight";
import { productUrl } from "@weftwallet/brand/products";
import { defineConfig } from "astro/config";
import { source } from "../../vite.source.ts";

// Built pages link to the other products' public addresses; `astro dev`, and
// any build with WEFT_PRODUCTS=dev (the end-to-end tests), to the local ones.
const local = process.env.WEFT_PRODUCTS ? process.env.WEFT_PRODUCTS === "dev" : process.argv.includes("dev");
const product = (id, path = "/") => /** @type {string} */ (productUrl(id, { dev: local, path }));

/** @param {string} url */
const resolve = (url) => {
  const [, id, path] = url.match(/^weft:([a-z]+)(\/.*)?$/) ?? [];
  if (!id) throw new Error(`Bad product link ${url}`);
  return product(id, path ?? "/");
};

/**
 * Links written `weft:<product>/<path>` in the docs, such as
 * `[the playground](weft:playground/)` or `<LinkCard href="weft:network/" />`,
 * point at that product.
 * @param {any} node
 */
function productLinks(node) {
  if ((node.type === "link" || node.type === "definition") && node.url?.startsWith("weft:")) node.url = resolve(node.url);
  for (const attr of Array.isArray(node.attributes) ? node.attributes : []) {
    if (attr.name === "href" && typeof attr.value === "string" && attr.value.startsWith("weft:")) attr.value = resolve(attr.value);
  }
  for (const child of node.children ?? []) productLinks(child);
}

export default defineConfig({
  site: productUrl("docs") ?? undefined,
  server: { port: Number(new URL(productUrl("docs", { dev: true }) ?? "").port) },
  // Reads the workspace packages from their source, so a stale build is never used.
  vite: source,
  markdown: { remarkPlugins: [() => productLinks] },
  // The tools that used to live here moved to their own products.
  redirects: {
    "/playground/": product("playground"),
    "/operators/invite-maker/": product("network", "/invite/"),
    "/join/": product("site", "/join/"),
  },
  integrations: [
    starlight({
      title: "weft docs",
      description: "Guides for people using Weft, building dApps and running Hyperledger Fabric networks.",
      favicon: "/favicon.svg",
      // The mark weaves on hover; see src/components/SiteTitle.astro. The
      // products switcher and the theme control are the sites' own, from
      // @weftwallet/ui, in SocialIcons.astro and ThemeSelect.astro.
      components: {
        SiteTitle: "./src/components/SiteTitle.astro",
        SocialIcons: "./src/components/SocialIcons.astro",
        ThemeSelect: "./src/components/ThemeSelect.astro",
      },
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/ifeanyi-ugwu/weft" }],
      editLink: { baseUrl: "https://github.com/ifeanyi-ugwu/weft/edit/main/apps/docs/" },
      customCss: [
        "@fontsource/atkinson-hyperlegible-next/400.css",
        "@fontsource/atkinson-hyperlegible-next/600.css",
        "@fontsource/atkinson-hyperlegible-mono/400.css",
        "@fontsource/atkinson-hyperlegible-mono/500.css",
        "@weftwallet/brand/tokens.css",
        "./src/styles/theme.css",
      ],
      sidebar: [
        {
          label: "Start here",
          items: [
            { label: "What is Weft?", slug: "start/what-is-weft" },
            { label: "Install and add an identity", slug: "start/install" },
          ],
        },
        {
          label: "Using Weft",
          items: [
            { label: "Reading a signature request", slug: "guides/signing" },
            { label: "Certificates and renewal", slug: "guides/certificates" },
            { label: "When a transaction fails", slug: "guides/failures" },
            { label: "Run an election", slug: "guides/elections" },
          ],
        },
        {
          label: "Build a dApp",
          items: [
            { label: "Quickstart", slug: "dapps/quickstart" },
            { label: "Provider API", slug: "dapps/provider-api" },
            { label: "Local test network", slug: "dapps/test-network" },
            { label: "Weft Playground", link: product("playground"), attrs: { "data-product": "playground" } },
          ],
        },
        {
          label: "Run a network",
          items: [
            { label: "Deploy the relay", slug: "operators/relay" },
            { label: "Publish an org invite", slug: "operators/invites" },
            { label: "Run an explorer", slug: "operators/explorer" },
            { label: "The network page", slug: "operators/network" },
            { label: "Weft Network", link: product("network"), attrs: { "data-product": "network" } },
          ],
        },
        {
          label: "Reference",
          items: [
            { label: "Security model", slug: "reference/security" },
            { label: "Transaction codes", slug: "reference/transaction-codes" },
            { label: "Architecture decisions", slug: "reference/decisions" },
            { label: "Brand", slug: "reference/brand" },
          ],
        },
      ],
    }),
  ],
});
