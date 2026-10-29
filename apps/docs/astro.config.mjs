// @ts-check
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import { source } from "../../vite.source.ts";

// Hosted as a subdomain of the main site for now; change `site` when Weft
// moves to its own domain. Nothing else depends on it.
export default defineConfig({
  site: "https://weft.ifeanyiugwu.dev",
  // Reads @weftwallet/core from its source, so a stale build is never used.
  vite: source,
  integrations: [
    starlight({
      title: "weft",
      description: "An identity wallet for Hyperledger Fabric.",
      logo: {
        dark: "./src/assets/lockup-dark.svg",
        light: "./src/assets/lockup-light.svg",
        alt: "Weft",
        replacesTitle: true,
      },
      favicon: "/favicon.svg",
      // The title weaves on hover; see src/components/SiteTitle.astro.
      components: { SiteTitle: "./src/components/SiteTitle.astro" },
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/ifeanyi-ugwu/weft" }],
      editLink: { baseUrl: "https://github.com/ifeanyi-ugwu/weft/edit/main/apps/docs/" },
      customCss: [
        "@fontsource/atkinson-hyperlegible-next/400.css",
        "@fontsource/atkinson-hyperlegible-next/600.css",
        "@fontsource/atkinson-hyperlegible-mono/400.css",
        "@fontsource/atkinson-hyperlegible-mono/500.css",
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
            { label: "Playground", slug: "playground" },
            { label: "Provider API", slug: "dapps/provider-api" },
            { label: "Local test network", slug: "dapps/test-network" },
          ],
        },
        {
          label: "Run a network",
          items: [
            { label: "Deploy the relay", slug: "operators/relay" },
            { label: "Publish an org invite", slug: "operators/invites" },
            { label: "Invite maker", slug: "operators/invite-maker" },
            { label: "Run an explorer", slug: "operators/explorer" },
            { label: "Network page", slug: "operators/network" },
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
