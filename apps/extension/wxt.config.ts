import { defineConfig } from "wxt";

// The end-to-end tests (e2e/) build a variant with WEFT_E2E=1: it may reach
// localhost from install, so enrolling there doesn't stop at the browser's
// permission prompt, which automated browsers can't click. It goes to its own
// folder so it's never mistaken for a release build.
const e2e = process.env.WEFT_E2E === "1";

// https://wxt.dev/api/config.html
export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  outDir: e2e ? ".output-e2e" : ".output",
  manifest: {
    name: "Weft",
    description: "Identity wallet for Hyperledger Fabric. Sign transactions with your organisation's certificate.",
    // alarms: an hourly check for expiring certificates (lib/certificate-watch.ts).
    permissions: ["storage", "unlimitedStorage", "activeTab", "alarms"],
    // CA and relay hosts differ per organisation, so access is requested at
    // runtime, per host, when the user adds a network.
    optional_host_permissions: ["https://*/*", "http://localhost/*", "http://127.0.0.1/*"],
    ...(e2e ? { host_permissions: ["http://localhost/*", "http://127.0.0.1/*"] } : {}),
    action: { default_title: "Weft" },
    icons: { 16: "icon/16.png", 32: "icon/32.png", 48: "icon/48.png", 128: "icon/128.png" },
  },
});
